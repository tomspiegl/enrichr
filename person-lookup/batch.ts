#!/usr/bin/env npx tsx
/**
 * Batch person lookup — reads input CSV (e.g. company-batch output) or plain text,
 * crawls each website, extracts persons, writes output CSV or JSON.
 *
 * Input can be:
 *   - company-batch output CSV (auto-detects website_url column)
 *   - any CSV with a website_url / website / url / domain column
 *   - plain text with one website per line
 *
 * Usage:
 *   npx tsx person-lookup/batch.ts --in .work/data_out/orgs.csv --out persons.csv
 *   npx tsx person-lookup/batch.ts --in websites.txt --out persons.csv
 *   npx tsx person-lookup/batch.ts --in orgs.csv --out persons.csv --concurrency 3
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { csvHeader, csvRow, csvEmptyRow, parseCsvLine, SEP } from "../common-lib/csv.ts";
import { createLlmContext } from "../common-lib/llm.ts";
import { lookupPersons, lastDiagnostics } from "./lookup.ts";

const dir = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(resolve(dir, "schema.json"), "utf-8"));
const schemaFields = Object.keys(schema.properties);

// --- Args ---
const args = process.argv.slice(2);
let inFile = "";
let outFile = "";
let logFile = ".work/run.log";
let concurrency = 3;
let format = "csv";
let modelSpec = "anthropic/claude-sonnet-4-20250514";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--in" && args[i + 1]) inFile = args[++i];
  else if (args[i] === "--out" && args[i + 1]) outFile = args[++i];
  else if (args[i] === "--log" && args[i + 1]) logFile = args[++i];
  else if (args[i] === "--concurrency" && args[i + 1]) concurrency = parseInt(args[++i]);
  else if (args[i] === "--format" && args[i + 1]) format = args[++i];
  else if (args[i] === "--model" && args[i + 1]) modelSpec = args[++i];
  else if (args[i] === "--help" || args[i] === "-h") {
    console.log(`Usage: batch.ts --in <input> --out <output> [options]

Options:
  --format csv|json  Output format (default: csv)
  --concurrency N    Parallel website crawls (default: 3)
  --model P/ID       Model (default: anthropic/claude-sonnet-4-20250514)
  --log <path>       Log file (default: .work/run.log)

Input: CSV with website_url column (e.g. company-batch output), or plain text (one URL per line)
Output: CSV or JSON with one row per person found

Typical workflow:
  just company-batch --in orgs.csv --out .work/data_out/orgs.csv
  just person-batch --in .work/data_out/orgs.csv --out .work/data_out/persons.csv`);
    process.exit(0);
  }
}

if (!inFile || !outFile) {
  console.error("Error: --in and --out required. Use --help.");
  process.exit(1);
}

// --- Logging ---
import { createLogger } from "../common-lib/log.ts";

let log: ReturnType<typeof createLogger>;

// --- Main ---
async function main() {
  const raw = readFileSync(inFile, "utf-8").replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

  // Handle CSV input: detect header with website column (works with company-batch output)
  // Support both semicolon (our output) and comma (common CSV) separators
  let websites: string[];
  const firstLine = lines[0] || "";
  const detectedSep = firstLine.includes(SEP) ? SEP : firstLine.includes(",") ? "," : null;

  if (detectedSep) {
    const header = parseCsvLine(firstLine, detectedSep).map((h) => h.trim().toLowerCase());
    // Match: website_url, website, url, domain
    const urlIdx = header.findIndex((h) =>
      h === "website_url" || h === "website" || h === "url" || h === "domain"
    );
    if (urlIdx !== -1) {
      console.error(`Detected CSV (sep='${detectedSep === "," ? "," : ";"}') with '${header[urlIdx]}' column (index ${urlIdx})`);
      websites = lines.slice(1)
        .map((l) => parseCsvLine(l, detectedSep)[urlIdx]?.trim())
        .filter((w) => w && w.length > 0 && w.toLowerCase() !== "null");
    } else {
      // CSV but no matching header — treat first column as URL
      websites = lines.map((l) => parseCsvLine(l, detectedSep)[0]?.trim()).filter((w) => w && w.length > 0);
    }
  } else {
    // Plain text: one URL per line
    websites = lines.filter((l) => l.length > 0 && l.toLowerCase() !== "null");
  }

  // Deduplicate, validate URLs, filter obvious non-URLs
  websites = [...new Set(websites)].filter((w) => {
    if (w.startsWith("-") || w.startsWith("/") || !w.includes(".")) return false;
    try {
      new URL(w.startsWith("http") ? w : `https://${w}`);
      return true;
    } catch {
      console.error(`Skipping invalid URL: ${w}`);
      return false;
    }
  });

  const total = websites.length;
  console.error(`Processing ${total} websites, concurrency=${concurrency}, model=${modelSpec}`);

  log = createLogger(logFile, "person-lookup");
  log({ event: "batch_start", inFile, outFile, format, total, concurrency, model: modelSpec });

  const ctx = createLlmContext(modelSpec);

  // Resume: read existing website_urls from output
  const doneUrls = new Set<string>();
  if (existsSync(outFile)) {
    const existing = readFileSync(outFile, "utf-8").replace(/^\uFEFF/, "").trim();
    if (format === "csv" && existing) {
      const csvLines = existing.split(/\r?\n/).slice(1);
      for (const line of csvLines) {
        if (!line.trim()) continue;
        const fields = parseCsvLine(line, SEP);
        const url = fields[0]?.trim();
        if (url) doneUrls.add(url);
      }
    } else if (format === "json" && existing) {
      try {
        const arr = JSON.parse(existing);
        if (Array.isArray(arr)) {
          for (const obj of arr) {
            if (obj?.website_url) doneUrls.add(obj.website_url);
          }
        }
      } catch { /* incomplete */ }
    }
    if (doneUrls.size > 0) {
      console.error(`Resuming: ${doneUrls.size} website(s) already done`);
      log({ event: "resume", alreadyDone: doneUrls.size });
    }
  }

  const remaining = websites.filter((w) => {
    const norm = w.replace(/^https?:\/\//, "");
    return !doneUrls.has(norm) && !doneUrls.has(`www.${norm}`) && !doneUrls.has(norm.replace(/^www\./, ""));
  });

  console.error(`${remaining.length} remaining (${websites.length - remaining.length} skipped)`);

  // Initialize output
  if (doneUrls.size === 0) {
    mkdirSync(dirname(resolve(outFile)), { recursive: true });
    if (format === "csv") {
      writeFileSync(outFile, csvHeader(schemaFields));
    } else {
      writeFileSync(outFile, "[\n");
    }
  }

  let done = websites.length - remaining.length;
  let jsonCount = doneUrls.size;
  let totalPersons = 0;

  async function processWebsite(website: string): Promise<void> {
    const t0 = Date.now();
    try {
      const persons = await lookupPersons(website, ctx, false);
      done++;
      const ms = Date.now() - t0;
      const pct = ((done / total) * 100).toFixed(1);
      totalPersons += persons.length;
      console.error(`[${done}/${total} ${pct}%] ${website} → ${persons.length} person(s) (${ms}ms)`);
      const d = lastDiagnostics;
      log({
        event: "lookup",
        index: done,
        website,
        status: "ok",
        persons_found: persons.length,
        duration_ms: ms,
        homepage_links: d?.homepageLinks ?? null,
        candidate_pages: d?.candidatePages ?? null,
        fetched_pages: d?.fetchedPages ?? null,
        used_playwright: d?.usedPlaywright ?? false,
      });

      // Write results
      if (format === "csv") {
        if (persons.length === 0) {
          const empty: Record<string, unknown> = { website_url: website };
          appendFileSync(outFile, csvRow(schemaFields, empty));
        } else {
          for (const person of persons) {
            appendFileSync(outFile, csvRow(schemaFields, person));
          }
        }
      } else {
        for (const person of persons) {
          const prefix = jsonCount > 0 ? ",\n" : "";
          appendFileSync(outFile, prefix + JSON.stringify(person, null, 2));
          jsonCount++;
        }
      }
    } catch (e: unknown) {
      done++;
      const ms = Date.now() - t0;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[${done}/${total}] ${website} ✗ error: ${msg}`);
      log({ event: "lookup", index: done, website, status: "error", error: msg, duration_ms: ms });

      if (format === "csv") {
        const empty: Record<string, unknown> = { website_url: website };
        appendFileSync(outFile, csvRow(schemaFields, empty));
      }
    }
  }

  // Sliding window concurrency
  const pending = new Set<Promise<void>>();
  for (const website of remaining) {
    const p = processWebsite(website).then(() => { pending.delete(p); });
    pending.add(p);
    if (pending.size >= concurrency) {
      await Promise.race(pending);
    }
  }
  await Promise.all(pending);

  // Close JSON array
  if (format === "json") {
    appendFileSync(outFile, "\n]\n");
  }

  console.error(`\nDone. ${done} websites processed, ${totalPersons} persons found → ${outFile}`);
  log({ event: "batch_end", total: done, totalPersons, outFile });
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
