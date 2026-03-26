import { CanonicalOffer, Itinerary, Segment } from "./types";

function serializeSegment(segment: Segment): string {
  return [
    segment.marketingCarrier,
    segment.flightNumber,
    segment.origin,
    segment.destination,
    segment.departureAt,
    segment.arrivalAt,
  ].join("|");
}

export function buildOfferSignature(offer: CanonicalOffer): string {
  const itineraries = offer.itineraries
    .map((itinerary: Itinerary) =>
      itinerary.segments
        .map((segment: Segment) => serializeSegment(segment))
        .join("~"),
    )
    .join("||");

  return [
    offer.tripType,
    offer.origin,
    offer.destination,
    itineraries,
    offer.validatingCarrier ?? "",
  ].join("::");
}
