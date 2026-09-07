# Who is behind a domain? What six months of certificates can and cannot tell you

I run a small service called [CTScout](https://ctscout.dev). It started as an attempt to answer one question, which legal entity stands behind a website domain, and it ended up answering a more careful one: which organization is named in the certificate evidence for a domain, and when that name can be tied to a legal entity. The gap between those two questions is the interesting part, and it is where a second dataset turned up that I had not gone looking for. This post is about how the measurement works, how often it means what it says, and where it does not.

## How I got here: crt.sh, then a package, then giving up and doing it myself

The public Certificate Transparency logs have had a free front door for years, [crt.sh](https://crt.sh). If you have ever tried to answer a real question with it, you know how the afternoon goes. The web form times out on any organization with more than a few hundred certificates. The trick everyone learns next is the public Postgres endpoint behind it, which works until it doesn't: queries queue behind everyone else's, a search that took two seconds at breakfast takes two minutes at lunch, and a connection that hangs is your problem to detect. I wanted "every domain this company holds certificates for", and getting that for one company was a project; getting it for a list was a week.

So I did what a data scientist does and wrapped the pain in a package. [domain-scout](https://github.com/minghsuy/domain-scout) is a Python tool that queries the crt.sh Postgres directly with a JSON fallback, holds itself to five concurrent queries with a one-second burst delay, then pivots each result through RDAP, DNS and the site's own metadata to corroborate who owns what. It has a rate limiter and a circuit breaker because it needed them. It works, and I still use pieces of it. But every run was still a negotiation with somebody else's database, and the answer was only as complete as the queries that happened not to time out.

The realization was that the logs themselves are a firehose anyone can drink from. Instead of asking crt.sh what it had indexed, I could watch the certificates as they are issued, keep the ones that name an organization, and build my own table. Since February a small collector on a machine under my desk has been doing exactly that: about 2.5 million certificate events a week in, one row per organization-and-domain out, matched against the legal-entity register and served from an edge worker so the answer is a millisecond lookup instead of a query plan. The rest of this post is what that table can and cannot say.

## Where the evidence comes from

When a company obtains an organization-validated certificate, the issuer checks that the organization exists and writes its registered name into the certificate. Those certificates are published in the public Certificate Transparency logs, the same logs your browser relies on. Nobody has to opt in; the record is public by design. A domain-validated certificate, the kind Let's Encrypt and ZeroSSL issue for free, names nobody, and CTScout does not see it.

CTScout reads the logs, keeps the certificates that name an organization, and matches the name to the legal-entity register (GLEIF, the people who issue LEIs). The result is a table of organization-to-domain pairs. As of this week it holds about 587,000 pairs across 198,000 organization names, from six months of continuous observation.

Nothing is inferred. A pair exists because a certificate naming that organization was logged for that domain. What the pair does not say, on its own, is that the organization owns the domain. Keep that in mind; it comes back.

## What the validation actually measures

There are two different questions here, and I want to keep them apart because it is easy to walk away with one number that answers neither.

**Can a certificate name be tied to one legal entity?** Of the 198,346 organization names seen in certificates, 44,436, or 22 percent, resolve to exactly one LEI under the published rule: 42,133 by an exact registered-name match, 2,303 by a close match above a threshold I checked by hand. The other 78 percent are left unresolved rather than guessed: names that match several entities, names that match none, names that are brands rather than legal names. A name that cannot be tied to one entity does not get one.

**When the owner of a site is known, does the certificate name agree?** For this I keep a gold set of 22,518 domain-to-LEI pairs from Wikidata, where someone else already recorded which company owns which domain. Scoring against it gives three outcomes, and it matters that there are three:

- **60 percent of the gold domains are absent.** No organization-validated certificate was observed for them; most such sites use domain-validated certificates only. That is coverage, not error. CTScout cannot see them and says so.
- **Of the 9,010 that are present, 58 percent carry the owner's registered name exactly**, and a further 12 percent carry a name that contains it or is contained by it. The product asserts only the exact case; the containment case is reported as weaker evidence and never used to assign an LEI.
- **29 percent of the present pairs name something other than the registered owner.** I decomposed those, and most are the owner's own group, a parent or subsidiary that obtained the certificate, or a vendor whose certificate sits on the owner's domain. They are registered-name disagreements, not evidence that a stranger is behind the site.

So the fair summary is: CTScout sees the organization-validated part of the web, which is a minority of it; within that part, the certificate name is the registered owner's exact name about six times in ten, and the tool tells you which of the other cases you are in rather than picking one. The full decomposition is [note 1](https://ctscout.dev/research/who-is-behind-a-domain).

## The failures contained another dataset

A domain's certificate is often not the owner's. That third bucket, the certificate that names someone else, is where the project changed. When the "someone else" is Salesforce, Adobe or Microsoft, it is not a resolution failure; it is a vendor running the customer's site, and the certificate is a record of that relationship. Counting certificates naively would call Adobe the owner of `absa.co.za`, which is wrong, but reading the same row as "Adobe runs something on ABSA's domain" is right, and useful.

[Note 2](https://ctscout.dev/research/who-runs-your-website) turns that into a measurement. For each candidate vendor I take the domains that carry its certificate but not its brand, sample them, and ask public DNS whether the certified address actually points at the vendor's own servers while the domain plainly belongs to someone else. Ten vendors pass the bar. The precision is measured per vendor on the sample, not per domain: Criteo 59 of 60, Adobe 54 of 58, Microsoft 39 of 43, Salesforce 52 of 58, CDNetworks 12 of 40. The candidate footprints are large, Microsoft 22,869 domains, Salesforce 20,949, Adobe 5,334, and the sample precision is the honest estimate of how much of each footprint is real customers.

[Note 3](https://ctscout.dev/research/who-uses-what) then profiles the candidates: 55,288 customer domains across the ten vendors, of which 5,924 can be tied to one legal entity because a second certificate on the same domain names the owner. Those are the rows with an LEI on them, with country and co-use tables around them.

That combination, vendor relationships validated by DNS sampling and resolved to legal entities where independent owner evidence exists, is the most differentiated dataset I have found in this work. Technographics vendors sell "who uses Salesforce" lists; none I know of key them to a legal-entity register or publish the precision they were measured at.

## What it is not

It is not a risk score. It does not know who operates a server, only who obtained the certificate. It is blind to the domain-validated majority of the web. Its name matching has a published rule and a measured error, and a name that matches nothing stays unmatched rather than being guessed. The [limitations file](https://github.com/minghsuy/ctscout-mcp/blob/main/LIMITATIONS.md) is longer than this section, on purpose.

## How to use it

- **A person:** type a company name on [ctscout.dev](https://ctscout.dev) and you get its answer page, no key. There is one page per resolved organization, 37,940 of them, and one per confirmed vendor.
- **An agent:** the same data is an MCP server. Point Claude Code, Claude Desktop or Cursor at `https://ctscout.dev/mcp` with a free key from the front page and ask "who is behind gs.com". The [reference](https://ctscout.dev/docs/) has the config.
- **A researcher:** the three notes and every JSON they are built from are public, with snapshot dates on every file.

The free tier is ten successful lookups a day. Pro is $49 a month for 3,000. As of today there are zero paying customers, sixteen active keys, and the two Pro keys are mine. Those numbers stay on the [open-data page](https://ctscout.dev/open/) whether they go up or not.

If you use it and something is wrong, that is the most useful thing you can tell me: pro@ctscout.dev.
