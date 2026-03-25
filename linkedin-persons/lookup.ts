#!/usr/bin/env npx tsx
/**
 * Single LinkedIn org people lookup — scrapes one company's people page,
 * filters by prompt, outputs person records.
 *
 * Usage:
 *   npx tsx linkedin-persons/lookup.ts --org "www.linkedin.com/company/acme" --prompt "decision makers"
 *   npx tsx linkedin-persons/lookup.ts --org "www.linkedin.com/company/acme" --prompt "all" --format csv
 */

import { launchBrowser, closeBrowser, lookupLinkedInPersons, schemaFields } from "./scrape.ts";
import { csvHeader, csvRow } from "../common-lib/csv.ts";
import { createLlmContext } from "../common-lib/llm.ts";
import { createLogger } from "../common-lib/log.ts";

async function main() {
  const args = process.argv.slice(2);
  let orgUrl = "";
  let prompt = "";
  let format = "json";
  let modelSpec = "anthropic/claude-sonnet-4-20250514";
  let maxPages = 5;
  let verbose = true;
  let logFile = ".work/run.log";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--org" && args[i + 1]) orgUrl = args[++i];
    else if (args[i] === "--prompt" && args[i + 1]) prompt = args[++i];
    else if (args[i] === "--format" && args[i + 1]) format = args[++i];
    else if (args[i] === "--model" && args[i + 1]) modelSpec = args[++i];
    else if (args[i] === "--max-pages" && args[i + 1]) maxPages = parseInt(args[++i]);
    else if (args[i] === "--log" && args[i + 1]) logFile = args[++i];
    else if (args[i] === "--quiet" || args[i] === "-q") verbose = false;
    else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`Usage: lookup.ts --org <linkedin-company-url> --prompt <filter> [options]

Scrapes a LinkedIn company's people page, filters persons matching the prompt.

Options:
  --org <url>         LinkedIn company URL (e.g. www.linkedin.com/company/acme)
  --prompt <text>     Filter prompt (e.g. "decision makers in sales") or "all"
  --format json|csv   Output format (default: json)
  --model P/ID        LLM model for filtering (default: anthropic/claude-sonnet-4-20250514)
  --max-pages N       Max pages to scrape (default: 5)
  --quiet, -q         Suppress progress output

Examples:
  lookup.ts --org "www.linkedin.com/company/ablo-gmbh" --prompt "C-level or founders"
  lookup.ts --org "www.linkedin.com/company/ablo-gmbh" --prompt "all" --format csv`);
      process.exit(0);
    }
  }

  if (!orgUrl) { console.error("Error: --org required. Use --help."); process.exit(1); }
  if (!prompt) { console.error("Error: --prompt required. Use --help."); process.exit(1); }

  const slug = orgUrl.match(/company\/([^/]+)/)?.[1] || orgUrl;
  if (verbose) console.error(`LinkedIn People Scraper`);
  if (verbose) console.error(`  Org: ${slug}`);
  if (verbose) console.error(`  Prompt: ${prompt}`);
  if (verbose) console.error(`  Max pages: ${maxPages}`);

  const log = createLogger(logFile, "linkedin-persons");
  log({ event: "lookup_start", linkedin_url: orgUrl, prompt, model: modelSpec, maxPages });

  const t0 = Date.now();
  const context = await launchBrowser();
  const ctx = createLlmContext(modelSpec);

  try {
    const persons = await lookupLinkedInPersons(context, orgUrl, prompt, ctx, maxPages, verbose);
    const ms = Date.now() - t0;

    const status = persons.length > 0 ? `✓ ${persons.length} person(s)` : "✗ no matches";
    if (verbose) console.error(`\n  ${slug} ${status} (${(ms / 1000).toFixed(1)}s)`);
    log({
      event: "lookup",
      linkedin_url: orgUrl,
      status: persons.length > 0 ? "ok" : "empty",
      persons_found: persons.length,
      duration_ms: ms,
    });

    if (format === "csv") {
      process.stdout.write(csvHeader(schemaFields));
      for (const person of persons) {
        process.stdout.write(csvRow(schemaFields, person));
      }
    } else {
      console.log(JSON.stringify(persons, null, 2));
    }
  } finally {
    await closeBrowser();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
