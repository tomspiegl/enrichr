#!/usr/bin/env npx tsx
/**
 * One-time migration: adds org_id to orgs.csv and person_id + org_id to persons.csv.
 * Backs up originals as *.bak before overwriting.
 *
 * Usage:
 *   npx tsx scripts/migrate-add-ids.ts [--orgs path] [--persons path]
 */

import { readFileSync, writeFileSync, copyFileSync } from "node:fs";

const SEP = ";";
const BOM = "\uFEFF";
const EOL = "\r\n";

function parseLine(line: string): string[] {
  const f: string[] = [];
  let c = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { c += '"'; i++; }
      else if (ch === '"') q = false;
      else c += ch;
    } else if (ch === '"') q = true;
    else if (ch === SEP) { f.push(c); c = ""; }
    else if (ch !== "\r") c += ch;
  }
  f.push(c);
  return f;
}

function escapeCsv(v: string): string {
  if (!v) return "";
  if (v.includes(SEP) || v.includes('"') || v.includes("\n")) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

// --- Args ---
const args = process.argv.slice(2);
let orgsFile = ".work/data_out/orgs.csv";
let personsFile = ".work/data_out/persons.csv";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--orgs" && args[i + 1]) orgsFile = args[++i];
  else if (args[i] === "--persons" && args[i + 1]) personsFile = args[++i];
}

// --- Read orgs ---
const orgsRaw = readFileSync(orgsFile, "utf-8").replace(/^\uFEFF/, "");
const orgsLines = orgsRaw.split(/\r?\n/).filter(l => l.trim());
const orgsHeader = parseLine(orgsLines[0]);

if (orgsHeader.includes("org_id")) {
  console.error("orgs.csv already has org_id — skipping org migration");
} else {
  console.error(`Migrating ${orgsFile}: adding org_id to ${orgsLines.length - 1} rows`);
  copyFileSync(orgsFile, orgsFile + ".bak");

  const newHeader = ["org_id", ...orgsHeader];
  let out = BOM + newHeader.map(escapeCsv).join(SEP) + EOL;

  for (let i = 1; i < orgsLines.length; i++) {
    const fields = parseLine(orgsLines[i]);
    const orgId = String(i);
    out += [orgId, ...fields.map(escapeCsv)].join(SEP) + EOL;
  }

  writeFileSync(orgsFile, out);
  console.error(`  Written ${orgsLines.length - 1} orgs with org_id 1..${orgsLines.length - 1}`);
}

// --- Build website_url → org_id map from (possibly updated) orgs ---
const orgsRaw2 = readFileSync(orgsFile, "utf-8").replace(/^\uFEFF/, "");
const orgsLines2 = orgsRaw2.split(/\r?\n/).filter(l => l.trim());
const orgsHeader2 = parseLine(orgsLines2[0]);
const orgIdIdx = orgsHeader2.indexOf("org_id");
const orgUrlIdx = orgsHeader2.indexOf("website_url");

const urlToOrgId = new Map<string, string>();
for (let i = 1; i < orgsLines2.length; i++) {
  const fields = parseLine(orgsLines2[i]);
  const url = fields[orgUrlIdx]?.trim();
  const id = fields[orgIdIdx]?.trim();
  if (url && id) {
    urlToOrgId.set(url, id);
    // Also map without www. prefix
    urlToOrgId.set(url.replace(/^www\./, ""), id);
  }
}

console.error(`  Built org_id map: ${urlToOrgId.size / 2} orgs with website_url`);

// --- Read persons ---
const personsRaw = readFileSync(personsFile, "utf-8").replace(/^\uFEFF/, "");
const personsLines = personsRaw.split(/\r?\n/).filter(l => l.trim());
const personsHeader = parseLine(personsLines[0]);

if (personsHeader.includes("person_id")) {
  console.error("persons.csv already has person_id — skipping person migration");
} else {
  console.error(`Migrating ${personsFile}: adding person_id + org_id to ${personsLines.length - 1} rows`);
  copyFileSync(personsFile, personsFile + ".bak");

  const pUrlIdx = personsHeader.indexOf("website_url");
  const newHeader = ["person_id", "org_id", ...personsHeader];
  let out = BOM + newHeader.map(escapeCsv).join(SEP) + EOL;

  for (let i = 1; i < personsLines.length; i++) {
    const fields = parseLine(personsLines[i]);
    const personId = String(i);
    const websiteUrl = fields[pUrlIdx]?.trim() || "";
    const orgId = urlToOrgId.get(websiteUrl) || urlToOrgId.get(websiteUrl.replace(/^www\./, "")) || "";
    out += [personId, orgId, ...fields.map(escapeCsv)].join(SEP) + EOL;
  }

  writeFileSync(personsFile, out);
  console.error(`  Written ${personsLines.length - 1} persons with person_id 1..${personsLines.length - 1}`);
}

console.error("Done.");
