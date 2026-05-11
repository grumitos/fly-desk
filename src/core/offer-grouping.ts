import type { CanonicalOffer, Itinerary, ProviderId, PurchasePath, Segment } from "./types";

const PROVIDER_LABELS: Record<ProviderId, string> = {
  "agil-local": "Agilsmart",
  costamar: "Costamar",
};

function normalizeToken(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function normalizeAmount(value: unknown): string {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : "0.00";
}

function normalizedFlightCode(segment: Segment): string {
  const carrier = normalizeToken(segment.marketingCarrier);
  const flightNumber = normalizeToken(segment.flightNumber).replace(/\s+/g, "");
  if (!flightNumber) return carrier;
  if (carrier && flightNumber.startsWith(carrier)) return flightNumber;
  return `${carrier}${flightNumber}`;
}

function segmentExactKey(segment: Segment): unknown {
  return [
    normalizedFlightCode(segment),
    normalizeToken(segment.origin),
    normalizeToken(segment.destination),
    String(segment.departureAt ?? "").trim(),
    String(segment.arrivalAt ?? "").trim(),
    String(segment.durationMinutes ?? ""),
    normalizeToken(segment.originTerminal),
    normalizeToken(segment.destinationTerminal),
  ];
}

function itineraryExactKey(itinerary: Itinerary): unknown {
  return [
    String(itinerary.direction ?? "").trim().toLowerCase(),
    String(itinerary.durationMinutes ?? ""),
    String(itinerary.stops ?? ""),
    (itinerary.layoverMinutes ?? []).map((minutes) => String(minutes)).join(","),
    (itinerary.segments ?? []).map(segmentExactKey),
  ];
}

function exactOfferGroupKey(offer: CanonicalOffer): string {
  return JSON.stringify([
    String(offer.tripType ?? "").trim().toLowerCase(),
    normalizeToken(offer.mainCarrier || offer.validatingCarrier),
    normalizeToken(offer.origin),
    normalizeToken(offer.destination),
    normalizeAmount(offer.price?.total?.amount),
    normalizeToken(offer.price?.total?.currencyCode),
    normalizeAmount(offer.price?.base?.amount),
    normalizeToken(offer.price?.base?.currencyCode),
    normalizeAmount(offer.price?.taxes?.amount),
    normalizeToken(offer.price?.taxes?.currencyCode),
    offer.baggage?.carryOnIncluded === true ? "1" : offer.baggage?.carryOnIncluded === false ? "0" : "u",
    offer.baggage?.checkedIncluded === true ? "1" : offer.baggage?.checkedIncluded === false ? "0" : "u",
    String(offer.baggage?.checkedBags ?? ""),
    (offer.itineraries ?? []).map(itineraryExactKey),
  ]);
}

function stableGroupId(key: string): string {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `exact-group-${(hash >>> 0).toString(36)}`;
}

function purchasePathFingerprint(path: PurchasePath): string {
  return JSON.stringify([
    path.provider,
    path.type,
    path.url ?? "",
    path.precision,
    path.state,
    path.commercialMode,
    path.referenceText ?? "",
  ]);
}

function mergePurchasePaths(left: PurchasePath[], right: PurchasePath[]): PurchasePath[] {
  const merged = new Map<string, PurchasePath>();
  for (const path of [...left, ...right]) {
    const key = purchasePathFingerprint(path);
    if (!merged.has(key)) {
      merged.set(key, path);
    }
  }
  return [...merged.values()];
}

function providerGroupTag(paths: PurchasePath[]): string | undefined {
  const providers = [...new Set(paths.map((path) => path.provider))]
    .sort((left, right) => providerRank(left) - providerRank(right));
  if (providers.length < 2) return undefined;
  return providers
    .map((provider) => PROVIDER_LABELS[provider] ?? provider)
    .join(" + ");
}

function providerRank(provider: ProviderId): number {
  if (provider === "agil-local") return 0;
  if (provider === "costamar") return 1;
  return 2;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

export function groupExactProviderOffers(offers: CanonicalOffer[]): CanonicalOffer[] {
  const grouped = new Map<string, CanonicalOffer>();

  for (const offer of offers) {
    const key = exactOfferGroupKey(offer);
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, {
        ...offer,
        id: stableGroupId(key),
        tags: [...offer.tags],
        warnings: [...offer.warnings],
        purchasePaths: [...offer.purchasePaths],
      });
      continue;
    }

    const purchasePaths = mergePurchasePaths(current.purchasePaths, offer.purchasePaths);
    const groupTag = providerGroupTag(purchasePaths);
    grouped.set(key, {
      ...current,
      purchasePaths,
      tags: uniqueStrings([
        ...current.tags,
        ...offer.tags,
        ...(groupTag ? [groupTag] : []),
      ]),
      warnings: uniqueStrings([...current.warnings, ...offer.warnings]),
    });
  }

  return [...grouped.values()];
}
