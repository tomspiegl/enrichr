/**
 * Web crawler — fetches pages and extracts text + links.
 * Uses native fetch first, falls back to Playwright for JS-rendered sites.
 */

const TIMEOUT_MS = 10_000;
const MAX_HTML_SIZE = 2_000_000; // 2MB max HTML download (for link extraction)
const MAX_TEXT_SIZE = 512_000;   // 512KB max text passed to LLM
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Thresholds to detect JS-rendered (empty) pages
const MIN_LINKS_THRESHOLD = 3;   // fewer links → probably JS-rendered
const MIN_TEXT_THRESHOLD = 200;   // fewer chars of text → probably JS-rendered

// Signals that a page has ACTUAL person content (not just nav/title mentions).
// Requires role keywords followed by text (name), or personal email patterns.
// Generic emails (info@, office@, personal@) don't count.
const PERSON_CONTENT_SIGNALS = /geschäftsführer\w*[\s:]+[A-ZÄÖÜ]\w+|vorstand\w*[\s:]+[A-ZÄÖÜ]\w+|prokurist\w*[\s:]+[A-ZÄÖÜ]\w+|CEO[\s:]+[A-ZÄÖÜ]\w+|managing director[\s:]+[A-ZÄÖÜ]\w+|medieninhaber[\s:]+[A-ZÄÖÜ]\w+|herausgeber[\s:]+[A-ZÄÖÜ]\w+|datenschutzbeauftragt\w*[\s:]+[A-ZÄÖÜ]\w+|[a-z]+\.[a-z]+@[a-z0-9.-]+\.[a-z]{2,}/;

export interface PageResult {
  url: string;
  text: string;
  links: string[];
  ok: boolean;
  status?: number;
  usedPlaywright?: boolean;
}

// --- Native fetch ---

async function fetchWithNative(fullUrl: string): Promise<PageResult> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(fullUrl, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": USER_AGENT },
    });
    clearTimeout(timer);

    if (!res.ok || !res.headers.get("content-type")?.includes("text/html")) {
      return { url: fullUrl, text: "", links: [], ok: false, status: res.status };
    }

    const fullHtml = (await res.text()).slice(0, MAX_HTML_SIZE);
    const text = htmlToText(fullHtml).slice(0, MAX_TEXT_SIZE);
    const links = extractLinks(fullHtml, fullUrl);

    return { url: fullUrl, text, links, ok: true, status: res.status };
  } catch {
    return { url: fullUrl, text: "", links: [], ok: false };
  }
}

// --- Playwright fallback (lazy-loaded) ---

let playwrightModule: typeof import("playwright") | null = null;

async function getPlaywright() {
  if (!playwrightModule) {
    try {
      playwrightModule = await import("playwright");
    } catch {
      return null;
    }
  }
  return playwrightModule;
}

// Shared browser instance (reused across calls, closed on process exit)
let sharedBrowser: any = null;

async function getOrCreateBrowser() {
  const pw = await getPlaywright();
  if (!pw) return null;
  if (!sharedBrowser || !sharedBrowser.isConnected()) {
    sharedBrowser = await pw.chromium.launch({ headless: true });
  }
  return sharedBrowser;
}

// Close browser on process exit
process.on("exit", () => { sharedBrowser?.close().catch(() => {}); });

async function fetchWithPlaywright(fullUrl: string): Promise<PageResult> {
  const browser = await getOrCreateBrowser();
  if (!browser) return { url: fullUrl, text: "", links: [], ok: false };

  let page;
  try {
    page = await browser.newPage();
    page.setDefaultTimeout(TIMEOUT_MS);

    const response = await page.goto(fullUrl, { waitUntil: "networkidle", timeout: TIMEOUT_MS });
    if (!response || response.status() >= 400) {
      return { url: fullUrl, text: "", links: [], ok: false, status: response?.status(), usedPlaywright: true };
    }

    const fullHtml = (await page.content()).slice(0, MAX_HTML_SIZE);
    const text = htmlToText(fullHtml).slice(0, MAX_TEXT_SIZE);
    const links = extractLinks(fullHtml, fullUrl);

    return { url: fullUrl, text, links, ok: true, status: response.status(), usedPlaywright: true };
  } catch {
    return { url: fullUrl, text: "", links: [], ok: false, usedPlaywright: true };
  } finally {
    await page?.close().catch(() => {});
  }
}

/** Check if a URL looks like a contact/impressum/team page */
function isContactUrl(url: string): boolean {
  return /\/(impressum|kontakt|contact|team|about|ueber|management|vorstand|leadership|ansprechpartner|staff|people)/i.test(url);
}

// --- Public API ---

/** Fetch a single page. Tries native fetch first, falls back to Playwright if result looks JS-rendered. */
export async function fetchPage(url: string): Promise<PageResult> {
  const fullUrl = url.startsWith("http") ? url : `https://${url}`;

  // Try native fetch first (fast)
  const result = await fetchWithNative(fullUrl);

  // Try Playwright if:
  // 1. Page has very little content (JS-rendered SPA)
  // 2. Fetch failed entirely (blocked, 403, timeout)
  // 3. Page is a contact page but has no person signals (JS-rendered content)
  const needsPlaywright =
    !result.ok ||
    result.links.length < MIN_LINKS_THRESHOLD ||
    result.text.length < MIN_TEXT_THRESHOLD ||
    (isContactUrl(fullUrl) && !PERSON_CONTENT_SIGNALS.test(result.text));

  if (needsPlaywright) {
    const pwResult = await fetchWithPlaywright(fullUrl);
    if (pwResult.ok && (pwResult.text.length > result.text.length || pwResult.links.length > result.links.length)) {
      return pwResult;
    }
  }

  return result;
}

/** Extract JSON-LD structured data (often contains person/company info) */
export function extractJsonLd(html: string): string {
  const blocks: string[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      // Parse and re-serialize to get clean text
      const data = JSON.parse(m[1]);
      const text = JSON.stringify(data, null, 2)
        // Decode HTML entities in JSON values
        .replace(/\\u003c[^>]*\\u003e/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&auml;/g, "ä")
        .replace(/&ouml;/g, "ö")
        .replace(/&uuml;/g, "ü")
        .replace(/&Auml;/g, "Ä")
        .replace(/&Ouml;/g, "Ö")
        .replace(/&Uuml;/g, "Ü")
        .replace(/&szlig;/g, "ß")
        .replace(/&nbsp;/g, " ");
      blocks.push(text);
    } catch {}
  }
  return blocks.join("\n\n");
}

/** Strip HTML tags, decode entities, collapse whitespace */
export function htmlToText(html: string): string {
  // Extract JSON-LD before stripping scripts (may contain person data)
  const jsonLd = extractJsonLd(html);

  // Remove script, style, noscript, svg blocks
  let text = html.replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  // Add newlines for block elements
  text = text.replace(/<\/(p|div|li|tr|h[1-6]|br|hr)[^>]*>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, " ");
  // Decode common entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&auml;/g, "ä")
    .replace(/&ouml;/g, "ö")
    .replace(/&uuml;/g, "ü")
    .replace(/&Auml;/g, "Ä")
    .replace(/&Ouml;/g, "Ö")
    .replace(/&Uuml;/g, "Ü")
    .replace(/&szlig;/g, "ß")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec)));
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

  // Append JSON-LD structured data (may contain person info not in visible text)
  if (jsonLd) {
    text += "\n\n=== STRUCTURED DATA (JSON-LD) ===\n" + jsonLd;
  }

  return text;
}

/** Extract all internal links from HTML, resolve relative URLs */
export function extractLinks(html: string, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const seen = new Set<string>();
  const links: string[] = [];

  // Allow # in URLs — the URL parser will strip fragments
  const re = /href=["']([^"']+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const resolved = new URL(m[1], baseUrl);
      // Only internal links (same hostname)
      if (resolved.hostname !== base.hostname) continue;
      // Skip assets, anchors, mailto, tel
      if (/\.(css|js|png|jpg|jpeg|gif|svg|webp|ico|pdf|zip|woff2?|ttf|eot)$/i.test(resolved.pathname)) continue;
      if (resolved.protocol === "mailto:" || resolved.protocol === "tel:") continue;

      const clean = resolved.origin + resolved.pathname.replace(/\/+$/, "");
      if (!seen.has(clean)) {
        seen.add(clean);
        links.push(clean);
      }
    } catch {
      // skip invalid URLs
    }
  }

  return links;
}

/** Crawl multiple pages. Tries native fetch, Playwright fallback per page. */
export async function crawlPages(urls: string[]): Promise<PageResult[]> {
  const results: PageResult[] = [];
  const pending = new Set<Promise<void>>();
  for (const url of urls) {
    const p = fetchPage(url).then((r) => {
      results.push(r);
      pending.delete(p);
    });
    pending.add(p);
    if (pending.size >= 5) await Promise.race(pending);
  }
  await Promise.all(pending);
  return results;
}
