export function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

export function parseIsoDiffMinutes(start?: string, end?: string): number {
  if (!start || !end) {
    return 0;
  }

  const diff = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(diff) ? Math.max(0, Math.round(diff / 60000)) : 0;
}

export function parseAgilDurationMinutes(value?: string, start?: string, end?: string): number {
  if (value) {
    const trimmed = value.trim();
    const dotted = trimmed.match(/^(\d+)\.(\d{2})$/);
    if (dotted) {
      return Number(dotted[1]) * 60 + Number(dotted[2]);
    }

    const compact = trimmed.match(/^(\d{4})$/);
    if (compact) {
      const hours = Number(compact[1].slice(0, 2));
      const minutes = Number(compact[1].slice(2));
      if (minutes < 60) {
        return (hours * 60) + minutes;
      }
    }

    const hhmm = trimmed.match(/^(\d{1,2}):(\d{2})$/);
    if (hhmm) {
      return Number(hhmm[1]) * 60 + Number(hhmm[2]);
    }

    const iso = trimmed.match(/^PT(?:(\d+)H)?(?:(\d+)M)?$/i);
    if (iso) {
      return Number(iso[1] ?? 0) * 60 + Number(iso[2] ?? 0);
    }
  }

  return parseIsoDiffMinutes(start, end);
}

export function minimumNumber(values: Array<number | undefined>): number | undefined {
  const numeric = values.filter((value): value is number => typeof value === "number");
  if (numeric.length === 0) {
    return undefined;
  }

  return Math.min(...numeric);
}

export function parseAgilNumericValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) {
      return undefined;
    }

    const parsed = Number(normalized.replace(",", "."));
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

export function combineIncludedFlags(values: Array<boolean | undefined>): boolean | undefined {
  const known = values.filter((value): value is boolean => typeof value === "boolean");
  if (known.length === 0) {
    return undefined;
  }

  return known.every(Boolean);
}

export function parseLimitDate(value?: string): string | undefined {
  if (!value || !/^\d{6}$/.test(value)) {
    return undefined;
  }

  const day = value.slice(0, 2);
  const month = value.slice(2, 4);
  const year = `20${value.slice(4, 6)}`;
  return `${year}-${month}-${day}`;
}

export function formatAgilSearchLocation(code: string, label?: string): string {
  const normalizedCode = code.trim().toUpperCase();
  const normalizedLabel = label?.trim() ?? "";
  if (!normalizedLabel) {
    return normalizedCode;
  }

  const labelWithoutCode = normalizedLabel
    .replace(new RegExp(`^${normalizedCode}\\s*-?\\s*`, "i"), "")
    .trim();

  return labelWithoutCode
    ? `${normalizedCode} ${labelWithoutCode}`
    : normalizedCode;
}

export function normalizeLocationText(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed === "\\N") {
    return undefined;
  }

  return trimmed;
}
