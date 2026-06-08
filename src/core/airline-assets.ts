export const AIRLINE_LOGO_CODES = [
  "4C",
  "4M",
  "AA",
  "AC",
  "AF",
  "AR",
  "AV",
  "CM",
  "DL",
  "H2",
  "IB",
  "JA",
  "JJ",
  "JZ",
  "KL",
  "LA",
  "LP",
  "LU",
  "OB",
  "PU",
  "PZ",
  "UX",
  "XL",
] as const;

const AIRLINE_LOGO_CODE_SET = new Set<string>(AIRLINE_LOGO_CODES);

export function normalizeAirlineAssetCode(value: unknown): string {
  const normalized = String(value ?? "").trim().toUpperCase();
  return /^[A-Z0-9]{2}$/.test(normalized) ? normalized : "";
}

export function airlineLogoAssetPath(value: unknown): string {
  const code = normalizeAirlineAssetCode(value);
  return code && AIRLINE_LOGO_CODE_SET.has(code) ? `/assets/airline-icons/${code}.png` : "";
}
