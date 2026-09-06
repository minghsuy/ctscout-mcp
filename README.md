# ctscout-mcp-server

MCP server for [ctscout.dev](https://ctscout.dev) — **named-entity attribution from Certificate Transparency logs (OV/EV only)**, with optional multi-signal corroboration on Pro. For mapping legal-entity digital footprints, sibling-domain discovery, and SAN-cohort analysis from LLM-driven workflows.

DV-only infrastructure (Let's Encrypt, ZeroSSL, cloud-native shops) is invisible to ctscout by design. See [LIMITATIONS.md](LIMITATIONS.md) for what that means in practice.

Seven tools:

- **`ctscout_search_company`** — find apex domains attributed to an organization by name
- **`ctscout_search_company_batch`** — the same, for up to 10 organization names in one call
- **`ctscout_lookup_domain`** — reverse-lookup the organization attributed to one or more domains
- **`ctscout_submit_deep_dive`** — Pro only: queue an asynchronous multi-signal deep dive (see [Deep dives](#deep-dives-pro-async))
- **`ctscout_get_job`** — poll a deep dive and read its result
- **`ctscout_lookup_lei`** — one LEI's record, or the LEIs under a legal name (see [Research product](#research-product-lei-and-vendor-tools))
- **`ctscout_vendor_customers`** — a vendor's customer counts, and with a key the customer enumeration

The first three work over the public ctscout.dev `/scan` API (the batch tool wraps `/scan/batch`); the deep-dive pair wraps `/jobs`; the last two read the research product objects at `/lei` and `/vendors`. Free tier requires an API key (no email, no signup). A Pro key gets up to 25 rows, a 12-month window and unlimited queries on `/scan`, and can submit deep-dive jobs, which return a `confidence_band` per attribution with the named signals behind it (DNS brand tokens, RDAP, IP/ASN, homepage metadata, favicon). Visual brand verification (VLM) is not part of v1.

**Not a cyber-risk-scoring tool.** See [LIMITATIONS.md](LIMITATIONS.md) for what ctscout is and isn't, the DV-cert coverage gap, and the corrections path.

Release history: see [CHANGELOG.md](CHANGELOG.md).

---

## Install

For Claude Code, Claude Desktop, Cursor, or any other MCP client. **Two ways to connect:** hosted (recommended, no install) or local npm (this package).

### 1. Get a free API key

Visit [ctscout.dev](https://ctscout.dev) and click "Get a free API key". Solve the Turnstile captcha. Copy the key (you can't recover it later — save it now).

### 2a. Hosted endpoint (recommended — zero install)

The same tools are hosted at `https://ctscout.dev/mcp`. Nothing to install — just point your MCP client at the URL with your API key as the `X-API-Key` header.

**Claude Code (CLI)**:

```bash
claude mcp add ctscout \
  -s user \
  --transport http \
  --header "X-API-Key: YOUR_KEY_HERE" \
  https://ctscout.dev/mcp
```

This writes to `~/.claude.json`.

**Claude Desktop / Cursor / Cline / any HTTP-transport MCP client** — edit the client config:

```json
{
  "mcpServers": {
    "ctscout": {
      "type": "http",
      "url": "https://ctscout.dev/mcp",
      "headers": { "X-API-Key": "YOUR_KEY_HERE" }
    }
  }
}
```

Config file locations:
- **Claude Desktop**: `~/Library/Application Support/Claude/claude_desktop_config.json` (Mac), `%APPDATA%\Claude\claude_desktop_config.json` (Windows). HTTP-transport MCP support requires a recent Desktop build; if your client doesn't recognize `"type": "http"`, use the local npm fallback below.
- **Cursor**: `~/.cursor/mcp.json`. If Cursor's HTTP transport doesn't connect, swap the `url` to `https://ctscout.dev/sse` — the same tools are served over the legacy SSE transport.

After adding, **fully quit and restart your MCP client** (not just close the window). The tools will appear under "ctscout".

### 2b. Local npm (fallback — if you can't use the hosted endpoint)

If your MCP client does not support remote HTTP transport, run the published
Node compatibility binary locally. It still calls `https://ctscout.dev`, so
your network must allow that origin. Version 0.3.0 and newer require Node.js
20 or newer:

```bash
claude mcp add ctscout \
  -s user \
  -e CTSCOUT_API_KEY=YOUR_KEY_HERE \
  -- npx -y ctscout-mcp-server
```

Or in JSON config:

```json
{
  "mcpServers": {
    "ctscout": {
      "command": "npx",
      "args": ["-y", "ctscout-mcp-server"],
      "env": { "CTSCOUT_API_KEY": "YOUR_KEY_HERE" }
    }
  }
}
```

The hosted endpoint is the authoritative MCP contract and is the recommended
path. The stdio package is a compatibility adapter over the same ctscout.dev
API for clients that cannot connect to remote MCP servers yet.

Hosted and stdio both expose the same public tool names, including the
names-only `ctscout_search_company_batch` contract (1–10 organization names,
ordered partial-failure results) and the deep-dive pair specified in
[ctscout-worker#344](https://github.com/minghsuy/ctscout-worker/issues/344)
(contract v1; the hosted tools land in that Worker change). Contract tests pin
the stdio schema and quota-sensitive annotations against the hosted surface.
The remaining shared-core/forwarding and automated cross-repository comparison
work is tracked in [#72](https://github.com/minghsuy/ctscout-mcp/issues/72).

Two documented, transport-specific differences. First, this package advertises
an `outputSchema` on every tool and, on every successful call, returns
`snapshot` and `snapshot_source` in `structuredContent`. On the scan and job
tools `snapshot` is the warehouse sync date and `snapshot_source` is
`"scan"` | `"unavailable"`; on `ctscout_lookup_lei` and
`ctscout_vendor_customers` it is the research export's version and the source
vocabulary is `"product"` | `"unavailable"` (see
[Research product](#research-product-lei-and-vendor-tools)) — the two are
different origins on different cadences, so they do not share a label. A failed
call (401, 429, timeout) is an `isError` result with no `structuredContent` at
all, so do not dereference `snapshot` on it.
Second, `ctscout_lookup_lei` and `ctscout_vendor_customers` ship here first:
the hosted MCP at `/mcp` does not advertise them yet, and mirroring them is a
separate ctscout-worker change. Until it lands the two transports differ by
exactly those two tools.
The `ctscout_submit_deep_dive` receipt is the other exception: it is a job
handle, not a warehouse read, so it carries neither field; both arrive on
`ctscout_get_job` with the result.
Since `X-API-Version` 2026-09-05 every `/scan` and `/scan/batch` answer carries
`snapshot`, the warehouse sync date it was read from (the sync runs daily), so
the scan tools report `snapshot_source: "scan"` with that date; a deep-dive
result carries its own (above). `snapshot_source` is `"unavailable"` and
`snapshot` is `null` only when the API sent none, which it does before a fresh
deploy's first sync or when its lookup failed. There is deliberately no
client-side fallback (a separately fetched date is not tied to the scan's
generation). A client must treat a missing or null `snapshot` as unknown, never
as "current". The hosted-side change was
[ctscout-worker#343](https://github.com/minghsuy/ctscout-worker/issues/343).

The stdio package accepts both MCP protocol eras: current clients can discover
the server through the stateless 2026-07-28 `server/discover` flow, while
existing clients keep the 2025 `initialize` handshake.

### 3. Use it

In Claude Code or Claude Desktop, just ask the model:

> "Find all domains attributed to Cloudflare"
>
> "Who is gs.com attributed to? What about goldmansachs.com — same parent?"
>
> "Given an OV/EV-cert domain, pivot from its cert subject and surface sibling apex domains attributed to the same legal entity."
>
> "List the domains attributed to The Hartford."

The model will pick the right ctscout tool, call it, and summarize.

---

## Free tier vs Pro tier

| | Free | Pro |
|---|---|---|
| Queries per day | 10 | unlimited |
| Results per query | top 5 | top 25 |
| History window | last 90 days | up to 12 months |
| Data freshness | daily snapshot (`snapshot` names the sync date) | daily snapshot (`snapshot` names the sync date) |
| Deep-dive jobs (async) | — | 20 per day |
| Per-attribution evidence | — | in a deep-dive result: `confidence_band` + named signals (DNS, RDAP, IP/ASN, homepage, favicon) |
| Price | $0 | concierge — email for early access |

The MCP server uses the same API key for both — your tier is determined by the key. If you hit the daily quota, the tool returns a 429 error with an upgrade hint.

Pro is currently concierge-only (manual key mint + invoice) while usage data justifies whether automated commerce is worth building. Email pro@ctscout.dev if you want a Pro key.

### What the Pro response looks like

`/scan` returns the `(domain, organization, certs, subdomains)` table on both tiers; Pro gets more rows and a longer window. A deep-dive job result replaces it with a richer attribution table you can defend in a meeting:

```
| Domain          | Attributed to  | Band         | Signals                                         | Evidence                                                  |
|---|---|---|---|---|
| coalition.com   | Coalition Inc  | ✅ verified  | dns_txt_brand_token, og_site_name_match, +1     | verified via google-site-verification, atlassian-domain... |
| imposter.com    | Coalition Inc  | ⚪ insufficient | dns_txt_brand_token                              | verified via google-site-verification                     |
```

Bands map to confidence intervals (`verified` ≥ multiple strong independent signals, down to `insufficient` = no signals or signals disagree). The `🚫VLM-veto` tag is reserved for visual brand verification overriding the positive signals; VLM does not run in v1, so it never appears yet. Full structured payload is available via `response_format: "json"`.

## Deep dives (Pro, async)

A deep dive is the full multi-signal attribution run executed by a batch worker
rather than inside the request. It is **asynchronous** and **Pro only**
([ctscout-worker#344](https://github.com/minghsuy/ctscout-worker/issues/344),
contract v1):

1. **`ctscout_submit_deep_dive`** (`POST /jobs`) takes `company_name` and/or
   `seed_domain` (max 10, validated exactly like `/scan`) and returns a receipt
   immediately: `{job_id, status: "queued", submitted_at, poll}`. Nothing is
   attributed yet. A free key gets HTTP 403 with the API's upgrade text; the
   quota is 20 submissions per key per day (HTTP 429 over). Submitting is not
   idempotent — a retry queues a second job.
2. **`ctscout_get_job`** (`GET /jobs/{id}`) returns
   `{job_id, kind, status, submitted_at, started_at, finished_at, result?, error?}`.
   `status` is `queued` | `running` | `done` | `failed`; `result` is present
   only when `done`, `error` only when `failed`. Polling is read-only and
   debits no quota. Job ids are scoped to the submitting key, so an id another
   key submitted answers 404 exactly like an unknown id.

**Poll with backoff:** wait about 30 s before the first poll, then back off
toward 5 min between polls. The batch worker picks up queued jobs every few
minutes and a deep dive can take several minutes to run.

**The result** is the deep-dive shape — `domains` with `attributed_to` and an
`enrichment` object per domain, plus `entity`, `run_metadata`, `source`,
`signals_degraded` — and three fields the batch worker adds: `snapshot` (the warehouse date the deep dive read from, present on
every deep-dive result because the worker sets it), `worker_version` and
`signals_attempted`. The markdown output renders the band / signals / evidence
table under the job's status lines (a `/scan` never carries one); `structuredContent`
carries the record with the top-level `snapshot` / `snapshot_source` resolved
from `result.snapshot` (`null` / `"unavailable"` until the job is done).
"Attributed" and "candidate" mean what they mean elsewhere in this package: an
attribution is what the evidence names for a domain, a candidate is a
name-similarity guess — deep dives report attributions with a confidence band,
never bare candidates.

**Not in v1:** visual brand verification (VLM) — `vlm_status` stays `pending`
or `skipped` and never vetoes a band; webhooks, cancellation, retries and
result expiry are follow-ups on the Worker side.

---

## Research product (LEI and vendor tools)

`ctscout_lookup_lei` and `ctscout_vendor_customers` read a different index from
the `/scan` warehouse: precomputed objects published by the ctscout-research
refresh and served by ctscout.dev at `/lei` and `/vendors`
([ctscout-worker#336](https://github.com/minghsuy/ctscout-worker/issues/336)).
The Worker classifies nothing on these routes — it reads one object and returns
it — so both tools are free and debit no quota.

### `ctscout_lookup_lei`

Takes **exactly one** of `lei` or `name`; passing both, or neither, is rejected
before any network call.

- **`{ lei }`** (`GET /lei/{lei}`, ISO 17442: 18 uppercase alphanumerics plus 2
  check digits) returns the entity record: `legal_name` and `country` from
  GLEIF, `isin_count` (ISINs mapped to the LEI), `apex_count` (apex domains
  attributed to it), the `first_seen` / `last_seen` observation window,
  `sample_domains` (a hash-chosen sample of up to 5 — **not** the top 5 and not
  a complete list; `apex_count` is the total) and `vendors_confirmed`, which is
  a list of vendor **slugs** you can pass straight to
  `ctscout_vendor_customers`.
- **`{ name }`** (`GET /lei?name=`) returns `{ query, name_match, leis,
  lei_count, limit, truncated }`. `leis` is capped at `limit` (20) while
  `lei_count` is the total before the cap, so on a truncated answer the two
  disagree by design — report `lei_count`, not `leis.length`.

`name_match` is also the discriminator between the two answer shapes: it is
present on the by-name answer and absent from the record.

**`name_match: "none"` does not mean the company has no LEI.** The name index is
keyed by the research normalizer's form of the GLEIF legal name; the two
spellings the route tries (the lowercased, trimmed query and its locale-suffix
normalization) are not that normalizer, so a real entity can miss on a spelling.
Retry with the exact GLEIF legal name, or look it up by LEI. The markdown output
says this in place of the miss.

### `ctscout_vendor_customers`

Takes a vendor `slug` and, optionally, `enumerate`.

- **`enumerate: false`** (the default, `GET /vendors/{slug}`) returns the free
  summary: `vendor_name`, `vendor_apex` (`null` when the vendor's brand token
  matches no label it certifies), the `customers` split, `countries_top`,
  `co_use` and `sample_customers`.
- **`enumerate: true`** (`GET /vendors/{slug}/customers`) returns the
  enumeration: `confirmed` and `candidates` rows of
  `{ apex, attributed_to, lei }`, plus `counts` and `capped`. This route needs
  an active ctscout.dev API key (any tier); without one the tool returns a clear
  401 message that also points back at the keyless summary.

**Candidates and confirmed are two different claims and are never summed.** A
candidate is an apex the vendor certified a hostname for — fan-out alone, which
looks identical to an organization certifying hundreds of its own product sites.
Confirmed is the DNS-confirmed subset: *a vendor is confirmed when a hostname it
certified resolves onto a domain it certifies and the customer's own www does
not* (or another organization certifies the apex). Because confirmed is a subset
of candidates, adding the two double-counts; the markdown keeps them in separate
tables and the JSON in separate fields.

Two more fields that read wrong if taken at face value: `co_use[].confirmed`
counts *this* vendor's confirmed customers that the other vendor also certifies
— a candidate there, not a mutual confirmation — and `countries_top` counts
confirmed customers that resolved to an LEI only.

`counts` and `capped` describe the object the research build published: `capped:
true` means the build itself kept a subset of the candidates. If this MCP server
has to drop rows to stay under its own character limit, it writes a separate
`truncation_note` and leaves `counts` and `capped` untouched, so a trimmed list
never reads as a complete enumeration. The markdown and the `structuredContent`
are two renderings of **one** bounded record — same rows, same "N listed of M"
headings, one note — so the half you read can never describe a list the other
half does not show.

### Freshness and the 503

Both tools carry `snapshot` (the export's `as_of`) and `snapshot_source`
(`"product"` when the API reported the version, `"unavailable"` when it did not
— then `snapshot` is `null` and freshness is unknown, never "current"), plus
`snapshot_dates`, the per-source provenance from the manifest (the dated GLEIF,
ISIN, ELF and Wikidata snapshots and the PSL bundle each join read). The markdown
renders both lines. This is a different clock from the `/scan` warehouse's daily
sync: the research export is republished by its own refresh, so these answers
move on that slower cadence.

Until the refresh has published its first product, `/lei` and `/vendors` answer
HTTP 503 with `{"detail": "Research product not yet published…"}`. Both tools
surface that as a plain "not published yet" error naming the API's own detail —
not as a server outage, and not as an empty result.

---

## What this is, and isn't

ctscout is a digital entity resolution tool — it maps apex domains to organizations attributed in their Certificate Transparency records, corroborated by DNS / RDAP / IP/ASN / homepage / favicon signals in a Pro deep dive.

**It is NOT a cyber-risk quantification platform.** It does not score security posture, predict breaches, or produce risk ratings. See [LIMITATIONS.md](LIMITATIONS.md) for the full disclaimer, coverage gaps, and corrections path.

## Coverage at a glance

ctscout's warehouse is built from OV/EV certificates only — the ones where the issuing CA validated the org's legal identity. **DV-only infrastructure (Let's Encrypt, ZeroSSL, ACME-defaulting cloud hosts) is invisible to the warehouse.**

The warehouse is strongest on: established US/EU enterprise, government, financial services, traditional infrastructure, defense, education.

The warehouse is weak on: modern cloud-native shops (most domains entirely behind Cloudflare/Vercel/Netlify), pre-launch / stealth-mode startups, anything that defaults to DV certs.

When `ctscout_lookup_domain` returns 0 results, the apex isn't in the warehouse — not necessarily that nobody owns it. See [LIMITATIONS.md](LIMITATIONS.md) for the full coverage discussion; current warehouse size is published live at https://ctscout.dev/stats.

---

## Local development

```bash
git clone https://github.com/minghsuy/ctscout-mcp.git
cd ctscout-mcp
npm install
npm run build

# Run the test suite (Vitest, no network)
npm test

# Maintainer-only, non-publishing 0.4.0 release preflight
npm run release:check

# Run the server (will fail without CTSCOUT_API_KEY)
node dist/index.js

# With a real key
CTSCOUT_API_KEY=your_key node dist/index.js

# Inspect with the official MCP inspector (browser UI)
npm run inspect
```

### Test the protocol handshake without a real key

```bash
echo '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1"}},"id":1}' | \
  CTSCOUT_API_KEY=fake node dist/index.js
```

Should respond with the server's capabilities + tool registration. (Tool calls themselves require a real key.)

---

## How it relates to ctscout.dev

This MCP server is a local stdio compatibility adapter over the public
ctscout.dev `/scan` API. It does no auth-handling magic or caching — it
translates MCP tool calls into HTTP requests and formats the response for an
LLM consumer. Hosted `https://ctscout.dev/mcp` is the authoritative MCP
surface.

If you're building your own integration in Python or another language, you can hit the same `/scan` endpoint directly. See [ctscout.dev](https://ctscout.dev) for `curl` examples.

---

## License

MIT. See [LICENSE](LICENSE).

The underlying ctscout service uses [domain-scout](https://github.com/minghsuy/domain-scout) (also MIT) for cert log analysis.
