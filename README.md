# ctscout-mcp-server

MCP server for [ctscout.dev](https://ctscout.dev) — **digital entity resolution from Certificate Transparency logs**, with optional multi-signal corroboration on Pro. Built for threat-intel pivots, sibling-domain discovery, and adversary-infrastructure attribution from LLM-driven workflows.

Two tools:

- **`ctscout_search_company`** — find apex domains attributed to an organization by name
- **`ctscout_lookup_domain`** — reverse-lookup the organization attributed to one or more domains

Both work over the public ctscout.dev `/scan` API. Free tier requires an API key (no email, no signup). Pro tier returns a `confidence_band` per attribution plus the underlying signal evidence (DNS brand tokens, og:site_name match, RDAP, IP/ASN, VLM verdict).

**Not a cyber-risk-scoring tool.** See [LIMITATIONS.md](LIMITATIONS.md) for what ctscout is and isn't, the DV-cert coverage gap, and the corrections path.

### What's new in 0.2.0

- Pro-tier response surfacing: `confidence_band`, `evidence`, `matched_via`, `signal_health`, `vlm_status`, `vlm_override` rendered in the markdown table when present.
- VLM-veto indicator (`🚫VLM-veto`) when a visual verdict overrode positive-signal accumulation.
- Backward-compatible: Free-tier responses render exactly as in v0.1.0; the new fields are additive.
- Tool descriptions updated: "attributed to" rather than "owns" (lawful, defensible language for attribution claims).
- Test suite added (Vitest). 20 tests covering both response shapes, truncation, error paths.

---

## Install

For Claude Code, Claude Desktop, Cursor, or any other MCP client.

### 1. Get a free API key

Visit [ctscout.dev](https://ctscout.dev) and click "Get a free API key". Solve the Turnstile captcha. Copy the key (you can't recover it later — save it now).

### 2. Configure your MCP client

> **Important — Claude Code CLI vs Claude Desktop have separate config files.** Adding via `claude mcp add` registers for the CLI only. If you use Claude Desktop, you must edit Desktop's config file directly.

**Claude Code (CLI)** — use the CLI:

```bash
claude mcp add ctscout \
  -s user \
  -e CTSCOUT_API_KEY=YOUR_KEY_HERE \
  -- npx -y ctscout-mcp-server
```

This writes to `~/.claude.json`.

**Claude Desktop** — edit `~/Library/Application Support/Claude/claude_desktop_config.json` (Mac) or the equivalent on Windows/Linux, and add:

```json
{
  "mcpServers": {
    "ctscout": {
      "command": "npx",
      "args": ["-y", "ctscout-mcp-server"],
      "env": {
        "CTSCOUT_API_KEY": "YOUR_KEY_HERE"
      }
    }
  }
}
```

If the file already has other MCP servers, just add the `ctscout` key under the existing `mcpServers` object.

**Cursor** (`~/.cursor/mcp.json`):

Same JSON shape as the Desktop example.

After adding the config, **fully quit and restart your MCP client** (not just close the window). The tools will appear under "ctscout" in your available tools.

### 3. Use it

In Claude Code or Claude Desktop, just ask the model:

> "Find all domains attributed to Cloudflare"
>
> "Who is gs.com attributed to? What about goldmansachs.com — same parent?"
>
> "I have a suspicious domain — pivot from its cert subject and surface any sibling apex domains attributed to the same entity."
>
> "List the domains attributed to The Hartford."

The model will pick the right ctscout tool, call it, and summarize.

---

## Free tier vs Pro tier

| | Free | Pro |
|---|---|---|
| Queries per day | 10 | unlimited |
| Results per query | top 5 | full set |
| Data freshness | weekly snapshot | live (DNS, RDAP, homepage, IP/ASN, VLM) |
| Per-attribution evidence | — | `confidence_band` + named signals |
| Price | $0 | concierge — email for early access |

The MCP server uses the same API key for both — your tier is determined by the key. If you hit the daily quota, the tool returns a 429 error with an upgrade hint.

Pro is currently concierge-only (manual key mint + invoice) while usage data justifies whether automated commerce is worth building. Email yminghsun@icloud.com if you want a Pro key.

### What the Pro response looks like

Free tier returns the legacy `(domain, organization, certs, subdomains)` table. Pro tier replaces it with a richer attribution table you can defend in a meeting:

```
| Domain          | Attributed to  | Band         | Signals                                         | Evidence                                                  |
|---|---|---|---|---|
| coalition.com   | Coalition Inc  | ✅ verified  | dns_txt_brand_token, og_site_name_match, +1     | verified via google-site-verification, atlassian-domain... |
| imposter.com    | Coalition Inc  | ⚪ insufficient 🚫VLM-veto | dns_txt_brand_token, vlm_verdict_no | Logo on screenshot is a different brand                   |
```

Bands map to confidence intervals (`verified` ≥ multiple strong independent signals, down to `insufficient` = no signals or signals disagree). The `🚫VLM-veto` tag appears when visual brand verification overrode the positive-signal accumulation. Full structured payload is available via `response_format: "json"`.

---

## What this is, and isn't

ctscout is a digital entity resolution tool — it maps apex domains to organizations attributed in their Certificate Transparency records, optionally corroborated by DNS / RDAP / IP/ASN / visual brand signals on the Pro tier.

**It is NOT a cyber-risk quantification platform.** It does not score security posture, predict breaches, or produce risk ratings. See [LIMITATIONS.md](LIMITATIONS.md) for the full disclaimer, coverage gaps, and corrections path.

## Coverage at a glance

ctscout's warehouse is built from OV/EV certificates only — the ones where the issuing CA validated the org's legal identity. **DV-only infrastructure (Let's Encrypt, ZeroSSL, ACME-defaulting cloud hosts) is invisible to the warehouse.**

The warehouse is strongest on: established US/EU enterprise, government, financial services, traditional infrastructure, defense, education.

The warehouse is weak on: modern cloud-native shops (most domains entirely behind Cloudflare/Vercel/Netlify), pre-launch / stealth-mode startups, anything that defaults to DV certs.

When `ctscout_lookup_domain` returns 0 results, the apex isn't in the warehouse — not necessarily that nobody owns it. See [LIMITATIONS.md](LIMITATIONS.md) for the full coverage discussion and ~5,976-org / 329K-pair scale stats.

---

## Local development

```bash
git clone https://github.com/minghsuy/ctscout-mcp.git
cd ctscout-mcp
npm install
npm run build

# Run the test suite (Vitest, no network)
npm test

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

This MCP server is a thin client over the public ctscout.dev `/scan` API. It does no auth-handling magic, no caching, no extra logic — just translates MCP tool calls into HTTP requests and formats the response for an LLM consumer.

If you're building your own integration in Python or another language, you can hit the same `/scan` endpoint directly. See [ctscout.dev](https://ctscout.dev) for `curl` examples.

---

## License

MIT. See [LICENSE](LICENSE).

The underlying ctscout service uses [domain-scout](https://github.com/minghsuy/domain-scout) (also MIT) for cert log analysis.
