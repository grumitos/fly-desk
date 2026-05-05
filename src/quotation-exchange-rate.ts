import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CanonicalOffer, SearchRequest } from "./core/types";
import { resolveLocalAgilUsdToPenRate } from "./local-agil";
import type { SearchSessionRecord } from "./session-store";

interface ResolveQuotationUsdToPenRateOptions {
  now?: Date;
  searchRate?: (request: SearchRequest) => Promise<number | undefined>;
  fetchExternalRate?: () => Promise<number | undefined>;
}

let cachedUsdToPenRate:
  | {
    day: string;
    rate: number;
  }
  | undefined;
let pendingUsdToPenRateLookup:
  | {
    day: string;
    promise: Promise<number | undefined>;
  }
  | undefined;
let persistedUsdToPenRateLoaded = false;

function resolveQuotationUsdToPenRateCachePath(): string {
  const explicitPath = process.env.FLY_DESK_QUOTATION_RATE_CACHE_PATH?.trim();
  return explicitPath || join(tmpdir(), "flydesk-quotation-usd-pen-rate.json");
}

function resolveLimaDay(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function normalizePositiveRate(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 2 || value > 8) {
    return undefined;
  }

  return Number(value.toFixed(4));
}

function quotationRateUrl(): string {
  return process.env.FLY_DESK_QUOTATION_RATE_URL?.trim()
    || "https://free.e-api.net.pe/tipo-cambio/today.json";
}

function pickExternalRate(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const record = payload as Record<string, unknown>;
  return normalizePositiveRate(
    record.sunat
      ?? record.venta
      ?? record.rate
      ?? record.usdToPen
      ?? record.pen
      ?? record.PEN,
  );
}

export async function fetchExternalUsdToPenRate(): Promise<number | undefined> {
  const response = await fetch(quotationRateUrl(), {
    headers: {
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    return undefined;
  }

  return pickExternalRate(await response.json());
}

function loadPersistedUsdToPenRate(): void {
  if (persistedUsdToPenRateLoaded) {
    return;
  }
  persistedUsdToPenRateLoaded = true;

  try {
    const cachePath = resolveQuotationUsdToPenRateCachePath();
    if (!existsSync(cachePath)) {
      return;
    }

    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as {
      day?: unknown;
      rate?: unknown;
    };
    const day = String(parsed.day ?? "").trim();
    const rate = normalizePositiveRate(parsed.rate);

    if (!day || rate === undefined) {
      return;
    }

    cachedUsdToPenRate = { day, rate };
  } catch {
    cachedUsdToPenRate = undefined;
  }
}

function persistUsdToPenRateCache(): void {
  if (!cachedUsdToPenRate) {
    return;
  }

  try {
    const cachePath = resolveQuotationUsdToPenRateCachePath();
    const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(tempPath, JSON.stringify(cachedUsdToPenRate), "utf8");
    try {
      renameSync(tempPath, cachePath);
    } catch {
      rmSync(cachePath, { force: true });
      renameSync(tempPath, cachePath);
    }
    rmSync(tempPath, { force: true });
  } catch {
    // Ignore persistence failures and keep the in-memory cache usable.
  }
}

function rememberUsdToPenRate(rate: number, now: Date): number {
  cachedUsdToPenRate = {
    day: resolveLimaDay(now),
    rate,
  };
  persistUsdToPenRateCache();

  return rate;
}

function pickMostCommonUsdToPenRate(offers: CanonicalOffer[]): number | undefined {
  const counts = new Map<number, number>();

  offers.forEach((offer) => {
    const rate = normalizePositiveRate(offer.usdToPenRate);
    if (rate === undefined) {
      return;
    }

    counts.set(rate, (counts.get(rate) ?? 0) + 1);
  });

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])[0]?.[0];
}

function sessionMatchesCurrentLimaDay(session: SearchSessionRecord, currentDay: string): boolean {
  const observedAt = session.searchMeta.requestedAt || session.createdAt;
  return resolveLimaDay(new Date(observedAt)) === currentDay;
}

function isUsdOffer(offer: CanonicalOffer): boolean {
  return String(offer.price.total.currencyCode ?? "").trim().toUpperCase() === "USD";
}

export function buildQuotationRateLookupRequest(
  baseRequest: SearchRequest,
  offer: CanonicalOffer,
): SearchRequest | undefined {
  const tripType = offer.tripType === "round-trip"
    ? "round-trip"
    : offer.tripType === "one-way"
      ? "one-way"
      : undefined;
  const outbound = offer.itineraries.find((itinerary) => itinerary.direction === "outbound") ?? offer.itineraries[0];
  const inbound = offer.itineraries.find((itinerary) => itinerary.direction === "inbound");
  const departureDate = outbound?.segments[0]?.departureAt?.slice(0, 10);
  const returnDate = inbound?.segments[0]?.departureAt?.slice(0, 10);

  if (!tripType || !departureDate) {
    return undefined;
  }

  if (tripType === "round-trip" && !returnDate) {
    return undefined;
  }

  return {
    ...baseRequest,
    providerId: "agil-local",
    tripType,
    searchMode: "exact",
    legs: [
      {
        origin: baseRequest.legs[0]?.origin ?? offer.origin,
        destination: baseRequest.legs[0]?.destination ?? offer.destination,
        originLabel: baseRequest.legs[0]?.originLabel,
        destinationLabel: baseRequest.legs[0]?.destinationLabel,
        departureDate,
        returnDate: tripType === "round-trip" ? returnDate : undefined,
      },
    ],
  };
}

export async function resolveQuotationUsdToPenRate(
  session: SearchSessionRecord,
  offer: CanonicalOffer,
  options: ResolveQuotationUsdToPenRateOptions = {},
): Promise<number | undefined> {
  loadPersistedUsdToPenRate();

  const now = options.now ?? new Date();
  const currentDay = resolveLimaDay(now);

  if (sessionMatchesCurrentLimaDay(session, currentDay)) {
    const sessionRate = pickMostCommonUsdToPenRate(session.offers);
    if (sessionRate !== undefined) {
      return rememberUsdToPenRate(sessionRate, now);
    }

    const offerRate = normalizePositiveRate(offer.usdToPenRate);
    if (offerRate !== undefined) {
      return rememberUsdToPenRate(offerRate, now);
    }
  }

  if (cachedUsdToPenRate?.day === currentDay) {
    return cachedUsdToPenRate.rate;
  }

  if (String(offer.price.total.currencyCode ?? "").trim().toUpperCase() !== "USD") {
    return undefined;
  }

  const lookupRequest = buildQuotationRateLookupRequest(session.request, offer);
  if (!lookupRequest) {
    return undefined;
  }

  if (pendingUsdToPenRateLookup?.day === currentDay) {
    return pendingUsdToPenRateLookup.promise;
  }

  const promise = (async () => {
    try {
      if (options.searchRate) {
        const resolvedRate = normalizePositiveRate(await options.searchRate(lookupRequest));
        if (resolvedRate !== undefined) {
          return rememberUsdToPenRate(resolvedRate, now);
        }
      }

      const fetchExternalRate = options.fetchExternalRate ?? fetchExternalUsdToPenRate;
      const externalRate = normalizePositiveRate(await fetchExternalRate());
      if (externalRate !== undefined) {
        return rememberUsdToPenRate(externalRate, now);
      }

      const resolvedRate = normalizePositiveRate(await resolveLocalAgilUsdToPenRate(lookupRequest));
      return resolvedRate === undefined ? undefined : rememberUsdToPenRate(resolvedRate, now);
    } catch {
      return undefined;
    }
  })();

  pendingUsdToPenRateLookup = {
    day: currentDay,
    promise,
  };
  void promise.finally(() => {
    if (pendingUsdToPenRateLookup?.promise === promise) {
      pendingUsdToPenRateLookup = undefined;
    }
  });

  return promise;
}

export async function resolveStandaloneUsdToPenRate(
  offer: CanonicalOffer,
  options: ResolveQuotationUsdToPenRateOptions = {},
): Promise<number | undefined> {
  loadPersistedUsdToPenRate();

  const now = options.now ?? new Date();
  const currentDay = resolveLimaDay(now);

  const offerRate = normalizePositiveRate(offer.usdToPenRate);
  if (offerRate !== undefined) {
    return rememberUsdToPenRate(offerRate, now);
  }

  if (cachedUsdToPenRate?.day === currentDay) {
    return cachedUsdToPenRate.rate;
  }

  if (!isUsdOffer(offer)) {
    return undefined;
  }

  const fetchExternalRate = options.fetchExternalRate ?? fetchExternalUsdToPenRate;
  const externalRate = normalizePositiveRate(await fetchExternalRate());
  return externalRate === undefined ? undefined : rememberUsdToPenRate(externalRate, now);
}

export function warmQuotationUsdToPenRate(
  session: SearchSessionRecord,
  options: ResolveQuotationUsdToPenRateOptions = {},
): Promise<number | undefined> | undefined {
  const offer = session.offers.find(isUsdOffer);
  if (!offer) {
    return undefined;
  }

  return resolveQuotationUsdToPenRate(session, offer, options);
}

export function resetQuotationUsdToPenRateCacheForTests(
  options: { preservePersisted?: boolean } = {},
): void {
  cachedUsdToPenRate = undefined;
  pendingUsdToPenRateLookup = undefined;
  persistedUsdToPenRateLoaded = false;

  if (!options.preservePersisted) {
    try {
      rmSync(resolveQuotationUsdToPenRateCachePath(), { force: true });
    } catch {
      // Ignore cleanup failures in tests.
    }
  }
}
