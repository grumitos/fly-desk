const IATA_CITY_NAME_FALLBACKS: Record<string, string> = {
  AEP: "Buenos Aires",
  BCN: "Barcelona",
  BIO: "Bilbao",
  BOG: "Bogota",
  BUE: "Buenos Aires",
  CUZ: "Cusco",
  EZE: "Buenos Aires",
  JFK: "Nueva York",
  LAX: "Los Angeles",
  LIM: "Lima",
  MAD: "Madrid",
  MEX: "Ciudad de Mexico",
  MIA: "Miami",
  MVD: "Montevideo",
  PEM: "Puerto Maldonado",
  PTY: "Ciudad de Panama",
  SCL: "Santiago",
  TPP: "Tarapoto",
  UIO: "Quito",
};

export function normalizeIataCode(code?: string): string {
  return String(code ?? "").trim().toUpperCase();
}

export function cityNameForIataCode(code?: string): string | undefined {
  return IATA_CITY_NAME_FALLBACKS[normalizeIataCode(code)];
}

export function stripAllAirportsLabel(value: string): string {
  return value
    .replace(/\s*\((?:todos\s+los\s+aeropuertos|all\s+airports)\)\s*/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
