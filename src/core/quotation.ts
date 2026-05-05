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

function formatCommercialDate(iso?: string, timeZone?: string): string {
  if (!iso) {
    return "Fecha por confirmar";
  }

  const date = new Date(isDateOnly(iso) ? `${iso}T12:00:00` : iso);
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

  if (isDateOnly(iso)) {
    return "hora por confirmar";
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

  if (isDateOnly(iso)) {
    return formatCommercialDate(iso, timeZone);
  }

  return `${formatCommercialDate(iso, timeZone)} a las ${formatCommercialTime(iso, timeZone)}`;
}

function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
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

function formatCommercialPenPriceLine(amount: number | undefined, suffix: string): string {
  return amount === undefined
    ? `S/ ${suffix}`.trimEnd()
    : `S/ ${formatQuotationAmount(amount)} ${suffix}`.trimEnd();
}

function formatCommercialTotalLine(label: string, prefix: string, amount: number | undefined): string {
  return amount === undefined
    ? `${label}: ${prefix} `
    : `${label}: ${prefix} ${formatQuotationAmount(amount)}`;
}

function formatCommercialPenTotalLine(label: string, amount: number | undefined): string {
  return amount === undefined
    ? `${label}: S/ `
    : `${label}: S/ ${formatQuotationAmount(amount)}`;
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

function normalizedComparisonText(value?: string): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
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

function carrierDisplayName(offer: CanonicalOffer): string {
  return collectCarrierDisplayNames(offer).join(" + ");
}

function normalizeIataCode(code?: string): string {
  return String(code ?? "").trim().toUpperCase();
}

function stripAllAirportsLabel(value: string): string {
  return value
    .replace(/\s*\((?:todos\s+los\s+aeropuertos|all\s+airports)\)\s*/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function locationLabel(value?: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return "";
  }

  const withoutCode = stripAllAirportsLabel(normalized.replace(/^[A-Z]{3}\s*-\s*/, "").trim());
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

function itineraryEndpointCodes(itinerary: Itinerary | undefined): string[] {
  const first = firstSegment(itinerary);
  const last = lastSegment(itinerary);
  return [
    normalizeIataCode(first?.origin),
    normalizeIataCode(last?.destination),
  ].filter(Boolean);
}

export function shouldIncludePenQuotationPrice(offer: CanonicalOffer, request: SearchRequest): boolean {
  const requestEndpointCodes = request.legs.flatMap((leg) => [
    normalizeIataCode(leg.origin),
    normalizeIataCode(leg.destination),
  ]);
  const itineraryEndpointCodesList = offer.itineraries.flatMap((itinerary) => itineraryEndpointCodes(itinerary));

  return [...requestEndpointCodes, ...itineraryEndpointCodesList].includes("LIM");
}

function joinSpanishList(items: string[]): string {
  if (items.length <= 1) {
    return items[0] ?? "";
  }

  if (items.length === 2) {
    return `${items[0]} y ${items[1]}`;
  }

  return `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;
}

function extractBaggageWeightLabel(description?: string): string | undefined {
  const normalized = String(description ?? "").trim();
  if (!normalized) {
    return undefined;
  }

  const match = normalized.match(/\b\d+(?:[.,]\d+)?\s*(?:kg|kilos?|lb|lbs|libras?)\b/i);
  return match?.[0]?.replace(/\s+/g, " ");
}

function formatCheckedBaggageLabel(checkedBags?: number, description?: string): string {
  const weight = extractBaggageWeightLabel(description);
  const suffix = weight ? ` de ${weight}` : "";
  if (typeof checkedBags === "number" && checkedBags > 0) {
    return checkedBags === 1 ? `1 maleta de bodega${suffix}` : `${checkedBags} maletas de bodega${suffix}`;
  }

  return `maleta de bodega${suffix}`;
}

function buildCommercialBaggageInclusion(baggage?: CanonicalOffer["baggage"]): string | undefined {
  if (!baggage) {
    return undefined;
  }

  const items: string[] = [];
  if (baggage.carryOnIncluded) {
    items.push("mochila o artículo personal", "maleta de mano");
  }
  if (baggage.checkedIncluded) {
    items.push(formatCheckedBaggageLabel(baggage.checkedBags, baggage.description));
  }

  if (items.length === 0) {
    return undefined;
  }

  return `Equipaje incluido: ${joinSpanishList(items)}`;
}

function buildCommercialInclusions(offer: CanonicalOffer, request: SearchRequest): string[] {
  const items = [
    request.tripType === "round-trip"
      ? "Boleto de ida y vuelta"
      : "Boleto de solo ida",
  ];

  const baggageInclusion = buildCommercialBaggageInclusion(offer.baggage);
  if (baggageInclusion) {
    items.push(baggageInclusion);
  }

  items.push("Check in online");
  items.push("Asiento según disponibilidad");
  return items;
}

function buildCommercialExclusions(offer: CanonicalOffer): string[] {
  const items: string[] = [];

  if (offer.baggage?.carryOnIncluded === false) {
    items.push("Maleta de mano");
  }

  if (offer.baggage?.checkedIncluded === false) {
    items.push("Maleta de bodega");
  }

  return items;
}

function buildRestrictionsSummary(): string[] {
  return [
    "Reembolsos no permitidos después de emitir.",
    "Cambios de nombre no permitidos.",
    "Cambios de fecha y ruta sujetos a condiciones de la tarifa.",
  ];
}

function buildCommercialScheduleLine(
  label: string,
  itinerary: Itinerary | undefined,
  options: QuotationRenderOptions,
): string {
  const departureSegment = firstSegment(itinerary);
  const arrivalSegment = lastSegment(itinerary);
  const originCode = normalizeIataCode(departureSegment?.origin);
  const destinationCode = normalizeIataCode(arrivalSegment?.destination);
  const departureSchedule = formatCommercialSchedule(departureSegment?.departureAt, options.timeZone);
  const departureText = originCode ? `${originCode} · ${departureSchedule}` : departureSchedule;

  if (arrivalSegment?.arrivalAt) {
    const arrivalSchedule = formatCommercialSchedule(arrivalSegment.arrivalAt, options.timeZone);
    const arrivalText = destinationCode ? `${destinationCode} · ${arrivalSchedule}` : arrivalSchedule;
    return `${label}: ${departureText} → ${arrivalText}`;
  }

  return `${label}: ${departureText}`;
}

function itineraryStopCodes(itinerary: Itinerary | undefined): string[] {
  const segments = itinerary?.segments ?? [];
  return segments
    .slice(0, -1)
    .map((segment) => normalizeIataCode(segment.destination))
    .filter((code, index, codes) => code && codes.indexOf(code) === index);
}

function formatCommercialStops(itinerary: Itinerary | undefined): string {
  const segments = itinerary?.segments ?? [];
  const stopCount = typeof itinerary?.stops === "number"
    ? itinerary.stops
    : Math.max(0, segments.length - 1);

  if (stopCount <= 0) {
    return "Sin escalas";
  }

  const noun = stopCount === 1 ? "escala" : "escalas";
  const stopCodes = itineraryStopCodes(itinerary);
  if (stopCodes.length > 0) {
    return `${stopCount} ${noun} en ${joinSpanishList(stopCodes)}`;
  }

  return `${stopCount} ${noun}`;
}

function buildCommercialStopsLine(label: string, itinerary: Itinerary | undefined): string {
  return `${label}: ${formatCommercialStops(itinerary)}`;
}

function buildCommercialPriceLines(
  offer: CanonicalOffer,
  request: SearchRequest,
  options: QuotationRenderOptions,
): string[] {
  const currencyCode = String(offer.price.total.currencyCode ?? "").trim().toUpperCase();
  const totalAmount = offer.price.total.amount;
  const usdToPenRate = shouldIncludePenQuotationPrice(offer, request)
    && typeof options.usdToPenRate === "number"
    && Number.isFinite(options.usdToPenRate)
    && options.usdToPenRate > 0
    ? options.usdToPenRate
    : undefined;
  const adults = request.passengers.adults;
  const children = request.passengers.children;
  const infants = request.passengers.infants;

  if (currencyCode !== "USD") {
    return [
      formatCommercialTotalLine("Total", currencyCode || "USD", totalAmount),
    ];
  }

  if (adults > 0 && children === 0 && infants === 0) {
    const perAdultUsd = totalAmount / adults;
    const lines = [
      formatCommercialPriceLine("US$", perAdultUsd, "por adulto."),
    ];

    if (usdToPenRate) {
      lines.push(formatCommercialPenPriceLine(perAdultUsd * usdToPenRate, "aprox. por adulto."));
    }

    if (adults > 1) {
      lines.push(formatCommercialTotalLine("Total", "US$", totalAmount));
      if (usdToPenRate) {
        lines.push(formatCommercialPenTotalLine("Total aprox.", totalAmount * usdToPenRate));
      }
    }

    return lines;
  }

  const lines = [
    formatCommercialTotalLine("Total", "US$", totalAmount),
  ];

  if (usdToPenRate) {
    lines.push(formatCommercialPenTotalLine("Total aprox.", totalAmount * usdToPenRate));
  }

  return lines;
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
    buildCommercialStopsLine("🔁 Escalas ida", outbound),
  ];

  if (inbound) {
    lines.push(buildCommercialScheduleLine("🛬 Horario retorno", inbound, options));
    lines.push(buildCommercialStopsLine("🔁 Escalas retorno", inbound));
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
  restrictions.forEach((item, index) => lines.push(`${index === 0 ? "-" : "*"} ${item}`));
  lines.push("");
  lines.push("💵 PRECIO:");
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
