import { CanonicalOffer, Itinerary, PurchasePath } from "./types";

function minBy<T>(values: T[], pick: (value: T) => number): number {
  if (values.length === 0) return 0;
  return Math.min(...values.map(pick));
}

function maxBy<T>(values: T[], pick: (value: T) => number): number {
  if (values.length === 0) return 1;
  return Math.max(...values.map(pick));
}

export function totalDuration(offer: CanonicalOffer): number {
  return offer.itineraries.reduce(
    (sum: number, itinerary: Itinerary) => sum + itinerary.durationMinutes,
    0,
  );
}

export function totalStops(offer: CanonicalOffer): number {
  return offer.itineraries.reduce(
    (sum: number, itinerary: Itinerary) => sum + itinerary.stops,
    0,
  );
}

function purchasePathScore(offer: CanonicalOffer): number {
  if (offer.purchasePaths.some((path: PurchasePath) => path.precision === "exact-offer")) {
    return 3;
  }

  if (offer.purchasePaths.some((path: PurchasePath) => path.type === "search-redirect")) {
    return 2;
  }

  if (offer.purchasePaths.some((path: PurchasePath) => path.type === "manual-reference")) {
    return 1;
  }

  return 0;
}

function baggageScore(offer: CanonicalOffer): number {
  if (offer.baggage?.checkedIncluded) {
    return 2;
  }

  if (offer.baggage?.carryOnIncluded) {
    return 1;
  }

  return 0;
}

export function enrichComparisonMetrics(offers: CanonicalOffer[]): CanonicalOffer[] {
  return offers.map((offer) => ({
    ...offer,
    comparisonMetrics: {
      totalDurationMinutes: totalDuration(offer),
      totalStops: totalStops(offer),
      baggageScore: baggageScore(offer),
      purchasePathScore: purchasePathScore(offer),
    },
  }));
}

export function computeValueScores(offers: CanonicalOffer[]): CanonicalOffer[] {
  if (offers.length === 0) return offers;

  const minPrice = minBy(offers, (offer) => offer.price.total.amount);
  const maxPrice = maxBy(offers, (offer) => offer.price.total.amount);
  const minDuration = minBy(offers, (offer) => totalDuration(offer));
  const maxDuration = maxBy(offers, (offer) => totalDuration(offer));

  return offers.map((offer) => {
    const duration = totalDuration(offer);
    const stops = totalStops(offer);

    const priceNorm =
      maxPrice === minPrice
        ? 0
        : (offer.price.total.amount - minPrice) / (maxPrice - minPrice);

    const durationNorm =
      maxDuration === minDuration
        ? 0
        : (duration - minDuration) / (maxDuration - minDuration);

    const stopPenalty = stops * 0.12;
    const verifiedBonus = offer.priceConfidence === "validated" ? -0.1 : 0;
    const exactPathBonus = offer.purchasePaths.some(
      (path: PurchasePath) => path.precision === "exact-offer",
    )
      ? -0.05
      : 0;
    const baggageBonus = offer.baggage?.checkedIncluded ? -0.03 : 0;

    const valueScore = Number(
      (
        priceNorm * 0.55 +
        durationNorm * 0.25 +
        stopPenalty +
        verifiedBonus +
        exactPathBonus +
        baggageBonus
      ).toFixed(4),
    );

    return { ...offer, valueScore };
  });
}

export function sortOffers(
  offers: CanonicalOffer[],
  mode: "cheapest" | "fastest" | "best-value",
): CanonicalOffer[] {
  const cloned = [...offers];

  switch (mode) {
    case "cheapest":
      return cloned.sort((a, b) => a.price.total.amount - b.price.total.amount);
    case "fastest":
      return cloned.sort((a, b) => totalDuration(a) - totalDuration(b));
    case "best-value":
    default:
      return cloned.sort((a, b) => a.valueScore - b.valueScore);
  }
}
