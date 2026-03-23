#!/usr/bin/env npx tsx
/**
 * Retry lookup for orgs missing specific fields in the output CSV.
 *
 * Usage:
 *   npx tsx pi-company-lookup/retry.ts .work/data_out/orgs.csv
 *   npx tsx pi-company-lookup/retry.ts --field website_url --concurrency 10 orgs.csv
 *   npx tsx pi-company-lookup/retry.ts --field website_url --field phone orgs.csv
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { escapeCsv, parseCsvLine, SEP, BOM, EOL } from "./csv.ts";
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
let file = "";
let fields = ["website_url"];
let concurrency = 5;
let logFile = ".work/run.log";
let modelSpec = "anthropic/claude-sonnet-4-20250514";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--field" && args[i + 1]) {
    if (fields[0] === "website_url" && fields.length === 1) fields = [];
    fields.push(args[++i]);
  } else if (args[i] === "--concurrency" && args[i + 1]) concurrency = parseInt(args[++i]);
  else if (args[i] === "--model" && args[i + 1]) modelSpec = args[++i];
  else if (args[i] === "--log" && args[i + 1]) logFile = args[++i];
  else if (args[i] === "--help" || args[i] === "-h") {
    console.log(`Usage: retry.ts [options] <output.csv>

Re-lookups orgs where specified fields are empty, updates them in-place.

Options:
  --field <name>     Field to check (default: website_url, repeatable)
  --concurrency N    Parallel lookups (default: 5)
  --model P/ID       Model (default: anthropic/claude-sonnet-4-20250514)`);
    process.exit(0);
  } else {
    file = args[i];
  }
}

if (!file) {
  console.error("Error: provide output CSV file. Use --help.");
  process.exit(1);
}

// CSV parsing and escaping imported from ./csv.ts

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
  } catch {
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

  // Verify + strip protocol from URLs
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

function log(entry: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  appendFileSync(logFile, line + "\n");
}

// --- Main ---
async function main() {
  const content = readFileSync(file, "utf-8").replace(/^\uFEFF/, ""); // strip BOM
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0];
  const headerFields = parseCsvLine(header, SEP);
  const rows = lines.slice(1).map((l) => parseCsvLine(l, SEP));

  // Find column indices
  const fieldIndices = fields.map((f) => headerFields.indexOf(f));
  for (let i = 0; i < fields.length; i++) {
    if (fieldIndices[i] === -1) {
      console.error(`Field "${fields[i]}" not found in CSV header: ${headerFields.join(", ")}`);
      process.exit(1);
    }
  }

  const orgNameIdx = headerFields.indexOf("org_name");
  const addressIdx = headerFields.indexOf("address");

  // Find rows missing any of the specified fields
  const missing: { idx: number; row: string[]; query: string }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const needsRetry = fieldIndices.some((fi) => !row[fi]?.trim());
    if (needsRetry) {
      const name = row[orgNameIdx] || "";
      const addr = row[addressIdx] || "";
      const query = addr ? `${name}, ${addr}` : name;
      missing.push({ idx: i, row, query });
    }
  }

  console.error(`${missing.length} orgs missing ${fields.join("/")} out of ${rows.length} total`);
  if (missing.length === 0) {
    console.error("Nothing to retry.");
    process.exit(0);
  }

  mkdirSync(dirname(resolve(logFile)), { recursive: true });
  log({ event: "retry_start", file, fields, missing: missing.length, concurrency, model: modelSpec });

  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);
  const [provider, ...idParts] = modelSpec.split("/");
  const model = modelRegistry.find(provider, idParts.join("/"));
  if (!model) {
    console.error(`Model "${modelSpec}" not found.`);
    process.exit(1);
  }

  let updated = 0;
  let retryDone = 0;

  async function processOne({ idx, row, query }: { idx: number; row: string[]; query: string }) {
    const name = row[orgNameIdx] || query;
    const t0 = Date.now();
    try {
      const data = await lookupOne(query, authStorage, modelRegistry, model);
      retryDone++;
      const ms = Date.now() - t0;

      if (!data) {
        console.error(`  [${retryDone}/${missing.length}] ${name} ✗ no data`);
        log({ event: "retry", query, status: "empty", duration_ms: ms });
        return;
      }

      // Merge: only fill in empty fields from the new lookup
      let changed = false;
      for (let fi = 0; fi < headerFields.length; fi++) {
        const field = headerFields[fi];
        if (!row[fi]?.trim() && data[field] != null && String(data[field]).trim()) {
          row[fi] = String(data[field]);
          changed = true;
        }
      }

      if (changed) {
        rows[idx] = row;
        updated++;
        console.error(`  [${retryDone}/${missing.length}] ${name} ✓ updated`);
        log({ event: "retry", query, status: "updated", confidence: data.confidence, duration_ms: ms });
      } else {
        console.error(`  [${retryDone}/${missing.length}] ${name} – no new data`);
        log({ event: "retry", query, status: "no_change", duration_ms: ms });
      }
    } catch (e: unknown) {
      retryDone++;
      const ms = Date.now() - t0;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  [${retryDone}/${missing.length}] ${name} ✗ error`);
      log({ event: "retry", query, status: "error", error: msg, duration_ms: ms });
    }
  }

  // Sliding window
  const pending = new Set<Promise<void>>();
  for (const item of missing) {
    const p = processOne(item).then(() => { pending.delete(p); });
    pending.add(p);
    if (pending.size >= concurrency) {
      await Promise.race(pending);
    }
  }
  await Promise.all(pending);

  // Write back (Excel-compatible)
  const out = BOM + [
    headerFields.join(SEP),
    ...rows.map((row) => row.map((v) => escapeCsv(v)).join(SEP)),
  ].join(EOL) + EOL;
  writeFileSync(file, out);

  console.error(`\nDone. ${updated}/${missing.length} orgs updated in ${file}`);
  log({ event: "retry_end", updated, total: missing.length, file });
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
