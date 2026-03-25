#!/usr/bin/env npx tsx
/**
 * Person lookup — crawls a company website, uses LLM to find contact pages,
 * then extracts person data (name, role, email, phone, LinkedIn).
 *
 * Usage:
 *   npx tsx person-lookup/lookup.ts "www.example.at"
 *   npx tsx person-lookup/lookup.ts --format csv "www.example.at"
 *   npx tsx person-lookup/lookup.ts --model openai/gpt-4o "example.at"
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPage, crawlPages } from "./crawl.ts";
import { csvHeader, csvRow, csvEmptyRow } from "../common-lib/csv.ts";
import { createLlmContext, llmCall, parseJson, type LlmContext } from "../common-lib/llm.ts";

const dir = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(resolve(dir, "schema.json"), "utf-8"));
const schemaFields = Object.keys(schema.properties);
const selectPagesPrompt = readFileSync(resolve(dir, "prompts/SELECT_PAGES.md"), "utf-8");
const extractPersonsPrompt = readFileSync(resolve(dir, "prompts/EXTRACT_PERSONS.md"), "utf-8");

// Max text chars to send to LLM per page
const MAX_PAGE_TEXT = 12_000;
// Max total text for extraction prompt
const MAX_TOTAL_TEXT = 40_000;

export interface PersonRecord extends Record<string, unknown> {
  website_url: string;
  source_page: string | null;
  salutation: string | null;
  title_prefix: string | null;
  title_suffix: string | null;
  first_name: string | null;
  last_name: string | null;
  full_name: string;
  position: string | null;
  role_category: string | null;
  is_decision_maker: boolean | null;
  department: string | null;
  additional_roles: string | null;
  email: string | null;
  phone_mobile: string | null;
  phone_office: string | null;
  linkedin_url: string | null;
  label: string | null;
  confidence: number;
}

// Well-known paths that almost always contain contact info on DACH company websites.
// These are probed directly regardless of what's in the homepage link list.
// Includes common variants: .html suffix, locale prefixes, trailing slashes.
const WELL_KNOWN_BASE_PATHS = [
  "/impressum",
  "/kontakt",
  "/contact",
  "/team",
  "/ueber-uns",
  "/about",
  "/about-us",
  "/management",
  "/vorstand",
  "/unternehmen",
];
const LOCALE_PREFIXES = ["", "/de", "/en", "/de-at", "/de-de", "/de-ch", "/at"];
const SUFFIXES = ["", ".html", "/"];

// Generate all well-known path variants
const WELL_KNOWN_PATHS: string[] = [];
for (const base of WELL_KNOWN_BASE_PATHS) {
  for (const locale of LOCALE_PREFIXES) {
    for (const suffix of SUFFIXES) {
      WELL_KNOWN_PATHS.push(locale + base + suffix);
    }
  }
}
// Deduplicate (e.g. "/impressum" and "/impressum" from "" locale + "" suffix)
const WELL_KNOWN_SET = [...new Set(WELL_KNOWN_PATHS)];

// Regex for contact-relevant paths found in link lists
const CONTACT_PATTERNS = /\/(team|about|kontakt|contact|impressum|datenschutz|privacy|ueber-uns|über-uns|unternehmen|firma|wir|management|geschaeftsfuehrung|vorstand|beirat|aufsichtsrat|gremien|leitung|fuehrung|mitarbeiter|ansprechpartner|staff|people|leadership|executive|board|organigramm|presse|press|newsroom|marketing)/i;

// Max links to send to LLM (huge lists overwhelm the model)
const MAX_LINKS_FOR_LLM = 100;

// Max pages to fetch total
const MAX_PAGES = 15;

export interface LookupDiagnostics {
  homepageOk: boolean;
  homepageLinks: number;
  candidatePages: number;
  fetchedPages: number;
  totalTextChars: number;
  usedPlaywright: boolean;
}

export let lastDiagnostics: LookupDiagnostics | null = null;

export async function lookupPersons(
  websiteUrl: string,
  ctx: LlmContext,
  verbose = false
): Promise<PersonRecord[]> {
  const baseUrl = websiteUrl.startsWith("http") ? websiteUrl : `https://${websiteUrl}`;
  let displayUrl = websiteUrl.replace(/^https?:\/\//, "");
  if (!displayUrl.startsWith("www.")) displayUrl = `www.${displayUrl}`;

  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    if (verbose) console.error(`  ✗ Invalid URL: ${baseUrl}`);
    return [];
  }

  const diag: LookupDiagnostics = {
    homepageOk: false, homepageLinks: 0, candidatePages: 0,
    fetchedPages: 0, totalTextChars: 0, usedPlaywright: false,
  };
  lastDiagnostics = diag;

  // Step 1: Fetch homepage, get all internal links
  if (verbose) console.error(`  Fetching homepage: ${baseUrl}`);
  const homepage = await fetchPage(baseUrl);
  diag.homepageOk = homepage.ok;
  diag.usedPlaywright = homepage.usedPlaywright || false;
  if (!homepage.ok) {
    if (verbose) console.error(`  ✗ Failed to fetch homepage`);
    return [];
  }

  const allLinks = homepage.links;
  diag.homepageLinks = allLinks.length;
  if (verbose) console.error(`  Found ${allLinks.length} internal links`);

  // Step 2: Build candidate URLs from 3 sources

  const candidateUrls = new Set<string>();

  // Source A: Probe well-known paths directly (fast HEAD requests)
  // These exist on most DACH sites but may not be linked from homepage.
  // Detect locale prefix from homepage links first, then probe smartly.
  if (verbose) console.error(`  Probing well-known paths...`);
  const allLinksSet = new Set(allLinks.map((l) => l.replace(/\/+$/, "")));

  // Detect locale prefixes used on this site from existing links
  const detectedLocales = new Set<string>([""]);
  for (const link of allLinks) {
    const path = link.replace(origin, "");
    const localeMatch = path.match(/^\/(de|en|de-at|de-de|de-ch|at|fr|it)\//i);
    if (localeMatch) detectedLocales.add("/" + localeMatch[1].toLowerCase());
  }

  // Build probe list: base paths × detected locales × suffixes
  const probePaths: string[] = [];
  for (const base of WELL_KNOWN_BASE_PATHS) {
    for (const locale of detectedLocales) {
      for (const suffix of SUFFIXES) {
        probePaths.push(locale + base + suffix);
      }
    }
  }

  // Probe in parallel, one hit per base path is enough
  const foundBases = new Set<string>();
  const probePromises = probePaths.map(async (path) => {
    const base = WELL_KNOWN_BASE_PATHS.find((b) => path.includes(b)) || path;
    if (foundBases.has(base)) return; // Already found this base

    const url = origin + path;
    const clean = url.replace(/\/+$/, "");
    if (allLinksSet.has(clean)) {
      candidateUrls.add(clean);
      foundBases.add(base);
      return;
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(url, {
        method: "HEAD",
        redirect: "follow",
        signal: ctrl.signal,
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
      });
      clearTimeout(timer);
      if (res.ok) {
        candidateUrls.add(clean);
        foundBases.add(base);
      }
    } catch {}
  });
  await Promise.all(probePromises);

  // Source B: Regex match on homepage links
  for (const link of allLinks) {
    if (CONTACT_PATTERNS.test(link)) {
      candidateUrls.add(link);
    }
  }

  // Source C: LLM selection (always run if we have links — LLM may find pages regex/probes missed)
  if (allLinks.length > 0) {
    // Truncate link list for LLM if too large
    const linksForLlm = allLinks.slice(0, MAX_LINKS_FOR_LLM);
    const linkList = linksForLlm.map((l, i) => `${i + 1}. ${l}`).join("\n");

    if (verbose) console.error(`  Asking LLM to select contact pages...`);
    try {
      const selectResponse = await llmCall(
        selectPagesPrompt,
        `Website: ${baseUrl}\n\nPages:\n${linkList}`,
        ctx
      );
      let selectedIndices: number[] = parseJson(selectResponse);
      if (Array.isArray(selectedIndices)) {
        for (const idx of selectedIndices) {
          if (idx >= 1 && idx <= linksForLlm.length) {
            candidateUrls.add(linksForLlm[idx - 1]);
          }
        }
      }
    } catch (e) {
      if (verbose) console.error(`  ✗ LLM page selection failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  diag.candidatePages = candidateUrls.size;
  if (verbose) console.error(`  ${candidateUrls.size} candidate contact pages found`);

  // Step 3: Fetch candidate pages (capped)
  const urlsToFetch = [...candidateUrls].slice(0, MAX_PAGES);

  if (urlsToFetch.length === 0) {
    // No contact pages found — try extracting from homepage alone
    return extractPersonsFromPages(displayUrl, [homepage], ctx, verbose);
  }

  if (verbose) console.error(`  Fetching ${urlsToFetch.length} contact pages...`);
  const pages = await crawlPages(urlsToFetch);
  const okPages = pages.filter((p) => p.ok && p.text.length > 50);

  diag.fetchedPages = okPages.length;
  if (verbose) console.error(`  ${okPages.length}/${urlsToFetch.length} pages fetched successfully`);

  // Include homepage too (may have info)
  const allPages = [homepage, ...okPages];

  // Step 4: Extract persons
  const persons = await extractPersonsFromPages(displayUrl, allPages, ctx, verbose);

  // Step 5: If no persons found despite having contact pages, ask LLM for known persons
  if (persons.length === 0 && urlsToFetch.length > 0) {
    if (verbose) console.error(`  ⚠ No persons extracted — falling back to LLM knowledge lookup`);
    return fallbackKnowledgeLookup(displayUrl, ctx, verbose);
  }

  return persons;
}

async function fallbackKnowledgeLookup(
  websiteUrl: string,
  ctx: LlmContext,
  verbose: boolean
): Promise<PersonRecord[]> {
  const fallbackPrompt = [
    "You are a business contact lookup service for Austrian/DACH companies.",
    "The website could not be fully crawled, but you may know the company's key persons from public records (Firmenbuch, LinkedIn, press releases).",
    "",
    "Return the company's known decision makers (Geschäftsführer, Vorstand, Prokurist, C-Level) as a JSON array.",
    "Only include persons you are confident about. Set confidence to 0.5 for knowledge-based lookups.",
    "Set source_page to null since this is from your knowledge, not a web page.",
    "",
    extractPersonsPrompt.split("## Required JSON fields")[0], // Reuse field rules
  ].join("\n");

  const schemaFieldsList = schemaFields.map((f) => {
    const prop = schema.properties[f];
    const type = Array.isArray(prop.type) ? prop.type.filter((t: string) => t !== "null").join("|") + "|null" : prop.type;
    const enumVals = prop.enum ? ` enum: ${JSON.stringify(prop.enum)}` : "";
    return `- **${f}** (${type}${enumVals})`;
  }).join("\n");

  const prompt = fallbackPrompt + "\n\n## Required JSON fields\n\n" + schemaFieldsList;

  try {
    const response = await llmCall(prompt, `Company website: ${websiteUrl}\n\nReturn known key persons for this company.`, ctx);
    const arr = parseJson(response);
    if (!Array.isArray(arr)) return [];
    return arr.map((p: any) => ({ person_id: null, org_id: null, ...p, website_url: p.website_url || websiteUrl }));
  } catch (e) {
    if (verbose) console.error(`  ✗ Fallback lookup failed: ${e instanceof Error ? e.message : e}`);
    return [];
  }
}

async function extractPersonsFromPages(
  websiteUrl: string,
  pages: { url: string; text: string }[],
  ctx: LlmContext,
  verbose: boolean
): Promise<PersonRecord[]> {
  // Build combined text, respecting limits
  let totalLen = 0;
  const pageTexts: string[] = [];

  for (const page of pages) {
    const text = page.text.slice(0, MAX_PAGE_TEXT);
    if (totalLen + text.length > MAX_TOTAL_TEXT) break;
    pageTexts.push(`=== PAGE: ${page.url} ===\n${text}`);
    totalLen += text.length;
  }

  const combinedText = pageTexts.join("\n\n");

  const schemaFields_list = schemaFields.map((f) => {
    const prop = schema.properties[f];
    const type = Array.isArray(prop.type) ? prop.type.filter((t: string) => t !== "null").join("|") + "|null" : prop.type;
    const enumVals = prop.enum ? ` enum: ${JSON.stringify(prop.enum)}` : "";
    return `- **${f}** (${type}${enumVals})`;
  }).join("\n");
  const extractPrompt = extractPersonsPrompt + "\n\n## Required JSON fields\n\nEvery object in the array MUST have exactly these fields:\n\n" + schemaFields_list;

  if (verbose) console.error(`  Extracting persons from ${pages.length} pages (${totalLen} chars)...`);

  let response: string;
  try {
    response = await llmCall(extractPrompt, combinedText, ctx);
  } catch (e) {
    if (verbose) console.error(`  ✗ LLM extraction failed: ${e instanceof Error ? e.message : e}`);
    return [];
  }

  try {
    const arr = parseJson(response);
    if (!Array.isArray(arr)) {
      if (verbose) console.error(`  ✗ LLM returned non-array: ${response.slice(0, 200)}`);
      return [];
    }
    if (arr.length === 0 && totalLen > 500) {
      // Suspicious: pages had content but LLM found no persons
      if (verbose) console.error(`  ⚠ LLM returned [] despite ${totalLen} chars of content`);
    }
    // Ensure website_url is set on every record
    return arr.map((p: any) => ({ person_id: null, org_id: null, ...p, website_url: p.website_url || websiteUrl }));
  } catch {
    if (verbose) console.error(`  ✗ Failed to parse extraction response: ${response.slice(0, 200)}`);
    return [];
  }
}

// --- CLI ---
async function main() {
  const args = process.argv.slice(2);
  let format = "json";
  let modelSpec = "anthropic/claude-sonnet-4-20250514";
  let verbose = false;
  const queryParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--format" && args[i + 1]) format = args[++i];
    else if (args[i] === "--model" && args[i + 1]) modelSpec = args[++i];
    else if (args[i] === "--verbose" || args[i] === "-v") verbose = true;
    else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`Usage: lookup.ts [options] <website-url>

Crawls a company website, finds contact/team pages, extracts person data.

Options:
  --format json|csv  Output format (default: json)
  --model P/ID       Model (default: anthropic/claude-sonnet-4-20250514)
  --verbose, -v      Show progress on stderr

Examples:
  lookup.ts "www.example.at"
  lookup.ts --format csv "example.at"
  lookup.ts -v --model openai/gpt-4o "www.company.com"`);
      process.exit(0);
    } else {
      queryParts.push(args[i]);
    }
  }

  const websiteUrl = queryParts.join(" ").trim();
  if (!websiteUrl) {
    console.error("Error: no website URL. Use --help for usage.");
    process.exit(1);
  }

  const ctx = createLlmContext(modelSpec);
  const persons = await lookupPersons(websiteUrl, ctx, verbose || true);

  if (format === "csv") {
    process.stdout.write(csvHeader(schemaFields));
    if (persons.length === 0) {
      process.stdout.write(csvEmptyRow(schemaFields));
    } else {
      for (const person of persons) {
        process.stdout.write(csvRow(schemaFields, person));
      }
    }
  } else {
    console.log(JSON.stringify(persons, null, 2));
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
