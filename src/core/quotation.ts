import type { CanonicalOffer, Itinerary, QuotationUsdToPenRateInfo, SearchRequest, Segment } from "./types";
import {
  cityNameForIataCode,
  countryCodeForIataCode,
  isAirportFacilityLabel,
  normalizeIataCode,
  stripAllAirportsLabel,
} from "./location-display";
import { resolveAirlineDisplayName } from "./airline-names";

export const QUOTATION_FARE_STALE_MINUTES = 15;
export const QUOTATION_FARE_FRESHNESS_MS = QUOTATION_FARE_STALE_MINUTES * 60_000;

export interface QuotationRenderOptions {
  timeZone?: string;
  usdToPenRate?: number;
  usdToPenRateInfo?: QuotationUsdToPenRateInfo;
  migrationPlan?: boolean;
}

const PERU_AIRPORT_CODES = new Set([
  "ANS",
  "AQP",
  "ATA",
  "AYP",
  "CIX",
  "CJA",
  "CUZ",
  "HUU",
  "ILQ",
  "IQT",
  "JAU",
  "JJI",
  "JUL",
  "LIM",
  "PEM",
  "PIO",
  "PCL",
  "PIU",
  "RIJ",
  "TBP",
  "TCQ",
  "TGI",
  "TPP",
  "TRU",
  "TYL",
]);

function commercialScheduleDate(iso: string, timeZone?: string): { date: Date; timeZone?: string } | undefined {
  if (isDateOnly(iso) || !timeZone) {
    const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/);
    if (match) {
      const [, yearValue, monthValue, dayValue, hourValue = "12", minuteValue = "00", secondValue = "00"] = match;
      const year = Number(yearValue);
      const month = Number(monthValue) - 1;
      const day = Number(dayValue);
      const hour = Number(hourValue);
      const minute = Number(minuteValue);
      const second = Number(secondValue);
      const date = new Date(Date.UTC(year, month, day, hour, minute, second));
      if (
        date.getUTCFullYear() === year
        && date.getUTCMonth() === month
        && date.getUTCDate() === day
        && date.getUTCHours() === hour
        && date.getUTCMinutes() === minute
        && date.getUTCSeconds() === second
      ) {
        return { date, timeZone: "UTC" };
      }
    }
  }

  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : { date, timeZone };
}

function formatCommercialDate(iso?: string, timeZone?: string): string {
  if (!iso) {
    return "Fecha por confirmar";
  }

  const schedule = commercialScheduleDate(iso, timeZone);
  if (!schedule) {
    return iso;
  }

  const formatter = new Intl.DateTimeFormat("es-PE", {
    day: "2-digit",
    month: "long",
    ...(schedule.timeZone ? { timeZone: schedule.timeZone } : {}),
  });
  const parts = formatter.formatToParts(schedule.date);
  const day = parts.find((part) => part.type === "day")?.value;
  const month = parts.find((part) => part.type === "month")?.value;

  return day && month ? `${day} ${month}` : formatter.format(schedule.date).replace("-", " ");
}

function formatCommercialTime(iso?: string, timeZone?: string): string {
  if (!iso) {
    return "Hora por confirmar";
  }

  if (isDateOnly(iso)) {
    return "hora por confirmar";
  }

  const schedule = commercialScheduleDate(iso, timeZone);
  if (!schedule) {
    return iso;
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    ...(schedule.timeZone ? { timeZone: schedule.timeZone } : {}),
  }).formatToParts(schedule.date);
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  const dayPeriod = parts.find((part) => part.type === "dayPeriod")?.value?.toLowerCase();

  return hour && minute && dayPeriod ? `${hour}:${minute} ${dayPeriod}` : iso;
}

function formatCommercialEndpointSchedule(iso?: string, timeZone?: string): string {
  if (!iso) {
    return "Fecha por confirmar";
  }

  if (isDateOnly(iso)) {
    return formatCommercialDate(iso, timeZone);
  }

  if (!commercialScheduleDate(iso, timeZone)) {
    return iso;
  }

  return `${formatCommercialDate(iso, timeZone)} · ${formatCommercialTime(iso, timeZone)}`;
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

function formatCommercialTotalLine(label: string, prefix: string, amount: number | undefined): string {
  return amount === undefined
    ? `${label}: ${prefix} `
    : `${label}: ${prefix} ${formatQuotationAmount(amount)}`;
}

function normalizeCommercialUsdToPenRate(rate: number | undefined): number | undefined {
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0
    ? rate
    : undefined;
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

function firstSegment(itinerary?: Itinerary): Segment | undefined {
  return itinerary?.segments?.[0];
}

function lastSegment(itinerary?: Itinerary): Segment | undefined {
  const segments = itinerary?.segments ?? [];
  return segments.length ? segments[segments.length - 1] : undefined;
}

function carrierDisplayNameFromSegment(segment?: Segment): string {
  const rawName = segment?.marketingCarrierName || segment?.operatingCarrierName;
  return resolveAirlineDisplayName({
    names: rawName ? [titleCase(rawName)] : [],
    codes: [segment?.marketingCarrier, segment?.operatingCarrier],
    fallback: "Aerolínea por confirmar",
  });
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

  const fallbackName = resolveAirlineDisplayName({
    codes: [offer.mainCarrier, offer.validatingCarrier],
    fallback: "Aerolínea por confirmar",
  });
  if (names.length === 0 && fallbackName && !seen.has(fallbackName)) {
    names.push(fallbackName);
  }

  return names;
}

function carrierDisplayName(offer: CanonicalOffer): string {
  return collectCarrierDisplayNames(offer).join(" + ");
}

function locationLabel(value?: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return "";
  }

  const withoutCode = stripAllAirportsLabel(normalized.replace(/^[A-Z]{3}\s*-\s*/, "").trim());
  const firstChunk = withoutCode.split(",")[0]?.trim() ?? "";
  const base = firstChunk || withoutCode;
  const baseCode = normalizeIataCode(base);
  if (/^[A-Z]{3}$/.test(baseCode) && base.trim().length === 3) {
    return cityNameForIataCode(baseCode) ?? baseCode;
  }

  return titleCase(base);
}

function isUsefulCityLabel(value: string, iata: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }

  if (iata && normalizeIataCode(normalized) === iata && /^[A-Z]{3}$/.test(iata)) {
    return false;
  }

  return !/^[A-Z]{2}$/i.test(normalized);
}

function cityFromRequestOrName(requestLabel?: string, name?: string, code?: string): string {
  const iata = normalizeIataCode(code);
  const requestCity = locationLabel(requestLabel);
  if (isUsefulCityLabel(requestCity, iata)) {
    return requestCity;
  }

  const providerCity = locationLabel(name);
  if (isUsefulCityLabel(providerCity, iata) && !isAirportFacilityLabel(providerCity)) {
    return providerCity;
  }

  return cityNameForIataCode(iata)
    || (isUsefulCityLabel(providerCity, iata) ? providerCity : "")
    || requestCity
    || providerCity
    || iata
    || "Ciudad por confirmar";
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

function hasPeruCountryLabel(value?: string): boolean {
  const normalized = String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

  return /\bperu\b/.test(normalized) || /\bpe\b/.test(normalized);
}

function isPeruEndpoint(code?: string, label?: string, name?: string): boolean {
  const normalizedCode = normalizeIataCode(code);
  if (normalizedCode && PERU_AIRPORT_CODES.has(normalizedCode)) {
    return true;
  }

  return hasPeruCountryLabel(label) || hasPeruCountryLabel(name);
}

function collectQuotationRouteEndpoints(offer: CanonicalOffer, request: SearchRequest): Array<{
  code?: string;
  label?: string;
  name?: string;
}> {
  const endpoints: Array<{ code?: string; label?: string; name?: string }> = [];

  request.legs.forEach((leg) => {
    endpoints.push({ code: leg.origin, label: leg.originLabel });
    endpoints.push({ code: leg.destination, label: leg.destinationLabel });
  });

  endpoints.push({ code: offer.origin });
  endpoints.push({ code: offer.destination });

  offer.itineraries.forEach((itinerary) => {
    const first = firstSegment(itinerary);
    const last = lastSegment(itinerary);
    endpoints.push({ code: first?.origin, name: first?.originName });
    endpoints.push({ code: last?.destination, name: last?.destinationName });
  });

  return endpoints.filter((endpoint) => endpoint.code || endpoint.label || endpoint.name);
}

export function isPeruDomesticQuotation(offer: CanonicalOffer, request: SearchRequest): boolean {
  const endpoints = collectQuotationRouteEndpoints(offer, request);
  return endpoints.length > 0 && endpoints.every((endpoint) =>
    isPeruEndpoint(endpoint.code, endpoint.label, endpoint.name)
  );
}

export function shouldIncludePenQuotationPrice(offer: CanonicalOffer, request: SearchRequest): boolean {
  return isPeruDomesticQuotation(offer, request);
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

function buildCommercialInclusions(offer: CanonicalOffer, request: SearchRequest, migrationPlan = false): string[] {
  const items = [
    migrationPlan
      ? "Boleto de ida + retorno de apoyo anulable"
      : request.tripType === "round-trip"
      ? "Boleto de ida y vuelta"
      : "Boleto de solo ida",
  ];

  const baggageInclusion = buildCommercialBaggageInclusion(offer.baggage);
  if (baggageInclusion) {
    items.push(baggageInclusion);
  }

  items.push("Check in online");
  if (migrationPlan) {
    items.push("Seguro de viaje Transitorio");
    items.push("Reserva de Alojamiento Transitorio");
    items.push("Itinerario completo");
    items.push("Asesoría Integral");
  } else {
    items.push("Asiento según disponibilidad");
  }
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

function buildRestrictionsSummary(migrationPlan = false): string[] {
  const items = [
    "Reembolsos no permitidos después de emitir.",
    "Cambios de nombre no permitidos.",
    "Cambios de fecha y ruta sujetos a condiciones de la tarifa.",
  ];
  if (migrationPlan) {
    items.push("Selección de asiento no permitida; la asignación es aleatoria.");
  }
  return items;
}

function flagEmoji(countryCode?: string): string {
  const normalized = String(countryCode ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) {
    return "🌍";
  }
  const regionName = new Intl.DisplayNames(["es"], { type: "region" }).of(normalized);
  if (!regionName || regionName === normalized || /desconocid[ao]/i.test(regionName)) {
    return "🌍";
  }
  return String.fromCodePoint(...[...normalized].map((letter) => letter.charCodeAt(0) + 127397));
}

function migrationPackageTitle(offer: CanonicalOffer, request: SearchRequest): string {
  const outbound = offer.itineraries.find((itinerary) => itinerary.direction === "outbound") ?? offer.itineraries[0];
  const leg = request.legs[0];
  const destinationCode = normalizeIataCode(leg?.destination || offer.destination);
  const city = cityNameForIataCode(destinationCode) || cityFromRequestOrName(
    leg?.destinationLabel,
    lastSegment(outbound)?.destinationName,
    destinationCode,
  );
  const countryCode = countryCodeForIataCode(destinationCode) || leg?.destinationCountryCode;
  return `PAQUETE MIGRATORIO ${city.toLocaleUpperCase("es-PE")} ${flagEmoji(countryCode)}`;
}

function buildCommercialScheduleLines(
  label: string,
  itinerary: Itinerary | undefined,
  options: QuotationRenderOptions,
): string[] {
  const departureSegment = firstSegment(itinerary);
  const arrivalSegment = lastSegment(itinerary);
  const originCode = normalizeIataCode(departureSegment?.origin);
  const destinationCode = normalizeIataCode(arrivalSegment?.destination);
  const departureSchedule = formatCommercialEndpointSchedule(departureSegment?.departureAt, options.timeZone);
  const departureText = originCode ? `${originCode} · ${departureSchedule}` : departureSchedule;
  const lines = [label, departureText];

  if (arrivalSegment?.arrivalAt) {
    const arrivalSchedule = formatCommercialEndpointSchedule(arrivalSegment.arrivalAt, options.timeZone);
    lines.push(destinationCode ? `${destinationCode} · ${arrivalSchedule}` : arrivalSchedule);
  }

  return lines;
}

function itineraryStopCodes(itinerary: Itinerary | undefined): string[] {
  const segments = itinerary?.segments ?? [];
  return segments
    .slice(0, -1)
    .map((segment) => normalizeIataCode(segment.destination))
    .filter((code, index, codes) => code && codes.indexOf(code) === index);
}

function formatCommercialStops(itinerary: Itinerary | undefined): string | undefined {
  const segments = itinerary?.segments ?? [];
  const stopCount = typeof itinerary?.stops === "number"
    ? itinerary.stops
    : Math.max(0, segments.length - 1);

  if (stopCount <= 0) {
    return undefined;
  }

  const noun = stopCount === 1 ? "escala" : "escalas";
  const stopCodes = itineraryStopCodes(itinerary);
  if (stopCodes.length > 0) {
    return `${stopCount} ${noun} en ${joinSpanishList(stopCodes)}`;
  }

  return `${stopCount} ${noun}`;
}

function buildCommercialStopsLine(label: string, itinerary: Itinerary | undefined): string | undefined {
  const stops = formatCommercialStops(itinerary);
  return stops ? `${label}: ${stops}` : undefined;
}

function buildCommercialPriceLines(
  offer: CanonicalOffer,
  request: SearchRequest,
  options: QuotationRenderOptions,
): string[] {
  const currencyCode = String(offer.price.total.currencyCode ?? "").trim().toUpperCase();
  const totalAmount = offer.price.total.amount;
  const rateInfoRate = normalizeCommercialUsdToPenRate(options.usdToPenRateInfo?.rate);
  const legacyRate = normalizeCommercialUsdToPenRate(options.usdToPenRate);
  const usdToPenRate = rateInfoRate ?? legacyRate;
  const domesticPeru = isPeruDomesticQuotation(offer, request);
  const adultCount = Math.max(1, Math.round(
    Number.isFinite(request.passengers.adults) ? request.passengers.adults : 1,
  ));
  const childCount = Math.max(0, Math.round(
    Number.isFinite(request.passengers.children) ? request.passengers.children : 0,
  ));
  const infantCount = Math.max(0, Math.round(
    Number.isFinite(request.passengers.infants) ? request.passengers.infants : 0,
  ));
  const target = domesticPeru
    ? domesticPenPrice(currencyCode, totalAmount, usdToPenRate)
    : internationalUsdPrice(currencyCode, totalAmount, usdToPenRate);
  if (childCount > 0 || infantCount > 0) {
    return [formatCommercialTotalLine("Total", target.prefix, target.amount)];
  }

  const perAdultAmount = target.amount / adultCount;
  const lines = [
    formatCommercialPriceLine(target.prefix, perAdultAmount, "por adulto"),
  ];

  if (adultCount > 1) {
    lines.push(formatCommercialTotalLine("Total", target.prefix, target.amount));
  }

  return lines;
}

function domesticPenPrice(
  currencyCode: string,
  totalAmount: number,
  usdToPenRate: number | undefined,
): { prefix: string; amount: number } {
  if (currencyCode === "PEN") {
    return { prefix: "S/", amount: totalAmount };
  }

  if (currencyCode === "USD" && usdToPenRate) {
    return { prefix: "S/", amount: totalAmount * usdToPenRate };
  }

  return { prefix: currencyCode || "S/", amount: totalAmount };
}

function internationalUsdPrice(
  currencyCode: string,
  totalAmount: number,
  usdToPenRate: number | undefined,
): { prefix: string; amount: number } {
  if (currencyCode === "USD") {
    return { prefix: "US$", amount: totalAmount };
  }

  if (currencyCode === "PEN" && usdToPenRate) {
    return { prefix: "US$", amount: totalAmount / usdToPenRate };
  }

  return { prefix: currencyCode || "US$", amount: totalAmount };
}

function stripFinalLinePeriod(line: string): string {
  return line.replace(/\.$/, "");
}

function buildCommercialQuotationText(
  offer: CanonicalOffer,
  request: SearchRequest,
  options: QuotationRenderOptions = {},
): string {
  const outbound = offer.itineraries.find((itinerary) => itinerary.direction === "outbound") ?? offer.itineraries[0];
  const inbound = offer.itineraries.find((itinerary) => itinerary.direction === "inbound");
  const carrierNames = collectCarrierDisplayNames(offer);
  const inclusions = buildCommercialInclusions(offer, request, options.migrationPlan);
  const exclusions = buildCommercialExclusions(offer);
  const restrictions = buildRestrictionsSummary(options.migrationPlan);
  const priceLines = buildCommercialPriceLines(offer, request, options);

  const lines = [
    options.migrationPlan ? migrationPackageTitle(offer, request) : "COTIZACIÓN BOLETO AÉREO ✈️",
    "",
    `✈️ Ruta: ${routeSummary(offer, request)}`,
    `✈️ ${carrierNames.length > 1 ? "Aerolíneas" : "Aerolínea"}: ${carrierDisplayName(offer)}`,
  ];

  lines.push("");
  lines.push(...buildCommercialScheduleLines("🛫 IDA", outbound, options));

  const outboundStopsLine = buildCommercialStopsLine("🔁 Escalas ida", outbound);
  if (outboundStopsLine) {
    lines.push(outboundStopsLine);
  }

  if (inbound) {
    lines.push("");
    lines.push(...buildCommercialScheduleLines("🛬 RETORNO", inbound, options));
    const inboundStopsLine = buildCommercialStopsLine("🔁 Escalas retorno", inbound);
    if (inboundStopsLine) {
      lines.push(inboundStopsLine);
    }
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

  return lines.map(stripFinalLinePeriod).join("\n");
}

export function buildCommercialQuotation(
  offer: CanonicalOffer,
  request: SearchRequest,
  options?: QuotationRenderOptions,
): string {
  return buildCommercialQuotationText(offer, request, options);
}
