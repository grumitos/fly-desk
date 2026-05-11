type PerfFieldValue = string | number | boolean | undefined | null;

export type PerfFields = Record<string, PerfFieldValue>;

function readFlag(name: string): boolean {
  const value = Bun.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function readNumber(name: string): number | undefined {
  const value = Bun.env[name]?.trim();
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function shouldLog(durationMs: number): boolean {
  if (readFlag("FLY_DESK_PERF_LOG")) {
    return true;
  }

  const slowMs = readNumber("FLY_DESK_PERF_LOG_SLOW_MS");
  return typeof slowMs === "number" && slowMs >= 0 && durationMs >= slowMs;
}

function formatFieldValue(value: PerfFieldValue): string {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value).replace(/\s+/g, "_");
}

function formatFields(fields: PerfFields | undefined): string {
  if (!fields) {
    return "";
  }

  return Object.entries(fields)
    .filter((entry): entry is [string, Exclude<PerfFieldValue, undefined | null>] =>
      entry[1] !== undefined && entry[1] !== null)
    .map(([key, value]) => `${key}=${formatFieldValue(value)}`)
    .join(" ");
}

export function startPerfTimer(): number {
  return performance.now();
}

export function elapsedPerfMs(startMs: number): number {
  return Math.max(0, performance.now() - startMs);
}

export function logPerfSpan(name: string, startMs: number, fields?: PerfFields): void {
  const durationMs = elapsedPerfMs(startMs);
  if (!shouldLog(durationMs)) {
    return;
  }

  const formatted = formatFields(fields);
  const suffix = formatted ? ` ${formatted}` : "";
  console.log(`[perf] ${name} durationMs=${durationMs.toFixed(1)}${suffix}`);
}
