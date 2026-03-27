import { CanonicalOffer, Itinerary, SearchRequest, Segment } from "./types";

const SPANISH_MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

const CARRIER_NAME_FALLBACKS: Record<string, string> = {
  AC: "Air Canada",
  AR: "Aerolineas Argentinas",
  AV: "Avianca",
  IB: "Iberia",
  LA: "Latam",
  LP: "Latam Peru",
  OB: "Boliviana de Aviacion",
  PU: "Plus Ultra",
  UX: "Air Europa",
};

function formatMoney(amount: number, currency: string): string {
  return `${currency} ${amount.toFixed(2)}`;
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  const datePart = date.toISOString().slice(0, 10);
  const timePart = date.toISOString().slice(11, 16);
  return `${datePart} ${timePart}`;
}

function formatCommercialDateTime(iso?: string): string {
  if (!iso) {
    return "Fecha por confirmar";
  }

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  const day = String(date.getDate()).padStart(2, "0");
  const month = SPANISH_MONTHS[date.getMonth()] ?? "";
  const rawHours = date.getHours();
  const hours12 = rawHours % 12 || 12;
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const meridiem = rawHours >= 12 ? "pm" : "am";

  return `${day} ${month} (${String(hours12).padStart(2, "0")}:${minutes} ${meridiem})`;
}

function titleCase(value?: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return "";
  }

  return normalized
    .toLowerCase()
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function describePriceSource(offer: CanonicalOffer): string {
  if (offer.priceConfidence === "validated") {
    return "Reprice Agil";
  }

  return "Agil live";
}

function segmentLine(segment: Segment): string[] {
  return [
    `  Vuelo ${segment.flightNumber} · ${segment.marketingCarrier}`,
    `  Salida:   ${formatDateTime(segment.departureAt)}  ${segment.origin}${
      segment.originTerminal ? ` T${segment.originTerminal}` : ""
    }`,
    `  Llegada:  ${formatDateTime(segment.arrivalAt)}  ${segment.destination}${
      segment.destinationTerminal ? ` T${segment.destinationTerminal}` : ""
    }`,
    `  Duracion: ${segment.durationMinutes} min`,
  ];
}

function buildTechnicalQuotationText(
  offer: CanonicalOffer,
  request: SearchRequest,
): string {
  const lines: string[] = [];
  const mainPath = offer.purchasePaths[0];

  lines.push("COTIZACION DE VUELO");
  lines.push("========================================");
  lines.push("");
  lines.push(`RUTA:  ${offer.origin} -> ${offer.destination}`);
  lines.push(`TIPO:  ${offer.tripType}`);
  lines.push(`AEROLINEA: ${offer.mainCarrier ?? offer.validatingCarrier ?? "N/D"}`);
  lines.push("");

  for (const itinerary of offer.itineraries as Itinerary[]) {
    lines.push("----------------------------------------");
    lines.push(
      itinerary.direction === "inbound"
        ? "  VUELTA"
        : itinerary.direction === "outbound"
          ? "  IDA"
          : "  TRAMO",
    );
    lines.push("----------------------------------------");
    lines.push("");

    itinerary.segments.forEach((segment: Segment, index: number) => {
      lines.push(...segmentLine(segment));
      if (index < itinerary.segments.length - 1) {
        const next = itinerary.segments[index + 1];
        const connectionMinutes = Math.round(
          (new Date(next.departureAt).getTime() - new Date(segment.arrivalAt).getTime()) / 60000,
        );
        lines.push("");
        lines.push(`     Escala en ${segment.destination} · ${connectionMinutes} min`);
      }
      lines.push("");
    });
  }

  lines.push("PRECIO");
  lines.push("----------------------------------------");
  lines.push(
    `  TOTAL ..................... ${formatMoney(
      offer.price.total.amount,
      offer.price.total.currencyCode,
    )}`,
  );
  lines.push("");

  if (offer.fareMeta?.lastTicketingDate) {
    lines.push(`  Limite de emision ......... ${offer.fareMeta.lastTicketingDate}`);
  }
  if (typeof offer.fareMeta?.seatsRemaining === "number") {
    lines.push(`  Asientos visibles ......... ${offer.fareMeta.seatsRemaining}`);
  }
  if (offer.baggage?.description) {
    lines.push(`  Equipaje .................. ${offer.baggage.description}`);
  }

  lines.push("");
  lines.push("FUENTE DEL PRECIO");
  lines.push("----------------------------------------");
  lines.push(`  Fuente .................... ${describePriceSource(offer)}`);
  if (offer.priceVerifiedAt) {
    lines.push(`  Actualizado en ............ ${offer.priceVerifiedAt}`);
  }

  lines.push("");
  lines.push("SALIDA ACCIONABLE");
  lines.push("----------------------------------------");
  if (mainPath) {
    lines.push(`  Tipo ...................... ${mainPath.type}`);
    lines.push(`  Label ..................... ${mainPath.label}`);
    lines.push(`  Precision ................. ${mainPath.precision}`);
  } else {
    lines.push("  Tipo ...................... manual-reference");
  }

  lines.push("");
  lines.push("NOTAS");
  lines.push("----------------------------------------");
  lines.push("  - Precio sujeto a disponibilidad al emitir.");
  lines.push("  - Si el flujo termina en proveedor externo, el landing puede variar.");
  lines.push("  - Reprice recomendado antes de emitir.");
  lines.push("");
  lines.push(
    `PAX: ${request.passengers.adults} ADT / ${request.passengers.children} CHD / ${request.passengers.infants} INF`,
  );

  return lines.join("\n");
}

function firstSegment(itinerary?: Itinerary): Segment | undefined {
  return itinerary?.segments?.[0];
}

function lastSegment(itinerary?: Itinerary): Segment | undefined {
  const segments = itinerary?.segments ?? [];
  return segments.length ? segments[segments.length - 1] : undefined;
}

function carrierDisplayName(offer: CanonicalOffer): string {
  const outbound = offer.itineraries.find((itinerary) => itinerary.direction === "outbound") ?? offer.itineraries[0];
  const first = firstSegment(outbound);
  const rawName = first?.marketingCarrierName || first?.operatingCarrierName;
  if (rawName) {
    return titleCase(rawName);
  }

  const carrierCode = offer.mainCarrier ?? offer.validatingCarrier ?? "";
  return CARRIER_NAME_FALLBACKS[carrierCode] ?? (carrierCode || "Aerolínea por confirmar");
}

function cityFromCodeOrName(name?: string, code?: string): string {
  return titleCase(name) || code || "Ciudad por confirmar";
}

function routeSummary(offer: CanonicalOffer, request: SearchRequest): string {
  const outbound = offer.itineraries.find((itinerary) => itinerary.direction === "outbound") ?? offer.itineraries[0];
  const inbound = offer.itineraries.find((itinerary) => itinerary.direction === "inbound");
  const originCity = cityFromCodeOrName(firstSegment(outbound)?.originName, request.legs[0]?.origin);
  const destinationCity = cityFromCodeOrName(lastSegment(outbound)?.destinationName, request.legs[0]?.destination);

  if (offer.tripType === "round-trip") {
    const returnCity = cityFromCodeOrName(
      lastSegment(inbound)?.destinationName || firstSegment(outbound)?.originName,
      request.legs[0]?.origin,
    );
    return `${originCity} - ${destinationCity} - ${returnCity}`;
  }

  return `${originCity} - ${destinationCity}`;
}

function includesSummary(offer: CanonicalOffer, request: SearchRequest): string {
  const tripLabel = request.tripType === "round-trip"
    ? "Boleto de ida y vuelta"
    : "Boleto de solo ida";
  const baggage = offer.baggage?.description
    ? titleCase(offer.baggage.description)
    : "Equipaje segun tarifa";
  return `${tripLabel}, ${baggage}, check in online, asiento segun disponibilidad.`;
}

function restrictionsSummary(): string {
  return "cambios de nombre no permitidos. Cambios de fecha, ruta y reembolsos sujetos a condiciones de la tarifa.";
}

function buildCommercialQuotationText(
  offer: CanonicalOffer,
  request: SearchRequest,
): string {
  const outbound = offer.itineraries.find((itinerary) => itinerary.direction === "outbound") ?? offer.itineraries[0];
  const inbound = offer.itineraries.find((itinerary) => itinerary.direction === "inbound");
  const outboundDeparture = firstSegment(outbound)?.departureAt;
  const inboundDeparture = firstSegment(inbound)?.departureAt;

  const lines = [
    "COTIZACIÓN BOLETO AÉREO ✈️",
    "",
    `✈️Aerolínea: ${carrierDisplayName(offer)}`,
    `🛫 Ruta: ${routeSummary(offer, request)}`,
    `📆 Ida: ${formatCommercialDateTime(outboundDeparture)}`,
  ];

  if (inboundDeparture) {
    lines.push(`📆 Retorno: ${formatCommercialDateTime(inboundDeparture)}`);
  }

  lines.push("");
  lines.push(`✅ Incluye: ${includesSummary(offer, request)}`);
  lines.push("");
  lines.push(`🙅🏻‍♀️ No permite: ${restrictionsSummary()}`);
  lines.push("");
  lines.push("PRECIO:");
  lines.push("[Aquí no se coloca nada de momento, el agente decide]");

  return lines.join("\n");
}

export function buildQuotationText(
  offer: CanonicalOffer,
  request: SearchRequest,
): string {
  return [
    buildCommercialQuotationText(offer, request),
    "",
    "========================================",
    "DETALLE TECNICO",
    "========================================",
    "",
    buildTechnicalQuotationText(offer, request),
  ].join("\n");
}
