import { createHash } from "node:crypto";
import type {
  CanonicalOffer,
  Itinerary,
  OfferScheduleCombination,
  OfferScheduleGroup,
  OfferScheduleOption,
} from "./types";

interface ScheduleVariant {
  offer: CanonicalOffer;
  outbound: Itinerary;
  inbound?: Itinerary;
  outboundIdentity: string;
  inboundIdentity?: string;
}

interface ScheduleGroupBucket {
  key: string;
  providerSource: CanonicalOffer["providerSource"];
  variants: ScheduleVariant[];
}

function rawRefString(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized || undefined;
}

function costamarRecommendationBase(value: string): string {
  return value.split(":")[0]?.trim() || value;
}

function nativeScheduleGroupId(offer: CanonicalOffer): string | undefined {
  if (offer.providerSource === "agil-local") {
    const groupId = rawRefString(offer.rawRefs?.agilGroupId);
    return groupId ? `agil:${groupId}` : undefined;
  }

  const recommendationId = rawRefString(offer.rawRefs?.recommendationId);
  return recommendationId
    ? `costamar:${costamarRecommendationBase(recommendationId)}`
    : undefined;
}

function itineraryDepartureDate(itinerary: Itinerary | undefined): string | undefined {
  const departureAt = itinerary?.segments[0]?.departureAt;
  if (typeof departureAt !== "string") {
    return undefined;
  }

  const date = departureAt.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
}

function nativeScheduleScope(offer: CanonicalOffer): string | undefined {
  const outboundDate = itineraryDepartureDate(itineraryForDirection(offer, "outbound"));
  const inboundDate = itineraryDepartureDate(itineraryForDirection(offer, "inbound"));
  if (!outboundDate || (offer.tripType === "round-trip" && !inboundDate)) {
    return undefined;
  }

  return JSON.stringify([
    rawRefString(offer.rawRefs?.scheduleGroupScope) ?? null,
    offer.providerSource === "agil-local"
      ? rawRefString(offer.rawRefs?.gdsId) ?? null
      : null,
    outboundDate,
    inboundDate ?? null,
  ]);
}

function commercialTermsSignature(offer: CanonicalOffer): string | undefined {
  const amount = offer.price?.total?.amount;
  const currencyCode = offer.price?.total?.currencyCode?.trim().toUpperCase();
  if (!Number.isFinite(amount) || !currencyCode) {
    return undefined;
  }

  return JSON.stringify([
    currencyCode,
    amount,
    offer.baggage?.carryOnIncluded ?? null,
    offer.baggage?.checkedIncluded ?? null,
    offer.baggage?.checkedBags ?? null,
    offer.baggage?.description ?? null,
  ]);
}

function groupKeyForOffer(offer: CanonicalOffer): string | undefined {
  const nativeGroupId = nativeScheduleGroupId(offer);
  const nativeScope = nativeScheduleScope(offer);
  const commercialTerms = commercialTermsSignature(offer);
  if (!nativeGroupId || !nativeScope || !commercialTerms) {
    return undefined;
  }

  return JSON.stringify([
    offer.providerSource,
    nativeGroupId,
    nativeScope,
    offer.tripType,
    offer.origin,
    offer.destination,
    commercialTerms,
  ]);
}

function itineraryFingerprint(itinerary: Itinerary): string {
  return JSON.stringify([
    itinerary.direction,
    itinerary.durationMinutes,
    itinerary.stops,
    itinerary.layoverMinutes,
    itinerary.segments.map((segment) => [
      segment.marketingCarrier,
      segment.marketingCarrierName ?? null,
      segment.operatingCarrier ?? null,
      segment.operatingCarrierName ?? null,
      segment.flightNumber,
      segment.origin,
      segment.originName ?? null,
      segment.destination,
      segment.destinationName ?? null,
      segment.departureAt,
      segment.arrivalAt,
      segment.durationMinutes,
      segment.originTerminal ?? null,
      segment.destinationTerminal ?? null,
    ]),
  ]);
}

function itineraryForDirection(
  offer: CanonicalOffer,
  direction: "outbound" | "inbound",
): Itinerary | undefined {
  return offer.itineraries.find((itinerary) => itinerary.direction === direction);
}

function optionIdentity(
  offer: CanonicalOffer,
  direction: "outbound" | "inbound",
  itinerary: Itinerary,
): string {
  const providerKey = offer.providerSource === "agil-local"
    ? rawRefString(offer.rawRefs?.[direction === "outbound" ? "outboundKey" : "inboundKey"])
    : undefined;
  return JSON.stringify([providerKey ?? null, itineraryFingerprint(itinerary)]);
}

function scheduleVariant(offer: CanonicalOffer): ScheduleVariant | undefined {
  if (!offer.id.trim() || offer.tripType === "multi-city") {
    return undefined;
  }

  const outbound = itineraryForDirection(offer, "outbound");
  const inbound = itineraryForDirection(offer, "inbound");
  if (!outbound || (offer.tripType === "round-trip" && !inbound)) {
    return undefined;
  }
  if (offer.tripType === "one-way" && inbound) {
    return undefined;
  }

  return {
    offer,
    outbound,
    ...(inbound ? { inbound } : {}),
    outboundIdentity: optionIdentity(offer, "outbound", outbound),
    ...(inbound ? { inboundIdentity: optionIdentity(offer, "inbound", inbound) } : {}),
  };
}

function opaqueId(prefix: string, value: string): string {
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `${prefix}:${digest}`;
}

function materializeGroup(bucket: ScheduleGroupBucket): OfferScheduleGroup | undefined {
  const outboundOptions = new Map<string, OfferScheduleOption>();
  const inboundOptions = new Map<string, OfferScheduleOption>();
  const combinations: OfferScheduleCombination[] = [];
  const seenPairs = new Set<string>();
  const groupId = opaqueId("schedule-group", bucket.key);

  for (const variant of bucket.variants) {
    const outboundOptionId = opaqueId(
      "outbound",
      `${bucket.key}\u0000${variant.outboundIdentity}`,
    );
    if (!outboundOptions.has(outboundOptionId)) {
      outboundOptions.set(outboundOptionId, {
        id: outboundOptionId,
        itinerary: variant.outbound,
      });
    }

    const inboundOptionId = variant.inbound && variant.inboundIdentity
      ? opaqueId("inbound", `${bucket.key}\u0000${variant.inboundIdentity}`)
      : undefined;
    if (inboundOptionId && variant.inbound && !inboundOptions.has(inboundOptionId)) {
      inboundOptions.set(inboundOptionId, {
        id: inboundOptionId,
        itinerary: variant.inbound,
      });
    }

    const pairKey = `${outboundOptionId}\u0000${inboundOptionId ?? ""}`;
    if (seenPairs.has(pairKey)) {
      continue;
    }
    seenPairs.add(pairKey);
    combinations.push({
      outboundOptionId,
      ...(inboundOptionId ? { inboundOptionId } : {}),
      offerId: variant.offer.id,
    });
  }

  if (combinations.length <= 1) {
    return undefined;
  }

  return {
    id: groupId,
    providerSource: bucket.providerSource,
    outboundOptions: [...outboundOptions.values()],
    ...(inboundOptions.size > 0 ? { inboundOptions: [...inboundOptions.values()] } : {}),
    combinations,
    truncated: bucket.variants.some(
      ({ offer }) => offer.rawRefs?.scheduleVariantsTruncated === true,
    ),
  };
}

/**
 * Builds selectable schedule groups exclusively from complete offers already
 * returned by a provider. It never creates a Cartesian product or a price.
 */
export function buildOfferScheduleGroups(
  offers: readonly CanonicalOffer[],
): OfferScheduleGroup[] {
  const buckets = new Map<string, ScheduleGroupBucket>();
  const seenOfferIds = new Set<string>();

  for (const offer of offers) {
    if (seenOfferIds.has(offer.id)) {
      continue;
    }
    seenOfferIds.add(offer.id);

    const key = groupKeyForOffer(offer);
    const variant = scheduleVariant(offer);
    if (!key || !variant) {
      continue;
    }

    const bucket = buckets.get(key);
    if (bucket) {
      bucket.variants.push(variant);
    } else {
      buckets.set(key, {
        key,
        providerSource: offer.providerSource,
        variants: [variant],
      });
    }
  }

  return [...buckets.values()].flatMap((bucket) => {
    const group = materializeGroup(bucket);
    return group ? [group] : [];
  });
}
