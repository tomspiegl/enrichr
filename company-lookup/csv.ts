/**
 * Shared CSV utilities — Excel-compatible output (UTF-8 BOM, semicolons, CRLF).
 */

export const BOM = "\uFEFF";
export const SEP = ";";
export const EOL = "\r\n";

/** Patterns Excel would auto-format as dates/numbers — force text with ="..." wrapper */
const EXCEL_DATE_PATTERN = /^\d{1,2}-\d{1,4}$/;

export function escapeCsv(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  // Prevent Excel date coercion: 11-50 → Nov.50
  if (EXCEL_DATE_PATTERN.test(s)) {
    return `="${s}"`;
  }
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
