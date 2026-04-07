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
  AR: "Aerolíneas Argentinas",
  AV: "Avianca",
  IB: "Iberia",
  LA: "LATAM",
  LP: "LATAM Perú",
  OB: "Boliviana de Aviación",
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

function sentenceCase(value?: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return "";
  }

  if (!/^[\p{L}\s]+$/u.test(normalized)) {
    return normalized;
  }

  const lower = normalized.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function normalizedComparisonText(value?: string): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

function describePriceSource(offer: CanonicalOffer): string {
  const providerLabel = offer.providerSource === "costamar" ? "Costamar" : "Agil";
  if (offer.priceConfidence === "validated") {
    return `Reprice ${providerLabel}`;
  }

  return `${providerLabel} live`;
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
  const carrierCodes = collectCarrierCodes(offer);

  lines.push("COTIZACION DE VUELO");
  lines.push("========================================");
  lines.push("");
  lines.push(`RUTA:  ${offer.origin} -> ${offer.destination}`);
  lines.push(`TIPO:  ${offer.tripType}`);
  lines.push(`${carrierCodes.length > 1 ? "AEROLINEAS" : "AEROLINEA"}: ${carrierCodes.join(" / ") || "N/D"}`);
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

function carrierDisplayNameFromSegment(segment?: Segment): string {
  const carrierCode = segment?.marketingCarrier ?? segment?.operatingCarrier ?? "";
  const fallback = CARRIER_NAME_FALLBACKS[carrierCode] ?? (carrierCode || "Aerolínea por confirmar");
  const rawName = segment?.marketingCarrierName || segment?.operatingCarrierName;
  if (rawName) {
    const titled = titleCase(rawName);
    if (fallback && normalizedComparisonText(titled) === normalizedComparisonText(fallback)) {
      return fallback;
    }

    return titled;
  }

  return fallback;
}

function collectCarrierDisplayNames(offer: CanonicalOffer): string[] {
  const names: string[] = [];
  const seen = new Set<string>();

  offer.itineraries.forEach((itinerary) => {
    itinerary.segments.forEach((segment) => {
      const display = carrierDisplayNameFromSegment(segment);
      if (display && !seen.has(display)) {
        seen.add(display);
        names.push(display);
      }
    });
  });

  const fallbackCode = offer.mainCarrier ?? offer.validatingCarrier ?? "";
  const fallbackName = CARRIER_NAME_FALLBACKS[fallbackCode] ?? (fallbackCode || "Aerolínea por confirmar");
  if (names.length === 0 && fallbackName && !seen.has(fallbackName)) {
    names.push(fallbackName);
  }

  return names;
}

function collectCarrierCodes(offer: CanonicalOffer): string[] {
  const codes: string[] = [];
  const seen = new Set<string>();

  offer.itineraries.forEach((itinerary) => {
    itinerary.segments.forEach((segment) => {
      const code = (segment.marketingCarrier || segment.operatingCarrier || "").trim().toUpperCase();
      if (code && !seen.has(code)) {
        seen.add(code);
        codes.push(code);
      }
    });
  });

  const fallbackCode = (offer.mainCarrier ?? offer.validatingCarrier ?? "").trim().toUpperCase();
  if (codes.length === 0 && fallbackCode && !seen.has(fallbackCode)) {
    codes.push(fallbackCode);
  }

  return codes;
}

function carrierDisplayName(offer: CanonicalOffer): string {
  return collectCarrierDisplayNames(offer).join(" + ");
}

function normalizeIataCode(code?: string): string {
  return String(code ?? "").trim().toUpperCase();
}

function locationLabel(value?: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return "";
  }

  const withoutCode = normalized.replace(/^[A-Z]{3}\s*-\s*/, "").trim();
  const firstChunk = withoutCode.split(",")[0]?.trim() ?? "";
  const base = firstChunk || withoutCode;
  if (/^[A-Z]{3}$/.test(base)) {
    return base;
  }

  return titleCase(base);
}

function cityFromRequestOrName(requestLabel?: string, name?: string, code?: string): string {
  return locationLabel(requestLabel) || locationLabel(name) || code || "Ciudad por confirmar";
}

function locationDisplay(requestLabel?: string, name?: string, code?: string): string {
  const city = cityFromRequestOrName(requestLabel, name, normalizeIataCode(code));
  const iata = normalizeIataCode(code);
  return iata ? `${city} (${iata})` : city;
}

function routeSummary(offer: CanonicalOffer, request: SearchRequest): string {
  const outbound = offer.itineraries.find((itinerary) => itinerary.direction === "outbound") ?? offer.itineraries[0];
  const leg = request.legs[0];
  const originCity = locationDisplay(leg?.originLabel, firstSegment(outbound)?.originName, leg?.origin);
  const destinationCity = locationDisplay(
    leg?.destinationLabel,
    lastSegment(outbound)?.destinationName,
    leg?.destination,
  );

  if (request.tripType === "round-trip") {
    const returnCity = locationDisplay(leg?.originLabel, firstSegment(outbound)?.originName, leg?.origin);
    return `${originCity} - ${destinationCity} - ${returnCity}`;
  }

  return `${originCity} - ${destinationCity}`;
}

function buildCommercialInclusions(offer: CanonicalOffer, request: SearchRequest): string[] {
  const items = [
    request.tripType === "round-trip"
      ? "Boleto de ida y vuelta"
      : "Boleto de solo ida",
  ];

  if (offer.baggage?.checkedIncluded) {
    items.push(
      offer.baggage.description
        ? `Equipaje facturado: ${sentenceCase(offer.baggage.description)}`
        : "Equipaje facturado incluido",
    );
  } else if (offer.baggage?.carryOnIncluded) {
    items.push("Equipaje de mano");
  }

  items.push("Check in online");
  items.push("Asiento según disponibilidad");
  return items;
}

function buildCommercialExclusions(offer: CanonicalOffer): string[] {
  const items: string[] = [];

  if (offer.baggage?.checkedIncluded === false) {
    items.push("Maleta facturada");
  }

  if (offer.baggage?.carryOnIncluded === false) {
    items.push("Equipaje de mano");
  }

  return items;
}

function buildRestrictionsSummary(): string[] {
  return [
    "Cambios de nombre no permitidos.",
    "Cambios de fecha, ruta y reembolsos sujetos a condiciones de la tarifa.",
  ];
}

function buildCommercialQuotationText(
  offer: CanonicalOffer,
  request: SearchRequest,
): string {
  const outbound = offer.itineraries.find((itinerary) => itinerary.direction === "outbound") ?? offer.itineraries[0];
  const inbound = offer.itineraries.find((itinerary) => itinerary.direction === "inbound");
  const outboundDeparture = firstSegment(outbound)?.departureAt;
  const inboundDeparture = firstSegment(inbound)?.departureAt;
  const carrierNames = collectCarrierDisplayNames(offer);
  const inclusions = buildCommercialInclusions(offer, request);
  const exclusions = buildCommercialExclusions(offer);
  const restrictions = buildRestrictionsSummary();

  const lines = [
    "COTIZACIÓN BOLETO AÉREO ✈️",
    "",
    `✈️ Ruta: ${routeSummary(offer, request)}`,
    `✈️ ${carrierNames.length > 1 ? "Aerolíneas" : "Aerolínea"}: ${carrierDisplayName(offer)}`,
    `📆 Ida: ${formatCommercialDateTime(outboundDeparture)}`,
  ];

  if (inboundDeparture) {
    lines.push(`📆 Retorno: ${formatCommercialDateTime(inboundDeparture)}`);
  }

  lines.push("");
  lines.push("✅ INCLUYE");
  inclusions.forEach((item) => lines.push(`* ${item}`));

  if (exclusions.length > 0) {
    lines.push("");
    lines.push("🚫 NO INCLUYE");
    exclusions.forEach((item) => lines.push(`* ${item}`));
  }

  lines.push("");
  lines.push("📋 CONDICIONES");
  restrictions.forEach((item) => lines.push(`* ${item}`));
  lines.push("");
  lines.push("💵 PRECIO:");
  lines.push("");
  lines.push("$ ______ dólares por adulto");
  lines.push("S/. ______ soles por adulto");

  return lines.join("\n");
}

export function buildCommercialQuotation(
  offer: CanonicalOffer,
  request: SearchRequest,
): string {
  return buildCommercialQuotationText(offer, request);
}

export function buildTechnicalQuotation(
  offer: CanonicalOffer,
  request: SearchRequest,
): string {
  return buildTechnicalQuotationText(offer, request);
}

export function buildQuotationText(
  offer: CanonicalOffer,
  request: SearchRequest,
): string {
  return [
    buildCommercialQuotation(offer, request),
    "",
    "========================================",
    "DETALLE TECNICO",
    "========================================",
    "",
    buildTechnicalQuotation(offer, request),
  ].join("\n");
}
