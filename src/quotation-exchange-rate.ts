import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CanonicalOffer, QuotationUsdToPenRateInfo } from "./core/types";

interface ResolveQuotationUsdToPenRateOptions {
  now?: Date;
  fetchExternalRate?: () => Promise<number | undefined>;
}

interface FetchExternalUsdToPenRateOptions {
  fallbackDate?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const AGIL_RATE_SOURCE_LABEL = "Agil";
const EXTERNAL_RATE_SOURCE_LABEL = "SUNAT";
const PERSISTED_RATE_SOURCE_LABEL = "Cache local";
export const QUOTATION_RATE_TIMEOUT_DEFAULT_MS = 1_500;
const QUOTATION_RATE_TIMEOUT_MAX_MS = 10_000;

type CachedUsdToPenRateInfo = QuotationUsdToPenRateInfo & {
  day: string;
};

let cachedUsdToPenRate: CachedUsdToPenRateInfo | undefined;
let persistedUsdToPenRateLoaded = false;

function resolveQuotationUsdToPenRateCachePath(): string {
  const explicitPath = process.env.FLY_DESK_QUOTATION_RATE_CACHE_PATH?.trim();
  if (explicitPath) {
    return explicitPath;
  }

  const sessionDbPath = process.env.FLY_DESK_SESSION_DB_PATH?.trim();
  if (sessionDbPath) {
    return join(dirname(sessionDbPath), "quotation-usd-pen-rate.json");
  }

  const appDataRoot = process.env.FLY_DESK_APP_DATA_DIR?.trim()
    || process.env.XDG_STATE_HOME?.trim()
    || process.env.LOCALAPPDATA?.trim()
    || process.env.APPDATA?.trim()
    || join(homedir(), ".local", "state");
  return join(appDataRoot, "fly-desk", "quotation-usd-pen-rate.json");
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

function quotationRateTimeoutMs(override?: number): number {
  const configured = Number(override ?? process.env.FLY_DESK_QUOTATION_RATE_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) {
    return QUOTATION_RATE_TIMEOUT_DEFAULT_MS;
  }

  return Math.min(QUOTATION_RATE_TIMEOUT_MAX_MS, Math.max(1, Math.trunc(configured)));
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
  options: FetchExternalUsdToPenRateOptions = {},
): Promise<QuotationUsdToPenRateInfo | undefined> {
  try {
    const response = await (options.fetchImpl ?? fetch)(quotationRateUrl(), {
      headers: {
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(quotationRateTimeoutMs(options.timeoutMs)),
    });
    if (!response.ok) {
      return undefined;
    }

    return pickExternalRateInfo(await response.json(), options.fallbackDate ?? resolveLimaDay());
  } catch {
    return undefined;
  }
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

    const stat = lstatSync(cachePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return;
    }

    if (process.platform !== "win32") {
      const currentUid = process.getuid?.();
      if (typeof currentUid === "number" && stat.uid !== currentUid) {
        return;
      }

      if ((stat.mode & 0o022) !== 0) {
        return;
      }
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
    const tempPath = join(dirname(cachePath), `.quotation-usd-pen-rate.${process.pid}.${randomUUID()}.tmp`);
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(tempPath, JSON.stringify(cachedUsdToPenRate), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(tempPath, cachePath);
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

function supportsUsdToPenConversion(offer: CanonicalOffer): boolean {
  const currencyCode = String(offer.price.total.currencyCode ?? "").trim().toUpperCase();
  return currencyCode === "USD" || currencyCode === "PEN";
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

  if (!supportsUsdToPenConversion(offer)) {
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

export function resetQuotationUsdToPenRateCacheForTests(
  options: { preservePersisted?: boolean } = {},
): void {
  cachedUsdToPenRate = undefined;
  persistedUsdToPenRateLoaded = false;

  if (!options.preservePersisted) {
    try {
      rmSync(resolveQuotationUsdToPenRateCachePath(), { force: true });
    } catch {
      // Ignore cleanup failures in tests.
    }
  }
}
