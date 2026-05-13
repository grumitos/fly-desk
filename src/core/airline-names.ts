const TRAILING_AIRLINE_SUFFIX_PATTERN = /\s+Airlines?\.?$/i;
const TRAILING_JETSMART_LEGAL_SUFFIX_PATTERN = /\s+S\.?P\.?A\.?$/i;
const AIRLINE_CODE_DISPLAY_NAMES: Record<string, string> = {
  "4C": "LATAM",
  "4M": "LATAM",
  AC: "Air Canada",
  AR: "Aerolíneas Argentinas",
  AV: "Avianca",
  H2: "Sky",
  IB: "Iberia",
  JA: "JetSmart",
  JJ: "LATAM",
  JZ: "JetSmart",
  LA: "LATAM",
  LP: "LATAM",
  LU: "LATAM",
  OB: "Boliviana de Aviación",
  PZ: "LATAM",
  PU: "Plus Ultra",
  UX: "Air Europa",
  XL: "LATAM",
};
const AIRLINE_NAME_VARIANT_DISPLAY_NAMES: Record<string, string> = {
  DELTAAIRLINES: "Delta",
  PLUSULTRALINEASAEREAS: "Plus Ultra",
};
const LATAM_VARIANT_QUALIFIERS = new Set([
  "AIRLINE",
  "AIRLINES",
  "ARGENTINA",
  "AEREA",
  "AEREAS",
  "BRASIL",
  "BRAZIL",
  "CARGO",
  "CHILE",
  "COLOMBIA",
  "DE",
  "DEL",
  "DO",
  "ECUADOR",
  "E",
  "EXPRESS",
  "GROUP",
  "LAN",
  "LINEA",
  "LINEAS",
  "LINHAS",
  "LTDA",
  "MERCOSUR",
  "PARAGUAY",
  "PERU",
  "REGIONAL",
  "S",
  "A",
  "SA",
  "SAC",
  "SPA",
  "TAM",
  "TRANSPORTES",
  "URUGUAY",
  "Y",
]);

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function comparableText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/gi, "")
    .toUpperCase();
}

function comparableWords(value: string): string[] {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean);
}

function isJetSmartBase(value: string): boolean {
  return comparableText(value) === "JETSMART";
}

function isLatamVariant(value: string): boolean {
  const words = comparableWords(value);
  const base = words[0];
  if (base !== "LATAM" && base !== "LAN" && base !== "TAM") {
    return false;
  }

  return words.slice(1).every((word) => LATAM_VARIANT_QUALIFIERS.has(word));
}

function isSkyBase(value: string): boolean {
  return comparableText(value) === "SKY";
}

function hasJetSmartLegalSuffix(value: string): boolean {
  if (!TRAILING_JETSMART_LEGAL_SUFFIX_PATTERN.test(value)) {
    return false;
  }

  const withoutLegalSuffix = collapseWhitespace(value.replace(TRAILING_JETSMART_LEGAL_SUFFIX_PATTERN, ""));
  const withoutAirlineSuffix = collapseWhitespace(withoutLegalSuffix.replace(TRAILING_AIRLINE_SUFFIX_PATTERN, ""));
  return isJetSmartBase(withoutLegalSuffix) || isJetSmartBase(withoutAirlineSuffix);
}

function applyKnownAirlineStyle(value: string): string {
  const codeDisplayName = AIRLINE_CODE_DISPLAY_NAMES[comparableText(value)];
  if (codeDisplayName) {
    return codeDisplayName;
  }

  const nameVariantDisplayName = AIRLINE_NAME_VARIANT_DISPLAY_NAMES[comparableText(value)];
  if (nameVariantDisplayName) {
    return nameVariantDisplayName;
  }

  if (isLatamVariant(value)) {
    return "LATAM";
  }

  if (isJetSmartBase(value)) {
    return "JetSmart";
  }

  if (isSkyBase(value)) {
    return "Sky";
  }

  return value;
}

export function normalizeAirlineDisplayName(value: unknown): string {
  let normalized = collapseWhitespace(String(value ?? ""));
  if (!normalized) {
    return "";
  }

  for (let index = 0; index < 4; index += 1) {
    const before = normalized;
    if (hasJetSmartLegalSuffix(normalized)) {
      normalized = collapseWhitespace(normalized.replace(TRAILING_JETSMART_LEGAL_SUFFIX_PATTERN, ""));
    }

    normalized = collapseWhitespace(normalized.replace(TRAILING_AIRLINE_SUFFIX_PATTERN, ""));
    if (normalized === before) {
      break;
    }
  }

  return applyKnownAirlineStyle(normalized);
}

export function resolveAirlineDisplayName(input: {
  names?: unknown[];
  codes?: unknown[];
  fallback?: string;
}): string {
  const codeDisplayNames = (input.codes ?? [])
    .map((value) => normalizeAirlineDisplayName(value))
    .filter(Boolean);

  for (const value of input.names ?? []) {
    const normalized = normalizeAirlineDisplayName(value);
    if (normalized) {
      return codeDisplayNames.find((codeName) => comparableText(codeName) === comparableText(normalized))
        ?? normalized;
    }
  }

  for (const normalized of codeDisplayNames) {
    return normalized;
  }

  return input.fallback ?? "";
}

export function airlineNameMatchKey(value: unknown): string {
  return comparableText(normalizeAirlineDisplayName(value));
}
