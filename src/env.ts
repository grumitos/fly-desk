/*
 * Environment readers. An unset, empty or non-numeric value falls back to the
 * default: `Number("")` is 0 and `Number("20s")` is NaN, which `setTimeout`
 * treats as an immediate timeout. The first name that holds a value wins, so a
 * current name can be listed ahead of its legacy alias.
 */
export function envString(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
}

export function envNumber(
  names: string | readonly string[],
  fallback: number,
  bounds: { min?: number; max?: number } = {},
): number {
  const raw = envString(...(typeof names === "string" ? [names] : names));
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(bounds.max ?? Number.POSITIVE_INFINITY, Math.max(bounds.min ?? Number.NEGATIVE_INFINITY, value));
}

export function envFlag(names: string | readonly string[], fallback: boolean): boolean {
  const raw = envString(...(typeof names === "string" ? [names] : names));
  if (raw === undefined) {
    return fallback;
  }

  return raw !== "0" && raw.toLowerCase() !== "false";
}
