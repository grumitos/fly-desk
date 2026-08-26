/*
 * The marks that ship with the release.
 *
 * Not the marks that exist: a code missing from this list is fetched once from
 * the provider and cached (`airline-mark-store.ts`), so this is the set that is
 * available offline, on the first request, and without trusting anything the
 * network says that day. It holds the carriers eight ordinary LIM routes
 * actually return, which is where a cold fetch would otherwise be paid.
 *
 * It used to be the gate as well, and hand-kept: those same eight routes return
 * 38 distinct carriers, and gating on a list of 23 drew British Airways,
 * Turkish, Vueling, Alitalia, TAP and Emirates as their bare two letters. A
 * list nobody can finish should not decide what gets drawn.
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

const AIRLINE_LOGO_CODE_SET = new Set<string>(AIRLINE_LOGO_CODES);

export function normalizeAirlineAssetCode(value: unknown): string {
  const normalized = String(value ?? "").trim().toUpperCase();
  return /^[A-Z0-9]{2}$/.test(normalized) ? normalized : "";
}

/**
 * Where the card asks for a carrier's mark.
 *
 * Any well-formed code gets a path, not only the ones bundled above: the server
 * answers a code it has no file for by fetching it once from the provider that
 * returned the flight, and a code with no artwork anywhere answers `404`, which
 * the card draws as the two letters. Gating this on the bundled list instead is
 * what left British Airways, Turkish and Vueling as bare codes — the list was
 * hand-kept and the carriers a search returns are not.
 */
export function airlineLogoAssetPath(value: unknown): string {
  const code = normalizeAirlineAssetCode(value);
  return code ? `/assets/airline-icons/${code}.png` : "";
}

/** Whether the release itself carries the mark, with nothing to fetch. */
export function isBundledAirlineLogoCode(value: unknown): boolean {
  return AIRLINE_LOGO_CODE_SET.has(normalizeAirlineAssetCode(value));
}
