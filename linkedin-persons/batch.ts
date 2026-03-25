#!/usr/bin/env npx tsx
/**
 * Batch LinkedIn people scraper — reads input CSV (company-batch output with linkedin_url),
 * scrapes each org's LinkedIn people page concurrently (multiple browser tabs),
 * filters by prompt, writes output CSV or JSON.
 *
 * Input can be:
 *   - company-batch output CSV (auto-detects linkedin_url + org_id columns)
 *   - any CSV with a linkedin_url column
 *   - plain text with one LinkedIn company URL per line
 *
 * Usage:
 *   npx tsx linkedin-persons/batch.ts --in .work/data_out/orgs.csv --out linkedin-persons.csv --prompt "decision makers"
 *   npx tsx linkedin-persons/batch.ts --in orgs.csv --out out.csv --prompt "all" --concurrency 3
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { csvHeader, csvRow, parseCsvLine, SEP } from "../common-lib/csv.ts";
import { createLlmContext } from "../common-lib/llm.ts";
import { createLogger } from "../common-lib/log.ts";
import { launchBrowser, closeBrowser, lookupLinkedInPersons, TabPool, schemaFields, type PersonRecord } from "./scrape.ts";

const dir = dirname(fileURLToPath(import.meta.url));

// --- Args ---
const args = process.argv.slice(2);
let inFile = "";
let outFile = "";
let logFile = ".work/run.log";
let prompt = "";
let concurrency = 1; // LinkedIn rate-limits aggressively, 1 is safest
let maxPages = 5;
let format = "csv";
let modelSpec = "anthropic/claude-sonnet-4-20250514";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--in" && args[i + 1]) inFile = args[++i];
  else if (args[i] === "--out" && args[i + 1]) outFile = args[++i];
  else if (args[i] === "--prompt" && args[i + 1]) prompt = args[++i];
  else if (args[i] === "--log" && args[i + 1]) logFile = args[++i];
  else if (args[i] === "--concurrency" && args[i + 1]) concurrency = parseInt(args[++i]);
  else if (args[i] === "--max-pages" && args[i + 1]) maxPages = parseInt(args[++i]);
  else if (args[i] === "--format" && args[i + 1]) format = args[++i];
  else if (args[i] === "--model" && args[i + 1]) modelSpec = args[++i];
  else if (args[i] === "--help" || args[i] === "-h") {
    console.log(`Usage: batch.ts --in <input> --out <output> --prompt <filter> [options]

Options:
  --prompt <text>     Filter prompt (e.g. "decision makers") or "all" (required)
  --format csv|json   Output format (default: csv)
  --concurrency N     Parallel browser tabs (default: 2, be conservative for LinkedIn)
  --max-pages N       Max pages to scrape per org (default: 5)
  --model P/ID        LLM model (default: anthropic/claude-sonnet-4-20250514)
  --log <path>        Log file (default: .work/run.log)

Input: CSV with linkedin_url column (e.g. company-batch output), or plain text (one URL per line)
Output: CSV or JSON with one row per person found`);
    process.exit(0);
  }
}

if (!inFile || !outFile) { console.error("Error: --in and --out required. Use --help."); process.exit(1); }
if (!prompt) { console.error("Error: --prompt required. Use --help."); process.exit(1); }

interface OrgEntry {
  linkedinUrl: string;
  orgId: number | null;
  websiteUrl: string | null;
}

async function main() {
  console.error(`LinkedIn Batch Scraper`);
  console.error(`  Input: ${inFile}`);
  console.error(`  Output: ${outFile}`);
  console.error(`  Prompt: "${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}"`);
  console.error(`  Concurrency: ${concurrency}, Max pages: ${maxPages}`);
  console.error(`  Model: ${modelSpec}`);
  console.error(`  Reading input...`);

  const raw = readFileSync(inFile, "utf-8").replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

  // Parse input — detect CSV with linkedin_url column
  const entries: OrgEntry[] = [];
  const firstLine = lines[0] || "";
  const detectedSep = firstLine.includes(SEP) ? SEP : firstLine.includes(",") ? "," : null;

  if (detectedSep) {
    const header = parseCsvLine(firstLine, detectedSep).map((h) => h.trim().toLowerCase());
    const liIdx = header.findIndex((h) => h === "linkedin_url");
    const orgIdIdx = header.findIndex((h) => h === "org_id");
    const webIdx = header.findIndex((h) => h === "website_url");

    if (liIdx === -1) {
      console.error("Error: input CSV has no 'linkedin_url' column.");
      process.exit(1);
    }

    console.error(`Detected CSV (sep='${detectedSep === "," ? "," : ";"}') with 'linkedin_url' column (index ${liIdx})`);

    for (const line of lines.slice(1)) {
      const fields = parseCsvLine(line, detectedSep);
      const liUrl = fields[liIdx]?.trim();
      if (!liUrl || liUrl.toLowerCase() === "null" || !liUrl.includes("linkedin.com/company")) continue;
      const orgId = orgIdIdx !== -1 ? parseInt(fields[orgIdIdx]?.trim()) || null : null;
      const websiteUrl = webIdx !== -1 ? fields[webIdx]?.trim() || null : null;
      entries.push({ linkedinUrl: liUrl, orgId, websiteUrl: websiteUrl === "null" ? null : websiteUrl });
    }
  } else {
    // Plain text: one LinkedIn URL per line
    for (const line of lines) {
      if (line.includes("linkedin.com/company")) {
        entries.push({ linkedinUrl: line, orgId: null, websiteUrl: null });
      }
    }
  }

  // Deduplicate by LinkedIn URL
  const seen = new Set<string>();
  const unique = entries.filter((e) => {
    const key = e.linkedinUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const total = unique.length;
  console.error(`  Found ${entries.length} orgs with LinkedIn URL, ${total} unique`);
  if (total === 0) {
    console.error("  No orgs to process. Check that input CSV has a 'linkedin_url' column with linkedin.com/company URLs.");
    process.exit(0);
  }

  const log = createLogger(logFile, "linkedin-persons");
  log({ event: "batch_start", inFile, outFile, format, total, concurrency, maxPages, prompt, model: modelSpec });

  const ctx = createLlmContext(modelSpec);

  // Resume: use linkedin_scraped_at flag in orgs.csv
  // Load orgs.csv into memory so we can update the flag after each org
  const orgsRaw = readFileSync(inFile, "utf-8").replace(/^\uFEFF/, "");
  const orgsAllLines = orgsRaw.split(/\r?\n/);
  const orgsHeader = parseCsvLine(orgsAllLines[0], SEP);
  const scrapedAtIdx = orgsHeader.findIndex((h) => h.trim() === "linkedin_scraped_at");
  const orgsLiIdx = orgsHeader.findIndex((h) => h.trim().toLowerCase() === "linkedin_url");

  // Track which orgs are already scraped
  const doneOrgs = new Set<string>();
  if (scrapedAtIdx !== -1) {
    for (let i = 1; i < orgsAllLines.length; i++) {
      if (!orgsAllLines[i].trim()) continue;
      const fields = parseCsvLine(orgsAllLines[i], SEP);
      const scraped = fields[scrapedAtIdx]?.trim();
      if (scraped) {
        const liUrl = fields[orgsLiIdx]?.trim() || "";
        const match = liUrl.match(/linkedin\.com\/company\/([^/]+)/);
        if (match) doneOrgs.add(match[1].toLowerCase());
      }
    }
  }

  if (doneOrgs.size > 0) {
    console.error(`  Resuming: ${doneOrgs.size} org(s) already scraped (linkedin_scraped_at)`);
    log({ event: "resume", alreadyDone: doneOrgs.size });
  }

  // Helper: update linkedin_scraped_at in orgs.csv for a given linkedin_url
  // Uses a write lock to prevent concurrent corruption
  let writeLock = Promise.resolve();
  function markOrgScraped(linkedinUrl: string): void {
    if (scrapedAtIdx === -1) return;
    writeLock = writeLock.then(() => {
      const ts = new Date().toISOString();
      for (let i = 1; i < orgsAllLines.length; i++) {
        if (!orgsAllLines[i].trim()) continue;
        const fields = parseCsvLine(orgsAllLines[i], SEP);
        const liUrl = fields[orgsLiIdx]?.trim() || "";
        if (liUrl === linkedinUrl || liUrl.replace(/^https?:\/\//, "") === linkedinUrl.replace(/^https?:\/\//, "")) {
          fields[scrapedAtIdx] = ts;
          orgsAllLines[i] = fields.map(f => {
            if (f.includes(SEP) || f.includes('"') || f.includes("\n")) return `"${f.replace(/"/g, '""')}"`;
            return f;
          }).join(SEP);
          break;
        }
      }
      writeFileSync(inFile, "\uFEFF" + orgsAllLines.join("\n"));
    });
  }

  const remaining = unique.filter((e) => {
    const match = e.linkedinUrl.match(/linkedin\.com\/company\/([^/]+)/);
    return match ? !doneOrgs.has(match[1].toLowerCase()) : true;
  });

  console.error(`${remaining.length} remaining (${total - remaining.length} skipped)`);

  // Initialize output
  if (doneOrgs.size === 0) {
    mkdirSync(dirname(resolve(outFile)), { recursive: true });
    if (format === "csv") {
      writeFileSync(outFile, csvHeader(schemaFields));
    } else {
      writeFileSync(outFile, "[\n");
    }
  }

  // person_id auto-increment: start after max existing ID
  let nextPersonId = 1;
  if (existsSync(outFile) && format === "csv") {
    const existing = readFileSync(outFile, "utf-8").replace(/^\uFEFF/, "").trim();
    const outHeader = parseCsvLine(existing.split(/\r?\n/)[0], SEP);
    const pidIdx = outHeader.findIndex((h) => h.trim() === "person_id");
    if (pidIdx !== -1) {
      for (const line of existing.split(/\r?\n/).slice(1)) {
        if (!line.trim()) continue;
        const val = parseInt(parseCsvLine(line, SEP)[pidIdx]?.trim());
        if (!isNaN(val) && val >= nextPersonId) nextPersonId = val + 1;
      }
    }
  }

  // Launch browser + tab pool
  console.error(`\n  Connecting to Chrome (CDP port 9222)...`);
  const context = await launchBrowser();
  console.error(`  Connected. Opening ${concurrency} tabs...`);
  const tabPool = new TabPool(context, concurrency);

  let done = total - remaining.length;
  let jsonCount = doneOrgs.size;
  let totalPersons = 0;

  // Adaptive throttle: starts at 3s, speeds up on success, backs off on errors
  const MIN_DELAY = 1000;
  const MAX_DELAY = 120000;
  const MAX_RETRIES = 5;
  let delay = 3000;
  let consecutiveErrors = 0;

  function isRetryable(msg: string): boolean {
    return msg.includes("ERR_HTTP_RESPONSE_CODE_FAILURE")
      || msg.includes("interrupted")
      || msg.includes("Timeout")
      || msg.includes("net::");
  }

  function speedUp(): void {
    consecutiveErrors = 0;
    delay = Math.max(MIN_DELAY, Math.round(delay * 0.85));
  }

  function slowDown(): void {
    consecutiveErrors++;
    delay = Math.min(MAX_DELAY, delay * 2);
  }

  // Sequential processing with adaptive delay and retry
  const page = await tabPool.acquire();

  for (let i = 0; i < remaining.length; i++) {
    const entry = remaining[i];
    const slug = entry.linkedinUrl.match(/linkedin\.com\/company\/([^/]+)/)?.[1] || entry.linkedinUrl;
    const t0 = Date.now();

    let persons: PersonRecord[] = [];
    let success = false;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          const backoff = Math.min(MAX_DELAY, delay * attempt);
          console.error(`  ↻ Retry ${attempt}/${MAX_RETRIES} for ${slug} (waiting ${(backoff / 1000).toFixed(0)}s, throttle=${(delay / 1000).toFixed(1)}s)...`);
          await new Promise((r) => setTimeout(r, backoff));
        }
        persons = await lookupLinkedInPersons(context, entry.linkedinUrl, prompt, ctx, maxPages, false, page);
        success = true;
        break;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!isRetryable(msg)) {
          // Non-retryable (e.g. company not found) — skip
          console.error(`  ✗ ${slug}: ${msg.slice(0, 100)}`);
          break;
        }
        slowDown();
        if (attempt === MAX_RETRIES) {
          console.error(`  ✗ ${slug}: gave up after ${MAX_RETRIES} retries (throttle=${(delay / 1000).toFixed(1)}s)`);
          log({ event: "lookup", index: done + 1, linkedin_url: entry.linkedinUrl, status: "error", error: msg, duration_ms: Date.now() - t0 });
        }
      }
    }

    done++;
    const ms = Date.now() - t0;
    const pct = ((done / total) * 100).toFixed(1);

    if (success) {
      speedUp();
      totalPersons += persons.length;
      const status = persons.length > 0 ? `✓ ${persons.length} person(s)` : "— no matches";
      console.error(`[${done}/${total} ${pct}%] ${slug} ${status} (${(ms / 1000).toFixed(1)}s) [throttle=${(delay / 1000).toFixed(1)}s]`);
      log({
        event: "lookup",
        index: done,
        linkedin_url: entry.linkedinUrl,
        status: "ok",
        persons_found: persons.length,
        duration_ms: ms,
      });

      // Assign person_id, org_id, website_url
      for (const person of persons) {
        person.person_id = nextPersonId++;
        person.org_id = entry.orgId;
        if (!person.website_url && entry.websiteUrl) {
          person.website_url = entry.websiteUrl;
        }
      }

      // Write results (skip orgs with no matches)
      if (format === "csv") {
        for (const person of persons) {
          appendFileSync(outFile, csvRow(schemaFields, person));
        }
      } else {
        for (const person of persons) {
          const prefix = jsonCount > 0 ? ",\n" : "";
          appendFileSync(outFile, prefix + JSON.stringify(person, null, 2));
          jsonCount++;
        }
      }
    }

    // Mark org as scraped
    markOrgScraped(entry.linkedinUrl);

    // Wait before next org
    if (i < remaining.length - 1) {
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  tabPool.release(page);

  if (format === "json") {
    appendFileSync(outFile, "\n]\n");
  }

  await tabPool.closeAll();

  console.error(`\nDone. ${done} orgs processed, ${totalPersons} persons found → ${outFile}`);
  log({ event: "batch_end", total: done, totalPersons, outFile });

  await closeBrowser();
}

main().catch(async (e) => {
  console.error(e.message);
  await closeBrowser();
  process.exit(1);
});
