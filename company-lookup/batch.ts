#!/usr/bin/env npx tsx
/**
 * Batch company lookup — reads input CSV, runs lookups in parallel, writes output CSV.
 *
 * Usage:
 *   npx tsx company-lookup/batch.ts --in .work/data_in/orgs.csv --out .work/data_out/orgs.csv
 *   npx tsx company-lookup/batch.ts --in data.csv --out out.csv --concurrency 10
 *   npx tsx company-lookup/batch.ts --in data.csv --out out.csv --model openai/gpt-4o
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { csvHeader, csvRow, csvEmptyRow, parseCsvLine, SEP } from "../common-lib/csv.ts";
import { createLlmContext, llmCall, parseJson, verifyUrl, type LlmContext } from "../common-lib/llm.ts";
import { createLogger } from "../common-lib/log.ts";

const dir = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(resolve(dir, "schema.json"), "utf-8"));
const schemaFields = Object.keys(schema.properties);

const URL_FIELDS = ["website_url", "linkedin_url"];

// --- Args ---
const args = process.argv.slice(2);
let inFile = "";
let outFile = "";
let logFile = ".work/run.log";
let concurrency = 5;
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
  --concurrency N    Parallel lookups (default: 5)
  --model P/ID       Model (default: anthropic/claude-sonnet-4-20250514)
  --log <path>       Log file (default: .work/run.log)

Input: one company per line (name + address as raw text)
Output: CSV file or JSON array`);
    process.exit(0);
  }
}

if (!inFile || !outFile) {
  console.error("Error: --in and --out required. Use --help.");
  process.exit(1);
}

const log = createLogger(logFile, "company-lookup");

// --- Helpers ---
async function lookupOne(query: string, ctx: LlmContext): Promise<Record<string, unknown> | null> {
  const systemPrompt = [
    "You are a company data lookup service.",
    "Return ONLY a raw JSON object matching this schema:",
    JSON.stringify(schema, null, 2),
    "All fields required. Use null for unknowns.",
    "No markdown fences, no explanation, just the JSON.",
  ].join("\n");

  let response: string;
  try {
    response = await llmCall(systemPrompt, `Look up: ${query}`, ctx);
  } catch {
    return null;
  }

  let data: Record<string, unknown>;
  try {
    data = parseJson(response);
  } catch {
    return null;
  }

  // Verify URLs + strip protocol
  await Promise.all(
    URL_FIELDS.filter((f) => data[f] && typeof data[f] === "string").map(async (field) => {
      if (!(await verifyUrl(data[field] as string))) {
        data[field] = null;
      } else {
        data[field] = String(data[field]).replace(/^https?:\/\//, "");
      }
    })
  );

  return data;
}

// --- Main ---
async function main() {
  const lines = readFileSync(inFile, "utf-8").split("\n").filter((l) => l.trim());
  const total = lines.length;
  console.error(`Processing ${total} companies, concurrency=${concurrency}, model=${modelSpec}`);

  log({ event: "batch_start", inFile, outFile, format, total, concurrency, model: modelSpec });

  const ctx = createLlmContext(modelSpec);

  // Resume: read existing org_names from output file
  const doneNames = new Set<string>();

  if (existsSync(outFile)) {
    const existing = readFileSync(outFile, "utf-8").trim();
    if (format === "csv") {
      const csvLines = existing.split("\n").slice(1);
      for (const line of csvLines) {
        if (!line.trim()) continue;
        const fields = parseCsvLine(line, SEP);
        const name = fields[0]?.trim();
        if (name) doneNames.add(name);
      }
    } else {
      try {
        const arr = JSON.parse(existing);
        if (Array.isArray(arr)) {
          for (const obj of arr) {
            if (obj?.org_name) doneNames.add(obj.org_name);
          }
        }
      } catch {
        for (const line of existing.split("\n")) {
          try {
            const obj = JSON.parse(line.replace(/^,/, ""));
            if (obj?.org_name) doneNames.add(obj.org_name);
          } catch { /* skip */ }
        }
      }
    }
    if (doneNames.size > 0) {
      console.error(`Resuming: ${doneNames.size} already done in ${outFile}`);
      log({ event: "resume", alreadyDone: doneNames.size, outFile });
    }
  }

  const remaining = lines.filter((line) => {
    for (const name of doneNames) {
      if (line.startsWith(name) || line.trim().startsWith(name)) return false;
    }
    return true;
  });

  console.error(`${remaining.length} remaining (${doneNames.size} skipped)`);

  // Initialize output file if starting fresh
  if (doneNames.size === 0) {
    mkdirSync(dirname(resolve(outFile)), { recursive: true });
    if (format === "csv") {
      writeFileSync(outFile, csvHeader(schemaFields));
    } else {
      writeFileSync(outFile, "[\n");
    }
  }

  // org_id auto-increment: start after max existing ID
  let nextOrgId = 1;
  if (existsSync(outFile) && format === "csv") {
    const existing = readFileSync(outFile, "utf-8").replace(/^\uFEFF/, "").trim();
    const csvLines = existing.split(/\r?\n/).slice(1);
    const header = parseCsvLine(existing.split(/\r?\n/)[0], SEP);
    const idIdx = header.findIndex(h => h.trim() === "org_id");
    if (idIdx !== -1) {
      for (const line of csvLines) {
        if (!line.trim()) continue;
        const val = parseInt(parseCsvLine(line, SEP)[idIdx]?.trim());
        if (!isNaN(val) && val >= nextOrgId) nextOrgId = val + 1;
      }
    }
  }

  let done = doneNames.size;
  let jsonCount = doneNames.size;

  // Sliding window: as soon as one finishes, next starts
  async function processLine(line: string): Promise<void> {
    const name = line.split(",")[0]?.trim() || line.trim().split(/\s{2,}/)[0] || line.trim();
    const t0 = Date.now();
    let data: Record<string, unknown> | null = null;

    try {
      data = await lookupOne(line.trim(), ctx);
      done++;
      const ms = Date.now() - t0;
      const pct = ((done / total) * 100).toFixed(1);
      const status = data ? `✓ ${data.confidence}` : "✗ failed";
      console.error(`[${done}/${total} ${pct}%] ${name} ${status}`);
      log({
        event: "lookup",
        index: done,
        query: line.trim(),
        status: data ? "ok" : "empty",
        confidence: data?.confidence ?? null,
        website_url: data?.website_url ?? null,
        duration_ms: ms,
      });
    } catch (e: unknown) {
      done++;
      const ms = Date.now() - t0;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[${done}/${total}] ${name} ✗ error`);
      log({ event: "lookup", index: done, query: line.trim(), status: "error", error: msg, duration_ms: ms });
    }

    // Assign org_id
    if (data) {
      data.org_id = nextOrgId++;
    }

    // Write result immediately
    if (format === "csv") {
      const row = data ? csvRow(schemaFields, data) : csvEmptyRow(schemaFields);
      writeFileSync(outFile, row, { flag: "a" });
    } else {
      const obj = data ?? Object.fromEntries(schemaFields.map((f) => [f, null]));
      const prefix = jsonCount > 0 ? ",\n" : "";
      writeFileSync(outFile, prefix + JSON.stringify(obj, null, 2), { flag: "a" });
      jsonCount++;
    }
  }

  // Semaphore-based sliding window
  const pending = new Set<Promise<void>>();
  for (const line of remaining) {
    const p = processLine(line).then(() => { pending.delete(p); });
    pending.add(p);
    if (pending.size >= concurrency) {
      await Promise.race(pending);
    }
  }
  await Promise.all(pending);

  if (format === "json") {
    writeFileSync(outFile, "\n]\n", { flag: "a" });
  }

  console.error(`\nDone. ${done} rows written to ${outFile}`);
  log({ event: "batch_end", total: done, outFile });
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
