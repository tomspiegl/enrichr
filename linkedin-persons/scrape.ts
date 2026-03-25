/**
 * LinkedIn org people scraper — core library.
 *
 * Opens a company's LinkedIn page, navigates to the people tab,
 * paginates through the employee list, extracts person data, then
 * uses an LLM to filter/enrich persons matching a prompt.
 *
 * Requires: Playwright + Chrome profile logged into LinkedIn.
 */

import { chromium, type Page, type BrowserContext } from "playwright";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createLlmContext, llmCall, parseJson, type LlmContext } from "../common-lib/llm.ts";

const dir = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(resolve(dir, "../person-lookup/schema.json"), "utf-8"));
export const schemaFields = Object.keys(schema.properties);

const ENRICHR_CHROME_DIR = resolve(process.env.HOME || "~", ".enrichr-chrome");

export interface LinkedInPerson {
  name: string;
  headline: string;
  profileUrl: string | null;
  location: string | null;
}

export interface PersonRecord extends Record<string, unknown> {
  person_id: number | null;
  org_id: number | null;
}

export interface ScrapeResult {
  orgUrl: string;
  scraped: number;
  filtered: number;
  persons: PersonRecord[];
}

// --- Browser Management ---
// Connects to user's Chrome via CDP on port 9222.
// Chrome must be started with: --remote-debugging-port=9222
//
// To start Chrome with CDP on macOS, QUIT Chrome first, then run:
//   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
//     --remote-debugging-port=9222 --user-data-dir="$HOME/.enrichr-chrome"
//
// On first use, log into LinkedIn in that Chrome window. The session persists
// in ~/.enrichr-chrome across runs.

let sharedBrowser: import("playwright").Browser | null = null;

const CDP_PORT = 9222;

async function isCdpAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function launchBrowser(): Promise<BrowserContext> {
  if (sharedBrowser) {
    return sharedBrowser.contexts()[0];
  }

  if (!(await isCdpAvailable())) {
    console.error([
      "",
      "  ERROR: Chrome is not running with remote debugging on port 9222.",
      "",
      "  To start Chrome for LinkedIn scraping:",
      "    1. Quit Chrome completely",
      "    2. Run:  just chrome-linkedin",
      "    3. Log into LinkedIn if this is the first time",
      "    4. Re-run this command",
      "",
    ].join("\n"));
    process.exit(1);
  }

  sharedBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const contexts = sharedBrowser.contexts();
  if (contexts.length === 0) {
    throw new Error("No browser contexts found after connecting via CDP");
  }
  return contexts[0];
}

export async function closeBrowser(): Promise<void> {
  if (sharedBrowser) {
    // Disconnect but don't close — leave the user's Chrome running
    sharedBrowser.close();
    sharedBrowser = null;
  }
}

// --- URL helpers ---

function normalizeOrgUrl(orgUrl: string): string {
  let url = orgUrl.trim();
  if (!url.startsWith("http")) url = `https://${url}`;
  url = url.replace(/\/+$/, "");
  url = url.replace(/\/(people|about|posts|jobs|events|videos|life)\/?$/, "");
  return url;
}

function sourcePageUrl(orgUrl: string): string {
  return normalizeOrgUrl(orgUrl) + "/people/";
}

/**
 * Resolve a company LinkedIn URL to a numeric company ID.
 * Navigates to the org page and extracts it from the redirect or page source.
 */
async function resolveCompanyId(page: Page, orgUrl: string, verbose: boolean): Promise<string | null> {
  const url = normalizeOrgUrl(orgUrl) + "/";
  if (verbose) console.error(`  Resolving company ID from ${url}`);

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);

  const currentUrl = page.url();

  // Check for login wall
  if (currentUrl.includes("/login") || currentUrl.includes("/authwall")) {
    console.error("  ERROR: Not logged into LinkedIn. Please log in via Chrome first.");
    return null;
  }

  // Admin redirect gives us the numeric ID: /company/96167156/admin/
  const adminMatch = currentUrl.match(/\/company\/(\d+)\//);
  if (adminMatch) return adminMatch[1];

  // Try to extract from page source
  const companyId = await page.evaluate(() => {
    // Look for company ID in various places
    const codeEl = document.querySelector('code[id*="company"]');
    if (codeEl) {
      const match = codeEl.textContent?.match(/"companyId":(\d+)/);
      if (match) return match[1];
    }
    // Try meta tags or embedded data
    const bodyHtml = document.body.innerHTML;
    const match = bodyHtml.match(/urn:li:fsd_company:(\d+)/) || bodyHtml.match(/"companyId":(\d+)/);
    return match ? match[1] : null;
  });

  return companyId;
}

// --- Scraping (uses LinkedIn People Search) ---

async function scrapePeoplePage(page: Page): Promise<LinkedInPerson[]> {
  // Extract person data from profile links on the search results page
  return page.evaluate(() => {
    const results: { name: string; headline: string; profileUrl: string | null; location: string | null }[] = [];
    const seen = new Set<string>();

    // Find all profile links — the most reliable selector
    const profileLinks = document.querySelectorAll('a[href*="/in/"]');
    for (const link of profileLinks) {
      const a = link as HTMLAnchorElement;
      const href = a.href;
      const match = href.match(/(https:\/\/www\.linkedin\.com\/in\/[^/?]+)/);
      if (!match) continue;
      const profileUrl = match[1].replace("https://", "");
      if (seen.has(profileUrl)) continue;

      // Get the name from the link text (may contain connection degree info)
      const nameSpan = a.querySelector('span[aria-hidden="true"]');
      let name = (nameSpan?.textContent || a.textContent || "").trim();
      // Clean up name — remove degree indicators like "• 1." or "• 2."
      name = name.replace(/\s*•\s*\d+\.?\s*$/, "").trim();
      if (!name || name === "LinkedIn Member" || name.length < 2) continue;

      seen.add(profileUrl);

      // Find the containing card/list item for headline and location
      const card = a.closest("li") || a.closest("[data-view-name]") || a.parentElement?.parentElement?.parentElement;
      let headline = "";
      let location: string | null = null;

      if (card) {
        // Headline: usually the text block after the name link
        const subtitleEl = card.querySelector(
          '.entity-result__primary-subtitle, ' +
          '.t-14.t-normal:not(.entity-result__secondary-subtitle)'
        );
        headline = subtitleEl?.textContent?.trim() || "";

        // Location
        const locEl = card.querySelector('.entity-result__secondary-subtitle');
        location = locEl?.textContent?.trim() || null;
      }

      results.push({ name, headline, profileUrl, location });
    }

    return results;
  });
}

async function hasNextPage(page: Page): Promise<boolean> {
  const nextBtn = await page.$(
    'button[aria-label="Next"], button[aria-label="Weiter"], button.artdeco-pagination__button--next'
  );
  if (!nextBtn) return false;
  const disabled = await nextBtn.getAttribute("disabled");
  return disabled === null;
}

async function goNextPage(page: Page): Promise<void> {
  const nextBtn = await page.$(
    'button[aria-label="Next"], button[aria-label="Weiter"], button.artdeco-pagination__button--next'
  );
  if (nextBtn) {
    await nextBtn.click();
    await page.waitForTimeout(4000);
    // Wait for new profile links to appear
    await page.waitForSelector('a[href*="/in/"]', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }
}

// --- LLM: prompt → search keywords ---

async function promptToKeywords(
  prompt: string,
  ctx: LlmContext,
  verbose: boolean
): Promise<string | null> {
  if (prompt.toLowerCase() === "all") return null;

  const systemPrompt = [
    "You convert a natural-language person search prompt into LinkedIn people search keywords.",
    "Return ONLY a short keyword string suitable for LinkedIn's search box (max 5-6 words).",
    "Focus on job titles and roles, not descriptions.",
    "Examples:",
    '  "decision makers in sales or marketing" → "Sales Marketing Director VP Head"',
    '  "C-level or founders" → "CEO CTO CFO COO Founder"',
    '  "HR people who decide on employee benefits" → "HR People Operations Benefits CEO Founder"',
    '  "software engineers" → "Software Engineer Developer"',
    "Return ONLY the keywords, no quotes, no explanation.",
  ].join("\n");

  try {
    const response = await llmCall(systemPrompt, prompt, ctx);
    const keywords = response.trim().replace(/^["']|["']$/g, "");
    if (verbose) console.error(`  Search keywords: "${keywords}"`);
    return keywords;
  } catch (e) {
    if (verbose) console.error(`  Keyword generation failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

// --- LLM: filter a page of people ---

function filterPeople(
  people: LinkedInPerson[],
  prompt: string,
  alreadyMatched: LinkedInPerson[],
  ctx: LlmContext,
  verbose: boolean
): Promise<LinkedInPerson[]> {
  if (prompt.toLowerCase() === "all") return Promise.resolve(people);

  const personList = people
    .map((p, i) => `${i + 1}. ${p.name} — ${p.headline}${p.location ? ` (${p.location})` : ""}`)
    .join("\n");

  const alreadyList = alreadyMatched.length > 0
    ? `\n\nAlready selected from previous pages:\n${alreadyMatched.map(p => `- ${p.name} — ${p.headline}`).join("\n")}`
    : "";

  const filterPrompt = [
    "You are a strict person filtering service for LinkedIn company employee lists.",
    "You will receive a list of people and a filter prompt describing who we're looking for.",
    "Return a JSON array of indices (1-based) of people that STRONGLY match the filter.",
    "",
    "STRICT RULES:",
    "- Only include people who would actually DECIDE on the described topic (sign contracts, approve budgets, authorize programs).",
    "- C-Level (CEO, CFO, COO, CTO), Geschäftsführer, Vorstand, VP, Director, Head of = YES, they decide.",
    "- 'Head of HR', 'HR Director', 'People & Culture Lead' = YES, they decide on HR programs.",
    "- 'HR Specialist', 'Recruiter', 'HR Coordinator', 'HR Assistant', 'Lehrlingsbetreuung' = NO, they execute but don't decide.",
    "- Only include the MOST senior relevant person per department. Skip subordinates if a boss is available.",
    "- When in doubt, EXCLUDE. We want decision makers, not staff.",
    "- Avoid duplicating roles already selected from previous pages.",
    "",
    "If no one matches, return [].",
    "Return ONLY the JSON array of numbers, e.g. [1, 3, 7].",
  ].join("\n");

  return llmCall(filterPrompt, `Filter: ${prompt}${alreadyList}\n\nNew people on this page:\n${personList}`, ctx)
    .then((response) => {
      const indices: number[] = parseJson(response);
      if (!Array.isArray(indices)) return [];
      return indices.filter((i) => i >= 1 && i <= people.length).map((i) => people[i - 1]);
    })
    .catch(() => []);
}

// --- LLM: should we keep paginating? ---

async function shouldContinuePaginating(
  prompt: string,
  matches: LinkedInPerson[],
  totalScraped: number,
  ctx: LlmContext,
): Promise<boolean> {
  if (matches.length === 0) return true; // always try more if we have nothing

  const matchList = matches
    .map((p) => `- ${p.name} — ${p.headline}`)
    .join("\n");

  const response = await llmCall(
    [
      "You decide whether we have enough matching contacts for a given search.",
      "We are scraping LinkedIn employees at a company to find specific people.",
      'Answer "yes" to continue searching or "no" if we have enough good contacts.',
      "Consider: do we have the key decision makers covered? Are there likely more relevant people if we keep looking?",
      "For small/medium companies, 1-3 good decision makers is usually enough.",
      "For large companies (100s of employees), we might need more to cover different departments.",
      'Return ONLY "yes" or "no".',
    ].join("\n"),
    `Search goal: ${prompt}\n\nEmployees seen so far: ${totalScraped}\n\nMatches found:\n${matchList}\n\nShould we continue searching for more?`,
    ctx
  ).catch(() => "no");

  return response.trim().toLowerCase().startsWith("y");
}

/**
 * Smart scrape: resolve company → keyword search → paginate with per-page filtering → LLM-driven stop.
 *
 * Stops when:
 *  - LLM says we have enough relevant decision makers
 *  - 2 consecutive pages with 0 new matches
 *  - No more pages or maxPages reached
 */
export async function scrapeAndFilter(
  page: Page,
  orgUrl: string,
  prompt: string,
  ctx: LlmContext,
  maxPages: number,
  verbose: boolean,
): Promise<LinkedInPerson[]> {
  // Step 1: Resolve company ID
  const companyId = await resolveCompanyId(page, orgUrl, verbose);
  if (!companyId) {
    if (verbose) console.error("  Could not resolve company ID");
    return [];
  }
  if (verbose) console.error(`  Company ID: ${companyId}`);

  // Step 2: LLM converts prompt → search keywords
  const keywords = await promptToKeywords(prompt, ctx, verbose);

  // Step 3: Navigate to people search (with keywords if available)
  let searchUrl = `https://www.linkedin.com/search/results/people/?currentCompany=%5B%22${companyId}%22%5D`;
  if (keywords) {
    searchUrl += `&keywords=${encodeURIComponent(keywords)}`;
  }
  if (verbose) console.error(`  Searching: ${searchUrl}`);
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(5000);
  await page.waitForSelector('a[href*="/in/"]', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // Check if keyword search returned results; if not, fallback to no keywords
  const hasResults = await page.$$('a[href*="/in/"]');
  if (hasResults.length === 0 && keywords) {
    if (verbose) console.error(`  No results with keywords — retrying without keywords`);
    const fallbackUrl = `https://www.linkedin.com/search/results/people/?currentCompany=%5B%22${companyId}%22%5D`;
    await page.goto(fallbackUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(5000);
    await page.waitForSelector('a[href*="/in/"]', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }

  // Step 4: Paginate with per-page filtering + LLM-driven stop
  const allMatches: LinkedInPerson[] = [];
  const seenKeys = new Set<string>();
  let emptyPages = 0;
  let totalScraped = 0;

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    if (verbose) console.error(`  Page ${pageNum}...`);
    const people = await scrapePeoplePage(page);

    // Dedup
    const newPeople: LinkedInPerson[] = [];
    for (const p of people) {
      const key = p.profileUrl || p.name;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        newPeople.push(p);
      }
    }
    totalScraped += newPeople.length;

    if (newPeople.length === 0) {
      if (verbose) console.error(`    No new people — stopping`);
      break;
    }

    // Filter this page with LLM (aware of already-matched people to avoid role duplication)
    const matches = await filterPeople(newPeople, prompt, allMatches, ctx, verbose);
    if (verbose) console.error(`    ${newPeople.length} scraped, ${matches.length} match (${allMatches.length + matches.length} total)`);

    if (matches.length > 0) {
      allMatches.push(...matches);
      emptyPages = 0;
    } else {
      emptyPages++;
    }

    // Stop conditions
    if (emptyPages >= 2) {
      if (verbose) console.error(`  2 consecutive pages with no matches — stopping`);
      break;
    }

    if (!(await hasNextPage(page))) {
      if (verbose) console.error("  No next page — done");
      break;
    }

    // Ask LLM if we have enough decision makers
    if (allMatches.length > 0) {
      const keepGoing = await shouldContinuePaginating(prompt, allMatches, totalScraped, ctx);
      if (!keepGoing) {
        if (verbose) console.error(`  LLM says we have enough contacts (${allMatches.length}) — stopping`);
        break;
      }
      if (verbose) console.error(`  LLM says keep searching...`);
    }

    await goNextPage(page);
  }

  return allMatches;
}

async function enrichWithLlm(
  people: LinkedInPerson[],
  ctx: LlmContext,
  orgUrl: string,
  verbose: boolean
): Promise<PersonRecord[]> {
  const personList = people
    .map((p) => `- ${p.name}: ${p.headline}${p.location ? ` (${p.location})` : ""}${p.profileUrl ? ` [${p.profileUrl}]` : ""}`)
    .join("\n");

  const schemaFieldsList = schemaFields
    .filter((f) => f !== "person_id" && f !== "org_id")
    .map((f) => {
      const prop = schema.properties[f];
      const type = Array.isArray(prop.type)
        ? prop.type.filter((t: string) => t !== "null").join("|") + "|null"
        : prop.type;
      const enumVals = prop.enum ? ` enum: ${JSON.stringify(prop.enum)}` : "";
      return `- **${f}** (${type}${enumVals}): ${prop.description || ""}`;
    })
    .join("\n");

  const systemPrompt = [
    "You are a person data enrichment service.",
    "Given LinkedIn profile snippets, return a JSON array of person objects matching this schema.",
    "Fill in what you can infer from the name and headline. Use null for unknowns.",
    "For linkedin_url: use the profile URL without https:// (e.g. 'www.linkedin.com/in/john-doe').",
    "For website_url: leave null (will be filled later).",
    "For source_page: use the LinkedIn company people page URL.",
    "For confidence: use 0.7 for LinkedIn-sourced data.",
    "person_id and org_id will be auto-assigned — set both to null.",
    "",
    "## Schema fields",
    schemaFieldsList,
    "",
    "Return ONLY the JSON array, no markdown fences.",
  ].join("\n");

  if (verbose) console.error(`  Enriching ${people.length} people via LLM...`);

  try {
    const response = await llmCall(systemPrompt, `LinkedIn company: ${orgUrl}\n\nPeople:\n${personList}`, ctx);
    const arr = parseJson(response);
    if (!Array.isArray(arr)) return people.map((p) => toBasicRecord(p, orgUrl));

    return arr.map((p: any) => ({
      person_id: null,
      org_id: null,
      ...p,
      source_page: p.source_page || sourcePageUrl(orgUrl),
    }));
  } catch (e) {
    if (verbose) console.error(`  LLM enrichment failed: ${e instanceof Error ? e.message : e}`);
    return people.map((p) => toBasicRecord(p, orgUrl));
  }
}

function toBasicRecord(p: LinkedInPerson, orgUrl: string): PersonRecord {
  const nameParts = p.name.split(/\s+/);
  return {
    person_id: null,
    org_id: null,
    website_url: null,
    source_page: sourcePageUrl(orgUrl),
    salutation: null,
    title_prefix: null,
    title_suffix: null,
    first_name: nameParts[0] || null,
    last_name: nameParts.slice(1).join(" ") || null,
    full_name: p.name,
    position: p.headline || null,
    role_category: null,
    is_decision_maker: null,
    department: null,
    additional_roles: null,
    email: null,
    phone_mobile: null,
    phone_office: null,
    linkedin_url: p.profileUrl || null,
    label: null,
    confidence: 0.6,
  };
}

/**
 * Full pipeline:
 *  1. LLM generates LinkedIn search keywords from prompt
 *  2. Search company employees with keywords (pre-filtered by LinkedIn)
 *  3. Paginate with per-page LLM filtering, stop early when enough matches
 *  4. Enrich matched people into full person records
 *
 * If a page (tab) is provided it is reused; otherwise a new tab is created and closed after.
 */
export async function lookupLinkedInPersons(
  context: BrowserContext,
  orgUrl: string,
  prompt: string,
  ctx: LlmContext,
  maxPages: number,
  verbose: boolean,
  reusePage?: Page
): Promise<PersonRecord[]> {
  const page = reusePage || await context.newPage();
  try {
    // Scrape + filter (keyword search + per-page LLM filtering + early stop)
    const matches = await scrapeAndFilter(page, orgUrl, prompt, ctx, maxPages, verbose);
    if (verbose) console.error(`  Total matches: ${matches.length}`);
    if (matches.length === 0) return [];

    // Enrich matched people into full person records
    const records = await enrichWithLlm(matches, ctx, orgUrl, verbose);
    if (verbose) console.error(`  Enriched: ${records.length} persons`);
    return records;
  } finally {
    if (!reusePage) await page.close();
  }
}

/**
 * Create a pool of reusable browser tabs.
 * acquire() returns a page, release() puts it back.
 */
export class TabPool {
  private available: Page[] = [];
  private waiting: ((page: Page) => void)[] = [];
  private context: BrowserContext;
  private size: number;
  private created = 0;

  constructor(context: BrowserContext, size: number) {
    this.context = context;
    this.size = size;
  }

  async acquire(): Promise<Page> {
    if (this.available.length > 0) {
      return this.available.pop()!;
    }
    if (this.created < this.size) {
      this.created++;
      return this.context.newPage();
    }
    // Wait for a tab to be released
    return new Promise<Page>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  release(page: Page): void {
    if (this.waiting.length > 0) {
      const resolve = this.waiting.shift()!;
      resolve(page);
    } else {
      this.available.push(page);
    }
  }

  async closeAll(): Promise<void> {
    for (const page of this.available) {
      await page.close().catch(() => {});
    }
    this.available = [];
  }
}
