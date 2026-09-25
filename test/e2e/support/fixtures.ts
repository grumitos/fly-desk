import { createHmac } from "node:crypto";

/*
 * The scenario vocabulary of the fake upstream, and the provider payloads it
 * turns into. Shapes follow what `src/local-agil.ts` and `src/local-costamar.ts`
 * read, including two provider habits the normalizers exist for: Agil sends
 * wall clocks with no offset and an `HHMM` duration that cannot hold a day, and
 * Click and Book Plus stamps `-05:00` on every timestamp, Madrid's included.
 */

export type FakeProvider = "agil" | "cbplus";
export type FakeTripType = "one-way" | "round-trip";

export const FAKE_AGIL_IDENTITY = Object.freeze({
  userCode: 480213,
  internalCode: "E2E-VEND-01",
  ip: "203.0.113.24",
});
export const FAKE_AGIL_SUBSCRIPTION_KEY = "e2e-apim-subscription-key";
export const FAKE_CBPLUS_TERMINAL_ID = "0799000001";

/**
 * One flight. The string form is `"LA2045 LIM-CUZ 05:40-07:05"`; `+N` after a
 * time means N days after the journey date (`"IB6650 LIM-MAD 17:25-11:50+1"`).
 */
export interface SegmentSpec {
  flight: string;
  from: string;
  to: string;
  departs: string;
  arrives: string;
  operatedBy?: string;
}

export type SegmentInput = string | SegmentSpec;

export interface BaggageSpec {
  carryOn: boolean;
  /** Checked pieces included; 0 means the provider says none. */
  checked: number;
}

export interface OfferSpec {
  outbound: readonly SegmentInput[];
  /** Required for round-trip queries; ignored by one-way ones. */
  inbound?: readonly SegmentInput[];
  /** Fare per adult or child in `currency`; an infant pays 10% of it. */
  price: number;
  /** Agil prices in this currency. Click and Book Plus always answers in the request currency. */
  currency?: string;
  /** Omitted: the provider sends no baggage evidence at all. */
  baggage?: BaggageSpec;
  /** Agil only. */
  seats?: number;
  /** Agil only: the GDS id that returns this offer (0, 1, 3, 7, 10, 21 or 22; default 0). */
  gds?: number;
  /** Click and Book Plus only: branded fare name. */
  brand?: string;
  validatingCarrier?: string;
}

export interface RouteMatch {
  origin: string;
  destination: string;
  departureDate?: string;
  returnDate?: string;
}

/** What a provider was asked, parsed from its own request body. */
export interface SearchQuery {
  provider: FakeProvider;
  tripType: FakeTripType;
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string;
  adults: number;
  children: number;
  infants: number;
  gds?: number;
  flexible?: boolean;
}

export type OfferSource = readonly OfferSpec[] | ((query: SearchQuery) => readonly OfferSpec[]);

export interface LocationFixture {
  code: string;
  type: "AIRPORT" | "CITY";
  city: string;
  cityCode: string;
  country: string;
  countryCode: string;
  name: string;
}

interface Airport {
  city: string;
  cityCode: string;
  country: string;
  countryCode: string;
  zone: string;
  name: string;
}

const PERU = { country: "Perú", countryCode: "PE", zone: "America/Lima" } as const;
const USA = { country: "Estados Unidos", countryCode: "US" } as const;
const SPAIN = { country: "España", countryCode: "ES", zone: "Europe/Madrid" } as const;
const ARGENTINA = { country: "Argentina", countryCode: "AR", zone: "America/Argentina/Buenos_Aires" } as const;

const AIRPORTS: Readonly<Record<string, Airport>> = {
  LIM: { ...PERU, city: "Lima", cityCode: "LIM", name: "Aeropuerto Internacional Jorge Chávez" },
  CUZ: { ...PERU, city: "Cusco", cityCode: "CUZ", name: "Aeropuerto Internacional Alejandro Velasco Astete" },
  AQP: { ...PERU, city: "Arequipa", cityCode: "AQP", name: "Aeropuerto Internacional Alfredo Rodríguez Ballón" },
  PIU: { ...PERU, city: "Piura", cityCode: "PIU", name: "Aeropuerto Internacional Guillermo Concha Iberico" },
  IQT: { ...PERU, city: "Iquitos", cityCode: "IQT", name: "Aeropuerto Internacional Francisco Secada Vignetta" },
  TPP: { ...PERU, city: "Tarapoto", cityCode: "TPP", name: "Aeropuerto Guillermo del Castillo Paredes" },
  TRU: { ...PERU, city: "Trujillo", cityCode: "TRU", name: "Aeropuerto Internacional Carlos Martínez de Pinillos" },
  CIX: { ...PERU, city: "Chiclayo", cityCode: "CIX", name: "Aeropuerto Internacional José Quiñones Gonzales" },
  JUL: { ...PERU, city: "Juliaca", cityCode: "JUL", name: "Aeropuerto Internacional Inca Manco Cápac" },
  PEM: { ...PERU, city: "Puerto Maldonado", cityCode: "PEM", name: "Aeropuerto Internacional Padre Aldamiz" },
  MIA: { ...USA, zone: "America/New_York", city: "Miami", cityCode: "MIA", name: "Miami International Airport" },
  JFK: { ...USA, zone: "America/New_York", city: "Nueva York", cityCode: "NYC", name: "John F. Kennedy International Airport" },
  MCO: { ...USA, zone: "America/New_York", city: "Orlando", cityCode: "ORL", name: "Orlando International Airport" },
  LAX: { ...USA, zone: "America/Los_Angeles", city: "Los Ángeles", cityCode: "LAX", name: "Los Angeles International Airport" },
  MAD: { ...SPAIN, city: "Madrid", cityCode: "MAD", name: "Aeropuerto Adolfo Suárez Madrid-Barajas" },
  BCN: { ...SPAIN, city: "Barcelona", cityCode: "BCN", name: "Aeropuerto Josep Tarradellas Barcelona-El Prat" },
  BOG: { city: "Bogotá", cityCode: "BOG", country: "Colombia", countryCode: "CO", zone: "America/Bogota", name: "Aeropuerto Internacional El Dorado" },
  MDE: { city: "Medellín", cityCode: "MDE", country: "Colombia", countryCode: "CO", zone: "America/Bogota", name: "Aeropuerto Internacional José María Córdova" },
  PTY: { city: "Panamá", cityCode: "PTY", country: "Panamá", countryCode: "PA", zone: "America/Panama", name: "Aeropuerto Internacional de Tocumen" },
  SCL: { city: "Santiago", cityCode: "SCL", country: "Chile", countryCode: "CL", zone: "America/Santiago", name: "Aeropuerto Internacional Arturo Merino Benítez" },
  EZE: { ...ARGENTINA, city: "Buenos Aires", cityCode: "BUE", name: "Aeropuerto Internacional Ministro Pistarini" },
  AEP: { ...ARGENTINA, city: "Buenos Aires", cityCode: "BUE", name: "Aeroparque Jorge Newbery" },
  GRU: { city: "São Paulo", cityCode: "SAO", country: "Brasil", countryCode: "BR", zone: "America/Sao_Paulo", name: "Aeropuerto Internacional de Guarulhos" },
  MEX: { city: "Ciudad de México", cityCode: "MEX", country: "México", countryCode: "MX", zone: "America/Mexico_City", name: "Aeropuerto Internacional Benito Juárez" },
  CUN: { city: "Cancún", cityCode: "CUN", country: "México", countryCode: "MX", zone: "America/Cancun", name: "Aeropuerto Internacional de Cancún" },
  UIO: { city: "Quito", cityCode: "UIO", country: "Ecuador", countryCode: "EC", zone: "America/Guayaquil", name: "Aeropuerto Internacional Mariscal Sucre" },
  LPB: { city: "La Paz", cityCode: "LPB", country: "Bolivia", countryCode: "BO", zone: "America/La_Paz", name: "Aeropuerto Internacional El Alto" },
  SJO: { city: "San José", cityCode: "SJO", country: "Costa Rica", countryCode: "CR", zone: "America/Costa_Rica", name: "Aeropuerto Internacional Juan Santamaría" },
};

const AIRLINE_NAMES: Readonly<Record<string, string>> = {
  "2I": "Star Perú",
  AA: "American Airlines",
  AM: "Aeroméxico",
  AR: "Aerolíneas Argentinas",
  AV: "Avianca",
  CM: "Copa Airlines",
  DL: "Delta Air Lines",
  H2: "SKY Airline",
  IB: "Iberia",
  JA: "JetSMART",
  LA: "LATAM Airlines",
  UA: "United Airlines",
  UX: "Air Europa",
  W4: "LC Perú",
};

const CITY_LOCATIONS: readonly LocationFixture[] = [
  { code: "BUE", type: "CITY", city: "Buenos Aires", cityCode: "BUE", country: "Argentina", countryCode: "AR", name: "Buenos Aires, todos los aeropuertos" },
  { code: "NYC", type: "CITY", city: "Nueva York", cityCode: "NYC", country: "Estados Unidos", countryCode: "US", name: "Nueva York, todos los aeropuertos" },
  { code: "SAO", type: "CITY", city: "São Paulo", cityCode: "SAO", country: "Brasil", countryCode: "BR", name: "São Paulo, todos los aeropuertos" },
];

/* The two catalogues differ on purpose, as the real ones do: Agil's geotree
   also answers with cities and does not know Aeroparque; this Click and Book
   Plus catalogue lists airports only. */
export function defaultLocations(provider: FakeProvider): LocationFixture[] {
  const airports = Object.entries(AIRPORTS).map(([code, airport]): LocationFixture => ({
    code,
    type: "AIRPORT",
    city: airport.city,
    cityCode: airport.cityCode,
    country: airport.country,
    countryCode: airport.countryCode,
    name: airport.name,
  }));

  return provider === "agil"
    ? [...CITY_LOCATIONS, ...airports.filter((entry) => entry.code !== "AEP")]
    : airports;
}

function foldText(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

export function matchLocations(entries: readonly LocationFixture[], query: string): LocationFixture[] {
  const needle = foldText(query).trim();
  if (!needle) {
    return [];
  }

  const hit = (text: string) => {
    const folded = foldText(text);
    return folded.startsWith(needle) || folded.split(/[^a-z0-9]+/).some((word) => word.startsWith(needle));
  };
  return entries.filter((entry) => foldText(entry.code).startsWith(needle) || hit(entry.city) || hit(entry.name));
}

export function agilGeoTreePayload(entries: readonly LocationFixture[]): Record<string, unknown>[] {
  return entries.map((entry) => ({
    city: entry.city,
    country: entry.country,
    country_id: entry.countryCode,
    state: "",
    state_id: "",
    language_id: "ES",
    aerocodiata: entry.code,
    tn_iata_padre_fn: entry.cityCode,
    search_type: entry.type,
    city_code: entry.cityCode,
  }));
}

export function cbplusAutocompletePayload(entries: readonly LocationFixture[]): Record<string, unknown> {
  return {
    airports: entries.map((entry) => ({
      code: entry.code,
      countryCode: entry.countryCode,
      cityCode: entry.cityCode,
      cityName: entry.city,
      type: entry.type,
      name: entry.name,
    })),
  };
}

function airlineName(code: string): string {
  return AIRLINE_NAMES[code] ?? code;
}

export function fakeJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}`;
  return `${unsigned}.${createHmac("sha256", "fly-desk-e2e").update(unsigned).digest("base64url")}`;
}

/** A Click and Book Plus branded token that `src/provider-context.ts` accepts as usable. */
export function fakeCbplusToken(terminalId = FAKE_CBPLUS_TERMINAL_ID, nowMs = Date.now()): string {
  const iat = Math.floor(nowMs / 1000);
  return fakeJwt({ id: terminalId, terminalId, iat, exp: iat + 30 * 24 * 60 * 60 });
}

/* ---- Time: wall clocks at each airport, durations through IANA zones ---- */

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneOffsetMinutes(zone: string, utcMs: number): number {
  let formatter = zoneFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    zoneFormatters.set(zone, formatter);
  }

  const parts = formatter.formatToParts(new Date(utcMs));
  const field = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  const local = Date.UTC(field("year"), field("month") - 1, field("day"), field("hour"), field("minute"));
  return Math.round((local - utcMs) / 60_000);
}

function airportOf(code: string): Airport {
  const airport = AIRPORTS[code];
  if (!airport) {
    throw new Error(`Fixture airport ${code} has no time zone in test/e2e/support/fixtures.ts AIRPORTS.`);
  }
  return airport;
}

function wallClockUtcMs(localIso: string, code: string): number {
  const zone = airportOf(code).zone;
  const wall = Date.parse(`${localIso}Z`);
  const guess = wall - zoneOffsetMinutes(zone, wall) * 60_000;
  return wall - zoneOffsetMinutes(zone, guess) * 60_000;
}

function addDays(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** `HHMM`, hours unbounded. */
function hhmm(minutes: number): string {
  return `${pad2(Math.floor(minutes / 60))}${pad2(minutes % 60)}`;
}

/* ---- Segments and journeys ---- */

interface ResolvedSegment {
  carrier: string;
  number: string;
  operatedBy: string;
  from: string;
  to: string;
  /** Local wall clock, `YYYY-MM-DDTHH:MM:00`. */
  departs: string;
  arrives: string;
  minutes: number;
}

const SEGMENT_TEXT = /^([A-Z0-9]{2})\s?(\d{1,4})\s+([A-Z]{3})-([A-Z]{3})\s+(\d{2}:\d{2}(?:\+\d)?)-(\d{2}:\d{2}(?:\+\d)?)$/;
const CLOCK = /^(\d{2}):(\d{2})(?:\+(\d))?$/;
const FLIGHT = /^([A-Z0-9]{2})\s?(\d{1,4})$/;

function parseSegment(input: SegmentInput): SegmentSpec {
  if (typeof input !== "string") {
    return input;
  }

  const match = SEGMENT_TEXT.exec(input.trim());
  if (!match) {
    throw new Error(`Segment "${input}" does not read as "LA2045 LIM-CUZ 05:40-07:05".`);
  }

  return {
    flight: `${match[1]}${match[2]}`,
    from: match[3]!,
    to: match[4]!,
    departs: match[5]!,
    arrives: match[6]!,
  };
}

function localClock(journeyDate: string, clock: string): string {
  const match = CLOCK.exec(clock);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new Error(`Time "${clock}" must be HH:MM with an optional +N day suffix.`);
  }

  return `${addDays(journeyDate, Number(match[3] ?? 0))}T${match[1]}:${match[2]}:00`;
}

function resolveJourney(segments: readonly SegmentInput[], journeyDate: string): ResolvedSegment[] {
  if (segments.length === 0) {
    throw new Error("A journey needs at least one segment.");
  }

  const resolved = segments.map((input): ResolvedSegment => {
    const spec = parseSegment(input);
    const flight = FLIGHT.exec(spec.flight.trim());
    if (!flight) {
      throw new Error(`Flight "${spec.flight}" must be a two-character carrier and a number.`);
    }

    const departs = localClock(journeyDate, spec.departs);
    const arrives = localClock(journeyDate, spec.arrives);
    const minutes = Math.round((wallClockUtcMs(arrives, spec.to) - wallClockUtcMs(departs, spec.from)) / 60_000);
    if (minutes <= 0) {
      throw new Error(`Segment ${spec.flight} ${spec.from}-${spec.to} arrives before it departs.`);
    }

    return {
      carrier: flight[1]!,
      number: flight[2]!,
      operatedBy: spec.operatedBy ?? flight[1]!,
      from: spec.from,
      to: spec.to,
      departs,
      arrives,
      minutes,
    };
  });

  resolved.slice(1).forEach((segment, index) => {
    const previous = resolved[index]!;
    if (previous.to !== segment.from || segment.departs <= previous.arrives) {
      throw new Error(`Segment ${segment.carrier}${segment.number} does not connect after ${previous.carrier}${previous.number} at ${previous.to}.`);
    }
  });

  return resolved;
}

function journeyMinutes(journey: readonly ResolvedSegment[]): number {
  const first = journey[0]!;
  const last = journey[journey.length - 1]!;
  return Math.round((wallClockUtcMs(last.arrives, last.to) - wallClockUtcMs(first.departs, first.from)) / 60_000);
}

/** Throws on a malformed offer: unknown airport, unparseable time, broken connection. */
export function validateOffer(offer: OfferSpec): void {
  if (!(offer.price > 0)) {
    throw new Error("An offer needs a positive price.");
  }
  resolveJourney(offer.outbound, "2030-01-15");
  if (offer.inbound) {
    resolveJourney(offer.inbound, "2030-01-22");
  }
}

/** The offers a provider would return for this query. */
export function offersForQuery(specs: readonly OfferSpec[], query: SearchQuery): OfferSpec[] {
  return specs.filter((spec) =>
    (query.tripType === "one-way" || Boolean(spec.inbound?.length))
    && (query.provider !== "agil" || (spec.gds ?? 0) === (query.gds ?? 0)));
}

/* ---- Fares ---- */

interface PassengerFare {
  code: "ADT" | "CHD" | "INF";
  quantity: number;
  perPassenger: number;
  base: number;
  taxes: number;
}

interface Fare {
  currency: string;
  total: number;
  base: number;
  taxes: number;
  passengers: PassengerFare[];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function buildFare(offer: OfferSpec, query: SearchQuery, currency: string): Fare {
  const passengers = ([
    ["ADT", query.adults, offer.price],
    ["CHD", query.children, offer.price],
    ["INF", query.infants, round2(offer.price * 0.1)],
  ] as const)
    .filter(([, quantity]) => quantity > 0)
    .map(([code, quantity, perPassenger]): PassengerFare => {
      const base = round2(perPassenger * 0.8);
      return { code, quantity, perPassenger, base, taxes: round2(perPassenger - base) };
    });

  const sum = (pick: (fare: PassengerFare) => number) =>
    round2(passengers.reduce((total, fare) => total + pick(fare) * fare.quantity, 0));
  return {
    currency,
    total: sum((fare) => fare.perPassenger),
    base: sum((fare) => fare.base),
    taxes: sum((fare) => fare.taxes),
    passengers,
  };
}

/* ---- Agil ---- */

function agilAirline(code: string): Record<string, unknown> {
  return { code, name: airlineName(code) };
}

function agilAirport(code: string): Record<string, unknown> {
  return { code, name: airportOf(code).city };
}

function agilBaggage(baggage: BaggageSpec): Record<string, unknown> {
  return {
    piezas: baggage.checked,
    descripcion1: baggage.checked > 0 ? `${baggage.checked} pieza(s) de 23 kg` : "",
    cabina: {
      piezas: baggage.carryOn ? 1 : 0,
      descripcion1: baggage.carryOn ? "Equipaje de mano 10 kg" : "",
    },
  };
}

/* Agil's `HHMM` cannot hold a day: 26h50m arrives as `0250`. */
function agilDuration(minutes: number): string {
  return hhmm(minutes % (24 * 60));
}

function agilSlice(journey: ResolvedSegment[], journeyDate: string, segmentId: number, offer: OfferSpec) {
  const first = journey[0]!;
  const last = journey[journey.length - 1]!;
  return {
    departureDate: `${journeyDate}T00:00:00`,
    originCity: agilAirport(first.from),
    destinationCity: agilAirport(last.to),
    segments: [{
      segmentId,
      startDateTime: first.departs,
      endDateTime: last.arrives,
      stops: journey.length - 1,
      flightDuration: agilDuration(journeyMinutes(journey)),
      ...(offer.baggage ? { equipaje: agilBaggage(offer.baggage) } : {}),
      flightSegments: journey.map((segment) => ({
        flightNumber: Number(segment.number),
        departureDateTime: segment.departs,
        arrivalDateTime: segment.arrives,
        elapsedTime: agilDuration(segment.minutes),
        seatsRemaining: offer.seats ?? 9,
        departureAirport: agilAirport(segment.from),
        arrivalAirport: agilAirport(segment.to),
        marketingAirline: agilAirline(segment.carrier),
        operatingAirline: agilAirline(segment.operatedBy),
      })),
    }],
  };
}

/* `limitDate` is `DDMMYY`. */
function agilLimitDate(departureDate: string): string {
  const [year, month, day] = addDays(departureDate, -1).split("-");
  return `${day}${month}${year!.slice(2)}`;
}

export function agilSearchGroup(offer: OfferSpec, query: SearchQuery, index: number, usdToPen: number): Record<string, unknown> {
  const outbound = resolveJourney(offer.outbound, query.departureDate);
  const inbound = query.tripType === "round-trip" && offer.inbound && query.returnDate
    ? resolveJourney(offer.inbound, query.returnDate)
    : undefined;
  const validating = offer.validatingCarrier ?? outbound[0]!.carrier;
  const fare = buildFare(offer, query, offer.currency ?? "USD");
  const gds = query.gds ?? 0;

  return {
    id: `E2E-G${gds}-${index + 1}`,
    display: true,
    lowCost: validating === "JA" || validating === "H2",
    esOnline: true,
    brandedFare: false,
    isAdvanceSale: false,
    airline: agilAirline(validating),
    departure: [agilSlice(outbound, query.departureDate, 10 + index, offer)],
    ...(inbound && query.returnDate ? { returns: [agilSlice(inbound, query.returnDate, 50 + index, offer)] } : {}),
    pricingInfo: {
      totalFare: fare.total,
      itinTotalFare: {
        validatingCarrier: validating,
        limitDate: agilLimitDate(query.departureDate),
        fareBreakDowns: fare.passengers.map((passenger) => ({
          passengerType: { code: passenger.code, quantity: passenger.quantity },
          passengerFare: {
            baseFare: passenger.base,
            taxes: passenger.taxes,
            totalFare: passenger.perPassenger,
            feeNMV: 0,
            feePTA: 0,
            dsctoTaxes: 0,
          },
        })),
      },
      tipoCambio: { code: fare.currency, rate: usdToPen },
    },
    gds: { idGDS: gds, webSessionID: `e2e-ws-${gds}-${index + 1}`, officeId: "LIME2E001", iata: "91500000" },
  };
}

/* ---- Click and Book Plus ---- */

function cbplusTimestamp(localIso: string): string {
  return `${localIso}-05:00`;
}

function cbplusAirport(code: string): Record<string, unknown> {
  return { locationCode: code, codeContext: airportOf(code).city };
}

function cbplusAirline(code: string): Record<string, unknown> {
  return { code, companyShortName: airlineName(code) };
}

function xmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/* The option's closing record: no flight number, its facts in `tpaextensions`. */
function cbplusAggregateSegment(journey: ResolvedSegment[], offer: OfferSpec): Record<string, unknown> {
  const first = journey[0]!;
  const last = journey[journey.length - 1]!;
  const details = [`<elapsedTime>${hhmm(journeyMinutes(journey))}</elapsedTime>`];
  if (offer.brand) {
    details.push(`<brandedFare brandName="${xmlAttribute(offer.brand)}"/>`);
  }
  if (offer.baggage) {
    const { checked, carryOn } = offer.baggage;
    const checkedDescription = checked > 0 ? ` description="${checked} maleta(s) de 23 kg"` : "";
    details.push(`<baggageInformationList><baggageInformation pieces="${checked}"${checkedDescription}/></baggageInformationList>`);
    details.push(`<handBaggage pieces="${carryOn ? 1 : 0}"${carryOn ? ' description="1 equipaje de mano de 10 kg"' : ""}/>`);
  }

  return {
    departureAirport: cbplusAirport(first.from),
    arrivalAirport: cbplusAirport(last.to),
    departureDateTime: cbplusTimestamp(first.departs),
    arrivalDateTime: cbplusTimestamp(last.arrives),
    marketingAirline: cbplusAirline(first.carrier),
    tpaextensions: { any: [`<flightDetails>${details.join("")}</flightDetails>`] },
  };
}

function cbplusOption(journey: ResolvedSegment[], refNumber: number, offer: OfferSpec): Record<string, unknown> {
  return {
    refNumber,
    rph: refNumber + 1,
    flightSegment: [
      ...journey.map((segment) => ({
        departureAirport: cbplusAirport(segment.from),
        arrivalAirport: cbplusAirport(segment.to),
        departureDateTime: cbplusTimestamp(segment.departs),
        arrivalDateTime: cbplusTimestamp(segment.arrives),
        elapsedTime: hhmm(segment.minutes),
        flightNumber: segment.number,
        marketingAirline: cbplusAirline(segment.carrier),
        operatingAirline: cbplusAirline(segment.operatedBy),
        bookingClassAvails: [{ bookingClassAvail: [{ resBookDesigCode: "Y" }] }],
        fareBasisCode: "YLOWPE",
        cabinType: "Y",
      })),
      cbplusAggregateSegment(journey, offer),
    ],
  };
}

export function cbplusPricedItinerary(
  offer: OfferSpec,
  query: SearchQuery,
  index: number,
  currency: string,
): Record<string, unknown> {
  const outbound = resolveJourney(offer.outbound, query.departureDate);
  const inbound = query.tripType === "round-trip" && offer.inbound && query.returnDate
    ? resolveJourney(offer.inbound, query.returnDate)
    : undefined;
  const fare = buildFare(offer, query, currency);
  const money = (amount: number) => ({ amount: amount.toFixed(2), currencyCode: currency });

  return {
    sequenceNumber: String(index + 1),
    airItinerary: {
      originDestinationOptions: {
        originDestinationOption: [
          cbplusOption(outbound, 0, offer),
          ...(inbound ? [cbplusOption(inbound, 1, offer)] : []),
        ],
      },
    },
    airItineraryPricingInfo: {
      itinTotalFare: [{ baseFare: money(fare.base), taxes: money(fare.taxes), totalFare: money(fare.total) }],
      validatingAirlineCode: offer.validatingCarrier ?? outbound[0]!.carrier,
      fareType: "PUBLISHED",
    },
    ticketingInfo: {
      pricingSystem: { code: "108", codeContext: "CBPLUS" },
      pseudoCityCode: "LIM",
    },
  };
}

export function cbplusEngineMetadata(terminalId: string): Record<string, unknown> {
  return {
    code: terminalId,
    profile: {
      id: "profile-e2e",
      name: "Fly Desk E2E",
      countryCode: "PE",
      currencyCode: "USD",
      currency: { code: "USD", mask: "$" },
    },
  };
}
