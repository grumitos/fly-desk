/*
 * The place an IATA code names, for the surfaces that have only the code.
 *
 * It is read three times and each read is a promise: the itinerary line in the
 * detail, the route and the migratory-package title of a commercial quotation
 * — which is a document that leaves the agency — and the flag beside that
 * title, through `countryCodeForIataCode`. So the rule the first twenty entries
 * were written under still holds: **only codes that are certain go in**. A code
 * that is missing falls back to the two or three letters, which says less but
 * never says something false.
 *
 * What it covers is what a Lima desk sells and connects through: Peru's own
 * network, Latin America, the North American gateways, and the European ones
 * — Spain first, which is where this desk's long-haul demand goes. A code
 * outside that is deliberately absent rather than guessed; the long tail of
 * nine thousand airports is not a list anybody can hand-keep correctly.
 *
 * The city, never the airport: EZE and AEP are both «Buenos Aires» and GRU and
 * CGH are both «São Paulo», because the code is printed beside the name and is
 * what tells the two apart. Spanish spelling with its accents, because these
 * strings are read by customers.
 */
const IATA_LOCATION_FALLBACKS: Record<string, { city: string; countryCode: string }> = {
  AEP: { city: "Buenos Aires", countryCode: "AR" },
  AGP: { city: "Málaga", countryCode: "ES" },
  AMS: { city: "Ámsterdam", countryCode: "NL" },
  ANS: { city: "Andahuaylas", countryCode: "PE" },
  AQP: { city: "Arequipa", countryCode: "PE" },
  ASU: { city: "Asunción", countryCode: "PY" },
  ATL: { city: "Atlanta", countryCode: "US" },
  AYP: { city: "Ayacucho", countryCode: "PE" },
  BCN: { city: "Barcelona", countryCode: "ES" },
  BIO: { city: "Bilbao", countryCode: "ES" },
  BOG: { city: "Bogotá", countryCode: "CO" },
  BOS: { city: "Boston", countryCode: "US" },
  BRU: { city: "Bruselas", countryCode: "BE" },
  BSB: { city: "Brasilia", countryCode: "BR" },
  BUE: { city: "Buenos Aires", countryCode: "AR" },
  CCS: { city: "Caracas", countryCode: "VE" },
  CDG: { city: "París", countryCode: "FR" },
  CGH: { city: "São Paulo", countryCode: "BR" },
  CIX: { city: "Chiclayo", countryCode: "PE" },
  CJA: { city: "Cajamarca", countryCode: "PE" },
  CLO: { city: "Cali", countryCode: "CO" },
  COR: { city: "Córdoba", countryCode: "AR" },
  CTG: { city: "Cartagena", countryCode: "CO" },
  CUN: { city: "Cancún", countryCode: "MX" },
  CUZ: { city: "Cusco", countryCode: "PE" },
  DFW: { city: "Dallas", countryCode: "US" },
  EWR: { city: "Nueva York", countryCode: "US" },
  EZE: { city: "Buenos Aires", countryCode: "AR" },
  FCO: { city: "Roma", countryCode: "IT" },
  FLL: { city: "Fort Lauderdale", countryCode: "US" },
  FRA: { city: "Frankfurt", countryCode: "DE" },
  GDL: { city: "Guadalajara", countryCode: "MX" },
  GIG: { city: "Río de Janeiro", countryCode: "BR" },
  GRU: { city: "São Paulo", countryCode: "BR" },
  GUA: { city: "Ciudad de Guatemala", countryCode: "GT" },
  GYE: { city: "Guayaquil", countryCode: "EC" },
  HAV: { city: "La Habana", countryCode: "CU" },
  HUU: { city: "Huánuco", countryCode: "PE" },
  IAD: { city: "Washington", countryCode: "US" },
  IAH: { city: "Houston", countryCode: "US" },
  IQT: { city: "Iquitos", countryCode: "PE" },
  IST: { city: "Estambul", countryCode: "TR" },
  JAU: { city: "Jauja", countryCode: "PE" },
  JFK: { city: "Nueva York", countryCode: "US" },
  JUL: { city: "Juliaca", countryCode: "PE" },
  LAS: { city: "Las Vegas", countryCode: "US" },
  LAX: { city: "Los Ángeles", countryCode: "US" },
  LGA: { city: "Nueva York", countryCode: "US" },
  LGW: { city: "Londres", countryCode: "GB" },
  LHR: { city: "Londres", countryCode: "GB" },
  LIM: { city: "Lima", countryCode: "PE" },
  LIS: { city: "Lisboa", countryCode: "PT" },
  LPB: { city: "La Paz", countryCode: "BO" },
  MAD: { city: "Madrid", countryCode: "ES" },
  MCO: { city: "Orlando", countryCode: "US" },
  MDE: { city: "Medellín", countryCode: "CO" },
  MDZ: { city: "Mendoza", countryCode: "AR" },
  MEX: { city: "Ciudad de México", countryCode: "MX" },
  MGA: { city: "Managua", countryCode: "NI" },
  MIA: { city: "Miami", countryCode: "US" },
  MTY: { city: "Monterrey", countryCode: "MX" },
  MUC: { city: "Múnich", countryCode: "DE" },
  MVD: { city: "Montevideo", countryCode: "UY" },
  MXP: { city: "Milán", countryCode: "IT" },
  OPO: { city: "Oporto", countryCode: "PT" },
  ORD: { city: "Chicago", countryCode: "US" },
  ORY: { city: "París", countryCode: "FR" },
  PCL: { city: "Pucallpa", countryCode: "PE" },
  PEM: { city: "Puerto Maldonado", countryCode: "PE" },
  PIU: { city: "Piura", countryCode: "PE" },
  PTY: { city: "Ciudad de Panamá", countryCode: "PA" },
  PUJ: { city: "Punta Cana", countryCode: "DO" },
  SAL: { city: "San Salvador", countryCode: "SV" },
  SCL: { city: "Santiago", countryCode: "CL" },
  SDQ: { city: "Santo Domingo", countryCode: "DO" },
  SEA: { city: "Seattle", countryCode: "US" },
  SFO: { city: "San Francisco", countryCode: "US" },
  SJO: { city: "San José", countryCode: "CR" },
  SVQ: { city: "Sevilla", countryCode: "ES" },
  TBP: { city: "Tumbes", countryCode: "PE" },
  TCQ: { city: "Tacna", countryCode: "PE" },
  TGU: { city: "Tegucigalpa", countryCode: "HN" },
  TPP: { city: "Tarapoto", countryCode: "PE" },
  TRU: { city: "Trujillo", countryCode: "PE" },
  UIO: { city: "Quito", countryCode: "EC" },
  VLC: { city: "Valencia", countryCode: "ES" },
  VVI: { city: "Santa Cruz", countryCode: "BO" },
  YUL: { city: "Montreal", countryCode: "CA" },
  YVR: { city: "Vancouver", countryCode: "CA" },
  YYZ: { city: "Toronto", countryCode: "CA" },
};

/**
 * Every code the catalogue answers for, so a check over it reads the map
 * itself. Restated as a literal somewhere else, the two drift and the entry
 * nobody re-read is the one that reaches a quotation wrong.
 */
export const IATA_LOCATION_CODES = Object.keys(IATA_LOCATION_FALLBACKS);

export function normalizeIataCode(code?: string): string {
  return String(code ?? "").trim().toUpperCase();
}

export function cityNameForIataCode(code?: string): string | undefined {
  return IATA_LOCATION_FALLBACKS[normalizeIataCode(code)]?.city;
}

export function countryCodeForIataCode(code?: string): string | undefined {
  return IATA_LOCATION_FALLBACKS[normalizeIataCode(code)]?.countryCode;
}

/*
 * The words that name the *facility* rather than the place it serves. Plate 1b
 * writes a station as «LIM · Jorge Chávez», so when a provider sends the full
 * legal designation the airport's own name is what survives — «Aeropuerto
 * Internacional Jorge Chávez» is the same runway written at length.
 */
const AIRPORT_FACILITY_WORDS = /\b(?:aeropuertos?|aeroportos?|airports?|international|internacional|intl\.?)\b/gi;

export function isAirportFacilityLabel(value: string): boolean {
  return /\b(?:airport|intl|international|aeropuerto|internacional)\b/i.test(value);
}

/**
 * «Aeropuerto Internacional Jorge Chávez» → «Jorge Chávez».
 *
 * Empty when the label was nothing but the facility: a name that says only
 * «Aeropuerto Internacional» names no place, and the code beside it already
 * says which one.
 */
export function stripAirportFacilityWords(value: string): string {
  return value
    .replace(AIRPORT_FACILITY_WORDS, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/^(?:de|del|da|do|dos|of)\s+/i, "")
    .trim();
}

export function stripAllAirportsLabel(value: string): string {
  return value
    .replace(/\s*\((?:todos\s+los\s+aeropuertos|all\s+airports)\)\s*/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
