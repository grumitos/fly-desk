/*
 * The marks that ship with the release.
 *
 * Not the marks that exist: a code missing from this list is fetched once from
 * the provider and cached (`airline-mark-store.ts`), so this is the set that is
 * available offline, on the first request, and without trusting anything the
 * network says that day. It holds the carriers eight ordinary LIM routes
 * actually return, which is where a cold fetch would otherwise be paid. It is
 * not a gate: a list nobody can finish should not decide what gets drawn.
 */
export const AIRLINE_LOGO_CODES = [
  "4C",
  "4M",
  "A5",
  "AA",
  "AC",
  "AF",
  "AM",
  "AR",
  "AV",
  "AZ",
  "B6",
  "BA",
  "CM",
  "DL",
  "DM",
  "EK",
  "EN",
  "G3",
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
  "TK",
  "TP",
  "UA",
  "UX",
  "VY",
  "XL",
  "Y4",
] as const;

export function normalizeAirlineAssetCode(value: unknown): string {
  const normalized = String(value ?? "").trim().toUpperCase();
  return /^[A-Z0-9]{2}$/.test(normalized) ? normalized : "";
}

/**
 * Where the card asks for a carrier's mark.
 *
 * Any well-formed code gets a path, not only the ones bundled above: the server
 * answers a code it has no file for by fetching it once from the provider's
 * CDN, and a code with no artwork anywhere answers `404`, which the card draws
 * as the two letters.
 */
export function airlineLogoAssetPath(value: unknown): string {
  const code = normalizeAirlineAssetCode(value);
  return code ? `/assets/airline-icons/${code}.png` : "";
}
