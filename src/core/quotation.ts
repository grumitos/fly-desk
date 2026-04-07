import { CanonicalOffer, Itinerary, SearchRequest, Segment } from "./types";

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

export interface QuotationRenderOptions {
  timeZone?: string;
  usdToPenRate?: number;
}

function formatMoney(amount: number, currency: string): string {
  return `${currency} ${amount.toFixed(2)}`;
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  const datePart = date.toISOString().slice(0, 10);
  const timePart = date.toISOString().slice(11, 16);
  return `${datePart} ${timePart}`;
}

function formatCommercialDate(iso?: string, timeZone?: string): string {
  if (!iso) {
    return "Fecha por confirmar";
  }

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  const formatter = new Intl.DateTimeFormat("es-PE", {
    day: "2-digit",
    month: "long",
    ...(timeZone ? { timeZone } : {}),
  });
  const parts = formatter.formatToParts(date);
  const day = parts.find((part) => part.type === "day")?.value;
  const month = parts.find((part) => part.type === "month")?.value;

  return day && month ? `${day} ${month}` : formatter.format(date).replace("-", " ");
}

function formatCommercialTime(iso?: string, timeZone?: string): string {
  if (!iso) {
    return "Hora por confirmar";
  }

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  const dayPeriod = parts.find((part) => part.type === "dayPeriod")?.value?.toLowerCase();

  return hour && minute && dayPeriod ? `${hour}:${minute} ${dayPeriod}` : iso;
}

function formatCommercialSchedule(iso?: string, timeZone?: string): string {
  if (!iso) {
    return "Fecha por confirmar";
  }

  return `${formatCommercialDate(iso, timeZone)} a las ${formatCommercialTime(iso, timeZone)}`;
}

function formatQuotationAmount(amount: number): string {
  const normalized = Math.abs(amount - Math.round(amount)) < 0.005
    ? Math.round(amount)
    : Number(amount.toFixed(2));
  const hasDecimals = Math.abs(normalized - Math.round(normalized)) >= 0.005;

  return new Intl.NumberFormat("es-PE", {
    minimumFractionDigits: hasDecimals ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(normalized);
}

function formatCommercialPriceLine(prefix: string, amount: number | undefined, suffix: string): string {
  return amount === undefined
    ? `${prefix}  ${suffix}`.trimEnd()
    : `${prefix} ${formatQuotationAmount(amount)} ${suffix}`.trimEnd();
}

function formatCommercialTotalLine(label: string, prefix: string, amount: number | undefined): string {
  return amount === undefined
    ? `${label}: ${prefix} `
    : `${label}: ${prefix} ${formatQuotationAmount(amount)}`;
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
  return offer.providerSource === "costamar" ? "Costamar" : "Agil";
}

function formatTripType(tripType: SearchRequest["tripType"]): string {
  if (tripType === "one-way") {
    return "Solo ida";
  }
  if (tripType === "multi-city") {
    return "Multidestino";
  }
  return "Ida y vuelta";
}

function pushTechnicalSection(lines: string[], title: string): void {
  if (lines.length > 0 && lines[lines.length - 1] !== "") {
    lines.push("");
  }

  lines.push(title);
}

function pushTechnicalField(lines: string[], label: string, value?: string | number | null): void {
  if (value === undefined || value === null || value === "") {
    return;
  }

  lines.push(`${label}: ${value}`);
}

function segmentLine(segment: Segment): string[] {
  const carrierCode = (segment.marketingCarrier || segment.operatingCarrier || "").trim();
  const flightNumber = String(segment.flightNumber || "").trim();
  const flightLabel = [carrierCode, flightNumber].filter(Boolean).join(" ") || "Por confirmar";
  const originLabel = `${segment.origin}${segment.originTerminal ? ` T${segment.originTerminal}` : ""}`;
  const destinationLabel = `${segment.destination}${segment.destinationTerminal ? ` T${segment.destinationTerminal}` : ""}`;

  return [
    `Vuelo: ${flightLabel}`,
    `Salida: ${formatDateTime(segment.departureAt)} · ${originLabel}`,
    `Llegada: ${formatDateTime(segment.arrivalAt)} · ${destinationLabel}`,
    `Duracion: ${segment.durationMinutes} min`,
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
  lines.push("");
  pushTechnicalField(lines, "Ruta", `${offer.origin} -> ${offer.destination}`);
  pushTechnicalField(lines, "Tipo", formatTripType(request.tripType));
  pushTechnicalField(
    lines,
    carrierCodes.length > 1 ? "Aerolineas" : "Aerolinea",
    carrierCodes.join(" / ") || "N/D",
  );

  for (const itinerary of offer.itineraries as Itinerary[]) {
    pushTechnicalSection(
      lines,
      itinerary.direction === "inbound"
        ? "Vuelta"
        : itinerary.direction === "outbound"
          ? "Ida"
          : "Tramo",
    );

    itinerary.segments.forEach((segment: Segment, index: number) => {
      if (itinerary.segments.length > 1) {
        lines.push(`Segmento ${index + 1}`);
      }
      lines.push(...segmentLine(segment));
      if (index < itinerary.segments.length - 1) {
        const next = itinerary.segments[index + 1];
        const connectionMinutes = Math.round(
          (new Date(next.departureAt).getTime() - new Date(segment.arrivalAt).getTime()) / 60000,
        );
        lines.push("");
        lines.push(`Escala: ${segment.destination} · ${connectionMinutes} min`);
      }

      if (index < itinerary.segments.length - 1) {
        lines.push("");
      }
    });
  }

  pushTechnicalSection(lines, "Precio");
  pushTechnicalField(lines, "Total", formatMoney(
    offer.price.total.amount,
    offer.price.total.currencyCode,
  ));

  if (offer.fareMeta?.lastTicketingDate) {
    pushTechnicalField(lines, "Limite de emision", offer.fareMeta.lastTicketingDate);
  }
  if (typeof offer.fareMeta?.seatsRemaining === "number") {
    pushTechnicalField(lines, "Asientos visibles", offer.fareMeta.seatsRemaining);
  }
  if (offer.baggage?.description) {
    pushTechnicalField(lines, "Equipaje", offer.baggage.description);
  }

  pushTechnicalSection(lines, "Fuente del precio");
  pushTechnicalField(lines, "Fuente", describePriceSource(offer));

  pushTechnicalSection(lines, "Salida accionable");
  if (mainPath) {
    pushTechnicalField(lines, "Tipo", mainPath.type);
    pushTechnicalField(lines, "Label", mainPath.label);
    pushTechnicalField(lines, "Precision", mainPath.precision);
  } else {
    pushTechnicalField(lines, "Tipo", "manual-reference");
  }

  pushTechnicalSection(lines, "Notas");
  lines.push("- Precio sujeto a disponibilidad al emitir.");
  lines.push("- Si el flujo termina en proveedor externo, el landing puede variar.");
  lines.push("- Reprice recomendado antes de emitir.");
  lines.push("");
  pushTechnicalField(
    lines,
    "PAX",
    `${request.passengers.adults} ADT / ${request.passengers.children} CHD / ${request.passengers.infants} INF`,
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

function buildCommercialScheduleLine(
  label: string,
  itinerary: Itinerary | undefined,
  options: QuotationRenderOptions,
): string {
  const departureSegment = firstSegment(itinerary);
  const originCode = normalizeIataCode(departureSegment?.origin);
  const schedule = formatCommercialSchedule(departureSegment?.departureAt, options.timeZone);

  return `${label}: ${originCode ? `${originCode} · ` : ""}${schedule}`;
}

function buildCommercialPriceLines(
  offer: CanonicalOffer,
  request: SearchRequest,
  options: QuotationRenderOptions,
): string[] {
  const currencyCode = String(offer.price.total.currencyCode ?? "").trim().toUpperCase();
  const totalAmount = offer.price.total.amount;
  const adults = request.passengers.adults;
  const children = request.passengers.children;
  const infants = request.passengers.infants;
  const usdToPenRate = typeof options.usdToPenRate === "number" && options.usdToPenRate > 0
    ? options.usdToPenRate
    : undefined;

  if (currencyCode !== "USD") {
    return [
      formatCommercialTotalLine("Total", currencyCode || "USD", totalAmount),
    ];
  }

  if (adults > 0 && children === 0 && infants === 0) {
    const perAdultUsd = totalAmount / adults;
    const perAdultPen = usdToPenRate === undefined ? undefined : perAdultUsd * usdToPenRate;
    const lines = [
      formatCommercialPriceLine("US$", perAdultUsd, "por adulto"),
      formatCommercialPriceLine("S/", perAdultPen, "por adulto"),
    ];

    if (adults > 1) {
      lines.push(formatCommercialTotalLine("Total", "US$", totalAmount));
      lines.push(
        formatCommercialTotalLine(
          "Total en soles",
          "S/",
          usdToPenRate === undefined ? undefined : totalAmount * usdToPenRate,
        ),
      );
    }

    return lines;
  }

  return [
    formatCommercialTotalLine("Total", "US$", totalAmount),
    formatCommercialTotalLine(
      "Total en soles",
      "S/",
      usdToPenRate === undefined ? undefined : totalAmount * usdToPenRate,
    ),
  ];
}

function buildCommercialQuotationText(
  offer: CanonicalOffer,
  request: SearchRequest,
  options: QuotationRenderOptions = {},
): string {
  const outbound = offer.itineraries.find((itinerary) => itinerary.direction === "outbound") ?? offer.itineraries[0];
  const inbound = offer.itineraries.find((itinerary) => itinerary.direction === "inbound");
  const carrierNames = collectCarrierDisplayNames(offer);
  const inclusions = buildCommercialInclusions(offer, request);
  const exclusions = buildCommercialExclusions(offer);
  const restrictions = buildRestrictionsSummary();
  const priceLines = buildCommercialPriceLines(offer, request, options);

  const lines = [
    "COTIZACIÓN BOLETO AÉREO ✈️",
    "",
    `✈️ Ruta: ${routeSummary(offer, request)}`,
    `✈️ ${carrierNames.length > 1 ? "Aerolíneas" : "Aerolínea"}: ${carrierDisplayName(offer)}`,
    buildCommercialScheduleLine("🛫 Horario ida", outbound, options),
  ];

  if (inbound) {
    lines.push(buildCommercialScheduleLine("🛬 Horario retorno", inbound, options));
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
  priceLines.forEach((line) => lines.push(line));

  return lines.join("\n");
}

export function buildCommercialQuotation(
  offer: CanonicalOffer,
  request: SearchRequest,
  options?: QuotationRenderOptions,
): string {
  return buildCommercialQuotationText(offer, request, options);
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
  options?: QuotationRenderOptions,
): string {
  return [
    buildCommercialQuotation(offer, request, options),
    "",
    "DETALLE TECNICO",
    "",
    buildTechnicalQuotation(offer, request),
  ].join("\n");
}
