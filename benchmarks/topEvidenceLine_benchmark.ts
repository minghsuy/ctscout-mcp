import { bench, run } from 'mitata';

const EVIDENCE_PRIORITY = [
  "cert_match",
  "dns_txt_brand_token",
  "og_site_name_match",
  "vlm_verdict_verified",
  "rdap_registrant_match",
  "homepage_title_brand_token",
  "ip_asn_custom_org",
  "san_cohort_overlap",
  "vlm_verdict_no",
];

function escapeForTable(s: string) { return s; }

function topEvidenceLineOld(evidence: Record<string, string>): string {
  for (const key of EVIDENCE_PRIORITY) {
    if (key in evidence) {
      return escapeForTable(evidence[key]);
    }
  }
  const keys = Object.keys(evidence);
  if (keys.length === 0) return "_no evidence_";
  return escapeForTable(evidence[keys[0]]);
}

function topEvidenceLineNew(evidence: Record<string, string>): string {
  for (const key of EVIDENCE_PRIORITY) {
    if (key in evidence) {
      return escapeForTable(evidence[key]);
    }
  }
  for (const key in evidence) {
    return escapeForTable(evidence[key]);
  }
  return "_no evidence_";
}

const evidence10 = Object.fromEntries(Array.from({length: 10}, (_, i) => [`other_key_${i}`, "value"]));
const evidence100 = Object.fromEntries(Array.from({length: 100}, (_, i) => [`other_key_${i}`, "value"]));
const evidence1000 = Object.fromEntries(Array.from({length: 1000}, (_, i) => [`other_key_${i}`, "value"]));

const evidenceMatchEarly10 = { ...evidence10, cert_match: "val" };
const evidenceMatchEarly100 = { ...evidence100, cert_match: "val" };
const evidenceMatchEarly1000 = { ...evidence1000, cert_match: "val" };

bench('Old (10 props)', () => { topEvidenceLineOld(evidence10); });
bench('New (10 props)', () => { topEvidenceLineNew(evidence10); });

bench('Old (100 props)', () => { topEvidenceLineOld(evidence100); });
bench('New (100 props)', () => { topEvidenceLineNew(evidence100); });

bench('Old (1000 props)', () => { topEvidenceLineOld(evidence1000); });
bench('New (1000 props)', () => { topEvidenceLineNew(evidence1000); });

bench('Old (Early Match, 1000 props)', () => { topEvidenceLineOld(evidenceMatchEarly1000); });
bench('New (Early Match, 1000 props)', () => { topEvidenceLineNew(evidenceMatchEarly1000); });


await run();
