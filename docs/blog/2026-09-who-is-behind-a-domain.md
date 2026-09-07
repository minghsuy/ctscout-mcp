# Who is behind a domain? What six months of certificates can and cannot tell you

*Draft for Ming's voice. Numbers are the 2026-09-06 refresh; every one of them is on the [open-data page](https://ctscout.dev/open/) or in the three notes linked below, so a reader can check them.*

I run a small service called [CTScout](https://ctscout.dev). It answers one question: which legal entity stands behind a website domain. This post is about how it answers, how often it is right, and where it is wrong, because the honest version of that is more useful than the pitch.

## How I got here: crt.sh, then a package, then giving up and doing it myself

The public Certificate Transparency logs have had a free front door for years, [crt.sh](https://crt.sh). If you have ever tried to answer a real question with it, you know how the afternoon goes. The web form times out on any organization with more than a few hundred certificates. The trick everyone learns next is the public Postgres endpoint behind it, which works until it doesn't: queries queue behind everyone else's, a search that took two seconds at breakfast takes two minutes at lunch, and a connection that hangs is your problem to detect. I wanted "every domain this company holds certificates for", and getting that for one company was a project; getting it for a list was a week.

So I did what a data scientist does and wrapped the pain in a package. [domain-scout](https://github.com/minghsuy/domain-scout) is a Python tool that queries the crt.sh Postgres directly with a JSON fallback, holds itself to five concurrent queries with a one-second burst delay, then pivots each result through RDAP, DNS and the site's own metadata to corroborate who owns what. It has a rate limiter and a circuit breaker because it needed them. It works, and I still use pieces of it. But every run was still a negotiation with somebody else's database, and the answer was only as complete as the queries that happened not to time out.

The realization was that the logs themselves are a firehose anyone can drink from. Instead of asking crt.sh what it had indexed, I could watch the certificates as they are issued, keep the ones that name an organization, and build my own table. Since February a small collector on a machine under my desk has been doing exactly that: about 2.5 million certificate events a week in, one row per organization-and-domain out, matched against the legal-entity register and served from an edge worker so the answer is a millisecond lookup instead of a query plan. The rest of this post is what that table can and cannot say.

## Where the answer comes from

When a company buys a website certificate and the issuer checks who they are, the company's registered name goes into the certificate. Those certificates are published in the public Certificate Transparency logs, the same logs your browser relies on. Nobody has to opt in; the record is public by design.

CTScout reads those logs, keeps the certificates that name an organization, and matches the name to the legal-entity register (GLEIF, the people who issue LEIs). The result is a table of organization-to-domain pairs. As of this week it holds about 587,000 pairs across 198,000 organizations, from six months of continuous observation.

Nothing is inferred. A pair exists because a certificate naming that organization was logged for that domain.

## How often it is right

I keep a gold set of 22,518 domain-to-LEI pairs from Wikidata, where someone else already recorded which company owns which domain. Scoring against it gives three outcomes, and it matters that there are three, not two:

- **60% of gold domains are absent.** They have no organization-validated certificate at all; they use Let's Encrypt or another free issuer, which names nobody. That is coverage, not error. CTScout cannot see them and does not pretend to.
- **Of the 40% that are present, 58% resolve to exactly the right LEI**, and a further 12% match loosely (the certificate name contains the registered name or the other way round). The product only asserts the exact case.
- **29% of the present pairs name something other than the registered owner.** I decomposed those: most are the owner's own group (a parent or subsidiary got the certificate) or a vendor whose certificate sits on the owner's domain. They are registered-name disagreements, not evidence that a stranger is behind the site.

So the fair one-line summary is: when an organization-validated certificate exists, CTScout puts a name on it that matches the register about six times in ten, and it tells you which of the other cases you are in. The full decomposition is [note 1](https://ctscout.dev/research/who-is-behind-a-domain).

## The part I did not expect: vendors

A domain's certificate is often not the owner's. Salesforce, Adobe and a handful of others hold certificates on tens of thousands of customer domains. Counting certificates would call Adobe the owner of `absa.co.za`, which is wrong.

[Note 2](https://ctscout.dev/research/who-runs-your-website) turns that into a feature. For each candidate vendor I sample its foreign domains and ask public DNS whether the certified address actually points at the vendor's own servers while the domain plainly belongs to someone else. Ten vendors pass the bar; per vendor, the DNS check confirms between 30% and 98% of the sample (Criteo 59 of 60, Yahoo 21 of 38). [Note 3](https://ctscout.dev/research/who-uses-what) then profiles their customers: 55,288 customer domains, 5,924 of them resolved to a legal entity, with country and co-use tables.

That is the closest thing CTScout has to a product nobody else sells: which vendors run which organizations' sites, confirmed by DNS and keyed to an LEI.

## What it is not

It is not a risk score. It does not know who operates a server, only who asked for the certificate. It is blind to the free-certificate half of the web. Its name matching has a published rule and a measured error, and a name that matches nothing stays unmatched rather than being guessed. The [limitations file](https://github.com/minghsuy/ctscout-mcp/blob/main/LIMITATIONS.md) is longer than this section, on purpose.

## How to use it

- **A person:** type a company name on [ctscout.dev](https://ctscout.dev) and you get its answer page, no key. There is one page per organization, 37,940 of them, and one per confirmed vendor.
- **An agent:** the same data is an MCP server. Point Claude Code, Claude Desktop or Cursor at `https://ctscout.dev/mcp` with a free key from the front page and ask "who is behind gs.com". The [reference](https://ctscout.dev/docs/) has the config.
- **A researcher:** the three notes and every JSON they are built from are public, with snapshot dates on every file.

The free tier is ten lookups a day. Pro is $49 a month for 3,000. As of today there are zero paying customers, sixteen active keys, and the two Pro keys are mine. Those numbers stay on the [open-data page](https://ctscout.dev/open/) whether they go up or not.

If you use it and something is wrong, that is the most useful thing you can tell me: pro@ctscout.dev.
