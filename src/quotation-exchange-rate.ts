import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CanonicalOffer, QuotationUsdToPenRateInfo, SearchRequest } from "./core/types";
import { resolveLocalAgilUsdToPenRate } from "./local-agil";
import type { SearchSessionRecord } from "./session-store";

interface ResolveQuotationUsdToPenRateOptions {
  now?: Date;
  searchRate?: (request: SearchRequest) => Promise<number | undefined>;
  fetchExternalRate?: () => Promise<number | undefined>;
}

const AGIL_RATE_SOURCE_LABEL = "Agil";
const EXTERNAL_RATE_SOURCE_LABEL = "SUNAT";
const PERSISTED_RATE_SOURCE_LABEL = "Cache local";

type CachedUsdToPenRateInfo = QuotationUsdToPenRateInfo & {
  day: string;
};

let cachedUsdToPenRate: CachedUsdToPenRateInfo | undefined;
let pendingUsdToPenRateLookup:
  | {
    day: string;
    promise: Promise<QuotationUsdToPenRateInfo | undefined>;
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

function buildQuotationUsdToPenRateInfo(
  rateValue: unknown,
  sourceLabelValue: unknown,
  dateValue: unknown,
): QuotationUsdToPenRateInfo | undefined {
  const rate = normalizePositiveRate(rateValue);
  const sourceLabel = String(sourceLabelValue ?? "").trim();
  const date = String(dateValue ?? "").trim();

  if (rate === undefined || !sourceLabel || !date) {
    return undefined;
  }

  return { rate, sourceLabel, date };
}

function cloneQuotationUsdToPenRateInfo(rateInfo: QuotationUsdToPenRateInfo): QuotationUsdToPenRateInfo {
  return {
    rate: rateInfo.rate,
    sourceLabel: rateInfo.sourceLabel,
    date: rateInfo.date,
  };
}

function quotationRateUrl(): string {
  return process.env.FLY_DESK_QUOTATION_RATE_URL?.trim()
    || "https://free.e-api.net.pe/tipo-cambio/today.json";
}

function pickExternalRateInfo(payload: unknown, fallbackDate: string): QuotationUsdToPenRateInfo | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const record = payload as Record<string, unknown>;
  return buildQuotationUsdToPenRateInfo(
    record.sunat
      ?? record.venta
      ?? record.rate
      ?? record.usdToPen
      ?? record.pen
      ?? record.PEN,
    EXTERNAL_RATE_SOURCE_LABEL,
    record.fecha ?? record.date ?? record.day ?? fallbackDate,
  );
}

export async function fetchExternalUsdToPenRateInfo(
  options: { fallbackDate?: string } = {},
): Promise<QuotationUsdToPenRateInfo | undefined> {
  const response = await fetch(quotationRateUrl(), {
    headers: {
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    return undefined;
  }

  return pickExternalRateInfo(await response.json(), options.fallbackDate ?? resolveLimaDay());
}

export async function fetchExternalUsdToPenRate(): Promise<number | undefined> {
  return (await fetchExternalUsdToPenRateInfo())?.rate;
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
      sourceLabel?: unknown;
      date?: unknown;
    };
    const day = String(parsed.day ?? "").trim();
    if (!day) {
      return;
    }

    const info = buildQuotationUsdToPenRateInfo(
      parsed.rate,
      String(parsed.sourceLabel ?? "").trim() || PERSISTED_RATE_SOURCE_LABEL,
      String(parsed.date ?? "").trim() || day,
    );
    if (info) {
      cachedUsdToPenRate = { day, ...info };
    }
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

function rememberUsdToPenRate(info: QuotationUsdToPenRateInfo, now: Date): QuotationUsdToPenRateInfo {
  cachedUsdToPenRate = {
    day: resolveLimaDay(now),
    ...info,
  };
  persistUsdToPenRateCache();

  return cloneQuotationUsdToPenRateInfo(info);
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

export async function resolveQuotationUsdToPenRateInfo(
  session: SearchSessionRecord,
  offer: CanonicalOffer,
  options: ResolveQuotationUsdToPenRateOptions = {},
): Promise<QuotationUsdToPenRateInfo | undefined> {
  loadPersistedUsdToPenRate();

  const now = options.now ?? new Date();
  const currentDay = resolveLimaDay(now);

  if (sessionMatchesCurrentLimaDay(session, currentDay)) {
    const sessionRate = pickMostCommonUsdToPenRate(session.offers);
    if (sessionRate !== undefined) {
      const sessionRateInfo = buildQuotationUsdToPenRateInfo(sessionRate, AGIL_RATE_SOURCE_LABEL, currentDay);
      return sessionRateInfo ? rememberUsdToPenRate(sessionRateInfo, now) : undefined;
    }

    const offerRateInfo = buildQuotationUsdToPenRateInfo(offer.usdToPenRate, AGIL_RATE_SOURCE_LABEL, currentDay);
    if (offerRateInfo) {
      return rememberUsdToPenRate(offerRateInfo, now);
    }
  }

  if (cachedUsdToPenRate?.day === currentDay) {
    return cloneQuotationUsdToPenRateInfo(cachedUsdToPenRate);
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
        const resolvedRateInfo = buildQuotationUsdToPenRateInfo(
          await options.searchRate(lookupRequest),
          AGIL_RATE_SOURCE_LABEL,
          currentDay,
        );
        if (resolvedRateInfo) {
          return rememberUsdToPenRate(resolvedRateInfo, now);
        }
      }

      const externalRateInfo = options.fetchExternalRate
        ? buildQuotationUsdToPenRateInfo(await options.fetchExternalRate(), EXTERNAL_RATE_SOURCE_LABEL, currentDay)
        : await fetchExternalUsdToPenRateInfo({ fallbackDate: currentDay });
      if (externalRateInfo) {
        return rememberUsdToPenRate(externalRateInfo, now);
      }

      const resolvedRateInfo = buildQuotationUsdToPenRateInfo(
        await resolveLocalAgilUsdToPenRate(lookupRequest),
        AGIL_RATE_SOURCE_LABEL,
        currentDay,
      );
      return resolvedRateInfo ? rememberUsdToPenRate(resolvedRateInfo, now) : undefined;
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

export async function resolveQuotationUsdToPenRate(
  session: SearchSessionRecord,
  offer: CanonicalOffer,
  options: ResolveQuotationUsdToPenRateOptions = {},
): Promise<number | undefined> {
  return (await resolveQuotationUsdToPenRateInfo(session, offer, options))?.rate;
}

export async function resolveStandaloneUsdToPenRateInfo(
  offer: CanonicalOffer,
  options: ResolveQuotationUsdToPenRateOptions = {},
): Promise<QuotationUsdToPenRateInfo | undefined> {
  loadPersistedUsdToPenRate();

  const now = options.now ?? new Date();
  const currentDay = resolveLimaDay(now);

  const offerRateInfo = buildQuotationUsdToPenRateInfo(offer.usdToPenRate, AGIL_RATE_SOURCE_LABEL, currentDay);
  if (offerRateInfo) {
    return rememberUsdToPenRate(offerRateInfo, now);
  }

  if (cachedUsdToPenRate?.day === currentDay) {
    return cloneQuotationUsdToPenRateInfo(cachedUsdToPenRate);
  }

  if (!isUsdOffer(offer)) {
    return undefined;
  }

  const externalRateInfo = options.fetchExternalRate
    ? buildQuotationUsdToPenRateInfo(await options.fetchExternalRate(), EXTERNAL_RATE_SOURCE_LABEL, currentDay)
    : await fetchExternalUsdToPenRateInfo({ fallbackDate: currentDay });
  return externalRateInfo ? rememberUsdToPenRate(externalRateInfo, now) : undefined;
}

export async function resolveStandaloneUsdToPenRate(
  offer: CanonicalOffer,
  options: ResolveQuotationUsdToPenRateOptions = {},
): Promise<number | undefined> {
  return (await resolveStandaloneUsdToPenRateInfo(offer, options))?.rate;
}

export function warmQuotationUsdToPenRate(
  session: SearchSessionRecord,
  options: ResolveQuotationUsdToPenRateOptions = {},
): Promise<number | undefined> | undefined {
  return warmQuotationUsdToPenRateInfo(session, options)?.then((rateInfo) => rateInfo?.rate);
}

export function warmQuotationUsdToPenRateInfo(
  session: SearchSessionRecord,
  options: ResolveQuotationUsdToPenRateOptions = {},
): Promise<QuotationUsdToPenRateInfo | undefined> | undefined {
  const offer = session.offers.find(isUsdOffer);
  if (!offer) {
    return undefined;
  }

  return resolveQuotationUsdToPenRateInfo(session, offer, options);
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
