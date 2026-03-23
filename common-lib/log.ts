/**
 * Shared structured logger — appends JSON lines to a log file.
 * Every entry includes timestamp and module name.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

export function createLogger(logFile: string, module: string) {
  mkdirSync(dirname(resolve(logFile)), { recursive: true });

  return function log(entry: Record<string, unknown>) {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      module,
      ...entry,
    });
    appendFileSync(logFile, line + "\n");
  };
}
