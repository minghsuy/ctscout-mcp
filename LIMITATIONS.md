# LIMITATIONS

ctscout is built to be honest about what it does and what it doesn't. Read this before using it for anything load-bearing.

## What ctscout is

A digital entity resolution tool that maps apex domains to the organizations attributed in their Certificate Transparency (CT) records, with optional multi-signal corroboration in a Pro deep dive (DNS, RDAP, IP/ASN, homepage metadata, favicon; visual brand verification is planned, not shipped).

ctscout indexes **OV and EV certificates exclusively** — the ones where the issuing CA validated the organization's legal identity and embedded it in the cert subject. DV certs (Let's Encrypt, ZeroSSL, ACME-defaulting cloud hosts) are filtered at ingest and are never stored, never queryable. This is a deliberate scoping decision, not a coverage gap to be filled later.

Primary use cases:
- **Named-entity attribution** — given a domain with an OV/EV cert, surface the legal entity recorded in the cert subject, with multi-signal corroboration in a Pro deep dive
- **Sibling and subsidiary discovery** — given a known org or domain, find related apex domains attributed to the same legal entity (within OV/EV coverage)
- **Cohort and temporal analysis** — analyze SAN cohorts and cert-issuance patterns over time

ctscout serves well: GTM / RevOps teams enriching account-to-domain mappings, brokerage / TPRM analysts mapping client digital footprints, researchers investigating relationships among legitimate entities.

Threat-intel and OSINT analysts get value on the subset of investigations where targets hold OV/EV certs — sanctioned entities, shell companies with real corporate paper, supply-chain compromises rooted at OV-cert vendors, sophisticated actors investing in legitimacy. **The majority of commodity adversary infrastructure (phishing, C2, cloud-native attack tooling) uses DV certs and is invisible to ctscout entirely.** See "Coverage gaps" below.

## What ctscout is NOT

**ctscout is NOT a cyber-risk quantification platform.** It does not:

- Score the security posture of an organization
- Predict breach likelihood, claim frequency, or financial loss exposure
- Produce risk ratings, security ratings, or comparable metrics
- Substitute for an EASM / attack-surface management product
- Provide vulnerability data, exploit predictions, or remediation guidance

ctscout's output is **digital identity information** (domain → legal-entity attribution with evidence), not security state. It is a perfectly reasonable input alongside other signals if you are an insurance underwriter, broker, risk analyst, or anyone else mapping a counterparty's digital footprint — you just shouldn't expect ctscout itself to do the risk scoring. Pair it with whatever EASM / security-rating / vulnerability product is doing that work in your stack.

## Coverage gaps you should know

### DV-only certs are not indexed

ctscout's warehouse is built from OV and EV certificates only — the ones where the issuing CA validated the organization's legal identity and included it in the cert subject. Domain-Validated (DV) certs from Let's Encrypt, ZeroSSL, and similar do not carry organization identity and are excluded.

In practice, this means **cloud-native modern infrastructure is largely invisible**:
- Sites entirely behind Cloudflare with no OV/EV cert: invisible
- Vercel, Netlify, Pages-style hosting using DV certs: invisible
- Most cyber-insurance MGAs (Coalition, At-Bay, Resilience, Corvus, Cowbell, etc.) — confirmed 0% recall as of 2026-05
- Most modern SaaS startups: partial to invisible

The warehouse is best at: established US/EU enterprise, government, financial services, traditional infrastructure, education, defense — anyone who buys OV/EV certs as a matter of policy.

Warehouse size (organizations, org-domain pairs, apex domains, last sync date) grows with every daily sync, so no figure is typed here; the live counts are published at https://ctscout.dev/stats.

### Temporal fields mean "when we observed it"

`first_seen` and `last_seen` reflect when the ctscout warehouse first/last ingested an entry from the CT pipeline. They do NOT mean the original SCT timestamp from the CT log. If you need the actual CT issuance time, query crt.sh or another CT-log search tool directly.

### Attribution confidence

The `org` field is the cert subject text recorded by the CA. We do not independently verify that the named entity currently owns or operates the domain. The cert subject reflects who held the cert at issuance time. Ownership and control can change without a new cert being issued.

When a Pro deep dive provides a `confidence_band`, it reflects the aggregated multi-signal corroboration (DNS, RDAP, IP/ASN, homepage metadata, favicon) at the time the job ran; visual brand verification is not among them in v1. It is not a guarantee, and it is not a substitute for first-party confirmation when the attribution is consequential.

### Deep dives are asynchronous and partial in v1

A Pro deep dive (`ctscout_submit_deep_dive` / `ctscout_get_job`) is not an answer, it is a job: the submission returns a receipt, a batch worker runs the multi-signal attribution some minutes later, and the result is read back by polling (about 30 s before the first poll, backing off toward 5 min). Its `snapshot` is the warehouse date the worker read from, which can lag the live site by up to a sync cycle. Visual brand verification (VLM) does not run in v1, so `vlm_status` is `pending` or `skipped` on every domain and no band has been VLM-vetoed; when `signals_degraded` is true, at least one signal errored and the absence of its evidence is not evidence of absence. Jobs are limited to 20 submissions per key per day, are visible only to the key that submitted them, and cannot yet be cancelled, retried or expired from this package.

### Brand-namesake collisions

Common-word entity names produce noisy results. A search for "Coalition" returns the IMCTC counter-terrorism coalition, several non-profits, the cyber MGA (often as 0 hits since they're DV-only), and various unrelated orgs. Multi-signal corroboration in a Pro deep dive helps disambiguate but does not eliminate the issue.

## Corrections and contact

If ctscout returns an attribution you believe is wrong, please open an issue at https://github.com/minghsuy/ctscout-mcp/issues with:
- The domain or company queried
- The result returned
- Why it's wrong (cert subject mismatch, stale data, brand collision, etc.)

For coverage requests (specific entities you want indexed beyond current warehouse), email pro@ctscout.dev with the entity name and any known apex domains.

## Tier issuance

The free tier is self-serve at https://ctscout.dev — Turnstile-protected, no email or account required, 10 queries per day.

The Pro tier (top 25 results, a 12-month window and unlimited `/scan` queries, plus 20 deep-dive jobs a day) is currently **concierge-only**. Email pro@ctscout.dev if you want early access; key minting and invoicing are manual until usage data justifies automated commerce.

## License and data

MIT-licensed. See [LICENSE](LICENSE). Data comes exclusively from public CT logs and public RDAP/DNS records; no PII is collected, transmitted, or sold.
