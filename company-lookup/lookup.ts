#!/usr/bin/env npx tsx
/**
 * Fast CLI lookup — uses pi SDK for auth, single process, single API call.
 *
 * Usage:
 *   npx tsx company-lookup/lookup.ts "Acme GmbH, Wien"
 *   npx tsx company-lookup/lookup.ts --format csv "Acme GmbH, Wien"
 *   npx tsx company-lookup/lookup.ts --model anthropic/claude-sonnet-4-20250514 "Acme GmbH"
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { escapeCsv, SEP, BOM, EOL } from "../common-lib/csv.ts";
import { createLlmContext, llmCall, parseJson, verifyUrl } from "../common-lib/llm.ts";

async function main() {
  // --- Parse args ---
  const args = process.argv.slice(2);
  let format = "json";
  let modelSpec = "anthropic/claude-sonnet-4-20250514";
  const queryParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--format" && args[i + 1]) {
      format = args[++i];
    } else if (args[i] === "--model" && args[i + 1]) {
      modelSpec = args[++i];
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`Usage: lookup.ts [--model provider/id] [--format json|csv] <query>

Uses your pi login (OAuth) for authentication. No API key needed.

Examples:
  lookup.ts "Acme GmbH, Wien"
  lookup.ts --format csv "Acme AG, Graz"
  lookup.ts --model openai/gpt-4o "Acme Corp"`);
      process.exit(0);
    } else {
      queryParts.push(args[i]);
    }
  }

  const query = queryParts.join(" ");
  if (!query) {
    console.error("Error: no company query. Use --help for usage.");
    process.exit(1);
  }

  // --- Load schema ---
  const dir = dirname(fileURLToPath(import.meta.url));
  const schema = JSON.parse(readFileSync(resolve(dir, "schema.json"), "utf-8"));

  // --- LLM call ---
  const ctx = createLlmContext(modelSpec);

  const systemPrompt = [
    "You are a company data lookup service.",
    "Return ONLY a raw JSON object matching this schema:",
    JSON.stringify(schema, null, 2),
    "All fields required. Use null for unknowns.",
    "No markdown fences, no explanation, just the JSON.",
  ].join("\n");

  const response = await llmCall(systemPrompt, `Look up: ${query}`, ctx);

  let data: Record<string, unknown>;
  try {
    data = parseJson(response);
  } catch {
    console.error("Failed to parse response:", response);
    process.exit(1);
  }

  // --- Verify URLs ---
  const URL_FIELDS = ["website_url", "linkedin_url"];
  await Promise.all(
    URL_FIELDS.filter((f) => data[f] && typeof data[f] === "string").map(async (field) => {
      if (!(await verifyUrl(data[field] as string))) {
        data[field] = null;
      } else {
        data[field] = String(data[field]).replace(/^https?:\/\//, "");
      }
    })
  );

  // --- Output ---
  if (format === "csv") {
    const keys = Object.keys(data);
    process.stdout.write(BOM + keys.join(SEP) + EOL);
    process.stdout.write(keys.map((k) => escapeCsv(data[k])).join(SEP) + EOL);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
