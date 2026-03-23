#!/usr/bin/env npx tsx
/**
 * Builds a self-contained HTML viewer with embedded CSV data.
 *
 * Usage:
 *   npx tsx viewer/build.ts --orgs .work/data_out/orgs.csv --persons .work/data_out/persons.csv --out .work/data_out/viewer.html
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);
let orgsFile = ".work/data_out/orgs.csv";
let personsFile = ".work/data_out/persons.csv";
let templateFile = "viewer.html";
let outFile = "viewer.html";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--orgs" && args[i + 1]) orgsFile = args[++i];
  else if (args[i] === "--persons" && args[i + 1]) personsFile = args[++i];
  else if (args[i] === "--template" && args[i + 1]) templateFile = args[++i];
  else if (args[i] === "--out" && args[i + 1]) outFile = args[++i];
}

const orgsText = readFileSync(orgsFile, "utf-8");
const personsText = readFileSync(personsFile, "utf-8");
const template = readFileSync(templateFile, "utf-8");

// JSON.stringify handles all Unicode escaping correctly
const BEGIN_MARKER = '<!--ENRICHR_DATA_BEGIN-->';
const END_MARKER = '<!--ENRICHR_DATA_END-->';
const dataBlock = `${BEGIN_MARKER}
<script>
const EMBEDDED_ORGS_CSV = ${JSON.stringify(orgsText)};
const EMBEDDED_PERSONS_CSV = ${JSON.stringify(personsText)};
</script>
${END_MARKER}`;

// Strip any previously embedded data (when template = output file)
const markerRe = new RegExp(BEGIN_MARKER + '[\\s\\S]*?' + END_MARKER, 'g');
const cleanTemplate = template.replace(markerRe, '');
const html = cleanTemplate.replace("</head>", `${dataBlock}\n</head>`);

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, html);

const sizeMb = (Buffer.byteLength(html) / 1024 / 1024).toFixed(1);
const orgLines = orgsText.split("\n").length - 1;
const personLines = personsText.split("\n").length - 1;
console.log(`Built ${outFile} (${sizeMb} MB) with ${orgLines} orgs + ${personLines} persons`);
