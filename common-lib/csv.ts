/**
 * Shared CSV utilities — Excel-compatible output (UTF-8 BOM, semicolons, CRLF).
 *
 * Excel quirks handled:
 *   - UTF-8 BOM so Excel detects encoding correctly
 *   - Semicolons as separator (German/Austrian Excel locale default)
 *   - CRLF line endings
 *   - ="..." wrapper for values Excel would auto-format (dates, phone numbers)
 *   - Formula injection prevention (=, +, -, @, tab, CR prefixes)
 */

export const BOM = "\uFEFF";
export const SEP = ";";
export const EOL = "\r\n";

/** Patterns Excel would auto-format as dates: 11-50 → Nov.50 */
const EXCEL_DATE_PATTERN = /^\d{1,2}-\d{1,4}$/;

/** Values starting with these trigger Excel formula interpretation */
const FORMULA_PREFIXES = ["=", "+", "-", "@", "\t", "\r"];

export function escapeCsv(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.length === 0) return "";

  // Prevent Excel date coercion: 11-50 → Nov.50
  // Prevent Excel number coercion: +43664525488 → 43664525488 or 4.37E+10
  // Prevent formula injection: =cmd, +cmd, -cmd, @mention
  if (EXCEL_DATE_PATTERN.test(s) || FORMULA_PREFIXES.some((p) => s.startsWith(p))) {
    return `="${s}"`;
  }

  // Quote if contains separator, quotes, or newlines
  if (s.includes(SEP) || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }

  return s;
}

export function csvHeader(fields: string[]): string {
  return BOM + fields.join(SEP) + EOL;
}

export function csvRow(fields: string[], data: Record<string, unknown>): string {
  return fields.map((f) => escapeCsv(data[f])).join(SEP) + EOL;
}

export function csvEmptyRow(fields: string[]): string {
  return fields.map(() => "").join(SEP) + EOL;
}

export function parseCsvLine(line: string, sep = ";"): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQ = false; }
      else { cur += c; }
    } else if (c === '"') {
      inQ = true;
    } else if (c === sep) {
      fields.push(cur);
      cur = "";
    } else if (c !== "\r") {
      cur += c;
    }
  }
  fields.push(cur);
  return fields;
}
