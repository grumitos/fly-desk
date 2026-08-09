import type { Cabin, PassengerMix } from "./types";

export const MAX_COMMERCIAL_QUOTATION_CHARS = 16_384;

export type QuotationParseState =
  | "parsed"
  | "missing"
  | "ambiguous"
  | "ignored"
  | "invalid";

export type QuotationFieldSourceLabel =
  | "format"
  | "route"
  | "outbound-schedule"
  | "inbound-schedule"
  | "airline"
  | "stops"
  | "price";

export interface QuotationFieldSource {
  line: number;
  label: QuotationFieldSourceLabel;
}

export type TracedQuotationField<T> =
  | { state: "parsed"; value: T; source: QuotationFieldSource }
  | { state: "missing"; reason: string; source?: QuotationFieldSource }
  | { state: "ambiguous"; reason: string; source?: QuotationFieldSource }
  | { state: "ignored"; reason: string; source?: QuotationFieldSource }
  | { state: "invalid"; reason: string; source?: QuotationFieldSource };

export interface PartialQuotationSearchLeg {
  origin?: string;
  destination?: string;
  departureDate?: string;
  returnDate?: string;
}

/**
 * Data that can be recovered without turning a commercial message into an
 * executable search. Notably, this contract has no filters or price fields.
 */
export interface PartialQuotationSearchRequest {
  tripType?: "one-way" | "round-trip";
  legs?: [PartialQuotationSearchLeg];
  passengers?: Partial<PassengerMix>;
  cabin?: Cabin;
}

export interface CommercialQuotationParseFields {
  format: TracedQuotationField<"commercial-quotation-v1">;
  origin: TracedQuotationField<string>;
  destination: TracedQuotationField<string>;
  tripType: TracedQuotationField<"one-way" | "round-trip">;
  departureDate: TracedQuotationField<string>;
  returnDate: TracedQuotationField<string>;
  passengers: TracedQuotationField<Partial<PassengerMix>>;
  cabin: TracedQuotationField<Cabin>;
  airline: TracedQuotationField<string>;
  stops: TracedQuotationField<string>;
  price: TracedQuotationField<string>;
}

export interface CommercialQuotationParseResult {
  kind: "commercial-quotation";
  version: 1;
  request: PartialQuotationSearchRequest;
  fields: CommercialQuotationParseFields;
  warnings: string[];
}

interface LocatedLine {
  index: number;
  text: string;
}

interface LocatedValue extends LocatedLine {
  value: string;
}

const SPANISH_MONTHS = new Map<string, number>([
  ["enero", 1],
  ["febrero", 2],
  ["marzo", 3],
  ["abril", 4],
  ["mayo", 5],
  ["junio", 6],
  ["julio", 7],
  ["agosto", 8],
  ["septiembre", 9],
  ["setiembre", 9],
  ["octubre", 10],
  ["noviembre", 11],
  ["diciembre", 12],
]);

const MONTH_PATTERN = [...SPANISH_MONTHS.keys()].join("|");

function source(lineIndex: number, label: QuotationFieldSourceLabel): QuotationFieldSource {
  return { line: lineIndex + 1, label };
}

function parsed<T>(
  value: T,
  fieldSource: QuotationFieldSource,
): TracedQuotationField<T> {
  return { state: "parsed", value, source: fieldSource };
}

function missing<T>(reason: string): TracedQuotationField<T> {
  return { state: "missing", reason };
}

function ambiguous<T>(
  reason: string,
  fieldSource?: QuotationFieldSource,
): TracedQuotationField<T> {
  return { state: "ambiguous", reason, ...(fieldSource ? { source: fieldSource } : {}) };
}

function ignored<T>(
  reason: string,
  fieldSource?: QuotationFieldSource,
): TracedQuotationField<T> {
  return { state: "ignored", reason, ...(fieldSource ? { source: fieldSource } : {}) };
}

function invalid<T>(
  reason: string,
  fieldSource?: QuotationFieldSource,
): TracedQuotationField<T> {
  return { state: "invalid", reason, ...(fieldSource ? { source: fieldSource } : {}) };
}

function normalizeForMatching(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function lettersOnly(value: string): string {
  return normalizeForMatching(value).replace(/[^a-z]+/g, "");
}

function labeledValues(lines: string[], labels: ReadonlySet<string>): LocatedValue[] {
  return lines.flatMap((line, index) => {
    const colonIndex = line.indexOf(":");
    if (colonIndex < 0 || !labels.has(lettersOnly(line.slice(0, colonIndex)))) {
      return [];
    }

    return [{ index, text: line, value: line.slice(colonIndex + 1).trim() }];
  });
}

function standaloneSections(lines: string[], label: string): LocatedLine[] {
  return lines.flatMap((line, index) => lettersOnly(line) === label
    ? [{ index, text: line }]
    : []);
}

function uniqueLocatedValues(entries: LocatedValue[]): LocatedValue[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = entry.value.replace(/\s+/g, " ").trim().toLocaleLowerCase("es-PE");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function routeCodes(value: string): string[] {
  const parenthesized = [...value.matchAll(/\(([A-Za-z]{3})\)/g)]
    .map((match) => match[1]!.toUpperCase());
  if (parenthesized.length > 0) {
    return parenthesized;
  }

  return value
    .split(/\s+-\s+/)
    .map((part) => part.trim().match(/^([A-Za-z]{3})$/)?.[1]?.toUpperCase())
    .filter((code): code is string => Boolean(code));
}

function isKnownSectionBoundary(line: string): boolean {
  const normalized = lettersOnly(line);
  return normalized === "ida"
    || normalized === "retorno"
    || normalized === "incluye"
    || normalized === "noincluye"
    || normalized === "condiciones"
    || normalized === "precio"
    || normalized === "escalasida"
    || normalized === "escalasretorno";
}

function scheduleAfter(lines: string[], section: LocatedLine): LocatedLine | undefined {
  for (let index = section.index + 1; index < lines.length; index += 1) {
    const text = lines[index]!.trim();
    if (!text) {
      continue;
    }
    if (isKnownSectionBoundary(text)) {
      return undefined;
    }
    return { index, text };
  }
  return undefined;
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function isoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseScheduleDate(
  schedule: LocatedLine | undefined,
  label: "outbound-schedule" | "inbound-schedule",
): TracedQuotationField<string> {
  if (!schedule) {
    return missing("La cotización no contiene una fecha de salida para este tramo.");
  }

  const fieldSource = source(schedule.index, label);
  const normalized = normalizeForMatching(schedule.text).replace(/\s+/g, " ");
  if (normalized.includes("fecha por confirmar")) {
    return missing("La fecha figura como pendiente de confirmación.");
  }

  const directIso = normalized.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (directIso) {
    const year = Number(directIso[1]);
    const month = Number(directIso[2]);
    const day = Number(directIso[3]);
    return isValidCalendarDate(year, month, day)
      ? parsed(isoDate(year, month, day), fieldSource)
      : invalid("La fecha explícita no es un día civil válido.", fieldSource);
  }

  const explicitYear = normalized.match(new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_PATTERN})\\s+(\\d{4})\\b`, "i"));
  if (explicitYear) {
    const day = Number(explicitYear[1]);
    const month = SPANISH_MONTHS.get(explicitYear[2]!.toLowerCase());
    const year = Number(explicitYear[3]);
    if (!month || !isValidCalendarDate(year, month, day)) {
      return invalid("La fecha explícita no es un día civil válido.", fieldSource);
    }
    return parsed(isoDate(year, month, day), fieldSource);
  }

  const withoutYear = normalized.match(new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_PATTERN})\\b`, "i"));
  if (withoutYear) {
    const day = Number(withoutYear[1]);
    const month = SPANISH_MONTHS.get(withoutYear[2]!.toLowerCase());
    if (!month || !isValidCalendarDate(2000, month, day)) {
      return invalid("La fecha sin año tampoco representa un día civil válido.", fieldSource);
    }
    return ambiguous(
      "La fecha no incluye año y no puede convertirse a YYYY-MM-DD sin inventarlo.",
      fieldSource,
    );
  }

  return invalid("No se reconoció una fecha comercial válida en el tramo.", fieldSource);
}

function uninspectedFields(reason: string): CommercialQuotationParseFields {
  return {
    format: invalid(reason),
    origin: invalid(reason),
    destination: invalid(reason),
    tripType: invalid(reason),
    departureDate: invalid(reason),
    returnDate: invalid(reason),
    passengers: invalid(reason),
    cabin: invalid(reason),
    airline: invalid(reason),
    stops: invalid(reason),
    price: invalid(reason),
  };
}

function rejectedResult(reason: string): CommercialQuotationParseResult {
  return {
    kind: "commercial-quotation",
    version: 1,
    request: {},
    fields: uninspectedFields(reason),
    warnings: [reason],
  };
}

function traceIgnoredLabel(
  entries: LocatedValue[],
  label: "airline" | "stops" | "price",
  reason: string,
  missingReason: string,
): TracedQuotationField<string> {
  const first = entries[0];
  return first
    ? ignored(reason, source(first.index, label))
    : missing(missingReason);
}

function warningReasons(fields: CommercialQuotationParseFields): string[] {
  const warnings = Object.values(fields)
    .filter((field) => field.state === "ambiguous" || field.state === "invalid")
    .map((field) => field.reason);
  return [...new Set(warnings)];
}

export function parseCommercialQuotation(input: unknown): CommercialQuotationParseResult {
  if (typeof input !== "string") {
    return rejectedResult("La cotización debe ser texto.");
  }
  if (input.length > MAX_COMMERCIAL_QUOTATION_CHARS) {
    return rejectedResult(`La cotización supera el máximo de ${MAX_COMMERCIAL_QUOTATION_CHARS} caracteres.`);
  }
  if (!input.trim()) {
    return rejectedResult("La cotización está vacía.");
  }

  const lines = input.split(/\r\n?|\n/);
  const routeEntries = uniqueLocatedValues(labeledValues(lines, new Set(["ruta"])));
  const outboundSections = standaloneSections(lines, "ida");
  const inboundSections = standaloneSections(lines, "retorno");
  const titleIndex = lines.findIndex((line) => {
    const normalized = lettersOnly(line);
    return normalized.startsWith("cotizacionboletoaereo")
      || normalized.startsWith("paquetemigratorio");
  });
  const formatSourceIndex = titleIndex >= 0 ? titleIndex : routeEntries[0]?.index;
  if (formatSourceIndex === undefined || (titleIndex < 0 && outboundSections.length === 0)) {
    return rejectedResult("El texto no tiene la estructura reconocible de una cotización comercial.");
  }

  let origin: TracedQuotationField<string>;
  let destination: TracedQuotationField<string>;
  let tripType: TracedQuotationField<"one-way" | "round-trip">;

  if (routeEntries.length === 0) {
    origin = missing("La cotización no contiene una línea de ruta.");
    destination = missing("La cotización no contiene una línea de ruta.");
    tripType = missing("No se puede determinar el tipo de viaje sin una ruta.");
  } else if (routeEntries.length > 1) {
    const routeSource = source(routeEntries[0]!.index, "route");
    origin = ambiguous("La cotización contiene más de una ruta distinta.", routeSource);
    destination = ambiguous("La cotización contiene más de una ruta distinta.", routeSource);
    tripType = ambiguous("La cotización contiene más de una ruta distinta.", routeSource);
  } else {
    const route = routeEntries[0]!;
    const routeSource = source(route.index, "route");
    const codes = routeCodes(route.value);
    if (codes.length !== 2 && codes.length !== 3) {
      origin = invalid("La ruta no contiene dos códigos IATA inequívocos.", routeSource);
      destination = invalid("La ruta no contiene dos códigos IATA inequívocos.", routeSource);
      tripType = invalid("La ruta no permite determinar ida o ida y vuelta.", routeSource);
    } else if (codes.length === 3 && codes[2] !== codes[0]) {
      origin = parsed(codes[0]!, routeSource);
      destination = parsed(codes[1]!, routeSource);
      tripType = invalid("Una ruta de ida y vuelta debe regresar al origen declarado.", routeSource);
    } else {
      origin = parsed(codes[0]!, routeSource);
      destination = parsed(codes[1]!, routeSource);
      tripType = parsed(codes.length === 3 ? "round-trip" : "one-way", routeSource);
    }
  }

  if (tripType.state === "parsed" && tripType.value === "one-way" && inboundSections.length > 0) {
    tripType = invalid(
      "La ruta parece solo ida, pero el texto también contiene un tramo de retorno.",
      tripType.source,
    );
  }

  const departureDate = outboundSections.length > 1
    ? ambiguous<string>(
      "La cotización contiene más de una sección de ida.",
      source(outboundSections[0]!.index, "outbound-schedule"),
    )
    : parseScheduleDate(
      outboundSections[0] ? scheduleAfter(lines, outboundSections[0]) : undefined,
      "outbound-schedule",
    );

  let returnDate: TracedQuotationField<string>;
  if (inboundSections.length > 1) {
    returnDate = ambiguous(
      "La cotización contiene más de una sección de retorno.",
      source(inboundSections[0]!.index, "inbound-schedule"),
    );
  } else if (inboundSections[0]) {
    returnDate = parseScheduleDate(scheduleAfter(lines, inboundSections[0]), "inbound-schedule");
  } else if (tripType.state === "parsed" && tripType.value === "one-way") {
    returnDate = ignored("Una búsqueda de solo ida no necesita fecha de retorno.");
  } else {
    returnDate = missing("La cotización no contiene una fecha de retorno.");
  }

  const airlineEntries = labeledValues(lines, new Set(["aerolinea", "aerolineas"]));
  const stopEntries = labeledValues(lines, new Set(["escalasida", "escalasretorno"]));
  const priceEntries = labeledValues(lines, new Set(["precio"]));
  const fields: CommercialQuotationParseFields = {
    format: parsed("commercial-quotation-v1", source(formatSourceIndex, "format")),
    origin,
    destination,
    tripType,
    departureDate,
    returnDate,
    passengers: missing("El formato comercial actual no declara la mezcla de pasajeros."),
    cabin: missing("El formato comercial actual no declara la cabina."),
    airline: traceIgnoredLabel(
      airlineEntries,
      "airline",
      "La aerolínea es información de la oferta y no se convierte en filtro de búsqueda.",
      "La cotización no declara una aerolínea.",
    ),
    stops: traceIgnoredLabel(
      stopEntries,
      "stops",
      "Las escalas son información de la oferta y no se convierten en filtro de búsqueda.",
      "La cotización no declara escalas; su ausencia no se interpreta como vuelo directo.",
    ),
    price: traceIgnoredLabel(
      priceEntries,
      "price",
      "El precio de una cotización nunca se hereda a una búsqueda nueva.",
      "La cotización no contiene una sección de precio.",
    ),
  };

  const request: PartialQuotationSearchRequest = {};
  if (tripType.state === "parsed") {
    request.tripType = tripType.value;
  }
  const leg: PartialQuotationSearchLeg = {};
  if (origin.state === "parsed") {
    leg.origin = origin.value;
  }
  if (destination.state === "parsed") {
    leg.destination = destination.value;
  }
  if (departureDate.state === "parsed") {
    leg.departureDate = departureDate.value;
  }
  if (returnDate.state === "parsed") {
    leg.returnDate = returnDate.value;
  }
  if (Object.keys(leg).length > 0) {
    request.legs = [leg];
  }

  return {
    kind: "commercial-quotation",
    version: 1,
    request,
    fields,
    warnings: warningReasons(fields),
  };
}
