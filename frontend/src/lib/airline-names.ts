const TRAILING_AIRLINE_SUFFIX_PATTERN = /\s+Airlines?\.?$/i
const TRAILING_JETSMART_LEGAL_SUFFIX_PATTERN = /\s+S\.?P\.?A\.?$/i

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function comparableText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/gi, "")
    .toUpperCase()
}

function isJetSmartBase(value: string): boolean {
  return comparableText(value) === "JETSMART"
}

function isSkyBase(value: string): boolean {
  return comparableText(value) === "SKY"
}

function hasJetSmartLegalSuffix(value: string): boolean {
  if (!TRAILING_JETSMART_LEGAL_SUFFIX_PATTERN.test(value)) return false

  const withoutLegalSuffix = collapseWhitespace(value.replace(TRAILING_JETSMART_LEGAL_SUFFIX_PATTERN, ""))
  const withoutAirlineSuffix = collapseWhitespace(withoutLegalSuffix.replace(TRAILING_AIRLINE_SUFFIX_PATTERN, ""))
  return isJetSmartBase(withoutLegalSuffix) || isJetSmartBase(withoutAirlineSuffix)
}

function applyKnownAirlineStyle(value: string): string {
  if (isJetSmartBase(value)) return "JetSmart"
  if (isSkyBase(value)) return "Sky"
  return value
}

export function normalizeAirlineDisplayName(value: unknown): string {
  let normalized = collapseWhitespace(String(value ?? ""))
  if (!normalized) return ""

  for (let index = 0; index < 4; index += 1) {
    const before = normalized
    if (hasJetSmartLegalSuffix(normalized)) {
      normalized = collapseWhitespace(normalized.replace(TRAILING_JETSMART_LEGAL_SUFFIX_PATTERN, ""))
    }

    normalized = collapseWhitespace(normalized.replace(TRAILING_AIRLINE_SUFFIX_PATTERN, ""))
    if (normalized === before) break
  }

  return applyKnownAirlineStyle(normalized)
}
