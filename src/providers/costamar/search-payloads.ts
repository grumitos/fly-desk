import type { CostamarProviderContext, SearchRequest } from "../../core/types";
import { resolveUsableCostamarBrandedToken } from "../../provider-context";

interface CostamarIsoDateParts {
  year: string;
  month: string;
  day: string;
}

export interface CostamarB2bFlightWarmupPayload {
  tripType: "one-way" | "round-trip";
  terminalId: string;
  origin: string;
  destination: string;
  departureDate: string;
  departureDisplayDate: string;
  returnDate?: string;
  returnDisplayDate?: string;
  adults: number;
  children: number;
  infants: number;
}

function splitIsoDateParts(dateIso?: string): CostamarIsoDateParts | undefined {
  const match = String(dateIso ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return undefined;
  }

  return {
    year: match[1],
    month: match[2],
    day: match[3],
  };
}

function toCostamarB2bDisplayDate(dateIso?: string): string | undefined {
  const parts = splitIsoDateParts(dateIso);
  if (!parts) {
    return undefined;
  }

  return `${parts.day}/${parts.month}/${parts.year}`;
}

function toCostamarDayStart(dateIso?: string): string | undefined {
  if (!dateIso) {
    return undefined;
  }

  return new Date(`${dateIso}T00:00:00-05:00`).toISOString();
}

function toCompactDate(dateIso?: string): string | undefined {
  return dateIso ? dateIso.replaceAll("-", "") : undefined;
}

export function buildCostamarB2bWarmupPayload(
  request: SearchRequest,
  context: CostamarProviderContext,
): CostamarB2bFlightWarmupPayload | undefined {
  const leg = request.legs[0];
  if (!leg || request.tripType === "multi-city") {
    return undefined;
  }

  const departureParts = splitIsoDateParts(leg.departureDate);
  const departureDisplayDate = toCostamarB2bDisplayDate(leg.departureDate);
  if (!departureParts || !departureDisplayDate || !context.terminalId) {
    return undefined;
  }

  if (request.tripType === "round-trip") {
    const returnParts = splitIsoDateParts(leg.returnDate);
    const returnDisplayDate = toCostamarB2bDisplayDate(leg.returnDate);
    if (!returnParts || !returnDisplayDate) {
      return undefined;
    }

    return {
      tripType: "round-trip",
      terminalId: context.terminalId,
      origin: leg.origin,
      destination: leg.destination,
      departureDate: `${departureParts.year}-${departureParts.month}-${departureParts.day}`,
      departureDisplayDate,
      returnDate: `${returnParts.year}-${returnParts.month}-${returnParts.day}`,
      returnDisplayDate,
      adults: request.passengers.adults,
      children: request.passengers.children,
      infants: request.passengers.infants,
    };
  }

  return {
    tripType: "one-way",
    terminalId: context.terminalId,
    origin: leg.origin,
    destination: leg.destination,
    departureDate: `${departureParts.year}-${departureParts.month}-${departureParts.day}`,
    departureDisplayDate,
    adults: request.passengers.adults,
    children: request.passengers.children,
    infants: request.passengers.infants,
  };
}

export function buildCostamarSearchBody(
  request: SearchRequest,
  context: CostamarProviderContext,
  flexible = false,
): Record<string, unknown> {
  const leg = request.legs[0];
  const departureDate = toCompactDate(leg.departureDate);
  const returnDate = toCompactDate(leg.returnDate);
  if (!departureDate) {
    throw new Error("Costamar exact search requires departureDate.");
  }

  const itinerary = [
    {
      origin: leg.origin,
      destination: leg.destination,
      date: departureDate,
    },
  ];

  if (request.tripType === "round-trip") {
    if (!returnDate) {
      throw new Error("Costamar round-trip search requires returnDate.");
    }

    itinerary.push({
      origin: leg.destination,
      destination: leg.origin,
      date: returnDate,
    });
  }

  const validationToken = resolveUsableCostamarBrandedToken(context.token, context.terminalId);

  return {
    flightType: request.tripType === "one-way" ? "OW" : "RT",
    terminalId: context.terminalId,
    itinerary,
    passengers: {
      adults: request.passengers.adults,
      children: request.passengers.children,
      infants: request.passengers.infants,
    },
    startDate: toCostamarDayStart(leg.departureDate),
    endDate: toCostamarDayStart(request.tripType === "round-trip" ? leg.returnDate : leg.departureDate),
    ...(validationToken ? { token: validationToken } : {}),
    hasValidationToken: Boolean(validationToken),
    flexible,
  };
}
