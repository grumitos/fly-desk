const TRAILING_AIRLINE_SUFFIX_PATTERN = /\s+Airlines?\.?$/i;
const TRAILING_JETSMART_LEGAL_SUFFIX_PATTERN = /\s+S\.?P\.?A\.?$/i;
/*
 * A code the map does not know reaches the card, the filter sheet and the
 * detail as the two raw letters, so this list is read as "which carriers does
 * a LIM desk see". It stayed at the LATAM group and its neighbours, which left
 * Copa — the single most frequent connection out of Lima — showing as «CM».
 * Only codes that are certain go in: a wrong name is worse than a code.
 */
const AIRLINE_CODE_DISPLAY_NAMES: Record<string, string> = {
  "4C": "LATAM",
  "4M": "LATAM",
  AA: "American",
  AC: "Air Canada",
  AD: "Azul",
  AF: "Air France",
  AM: "Aeroméxico",
  AR: "Aerolíneas Argentinas",
  AV: "Avianca",
  B6: "JetBlue",
  CM: "Copa",
  DL: "Delta",
  G3: "Gol",
  H2: "Sky",
  IB: "Iberia",
  JA: "JetSmart",
  JJ: "LATAM",
  JZ: "JetSmart",
  KL: "KLM",
  LA: "LATAM",
  LH: "Lufthansa",
  LP: "LATAM",
  LU: "LATAM",
  NK: "Spirit",
  OB: "Boliviana de Aviación",
  PZ: "LATAM",
  PU: "Plus Ultra",
  UA: "United",
  UX: "Air Europa",
  VB: "Viva Aerobus",
  XL: "LATAM",
  Y4: "Volaris",
};
/*
 * Names whose styled form the suffix stripper cannot reach: it only removes a
 * trailing «Airline(s)», so «JetBlue Airways» and «Gol Linhas Aéreas» would
 * each read as a second carrier beside the code they share.
 */
const AIRLINE_NAME_VARIANT_DISPLAY_NAMES: Record<string, string> = {
  AEROMEXICO: "Aeroméxico",
  AZULLINHASAEREASBRASILEIRAS: "Azul",
  DELTAAIRLINES: "Delta",
  GOLLINHASAEREAS: "Gol",
  GOLLINHASAEREASINTELIGENTES: "Gol",
  JETBLUEAIRWAYS: "JetBlue",
  PLUSULTRALINEASAEREAS: "Plus Ultra",
  VIVAAEROBUS: "Viva Aerobus",
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
