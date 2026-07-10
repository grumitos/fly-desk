const IATA_LOCATION_FALLBACKS: Record<string, { city: string; countryCode: string }> = {
  AEP: { city: "Buenos Aires", countryCode: "AR" },
  BCN: { city: "Barcelona", countryCode: "ES" },
  BIO: { city: "Bilbao", countryCode: "ES" },
  BOG: { city: "Bogota", countryCode: "CO" },
  BUE: { city: "Buenos Aires", countryCode: "AR" },
  CUZ: { city: "Cusco", countryCode: "PE" },
  EZE: { city: "Buenos Aires", countryCode: "AR" },
  JFK: { city: "Nueva York", countryCode: "US" },
  LAX: { city: "Los Angeles", countryCode: "US" },
  LIM: { city: "Lima", countryCode: "PE" },
  MAD: { city: "Madrid", countryCode: "ES" },
  MEX: { city: "Ciudad de Mexico", countryCode: "MX" },
  MIA: { city: "Miami", countryCode: "US" },
  MVD: { city: "Montevideo", countryCode: "UY" },
  PEM: { city: "Puerto Maldonado", countryCode: "PE" },
  PTY: { city: "Ciudad de Panama", countryCode: "PA" },
  SCL: { city: "Santiago", countryCode: "CL" },
  TPP: { city: "Tarapoto", countryCode: "PE" },
  UIO: { city: "Quito", countryCode: "EC" },
};

export function normalizeIataCode(code?: string): string {
  return String(code ?? "").trim().toUpperCase();
}

export function cityNameForIataCode(code?: string): string | undefined {
  return IATA_LOCATION_FALLBACKS[normalizeIataCode(code)]?.city;
}

export function countryCodeForIataCode(code?: string): string | undefined {
  return IATA_LOCATION_FALLBACKS[normalizeIataCode(code)]?.countryCode;
}

export function stripAllAirportsLabel(value: string): string {
  return value
    .replace(/\s*\((?:todos\s+los\s+aeropuertos|all\s+airports)\)\s*/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
