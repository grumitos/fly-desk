import { IATA_LOCATION_CODES, normalizeIataCode } from "./location-display";

/*
 * The clock each IATA code keeps.
 *
 * Providers send a flight's departure and arrival as the *wall clock the
 * traveller reads at each end* — Agil with no offset at all, Click and Book
 * with a single `-0500` stamped on every timestamp including Madrid's. Neither
 * is an instant, so subtracting one from the other measures nothing whenever
 * the two ends keep different clocks: LIM 01:10 to MAD 11:00 the next day is
 * 26h50m of flying and connecting, and 33h50m of arithmetic on the digits.
 *
 * An IANA zone is what turns the digits back into an instant, daylight saving
 * included — and it has to be IANA rather than a fixed offset, because half
 * this network moves: Santiago is UTC-4 in July and UTC-3 in September, which
 * is exactly when a Lima desk sells the connection through it.
 *
 * The list is the location catalogue's, code for code, and the suite checks
 * that it stays that way. A code with a name but no clock would read as an
 * airport whose durations quietly fall back to the wrong arithmetic, and a
 * clock with no name is a code this desk does not sell.
 */
const IATA_TIME_ZONES: Record<string, string> = {
  AEP: "America/Argentina/Buenos_Aires",
  AGP: "Europe/Madrid",
  AMS: "Europe/Amsterdam",
  ANS: "America/Lima",
  AQP: "America/Lima",
  ASU: "America/Asuncion",
  ATL: "America/New_York",
  AYP: "America/Lima",
  BCN: "Europe/Madrid",
  BIO: "Europe/Madrid",
  BOG: "America/Bogota",
  BOS: "America/New_York",
  BRU: "Europe/Brussels",
  BSB: "America/Sao_Paulo",
  BUE: "America/Argentina/Buenos_Aires",
  CCS: "America/Caracas",
  CDG: "Europe/Paris",
  CGH: "America/Sao_Paulo",
  CIX: "America/Lima",
  CJA: "America/Lima",
  CLO: "America/Bogota",
  COR: "America/Argentina/Cordoba",
  CTG: "America/Bogota",
  CUN: "America/Cancun",
  CUZ: "America/Lima",
  DFW: "America/Chicago",
  EWR: "America/New_York",
  EZE: "America/Argentina/Buenos_Aires",
  FCO: "Europe/Rome",
  FLL: "America/New_York",
  FRA: "Europe/Berlin",
  GDL: "America/Mexico_City",
  GIG: "America/Sao_Paulo",
  GRU: "America/Sao_Paulo",
  GUA: "America/Guatemala",
  GYE: "America/Guayaquil",
  HAV: "America/Havana",
  HUU: "America/Lima",
  IAD: "America/New_York",
  IAH: "America/Chicago",
  IQT: "America/Lima",
  IST: "Europe/Istanbul",
  JAU: "America/Lima",
  JFK: "America/New_York",
  JUL: "America/Lima",
  LAS: "America/Los_Angeles",
  LAX: "America/Los_Angeles",
  LGA: "America/New_York",
  LGW: "Europe/London",
  LHR: "Europe/London",
  LIM: "America/Lima",
  LIS: "Europe/Lisbon",
  LPB: "America/La_Paz",
  MAD: "Europe/Madrid",
  MCO: "America/New_York",
  MDE: "America/Bogota",
  MDZ: "America/Argentina/Mendoza",
  MEX: "America/Mexico_City",
  MGA: "America/Managua",
  MIA: "America/New_York",
  MTY: "America/Monterrey",
  MUC: "Europe/Berlin",
  MVD: "America/Montevideo",
  MXP: "Europe/Rome",
  OPO: "Europe/Lisbon",
  ORD: "America/Chicago",
  ORY: "Europe/Paris",
  PCL: "America/Lima",
  PEM: "America/Lima",
  PIU: "America/Lima",
  PTY: "America/Panama",
  PUJ: "America/Santo_Domingo",
  SAL: "America/El_Salvador",
  SCL: "America/Santiago",
  SDQ: "America/Santo_Domingo",
  SEA: "America/Los_Angeles",
  SFO: "America/Los_Angeles",
  SJO: "America/Costa_Rica",
  SVQ: "Europe/Madrid",
  TBP: "America/Lima",
  TCQ: "America/Lima",
  TGU: "America/Tegucigalpa",
  TPP: "America/Lima",
  TRU: "America/Lima",
  UIO: "America/Guayaquil",
  VLC: "Europe/Madrid",
  VVI: "America/La_Paz",
  YUL: "America/Toronto",
  YVR: "America/Vancouver",
  YYZ: "America/Toronto",
};

/** Every code the clock catalogue answers for, so a check reads the map. */
export const IATA_TIME_ZONE_CODES = Object.keys(IATA_TIME_ZONES);

/** The two catalogues are one list read twice; the suite holds them to it. */
export const IATA_LOCATION_CODES_WITHOUT_TIME_ZONE = IATA_LOCATION_CODES
  .filter((code) => !IATA_TIME_ZONES[code]);

export function timeZoneForIataCode(code?: string): string | undefined {
  return IATA_TIME_ZONES[normalizeIataCode(code)];
}
