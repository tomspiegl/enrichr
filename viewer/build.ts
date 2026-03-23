#!/usr/bin/env npx tsx
/**
 * Builds a self-contained HTML viewer with embedded CSV data.
 * Prompts for file paths interactively, press Enter for defaults.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

const DEFAULTS = {
  orgs: ".work/data_out/orgs.csv",
  persons: ".work/data_out/persons.csv",
  template: "viewer/viewer.html",
  out: ".work/data_out/viewer.html",
};

async function ask(prompt: string, def: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`${prompt} [${def}]: `, (answer) => {
      rl.close();
      resolve(answer.trim() || def);
    });
  });
}

async function main() {
  // Check for --non-interactive or piped args
  const args = process.argv.slice(2);
  let orgsFile = DEFAULTS.orgs;
  let personsFile = DEFAULTS.persons;
  let templateFile = DEFAULTS.template;
  let outFile = DEFAULTS.out;

  if (args.length > 0) {
    // CLI mode: parse flags
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--orgs" && args[i + 1]) orgsFile = args[++i];
      else if (args[i] === "--persons" && args[i + 1]) personsFile = args[++i];
      else if (args[i] === "--template" && args[i + 1]) templateFile = args[++i];
      else if (args[i] === "--out" && args[i + 1]) outFile = args[++i];
    }
  } else {
    // Interactive mode: prompt with defaults
    orgsFile = await ask("Organizations CSV", DEFAULTS.orgs);
    personsFile = await ask("Persons CSV", DEFAULTS.persons);
    outFile = await ask("Output HTML", DEFAULTS.out);
  }

  // Validate inputs
  if (!existsSync(orgsFile)) { console.error(`File not found: ${orgsFile}`); process.exit(1); }
  if (!existsSync(personsFile)) { console.error(`File not found: ${personsFile}`); process.exit(1); }
  if (!existsSync(templateFile)) { console.error(`Template not found: ${templateFile}`); process.exit(1); }

  const orgsText = readFileSync(orgsFile, "utf-8");
  const personsText = readFileSync(personsFile, "utf-8");
  const template = readFileSync(templateFile, "utf-8");

  const BEGIN_MARKER = '<!--ENRICHR_DATA_BEGIN-->';
  const END_MARKER = '<!--ENRICHR_DATA_END-->';
  const dataBlock = `${BEGIN_MARKER}
<script>
const EMBEDDED_ORGS_CSV = ${JSON.stringify(orgsText)};
const EMBEDDED_PERSONS_CSV = ${JSON.stringify(personsText)};
</script>
${END_MARKER}`;

  const markerRe = new RegExp(BEGIN_MARKER + '[\\s\\S]*?' + END_MARKER, 'g');
  const cleanTemplate = template.replace(markerRe, '');
  const html = cleanTemplate.replace("</head>", `${dataBlock}\n</head>`);

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, html);

  const sizeMb = (Buffer.byteLength(html) / 1024 / 1024).toFixed(1);
  const orgLines = orgsText.split("\n").length - 1;
  const personLines = personsText.split("\n").length - 1;
  console.log(`Built ${outFile} (${sizeMb} MB) with ${orgLines} orgs + ${personLines} persons`);
}

main();
