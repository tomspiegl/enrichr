#!/usr/bin/env npx tsx
/**
 * Fast CLI lookup — uses pi SDK for auth, single process, single API call.
 *
 * Usage:
 *   npx tsx pi-company-lookup/lookup.ts "Acme GmbH, Wien"
 *   npx tsx pi-company-lookup/lookup.ts --format csv "Acme GmbH, Wien"
 *   npx tsx pi-company-lookup/lookup.ts --model anthropic/claude-sonnet-4-20250514 "Acme GmbH"
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { escapeCsv, SEP, BOM, EOL } from "./csv.ts";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";

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

  // --- Resolve model (uses pi's auth: OAuth, API keys, env vars) ---
  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);

  const [provider, ...idParts] = modelSpec.split("/");
  const modelId = idParts.join("/");
  const model = modelRegistry.find(provider, modelId);

  if (!model) {
    const available = await modelRegistry.getAvailable();
    console.error(`Model "${modelSpec}" not found. Available:`);
    available.forEach((m) => console.error(`  ${m.provider}/${m.id}`));
    process.exit(1);
  }

  // --- Single API call via pi SDK (no extensions, no tools, no skills) ---
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

  await session.prompt(`Look up: ${query}`);
  session.dispose();

  // --- Parse response ---
  let jsonStr = response.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(jsonStr);
  } catch {
    console.error("Failed to parse response:", response);
    process.exit(1);
  }

  // --- Verify URLs (schema stores without protocol, verify with https://) ---
  const URL_FIELDS = ["website_url", "linkedin_url"];
  await Promise.all(
    URL_FIELDS.filter((f) => data[f] && typeof data[f] === "string").map(async (field) => {
      const url = String(data[field]);
      const fullUrl = url.startsWith("http") ? url : `https://${url}`;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        const res = await fetch(fullUrl, {
          method: "HEAD",
          redirect: "follow",
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (res.status >= 400) data[field] = null;
      } catch {
        data[field] = null;
      }
      // Strip protocol if LLM included it
      if (data[field] && typeof data[field] === "string") {
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
