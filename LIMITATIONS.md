# LIMITATIONS

ctscout is built to be honest about what it does and what it doesn't. Read this before using it for anything load-bearing.

## What ctscout is

A digital entity resolution tool that maps apex domains to the organizations attributed in their Certificate Transparency (CT) records, with optional multi-signal corroboration (DNS, RDAP, IP/ASN, favicon, visual brand verification).

ctscout indexes **OV and EV certificates exclusively** — the ones where the issuing CA validated the organization's legal identity and embedded it in the cert subject. DV certs (Let's Encrypt, ZeroSSL, ACME-defaulting cloud hosts) are filtered at ingest and are never stored, never queryable. This is a deliberate scoping decision, not a coverage gap to be filled later.

Primary use cases:
- **Named-entity attribution** — given a domain with an OV/EV cert, surface the legal entity recorded in the cert subject, with multi-signal corroboration on the Pro tier
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

If you are an insurance underwriter, broker, or risk analyst looking for cyber-risk-scoring inputs, ctscout is not your tool. The output of ctscout (domain → entity attribution with evidence) is digital identity information, not security state.

## Coverage gaps you should know

### DV-only certs are not indexed

ctscout's warehouse is built from OV and EV certificates only — the ones where the issuing CA validated the organization's legal identity and included it in the cert subject. Domain-Validated (DV) certs from Let's Encrypt, ZeroSSL, and similar do not carry organization identity and are excluded.

In practice, this means **cloud-native modern infrastructure is largely invisible**:
- Sites entirely behind Cloudflare with no OV/EV cert: invisible
- Vercel, Netlify, Pages-style hosting using DV certs: invisible
- Most cyber-insurance MGAs (Coalition, At-Bay, Resilience, Corvus, Cowbell, etc.) — confirmed 0% recall as of 2026-05
- Most modern SaaS startups: partial to invisible

The warehouse is best at: established US/EU enterprise, government, financial services, traditional infrastructure, education, defense — anyone who buys OV/EV certs as a matter of policy.

As of 2026-05, the warehouse covers approximately 5,976 organizations across 329,000 org-domain pairs.

### Temporal fields mean "when we observed it"

`first_seen` and `last_seen` reflect when the ctscout warehouse first/last ingested an entry from the CT pipeline. They do NOT mean the original SCT timestamp from the CT log. If you need the actual CT issuance time, query crt.sh or another CT-log search tool directly.

### Attribution confidence

The `org` field is the cert subject text recorded by the CA. We do not independently verify that the named entity currently owns or operates the domain. The cert subject reflects who held the cert at issuance time. Ownership and control can change without a new cert being issued.

When the Pro tier provides a `confidence_band`, it reflects the aggregated multi-signal corroboration (DNS, RDAP, visual brand verification, etc.) at the time of the query. It is not a guarantee, and it is not a substitute for first-party confirmation when the attribution is consequential.

### Brand-namesake collisions

Common-word entity names produce noisy results. A search for "Coalition" returns the IMCTC counter-terrorism coalition, several non-profits, the cyber MGA (often as 0 hits since they're DV-only), and various unrelated orgs. Multi-signal corroboration on the Pro tier helps disambiguate but does not eliminate the issue.

## Corrections and contact

If ctscout returns an attribution you believe is wrong, please open an issue at https://github.com/minghsuy/ctscout-mcp/issues with:
- The domain or company queried
- The result returned
- Why it's wrong (cert subject mismatch, stale data, brand collision, etc.)

For coverage requests (specific entities you want indexed beyond current warehouse), email yminghsun@icloud.com with the entity name and any known apex domains.

## Tier issuance

The free tier is self-serve at https://ctscout.dev — Turnstile-protected, no email or account required, 10 queries per day.

The Pro tier (live multi-signal enrichment, full result set, higher quota) is currently **concierge-only**. Email yminghsun@icloud.com if you want early access; key minting and invoicing are manual until usage data justifies automated commerce.

## License and data

MIT-licensed. See [LICENSE](LICENSE). Data comes exclusively from public CT logs and public RDAP/DNS records; no PII is collected, transmitted, or sold.
