#!/usr/bin/env npx tsx
/**
 * Batch company lookup — reads input CSV, runs lookups in parallel, writes output CSV.
 *
 * Usage:
 *   npx tsx pi-company-lookup/batch.ts --in .work/data_in/orgs.csv --out .work/data_out/orgs.csv
 *   npx tsx pi-company-lookup/batch.ts --in data.csv --out out.csv --concurrency 10
 *   npx tsx pi-company-lookup/batch.ts --in data.csv --out out.csv --model openai/gpt-4o
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { csvHeader, csvRow, csvEmptyRow, parseCsvLine, SEP } from "./csv.ts";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";

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

// --- Logging ---
function log(entry: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  appendFileSync(logFile, line + "\n");
}

if (!inFile || !outFile) {
  console.error("Error: --in and --out required. Use --help.");
  process.exit(1);
}

// --- Helpers ---
async function verifyUrl(url: string): Promise<boolean> {
  const fullUrl = url.startsWith("http") ? url : `https://${url}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(fullUrl, { method: "HEAD", redirect: "follow", signal: ctrl.signal });
    clearTimeout(timer);
    return res.status < 400;
  } catch {
    return false;
  }
}

async function lookupOne(
  query: string,
  authStorage: AuthStorage,
  modelRegistry: ModelRegistry,
  model: any
): Promise<Record<string, unknown> | null> {
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    settingsManager: SettingsManager.inMemory(),
    disableExtensions: true,
    disableSkills: true,
    disablePromptTemplates: true,
    disableThemes: true,
    disableAgentsFiles: true,
    systemPromptOverride: () => [
      "You are a company data lookup service.",
      "Return ONLY a raw JSON object matching this schema:",
      JSON.stringify(schema, null, 2),
      "All fields required. Use null for unknowns.",
      "No markdown fences, no explanation, just the JSON.",
    ].join("\n"),
  });
  await loader.reload();

  const { session } = await createAgentSession({
    model,
    thinkingLevel: "off",
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
    resourceLoader: loader,
    tools: [],
  });

  let response = "";
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      response += event.assistantMessageEvent.delta;
    }
  });

  try {
    await session.prompt(`Look up: ${query}`);
  } catch (e) {
    session.dispose();
    return null;
  }
  session.dispose();

  let jsonStr = response.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(jsonStr);
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

  mkdirSync(dirname(resolve(logFile)), { recursive: true });
  log({ event: "batch_start", inFile, outFile, format, total, concurrency, model: modelSpec });

  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);
  const [provider, ...idParts] = modelSpec.split("/");
  const model = modelRegistry.find(provider, idParts.join("/"));
  if (!model) {
    console.error(`Model "${modelSpec}" not found.`);
    process.exit(1);
  }

  // Resume: read existing org_names from output file
  const doneNames = new Set<string>();

  if (existsSync(outFile)) {
    const existing = readFileSync(outFile, "utf-8").trim();
    if (format === "csv") {
      // Parse CSV (semicolon-separated): org_name is first column after header
      const csvLines = existing.split("\n").slice(1); // skip header
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
        // Incomplete JSON array (interrupted) — parse line by line
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

  // Filter to only lines not yet processed
  const remaining = lines.filter((line) => {
    // Try to match input line against done org_names
    // Input is freeform text, so check if any done name is a prefix of the line
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

  // Process in batches
  let done = doneNames.size;
  let jsonCount = doneNames.size;

  // Sliding window: as soon as one finishes, next starts
  async function processLine(line: string): Promise<void> {
    const name = line.split(",")[0]?.trim() || line.trim().split(/\s{2,}/)[0] || line.trim();
    const t0 = Date.now();
    let data: Record<string, unknown> | null = null;

    try {
      data = await lookupOne(line.trim(), authStorage, modelRegistry, model);
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

  // Close JSON array
  if (format === "json") {
    writeFileSync(outFile, "\n]\n", { flag: "a" });
  }

  console.error(`\nDone. ${done} rows written to ${outFile}`);
  log({ event: "batch_end", total: done, outFile, logFile });
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
