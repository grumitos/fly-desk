/*
 * Which carriers have a mark, which is not the same list as the one that has a
 * *name*: `airline-names.ts` knows more codes than there are files here, and a
 * code with no file falls back to the two letters — legible at 32px, which the
 * marks that are wordmarks rather than symbols are not.
 *
 * That is the whole criterion, and it is applied by looking: `AM`, `UA` and
 * `LH` are symbols and read cleanly in a 32px slot; the six carriers the name
 * catalogue knows and this list omits — `AD`, `B6`, `G3`, `NK`, `VB`, `Y4` —
 * ship a wordmark as their only artwork, and «jetBlue» rendered 32px wide is
 * less legible than «B6». The gap is a decision about the card, not an
 * omission, and a code with no file is a supported state rather than a bug.
 */
export const AIRLINE_LOGO_CODES = [
  "4C",
  "4M",
  "AA",
  "AC",
  "AF",
  "AM",
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
  "LH",
  "LP",
  "LU",
  "OB",
  "PU",
  "PZ",
  "UA",
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
