import { chmodSync, lstatSync, readFileSync, mkdirSync, mkdtempSync, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Browser, BrowserContext, Page } from "playwright";
import {
  registerActiveTempArtifact,
  removePathWithRetries,
  unregisterActiveTempArtifact,
} from "./temp-artifacts";
import type { ChromeLaunchOptions } from "./local-browser";
import {
  resolveMatrixCellConcurrency,
  resolveProviderSubrequestConcurrency,
  resolveRangeSearchConcurrency,
  SHARED_SEARCH_CONCURRENCY,
} from "./search-concurrency";
import {
  buildDerivedOneWayRequest,
  buildDerivedRequest,
  diffDays,
  enumerateRoundTripFlexibleAxes,
  enumerateRange,
  enumerateUsefulRoundTripPairs,
  enumerateUsefulFlexibleRequests,
} from "./core/flexible-search";
import { normalizeAirlineDisplayName } from "./core/airline-names";
import {
  buildMatrixConfidenceSummary,
  mapConcurrent,
  prioritizeMatrixLoadingCells,
} from "./core/matrix";
import { buildOfferSignature } from "./core/offer-signature";
import {
  parseProviderAmount,
  providerAmountsDiffer,
  roundProviderAmount,
} from "./core/provider-money";
import {
  asArray,
  combineIncludedFlags,
  formatAgilSearchLocation,
  minimumNumber,
  normalizeLocationText,
  parseAgilDurationMinutes,
  parseAgilNumericValue,
  parseIsoDiffMinutes,
  parseLimitDate,
} from "./core/agil-normalization";
import { PROVIDER_OFFER_VARIANT_LIMIT, takeProviderOfferVariants } from "./core/provider-offer-limits";
import { buildFlexibleVariantGroupKey } from "./core/variant-group-key";
import {
  ProviderSearchResult,
} from "./core/provider";
import {
  BaggageSummary,
  CanonicalOffer,
  Itinerary,
  MatrixCell,
  MatrixResponse,
  Money,
  ProviderMeta,
  PurchasePath,
  SearchResponse,
  SearchRequest,
  Segment,
} from "./core/types";
import { rankLocationSuggestions } from "./location-suggestions";
import { recordProviderFirstHttpRequest } from "./provider-diagnostics";

export interface BrowserStorageSnapshot {
  tokenSearchFlight: string;
  userData: string;
  ip: string;
}

interface AgilStorageSnapshotCandidate {
  snapshot: BrowserStorageSnapshot;
  freshnessMs: number;
}

interface AgilSessionData {
  token: string;
  expiresAtMs: number;
  userCode: number;
  internalCode: string;
  ip: string;
  capturedAtMs: number;
}

interface CdpResponse {
  id?: number;
  sessionId?: string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    message?: string;
  };
}

interface CdpClient {
  close: () => void;
  send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown>;
  waitForEvent: (method: string, sessionId: string | undefined, timeoutMs: number) => Promise<unknown>;
}

interface AgilCityLike {
  code?: string;
  name?: string;
  airport?: string;
  country?: string;
  continent?: string;
}

interface AgilAirline {
  code?: string;
  name?: string;
  imageUrl?: string;
  flightNumber?: number;
}

interface AgilBaggageInfo {
  piezas?: number | string;
  descripcion1?: string;
  cabina?: {
    piezas?: number | string;
    descripcion1?: string;
  };
}

interface AgilFareBreakdown {
  passengerType?: {
    quantity?: number;
  };
  passengerFare?: {
    baseFare?: number;
    taxes?: number;
    totalFare?: number;
    feeNMV?: number;
    feePTA?: number;
    dsctoTaxes?: number;
  };
}

interface AgilPricingInfo {
  totalFare?: number;
  itinTotalFare?: {
    validatingCarrier?: string;
    limitDate?: string;
    fareBreakDowns?: AgilFareBreakdown[];
  };
  tipoCambio?: {
    code?: string;
    rate?: number;
  };
}

interface AgilFlightSegment {
  flightNumber?: number;
  departureDateTime?: string;
  arrivalDateTime?: string;
  elapsedTime?: string;
  seatsRemaining?: number;
  departureAirport?: AgilCityLike;
  arrivalAirport?: AgilCityLike;
  operatingAirline?: AgilAirline;
  marketingAirline?: AgilAirline;
}

interface AgilJourneyOption {
  startDateTime?: string;
  endDateTime?: string;
  stops?: number;
  segmentId?: number;
  flightDuration?: string;
  equipaje?: AgilBaggageInfo;
  flightSegments?: AgilFlightSegment[];
}

interface AgilJourneySlice {
  departureDate?: string;
  originCity?: AgilCityLike;
  destinationCity?: AgilCityLike;
  segments?: AgilJourneyOption[];
}

interface AgilSearchGroup {
  id?: string;
  display?: boolean;
  lowCost?: boolean;
  esOnline?: boolean;
  brandedFare?: boolean;
  isAdvanceSale?: boolean;
  airline?: AgilAirline;
  departure?: AgilJourneySlice[];
  returns?: AgilJourneySlice | AgilJourneySlice[];
  pricingInfo?: AgilPricingInfo;
  gds?: {
    idGDS?: number;
    webSessionID?: string;
    officeId?: string;
    iata?: string;
  };
}

interface AgilSearchResponse {
  groups?: AgilSearchGroup[];
}

interface AgilCellQuote {
  amount: number;
  currencyCode: string;
  validatingCarrier?: string;
  variantKey?: string;
  offer: CanonicalOffer;
}

interface AgilGeoTreeLocation {
  city?: string;
  country?: string;
  country_id?: string;
  state?: string;
  state_id?: string;
  language_id?: string;
  aerocodiata?: string;
  tn_iata_padre_fn?: string;
  search_type?: string;
  city_code?: string;
}

export interface AgilLocationSuggestion {
  code: string;
  city: string;
  country: string;
  countryCode?: string;
  state?: string;
  cityCode?: string;
  searchType?: string;
  label: string;
}

interface AgilExactSearchOutcome {
  groups: AgilSearchGroup[];
  warnings: string[];
  partial: boolean;
}

interface ItineraryCandidate {
  itinerary: Itinerary;
  baggage?: AgilBaggageInfo;
  seatsRemaining?: number;
  key: string;
}

const AGIL_GDS_LIST = [0, 1, 3, 7, 10, 21, 22];
const AGIL_BASE_URL = "https://motorvuelos.expertiatravel.com";
const AGIL_FRONTEND_URL = "https://www.agilsmart.com/home-user";
const AGIL_STORAGE_ORIGINS = [
  "https://www.agilsmart.com/home-user",
  "https://motorvuelos.expertiatravel.com/",
] as const;
const AGIL_TOKEN_STORAGE_KEYS = ["tokenSearchFlight", "tokenTravelC"] as const;
const AGIL_HTTP_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.AGIL_HTTP_TIMEOUT_MS ?? 20000),
);
const AGIL_SESSION_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const AGIL_SESSION_REVALIDATE_MS = Math.max(
  15000,
  Number(process.env.AGIL_SESSION_REVALIDATE_MS ?? 60000),
);
const AGIL_RANGE_DAY_RETRY_ATTEMPTS = Math.max(
  0,
  Math.trunc(Number(process.env.AGIL_RANGE_DAY_RETRY_ATTEMPTS ?? 1)) || 0,
);
const AGIL_RANGE_DAY_RETRY_DELAY_MS = Math.max(
  0,
  Math.trunc(Number(process.env.AGIL_RANGE_DAY_RETRY_DELAY_MS ?? 250)) || 0,
);

export const AGIL_CONCURRENCY = Object.freeze({
  get matrixMinimum() {
    return SHARED_SEARCH_CONCURRENCY.matrixMinimum;
  },
  get rangeMinimum() {
    return SHARED_SEARCH_CONCURRENCY.rangeMinimum;
  },
  get gdsSearch() {
    return resolveProviderSubrequestConcurrency("AGIL_GDS_SEARCH_CONCURRENCY", 4);
  },
  get matrixCell() {
    return resolveMatrixCellConcurrency("AGIL_MATRIX_CELL_CONCURRENCY");
  },
  get rangeSearch() {
    return resolveRangeSearchConcurrency("AGIL_RANGE_SEARCH_CONCURRENCY");
  },
  httpTimeoutMs: AGIL_HTTP_TIMEOUT_MS,
});

let playwrightPromise: Promise<typeof import("playwright")> | undefined;
let cachedSession: AgilSessionData | undefined;
let pendingSessionPromise: Promise<AgilSessionData> | undefined;
let cachedAgilApimSubscriptionKey: string | undefined;
let agilApimSubscriptionKeyPromise: Promise<string> | undefined;

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function waitMs(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, durationMs));
  });
}

function sha1Hex(input: string): string {
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(input);
  return hasher.digest("hex");
}

async function searchLocalAgilExactWithRetry(request: SearchRequest): Promise<ProviderSearchResult> {
  let attempt = 0;
  while (true) {
    try {
      return await searchLocalAgilExact(request);
    } catch (error) {
      if (attempt >= AGIL_RANGE_DAY_RETRY_ATTEMPTS) {
        throw error;
      }

      attempt += 1;
      const retryDelayMs = AGIL_RANGE_DAY_RETRY_DELAY_MS * attempt;
      if (retryDelayMs > 0) {
        await waitMs(retryDelayMs);
      }
    }
  }
}

function agilBundlePriority(url: string): number {
  if (/\/main(?:\.[^/]+)?\.js(?:[?#]|$)/i.test(url)) return 0;
  if (/\/\d+(?:\.[^/]+)?\.js(?:[?#]|$)/i.test(url)) return 1;
  if (/\/runtime(?:\.[^/]+)?\.js(?:[?#]|$)/i.test(url)) return 2;
  return 3;
}

export function parseAgilApimSubscriptionKeyFromFrontendBundle(text: string): string | undefined {
  const directMatch = text.match(/urlHeaderMotor:"([^"]+)"/i)?.[1]?.trim();
  if (directMatch) {
    return directMatch;
  }

  const quotedHeaderMatch = text.match(/["']Ocp-Apim-Subscription-Key["']\s*[:=]\s*["']([^"']+)["']/i)?.[1]?.trim();
  if (quotedHeaderMatch) {
    return quotedHeaderMatch;
  }

  return undefined;
}

async function fetchAgilFrontendBundleUrls(frontendUrl: string): Promise<string[]> {
  const response = await fetch(frontendUrl);
  if (!response.ok) {
    throw new Error(`Agil frontend bootstrap failed: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const frontendOrigin = new URL(frontendUrl).origin;
  const bundleUrls = [...html.matchAll(/<script[^>]+src=["']([^"']+\.js[^"']*)["'][^>]*>/gi)]
    .map((match) => {
      try {
        return new URL(match[1], frontendUrl).toString();
      } catch {
        return "";
      }
    })
    .filter(Boolean)
    .filter((url) => {
      try {
        return new URL(url).origin === frontendOrigin;
      } catch {
        return false;
      }
    });

  return uniqueStrings(bundleUrls).sort((left, right) => agilBundlePriority(left) - agilBundlePriority(right));
}

async function recoverAgilApimSubscriptionKeyFromFrontend(frontendUrl = AGIL_FRONTEND_URL): Promise<string> {
  const bundleUrls = await fetchAgilFrontendBundleUrls(frontendUrl);
  for (const bundleUrl of bundleUrls) {
    const response = await fetch(bundleUrl);
    if (!response.ok) {
      continue;
    }

    const text = await response.text();
    const key = parseAgilApimSubscriptionKeyFromFrontendBundle(text);
    if (key) {
      return key;
    }
  }

  throw new Error("AGIL_APIM_SUBSCRIPTION_KEY is required for live Agil requests and could not be recovered from the Agil frontend.");
}

async function resolveAgilApimSubscriptionKey(): Promise<string> {
  const key = process.env.AGIL_APIM_SUBSCRIPTION_KEY?.trim();
  if (key) {
    cachedAgilApimSubscriptionKey = key;
    return key;
  }

  if (cachedAgilApimSubscriptionKey) {
    return cachedAgilApimSubscriptionKey;
  }

  if (!agilApimSubscriptionKeyPromise) {
    agilApimSubscriptionKeyPromise = recoverAgilApimSubscriptionKeyFromFrontend()
      .then((resolvedKey) => {
        cachedAgilApimSubscriptionKey = resolvedKey;
        return resolvedKey;
      })
      .finally(() => {
        agilApimSubscriptionKeyPromise = undefined;
      });
  }

  return agilApimSubscriptionKeyPromise;
}

export function resetAgilApimSubscriptionKeyCacheForTests(): void {
  cachedAgilApimSubscriptionKey = undefined;
  agilApimSubscriptionKeyPromise = undefined;
}

function decodeJwtExpiry(token: string): number {
  const payload = token.split(".")[1];
  if (!payload) {
    return 0;
  }

  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const decoded = Buffer.from(normalized, "base64").toString("utf8");
  const parsed = JSON.parse(decoded) as { exp?: number };
  return typeof parsed.exp === "number" ? parsed.exp * 1000 : 0;
}

function decodeBase64Json(value: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as Record<string, unknown>;
}

function decodeBase64Text(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

function defaultChromeUserDataDir(): string | undefined {
  return process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "Google", "Chrome", "User Data")
    : undefined;
}

function normalizeChromePath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim() || undefined;
  }

  return trimmed;
}

function extractChromeFlagValue(commandLine: string, flagName: string): string | undefined {
  const escapedFlag = flagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = commandLine.match(new RegExp(
    `(?:^|\\s)--${escapedFlag}(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|(\\S+))`,
    "i",
  ));
  return normalizeChromePath(match?.[1] ?? match?.[2] ?? match?.[3]);
}

function extractChromeUserDataDirsFromCommandLines(commandLines: string[]): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const pushUnique = (value?: string) => {
    const normalized = normalizeChromePath(value);
    if (!normalized || seen.has(normalized)) {
      return;
    }

    seen.add(normalized);
    candidates.push(normalized);
  };

  for (const commandLine of commandLines) {
    if (!/chrome(?:\.exe)?/i.test(commandLine) || !commandLine.includes("--user-data-dir")) {
      continue;
    }

    pushUnique(extractChromeFlagValue(commandLine, "user-data-dir"));
  }

  return candidates;
}

export function extractAgilChromeUserDataDirsFromCommandLinesForTests(commandLines: string[]): string[] {
  return extractChromeUserDataDirsFromCommandLines(commandLines);
}

function extractChromeDebugPortsFromCommandLines(commandLines: string[]): number[] {
  const ports: number[] = [];
  const seen = new Set<number>();

  for (const commandLine of commandLines) {
    if (!/chrome(?:\.exe)?/i.test(commandLine) || !commandLine.includes("--remote-debugging-port")) {
      continue;
    }

    const rawPort = extractChromeFlagValue(commandLine, "remote-debugging-port");
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port <= 0 || port > 65535 || seen.has(port)) {
      continue;
    }

    seen.add(port);
    ports.push(port);
  }

  return ports;
}

export function extractAgilChromeDebugPortsFromCommandLinesForTests(commandLines: string[]): number[] {
  return extractChromeDebugPortsFromCommandLines(commandLines);
}

function runningChromeProcessDiscoveryEnabled(): boolean {
  return process.env.AGIL_CHROME_PROCESS_DISCOVERY !== "0";
}

function readRunningChromeCommandLines(): string[] {
  if (!runningChromeProcessDiscoveryEnabled()) {
    return [];
  }

  if (process.platform !== "win32") {
    return [];
  }

  const script = [
    "$ErrorActionPreference='SilentlyContinue';",
    "Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe'\" |",
    "Where-Object { $_.CommandLine -and $_.CommandLine.Contains('--user-data-dir') } |",
    "ForEach-Object { $_.CommandLine }",
  ].join(" ");
  const result = Bun.spawnSync(["powershell.exe",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ], {
    stdout: "pipe",
    stderr: "ignore",
    timeout: 3000,
    windowsHide: true,
  });
  const stdout = result.stdout?.toString("utf8") ?? "";

  if (result.exitCode !== 0 || !stdout) {
    return [];
  }

  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function readRunningChromeUserDataDirCandidates(): string[] {
  return extractChromeUserDataDirsFromCommandLines(readRunningChromeCommandLines())
    .filter((candidate) => existsSync(candidate));
}

function readRunningChromeDebugPorts(): number[] {
  return extractChromeDebugPortsFromCommandLines(readRunningChromeCommandLines());
}

function readAgilChromeUserDataDirCandidates(): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const pushUnique = (value?: string) => {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) {
      return;
    }

    seen.add(normalized);
    candidates.push(normalized);
  };

  pushUnique(process.env.AGIL_CHROME_USER_DATA_DIR);
  pushUnique(process.env.CHROME_USER_DATA_DIR);
  pushUnique(process.env.COSTAMAR_CHROME_USER_DATA_DIR);
  readRunningChromeUserDataDirCandidates().forEach((candidate) => pushUnique(candidate));
  pushUnique(defaultChromeUserDataDir());
  return candidates;
}

export function resolveAgilChromeLaunchOptions(): ChromeLaunchOptions {
  const userDataDir = readAgilChromeUserDataDirCandidates()[0]
    ?? join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "User Data");
  const profileDirectory = process.env.AGIL_CHROME_PROFILE?.trim() || undefined;

  return {
    ...(userDataDir ? { userDataDir } : {}),
    ...(profileDirectory ? { profileDirectory } : {}),
  };
}

function resolveBrowserUserDataDir(): string {
  return resolveAgilChromeLaunchOptions().userDataDir
    ?? join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "User Data");
}

function resolveAgilBrowserEndpoint(): string | undefined {
  const browserUrl = process.env.AGIL_BROWSER_URL?.trim();
  if (browserUrl) {
    return browserUrl;
  }

  const wsEndpoint = process.env.AGIL_BROWSER_WS_ENDPOINT?.trim();
  if (wsEndpoint) {
    return wsEndpoint;
  }

  return undefined;
}

function resolveAgilBrowserConnectTimeoutMs(): number {
  return Math.max(500, Number(process.env.AGIL_BROWSER_CONNECT_TIMEOUT_MS ?? 2500));
}

function resolveChromeDevToolsBrowserWsEndpoint(userDataDir: string): string | undefined {
  const devToolsPath = join(userDataDir, "DevToolsActivePort");
  if (!existsSync(devToolsPath)) {
    return undefined;
  }

  try {
    const [portLine = "", browserPath = ""] = readFileSync(devToolsPath, "utf8")
      .trim()
      .split(/\r?\n/);
    const port = Number(portLine);
    const normalizedPath = browserPath.trim();
    if (!Number.isFinite(port) || port <= 0 || port > 65535 || !normalizedPath.startsWith("/")) {
      return undefined;
    }

    return `ws://127.0.0.1:${port}${normalizedPath}`;
  } catch {
    return undefined;
  }
}

export function resolveAgilChromeDevToolsBrowserWsEndpointForTests(userDataDir: string): string | undefined {
  return resolveChromeDevToolsBrowserWsEndpoint(userDataDir);
}

async function resolveChromeDevToolsBrowserWsEndpointFromPort(port: number): Promise<string | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), resolveAgilBrowserConnectTimeoutMs());

  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return undefined;
    }

    const payload = await response.json() as { webSocketDebuggerUrl?: unknown };
    return typeof payload.webSocketDebuggerUrl === "string"
      ? payload.webSocketDebuggerUrl
      : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveAgilBrowserDevToolsWsEndpoint(endpoint: string): Promise<string | undefined> {
  const normalized = endpoint.trim();
  if (normalized.startsWith("ws://") || normalized.startsWith("wss://")) {
    return normalized;
  }

  let versionUrl: URL;
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    versionUrl = new URL("/json/version", parsed);
  } catch {
    return undefined;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), resolveAgilBrowserConnectTimeoutMs());

  try {
    const response = await fetch(versionUrl, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return undefined;
    }

    const payload = await response.json() as { webSocketDebuggerUrl?: unknown };
    return typeof payload.webSocketDebuggerUrl === "string"
      ? payload.webSocketDebuggerUrl
      : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function readRunningChromeDevToolsBrowserWsEndpoints(): Promise<string[]> {
  const endpoints: string[] = [];
  const seen = new Set<string>();

  for (const port of readRunningChromeDebugPorts()) {
    const endpoint = await resolveChromeDevToolsBrowserWsEndpointFromPort(port);
    if (!endpoint || seen.has(endpoint)) {
      continue;
    }

    seen.add(endpoint);
    endpoints.push(endpoint);
  }

  return endpoints;
}

function cdpErrorMessage(method: string, response: CdpResponse): string {
  return response.error?.message
    ? `${method}: ${response.error.message}`
    : `${method} failed.`;
}

async function createCdpClient(endpoint: string, timeoutMs: number): Promise<CdpClient> {
  if (typeof WebSocket !== "function") {
    throw new Error("WebSocket is not available for Chrome DevTools.");
  }

  const socket = new WebSocket(endpoint);
  let nextId = 1;
  const pending = new Map<number, {
    method: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const eventWaiters: Array<{
    method: string;
    sessionId?: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  const failAll = (error: Error) => {
    for (const [id, waiter] of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
      pending.delete(id);
    }

    while (eventWaiters.length > 0) {
      const waiter = eventWaiters.pop();
      if (!waiter) {
        continue;
      }
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };

  socket.addEventListener("message", (event) => {
    let message: CdpResponse;
    try {
      message = JSON.parse(String(event.data)) as CdpResponse;
    } catch {
      return;
    }

    if (typeof message.id === "number") {
      const waiter = pending.get(message.id);
      if (!waiter) {
        return;
      }

      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) {
        waiter.reject(new Error(cdpErrorMessage(waiter.method, message)));
      } else {
        waiter.resolve(message.result);
      }
      return;
    }

    if (!message.method) {
      return;
    }

    for (let index = 0; index < eventWaiters.length; index += 1) {
      const waiter = eventWaiters[index];
      if (waiter.method !== message.method || waiter.sessionId !== message.sessionId) {
        continue;
      }

      eventWaiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message.params);
      break;
    }
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Chrome DevTools websocket did not open in time.")), timeoutMs);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Chrome DevTools websocket failed to open."));
    }, { once: true });
  });

  socket.addEventListener("error", () => failAll(new Error("Chrome DevTools websocket failed.")));
  socket.addEventListener("close", () => failAll(new Error("Chrome DevTools websocket closed.")));

  return {
    close: () => {
      try {
        socket.close();
      } catch {
        // Ignore close failures.
      }
    },
    send: (method, params = {}, sessionId) => {
      const id = nextId;
      nextId += 1;
      const payload: Record<string, unknown> = {
        id,
        method,
        params,
      };
      if (sessionId) {
        payload.sessionId = sessionId;
      }

      socket.send(JSON.stringify(payload));
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out.`));
        }, timeoutMs);
        pending.set(id, {
          method,
          resolve,
          reject,
          timer,
        });
      });
    },
    waitForEvent: (method, sessionId, eventTimeoutMs) => new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = eventWaiters.findIndex((waiter) =>
          waiter.method === method && waiter.sessionId === sessionId && waiter.resolve === resolve
        );
        if (index >= 0) {
          eventWaiters.splice(index, 1);
        }
        reject(new Error(`${method} timed out.`));
      }, eventTimeoutMs);
      eventWaiters.push({
        method,
        sessionId,
        resolve,
        reject,
        timer,
      });
    }),
  };
}

function normalizeCdpStorageSnapshot(value: unknown): BrowserStorageSnapshot {
  const candidate = typeof value === "object" && value !== null
    ? value as Partial<BrowserStorageSnapshot>
    : {};

  return {
    tokenSearchFlight: typeof candidate.tokenSearchFlight === "string" ? candidate.tokenSearchFlight : "",
    userData: typeof candidate.userData === "string" ? candidate.userData : "",
    ip: typeof candidate.ip === "string" ? candidate.ip : "",
  };
}

async function waitForAgilStorageSnapshotInCdpSession(
  client: CdpClient,
  sessionId: string,
): Promise<BrowserStorageSnapshot> {
  const deadline = Date.now() + 5000;
  let latest: BrowserStorageSnapshot = {
    tokenSearchFlight: "",
    userData: "",
    ip: "",
  };

  do {
    const evaluated = await client.send("Runtime.evaluate", {
      expression: `(() => ({
        tokenSearchFlight: localStorage.getItem("tokenSearchFlight") || localStorage.getItem("tokenTravelC") || "",
        userData: localStorage.getItem("user_data") || "",
        ip: localStorage.getItem("ip") || ""
      }))()`,
      returnByValue: true,
      awaitPromise: true,
    }, sessionId) as { result?: { value?: unknown } };
    latest = normalizeCdpStorageSnapshot(evaluated.result?.value);
    if (latest.tokenSearchFlight && latest.userData && latest.ip) {
      return latest;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);

  return latest;
}

async function readAgilStorageSnapshotFromDevToolsEndpoint(endpoint: string): Promise<BrowserStorageSnapshot> {
  const client = await createCdpClient(endpoint, resolveAgilBrowserConnectTimeoutMs());
  try {
    return await readAgilStorageSnapshotFromNavigable(async (origin) => {
      const target = await client.send("Target.createTarget", { url: "about:blank" }) as { targetId?: string };
      const targetId = target.targetId;
      if (!targetId) {
        throw new Error("Chrome DevTools did not create a target.");
      }

      try {
        const attached = await client.send("Target.attachToTarget", {
          targetId,
          flatten: true,
        }) as { sessionId?: string };
        const sessionId = attached.sessionId;
        if (!sessionId) {
          throw new Error("Chrome DevTools did not attach to the target.");
        }

        await client.send("Page.enable", {}, sessionId);
        await client.send("Runtime.enable", {}, sessionId);
        const domReady = client.waitForEvent("Page.domContentEventFired", sessionId, 30000).catch(() => undefined);
        await client.send("Page.navigate", { url: origin }, sessionId);
        await domReady;
        return await waitForAgilStorageSnapshotInCdpSession(client, sessionId);
      } finally {
        await client.send("Target.closeTarget", { targetId }).catch(() => undefined);
      }
    });
  } finally {
    client.close();
  }
}

function temporaryChromeStorageFallbackEnabled(): boolean {
  const value = String(process.env.AGIL_TEMP_CHROME_STORAGE_FALLBACK ?? "0").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function isAgilTemporaryChromeStorageFallbackEnabledForTests(): boolean {
  return temporaryChromeStorageFallbackEnabled();
}

function rawChromeStorageFileScanEnabled(): boolean {
  const value = String(process.env.AGIL_RAW_CHROME_STORAGE_FILE_SCAN ?? "0").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function isAgilRawChromeStorageFileScanEnabledForTests(): boolean {
  return rawChromeStorageFileScanEnabled();
}

function readChromeProfileName(userDataDir = resolveBrowserUserDataDir()): string {
  const localStatePath = join(userDataDir, "Local State");

  const raw = readFileSync(localStatePath, "utf8");
  const parsed = JSON.parse(raw) as { profile?: { last_used?: string } };
  return parsed.profile?.last_used || "Default";
}

function readChromeProfileCandidates(userDataDir = resolveBrowserUserDataDir()): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const pushUnique = (value: string | undefined) => {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    candidates.push(normalized);
  };

  pushUnique(process.env.AGIL_CHROME_PROFILE?.trim());

  try {
    pushUnique(readChromeProfileName(userDataDir));
  } catch {
    pushUnique("Default");
  }

  try {
    const localStatePath = join(userDataDir, "Local State");
    const raw = readFileSync(localStatePath, "utf8");
    const parsed = JSON.parse(raw) as {
      profile?: {
        info_cache?: Record<string, unknown>;
        last_active_profiles?: string[];
      };
    };
    parsed.profile?.last_active_profiles?.forEach((profileName) => pushUnique(profileName));
    Object.keys(parsed.profile?.info_cache ?? {}).forEach((profileName) => pushUnique(profileName));
  } catch {
    // Ignore and fall back to directory enumeration.
  }

  try {
    readdirSync(userDataDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && (entry.name === "Default" || /^Profile \d+$/.test(entry.name)))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right))
      .forEach((profileName) => pushUnique(profileName));
  } catch {
    // Ignore directory enumeration failures.
  }

  pushUnique("Default");
  return candidates;
}

function shouldScanAllChromeProfilesForAgilStorage(): boolean {
  const value = String(process.env.AGIL_SCAN_ALL_CHROME_PROFILES ?? "0").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function readAgilChromeProfileCandidatesForTests(): string[] {
  return readChromeProfileCandidates();
}

function findChromeExecutable(): string {
  const configured = process.env.AGIL_CHROME_EXECUTABLE?.trim();
  if (configured && existsSync(configured)) {
    return configured;
  }

  const candidates = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
    process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
  ].filter((value): value is string => Boolean(value));

  const match = candidates.find((candidate) => existsSync(candidate));
  if (!match) {
    throw new Error("Chrome executable was not found on this machine.");
  }

  return match;
}

function resolveAgilSmartAddress(): string | undefined {
  const configured = process.env.AGILSMART_HOST_IP?.trim();
  if (configured) {
    return configured;
  }
  return undefined;
}

function applyPrivateMode(path: string, mode: number): void {
  if (process.platform === "win32") {
    return;
  }

  try {
    chmodSync(path, mode);
  } catch {
    // Best-effort on filesystems that do not support POSIX modes.
  }
}

function mkdirPrivate(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  applyPrivateMode(path, 0o700);
}

function copyPathPrivate(source: string, destination: string): void {
  try {
    const stats = lstatSync(source);
    if (stats.isSymbolicLink()) {
      return;
    }

    if (stats.isDirectory()) {
      mkdirPrivate(destination);
      readdirSync(source, { withFileTypes: true }).forEach((entry) => {
        copyPathPrivate(join(source, entry.name), join(destination, entry.name));
      });
      return;
    }

    if (!stats.isFile()) {
      return;
    }

    mkdirPrivate(dirname(destination));
    writeFileSync(destination, readFileSync(source), { mode: 0o600 });
    applyPrivateMode(destination, 0o600);
  } catch {
    // Ignore locked or transient browser artifacts while cloning the profile.
  }
}

function prepareTemporaryChromeProfile(userDataDir: string, profileName: string): string {
  const sourceRoot = userDataDir;
  const tempRoot = mkdtempSync(join(tmpdir(), "travel_quote_foundation_agil_"));
  const profileRoot = join(tempRoot, profileName);
  mkdirPrivate(profileRoot);
  registerActiveTempArtifact(tempRoot);

  const items = [
    "Local State",
    join(profileName, "Preferences"),
    join(profileName, "Local Storage"),
  ];

  for (const relativePath of items) {
    const source = join(sourceRoot, relativePath);
    if (!existsSync(source)) {
      continue;
    }

    const destination = join(tempRoot, relativePath);
    copyPathPrivate(source, destination);
  }

  return tempRoot;
}

export function prepareTemporaryAgilChromeProfileForTests(userDataDir: string, profileName: string): string {
  return prepareTemporaryChromeProfile(userDataDir, profileName);
}

export async function cleanupTemporaryAgilChromeProfileForTests(userDataDir: string): Promise<void> {
  await removePathWithRetries(userDataDir, 6, 250);
  unregisterActiveTempArtifact(userDataDir);
}

function launchChromeForCdp(userDataDir: string, profileName: string, port: number): Bun.NullSubprocess {
  const chromePath = findChromeExecutable();
  const args = [
    `--user-data-dir=${userDataDir}`,
    `--profile-directory=${profileName}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--headless=new",
    "about:blank",
  ];
  const agilSmartAddress = resolveAgilSmartAddress();
  if (agilSmartAddress) {
    args.splice(args.length - 1, 0, `--host-resolver-rules=MAP agilsmart.com ${agilSmartAddress},MAP www.agilsmart.com ${agilSmartAddress}`);
  }

  return Bun.spawn([chromePath, ...args], {
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
}

async function waitForDebugger(port: number): Promise<void> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        return;
      }
    } catch {
      // Ignore until the debugger port is ready.
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error("Chrome debugger port did not open in time.");
}

async function getPlaywright(): Promise<typeof import("playwright")> {
  if (!playwrightPromise) {
    playwrightPromise = import("playwright");
  }

  return playwrightPromise;
}

async function cleanupTemporaryChromeLaunch(userDataDir: string, chrome?: Bun.NullSubprocess): Promise<void> {
  if (chrome) {
    try {
      chrome.kill("SIGTERM");
    } catch {
      // Ignore processes that are already gone.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  await removePathWithRetries(userDataDir, 6, 250);
  unregisterActiveTempArtifact(userDataDir);
}

async function fetchAgil(
  url: string,
  init: RequestInit,
  label: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AGIL_HTTP_TIMEOUT_MS);
  const headers = new Headers(init.headers);
  headers.set("Ocp-Apim-Subscription-Key", await resolveAgilApimSubscriptionKey());
  recordProviderFirstHttpRequest(label);

  try {
    return await fetch(url, {
      ...init,
      headers,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${label} timed out after ${AGIL_HTTP_TIMEOUT_MS}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readAgilStorageSnapshotFromNavigable(
  loadOriginSnapshot: (origin: string) => Promise<BrowserStorageSnapshot>,
): Promise<BrowserStorageSnapshot> {
  const merged: BrowserStorageSnapshot = {
    tokenSearchFlight: "",
    userData: "",
    ip: "",
  };
  const navigationErrors: string[] = [];

  for (const origin of AGIL_STORAGE_ORIGINS) {
    try {
      const snapshot = await loadOriginSnapshot(origin);
      merged.tokenSearchFlight ||= snapshot.tokenSearchFlight;
      merged.userData ||= snapshot.userData;
      merged.ip ||= snapshot.ip;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Navigation failed";
      navigationErrors.push(`${origin}: ${detail}`);
    }

    if (merged.tokenSearchFlight && merged.userData && merged.ip) {
      break;
    }
  }

  if (!merged.userData || !merged.ip) {
    const suffix = navigationErrors.length > 0
      ? ` Navigation issues: ${navigationErrors.join(" | ")}`
      : "";
    throw new Error(`Agil local session data is incomplete in Chrome localStorage.${suffix}`);
  }

  return merged;
}

export async function readAgilStorageSnapshotFromPage(
  page: Pick<Page, "goto" | "waitForFunction" | "evaluate">,
): Promise<BrowserStorageSnapshot> {
  return readAgilStorageSnapshotFromNavigable(async (origin) => {
    await page.goto(origin, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    try {
      await page.waitForFunction(() => (
        Boolean(localStorage.getItem("tokenSearchFlight"))
        || Boolean(localStorage.getItem("tokenTravelC"))
        || Boolean(localStorage.getItem("user_data"))
        || Boolean(localStorage.getItem("ip"))
      ), {
        timeout: 5000,
      });
    } catch {
      // Some origins may not persist data for the active session.
    }

    return page.evaluate(() => ({
      tokenSearchFlight: localStorage.getItem("tokenSearchFlight")
        || localStorage.getItem("tokenTravelC")
        || "",
      userData: localStorage.getItem("user_data") || "",
      ip: localStorage.getItem("ip") || "",
    }));
  });
}

async function readAgilStorageSnapshotFromContext(
  context: Pick<BrowserContext, "newPage">,
): Promise<BrowserStorageSnapshot> {
  return readAgilStorageSnapshotFromNavigable(async (origin) => {
    const page = await context.newPage();
    try {
      await page.goto(origin, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      try {
        await page.waitForFunction(() => (
          Boolean(localStorage.getItem("tokenSearchFlight"))
          || Boolean(localStorage.getItem("tokenTravelC"))
          || Boolean(localStorage.getItem("user_data"))
          || Boolean(localStorage.getItem("ip"))
        ), {
          timeout: 5000,
        });
      } catch {
        // Some origins may not persist data for the active session.
      }

      return await page.evaluate(() => ({
        tokenSearchFlight: localStorage.getItem("tokenSearchFlight")
          || localStorage.getItem("tokenTravelC")
          || "",
        userData: localStorage.getItem("user_data") || "",
        ip: localStorage.getItem("ip") || "",
      }));
    } finally {
      await page.close().catch(() => undefined);
    }
  });
}

async function disconnectBrowser(browser: Browser | undefined): Promise<void> {
  if (!browser) {
    return;
  }

  const maybeDisconnectable = browser as Browser & { disconnect?: () => void | Promise<void> };
  if (typeof maybeDisconnectable.disconnect === "function") {
    await Promise.resolve(maybeDisconnectable.disconnect()).catch(() => undefined);
  }
}

const AGIL_STORAGE_ORIGIN_HOSTS = new Set(
  AGIL_STORAGE_ORIGINS.map((origin) => new URL(origin).host.toLowerCase()),
);
const STORAGE_ORIGIN_PATTERN = /https?:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[^\s"'<>\\\x00]*)?/g;

function isAgilStorageOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && AGIL_STORAGE_ORIGIN_HOSTS.has(parsed.host.toLowerCase());
  } catch {
    return false;
  }
}

function nearestStorageOriginBefore(text: string, index: number): string | undefined {
  const prefix = text.slice(Math.max(0, index - 2048), index);
  let latest: string | undefined;
  let match: RegExpExecArray | null;
  STORAGE_ORIGIN_PATTERN.lastIndex = 0;
  while ((match = STORAGE_ORIGIN_PATTERN.exec(prefix)) !== null) {
    latest = match[0];
  }
  return latest;
}

function isAgilStorageKeyOccurrence(text: string, index: number): boolean {
  const origin = nearestStorageOriginBefore(text, index);
  return Boolean(origin && isAgilStorageOrigin(origin));
}

function candidateTokensNearKey(text: string, key: string): string[] {
  const candidates: string[] = [];
  let cursor = 0;

  while (cursor >= 0) {
    const keyIndex = text.indexOf(key, cursor);
    if (keyIndex < 0) {
      break;
    }

    if (!isAgilStorageKeyOccurrence(text, keyIndex)) {
      cursor = keyIndex + key.length;
      continue;
    }

    const chunk = text.slice(keyIndex, Math.min(text.length, keyIndex + 12000));
    const jwtMatches = chunk.match(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) ?? [];
    const base64Matches = chunk.match(/[A-Za-z0-9+/=_-]{8,5000}/g) ?? [];
    candidates.push(...jwtMatches, ...base64Matches);
    cursor = keyIndex + key.length;
  }

  return Array.from(new Set(candidates));
}

function extractAgilStorageSnapshotFromText(text: string): BrowserStorageSnapshot {
  const snapshot: BrowserStorageSnapshot = {
    tokenSearchFlight: "",
    userData: "",
    ip: "",
  };

  for (const tokenKey of AGIL_TOKEN_STORAGE_KEYS) {
    for (const candidate of candidateTokensNearKey(text, tokenKey)) {
      if (candidate.includes(".")) {
        snapshot.tokenSearchFlight = candidate;
        break;
      }
    }

    if (snapshot.tokenSearchFlight) {
      break;
    }
  }

  for (const candidate of candidateTokensNearKey(text, "user_data")) {
    try {
      const parsed = decodeBase64Json(candidate) as {
        Usuario?: unknown;
        Cliente?: unknown;
      };
      if (parsed.Usuario || parsed.Cliente) {
        snapshot.userData = candidate;
        break;
      }
    } catch {
      // Keep scanning; LevelDB stores many unrelated base64-like fragments.
    }
  }

  for (const candidate of candidateTokensNearKey(text, "ip")) {
    try {
      const decoded = decodeBase64Text(candidate).trim();
      if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(decoded)) {
        snapshot.ip = candidate;
        break;
      }
    } catch {
      // Keep scanning.
    }
  }

  return snapshot;
}

function mergeAgilStorageSnapshots(
  left: BrowserStorageSnapshot,
  right: BrowserStorageSnapshot,
): BrowserStorageSnapshot {
  return {
    tokenSearchFlight: left.tokenSearchFlight || right.tokenSearchFlight,
    userData: left.userData || right.userData,
    ip: left.ip || right.ip,
  };
}

function readStorageFilesRecursive(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...readStorageFilesRecursive(fullPath));
    } else if (/\.(log|ldb|sqlite|sqlite3|localstorage|leveldb)$/i.test(entry.name) || !entry.name.includes(".")) {
      files.push(fullPath);
    }
  }
  return files;
}

function readAgilStorageSnapshotFromProfileFiles(
  userDataDir: string,
  profileName: string,
): AgilStorageSnapshotCandidate {
  const profileRoot = join(userDataDir, profileName);
  if (!existsSync(profileRoot)) {
    throw new Error("Chrome profile directory does not exist.");
  }

  const storageRoots = [
    join(profileRoot, "Local Storage"),
    join(profileRoot, "Session Storage"),
  ];
  let snapshot: BrowserStorageSnapshot = {
    tokenSearchFlight: "",
    userData: "",
    ip: "",
  };
  let freshnessMs = 0;
  const failures: string[] = [];
  const files = storageRoots
    .flatMap((directory) => readStorageFilesRecursive(directory))
    .map((filePath) => {
      try {
        return {
          filePath,
          mtimeMs: statSync(filePath).mtimeMs,
        };
      } catch {
        return {
          filePath,
          mtimeMs: 0,
        };
      }
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  for (const file of files) {
    try {
      const before = snapshot;
      const buffer = readFileSync(file.filePath);
      const extracted = mergeAgilStorageSnapshots(
        extractAgilStorageSnapshotFromText(buffer.toString("utf8")),
        extractAgilStorageSnapshotFromText(buffer.toString("utf16le")),
      );
      snapshot = mergeAgilStorageSnapshots(snapshot, extracted);
      if (
        snapshot.tokenSearchFlight !== before.tokenSearchFlight
        || snapshot.userData !== before.userData
        || snapshot.ip !== before.ip
      ) {
        freshnessMs = Math.max(freshnessMs, file.mtimeMs);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unable to read storage file";
      failures.push(`${file.filePath}: ${detail}`);
    }
  }

  if (snapshot.userData && snapshot.ip) {
    return {
      snapshot,
      freshnessMs,
    };
  }

  const suffix = failures.length > 0 ? ` Read failures: ${failures.slice(0, 3).join(" | ")}` : "";
  throw new Error(`Agil local session data was not found in Chrome storage files.${suffix}`);
}

function pickBestAgilStorageSnapshotCandidate(
  candidates: AgilStorageSnapshotCandidate[],
): AgilStorageSnapshotCandidate | undefined {
  return candidates
    .slice()
    .sort((left, right) => {
      if (right.freshnessMs !== left.freshnessMs) {
        return right.freshnessMs - left.freshnessMs;
      }

      const rightHasToken = right.snapshot.tokenSearchFlight ? 1 : 0;
      const leftHasToken = left.snapshot.tokenSearchFlight ? 1 : 0;
      return rightHasToken - leftHasToken;
    })[0];
}

async function extractBrowserStorageSnapshot(): Promise<BrowserStorageSnapshot> {
  const userDataDirs = readAgilChromeUserDataDirCandidates();
  const failures: string[] = [];

  const browserEndpoint = resolveAgilBrowserEndpoint();
  if (browserEndpoint) {
    let browser: Browser | undefined;
    try {
      const playwright = await getPlaywright();
      browser = await playwright.chromium.connectOverCDP(browserEndpoint, {
        timeout: resolveAgilBrowserConnectTimeoutMs(),
      });
      const context = browser.contexts()[0];
      if (!context) {
        throw new Error("Connected browser exposed no contexts.");
      }
      return await readAgilStorageSnapshotFromContext(context);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unable to read Agil storage";
      failures.push(`connected browser: ${detail}`);
    } finally {
      await disconnectBrowser(browser);
    }

    const devToolsEndpoint = await resolveAgilBrowserDevToolsWsEndpoint(browserEndpoint);
    if (devToolsEndpoint) {
      try {
        return await readAgilStorageSnapshotFromDevToolsEndpoint(devToolsEndpoint);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Unable to read Agil storage";
        failures.push(`connected browser direct CDP: ${detail}`);
      }
    }
  }

  for (const devToolsEndpoint of await readRunningChromeDevToolsBrowserWsEndpoints()) {
    if (devToolsEndpoint === browserEndpoint) {
      continue;
    }

    try {
      return await readAgilStorageSnapshotFromDevToolsEndpoint(devToolsEndpoint);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unable to read Agil storage";
      failures.push(`running Chrome DevTools: ${detail}`);
    }
  }

  for (const userDataDir of userDataDirs) {
    const devToolsEndpoint = resolveChromeDevToolsBrowserWsEndpoint(userDataDir);
    if (!devToolsEndpoint || devToolsEndpoint === browserEndpoint) {
      continue;
    }

    try {
      return await readAgilStorageSnapshotFromDevToolsEndpoint(devToolsEndpoint);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unable to read Agil storage";
      failures.push(`${userDataDir} DevTools: ${detail}`);
    }
  }

  if (rawChromeStorageFileScanEnabled()) {
    for (const userDataDir of userDataDirs) {
      const fileCandidates: AgilStorageSnapshotCandidate[] = [];
      const profileCandidates = readChromeProfileCandidates(userDataDir);
      const profileNames = shouldScanAllChromeProfilesForAgilStorage()
        ? profileCandidates
        : profileCandidates.slice(0, 1);
      try {
        for (const profileName of profileNames) {
          try {
            fileCandidates.push(readAgilStorageSnapshotFromProfileFiles(userDataDir, profileName));
          } catch (error) {
            const detail = error instanceof Error ? error.message : "Unable to read Agil storage";
            failures.push(`${profileName} files: ${detail}`);
          }
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Unable to read Agil storage";
        failures.push(`${userDataDir}: ${detail}`);
      }

      const bestFileCandidate = pickBestAgilStorageSnapshotCandidate(fileCandidates);
      if (bestFileCandidate) {
        return bestFileCandidate.snapshot;
      }
    }
  } else {
    failures.push("raw Chrome storage file scan: disabled");
  }

  if (!temporaryChromeStorageFallbackEnabled()) {
    throw new Error(`Unable to extract Agil session from Chrome profiles. ${failures.join(" | ")}`.trim());
  }

  for (const userDataDirRoot of userDataDirs) {
    const profileCandidates = readChromeProfileCandidates(userDataDirRoot);
    const profileNames = shouldScanAllChromeProfilesForAgilStorage()
      ? profileCandidates
      : profileCandidates.slice(0, 1);
    for (const profileName of profileNames) {
      if (!existsSync(join(userDataDirRoot, profileName))) {
        failures.push(`${profileName}: Chrome profile directory does not exist.`);
        continue;
      }

      const userDataDir = prepareTemporaryChromeProfile(userDataDirRoot, profileName);
      const port = 9400 + Math.floor(Math.random() * 200);
      let chrome: Bun.NullSubprocess | undefined;

      try {
        chrome = launchChromeForCdp(userDataDir, profileName, port);
        await waitForDebugger(port);
        const endpoint = await resolveChromeDevToolsBrowserWsEndpointFromPort(port);
        if (!endpoint) {
          throw new Error("Chrome debugger endpoint was not available.");
        }
        return await readAgilStorageSnapshotFromDevToolsEndpoint(endpoint);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Unable to read Agil storage";
        failures.push(`${profileName}: ${detail}`);
      } finally {
        await cleanupTemporaryChromeLaunch(userDataDir, chrome);
      }
    }
  }

  throw new Error(`Unable to extract Agil session from Chrome profiles. ${failures.join(" | ")}`.trim());
}

export async function extractAgilBrowserStorageSnapshotForTests(): Promise<BrowserStorageSnapshot> {
  return extractBrowserStorageSnapshot();
}

export function parseAgilSessionData(snapshot: BrowserStorageSnapshot): AgilSessionData {
  const capturedAtMs = Date.now();
  const expiresAtMs = snapshot.tokenSearchFlight
    ? decodeJwtExpiry(snapshot.tokenSearchFlight)
    : 0;
  const userData = decodeBase64Json(snapshot.userData) as {
    Usuario?: {
      CodigoUsuario?: number;
    };
    Cliente?: {
      Vendedor?: {
        CodigoVendedor?: string;
      };
    };
  };

  const userCode = userData.Usuario?.CodigoUsuario;
  const internalCode = userData.Cliente?.Vendedor?.CodigoVendedor;
  const ip = decodeBase64Text(snapshot.ip);

  if (!userCode || !internalCode || !ip) {
    throw new Error("Unable to decode Agil local session details.");
  }

  return {
    token: snapshot.tokenSearchFlight,
    expiresAtMs,
    userCode,
    internalCode,
    ip,
    capturedAtMs,
  };
}

export function parseAgilRefreshTokenPayload(payload: { token?: string; accessToken?: string }): string {
  if (typeof payload.token === "string" && payload.token) {
    return payload.token;
  }

  if (typeof payload.accessToken === "string" && payload.accessToken) {
    return payload.accessToken;
  }

  return "";
}

async function refreshAgilToken(session: AgilSessionData): Promise<AgilSessionData> {
  const response = await fetchAgil(`${AGIL_BASE_URL}/auth/api/auth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      trackingCode: crypto.randomUUID(),
      muteExceptions: true,
      caller: {
        company: "Expertia",
        application: "Agil",
        fromIP: session.ip,
        fromBrowser: "Chrome",
      },
      webId: 310,
      device: 3,
      userCode: session.userCode,
      internalCode: session.internalCode,
      appclient: 2,
      providers: [],
    }),
  }, "Agil token refresh");

  if (!response.ok) {
    throw new Error(`Agil token refresh failed: ${response.status} ${response.statusText}`);
  }

  const json = await response.json() as { token?: string; accessToken?: string };
  const token = parseAgilRefreshTokenPayload(json);
  if (!token) {
    throw new Error("Agil token refresh returned no token.");
  }

  return {
    ...session,
    token,
    expiresAtMs: decodeJwtExpiry(token),
    capturedAtMs: Date.now(),
  };
}

export function sameAgilSessionIdentity(
  left: Pick<AgilSessionData, "userCode" | "internalCode" | "ip">,
  right: Pick<AgilSessionData, "userCode" | "internalCode" | "ip">,
): boolean {
  return left.userCode === right.userCode
    && left.internalCode === right.internalCode
    && left.ip === right.ip;
}

export function shouldReuseAgilSession(
  session: Pick<AgilSessionData, "expiresAtMs" | "capturedAtMs">,
  now = Date.now(),
): boolean {
  return session.expiresAtMs - now > AGIL_SESSION_EXPIRY_BUFFER_MS
    && now - session.capturedAtMs < AGIL_SESSION_REVALIDATE_MS;
}

async function loadAgilSession(
  now: number,
  options: { forceRefresh?: boolean } = {},
): Promise<AgilSessionData> {
  const extracted = parseAgilSessionData(await extractBrowserStorageSnapshot());

  if (cachedSession && sameAgilSessionIdentity(cachedSession, extracted)) {
    if (!options.forceRefresh && cachedSession.expiresAtMs - now > AGIL_SESSION_EXPIRY_BUFFER_MS) {
      cachedSession = {
        ...cachedSession,
        capturedAtMs: now,
      };
      return cachedSession;
    }
  }

  cachedSession = await refreshAgilToken(extracted);
  return cachedSession;
}

async function getAgilSession(): Promise<AgilSessionData> {
  const now = Date.now();
  if (cachedSession && shouldReuseAgilSession(cachedSession, now)) {
    return cachedSession;
  }

  if (!pendingSessionPromise) {
    pendingSessionPromise = loadAgilSession(now)
      .finally(() => {
        pendingSessionPromise = undefined;
      });
  }

  return pendingSessionPromise;
}

export function resetAgilSessionCacheForTests(): void {
  cachedSession = undefined;
  pendingSessionPromise = undefined;
}

export function setAgilSessionForTests(overrides: {
  token?: string;
  expiresAtMs?: number;
  userCode?: number;
  internalCode?: string;
  ip?: string;
  capturedAtMs?: number;
} = {}): void {
  cachedSession = {
    token: overrides.token ?? "test-agil-token",
    expiresAtMs: overrides.expiresAtMs ?? Date.now() + (60 * 60 * 1000),
    userCode: overrides.userCode ?? 1,
    internalCode: overrides.internalCode ?? "TEST",
    ip: overrides.ip ?? "127.0.0.1",
    capturedAtMs: overrides.capturedAtMs ?? Date.now(),
  };
  pendingSessionPromise = undefined;
}

export async function prewarmLocalAgilSession(): Promise<void> {
  const now = Date.now();
  if (!pendingSessionPromise) {
    pendingSessionPromise = loadAgilSession(now, { forceRefresh: true })
      .finally(() => {
        pendingSessionPromise = undefined;
      });
  }

  await pendingSessionPromise;
}

function cabinToAgilClass(cabin: SearchRequest["cabin"]): number {
  if (cabin === "BUSINESS") {
    return 1;
  }

  if (cabin === "FIRST") {
    return 2;
  }

  return 0;
}

function buildAgilBaseSearchPayload(request: SearchRequest): Record<string, unknown> {
  const leg = request.legs[0];
  if (!leg.departureDate) {
    throw new Error("Agil exact search requires departureDate.");
  }

  if (request.tripType === "round-trip" && !leg.returnDate) {
    throw new Error("Agil round-trip exact search requires returnDate.");
  }

  return {
    flightType: request.tripType === "one-way" ? 1 : 0,
    departureLocation: leg.origin,
    arrivalLocation: leg.destination,
    departureDate: leg.departureDate,
    arrivalDate: request.tripType === "round-trip" ? leg.returnDate : undefined,
    adults: request.passengers.adults,
    children: request.passengers.children,
    infants: request.passengers.infants,
    flightClass: cabinToAgilClass(request.cabin),
  };
}

function buildAgilSearchPayload(request: SearchRequest, gds: number): Record<string, unknown> {
  return {
    ...buildAgilBaseSearchPayload(request),
    gds,
  };
}

function buildAgilStartSearchPayload(
  request: SearchRequest,
  searchTrackingCode: string,
): Record<string, unknown> {
  return {
    ...buildAgilBaseSearchPayload(request),
    searchTrackingCode,
  };
}

function computeLayoverMinutes(segments: Segment[]): number[] {
  const layovers: number[] = [];
  for (let index = 0; index < segments.length - 1; index += 1) {
    layovers.push(parseIsoDiffMinutes(segments[index].arrivalAt, segments[index + 1].departureAt));
  }
  return layovers;
}

function requestSummary(request: SearchRequest): string {
  const leg = request.legs[0];
  if (request.searchMode === "exact") {
    if (request.tripType === "one-way") {
      return `${leg.origin}-${leg.destination} ${leg.departureDate || "?"}`;
    }

    return `${leg.origin}-${leg.destination} ${leg.departureDate || "?"} -> ${leg.returnDate || "?"}`;
  }

  if (request.tripType === "one-way") {
    return `${leg.origin}-${leg.destination} ${leg.departureStart || "?"}..${leg.departureEnd || "?"}`;
  }

  return `${leg.origin}-${leg.destination} ${leg.departureStart || "?"}..${leg.departureEnd || "?"} / ${leg.returnStart || "?"}..${leg.returnEnd || "?"}`;
}

async function readAgilErrorBody(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim().replace(/\s+/g, " ");
    if (!text) {
      return "";
    }

    return text.slice(0, 180);
  } catch {
    return "";
  }
}

function hasAgilCarryDescription(info: AgilBaggageInfo | undefined): boolean {
  const descriptions = [
    info?.cabina?.descripcion1,
    info?.descripcion1,
  ];

  return descriptions.some((description) =>
    typeof description === "string" && /equipaje\s+de\s+mano|maleta\s+de\s+mano|cabina|carry|hand/i.test(description)
  );
}

function hasAgilBaggageSignal(info: AgilBaggageInfo | undefined): boolean {
  return Boolean(
    info
      && (
        info.piezas !== undefined
        || info.descripcion1
        || info.cabina
      ),
  );
}

function resolveAgilCarryOnIncluded(info: AgilBaggageInfo | undefined): boolean | undefined {
  if (!info) {
    return undefined;
  }

  const cabinPieces = parseAgilNumericValue(info.cabina?.piezas);
  if (typeof cabinPieces === "number") {
    return cabinPieces > 0;
  }

  if (hasAgilCarryDescription(info)) {
    return true;
  }

  return hasAgilBaggageSignal(info) ? false : undefined;
}

function segmentCarrierCode(flight: AgilFlightSegment, fallbackCarrier?: string): string {
  return flight.marketingAirline?.code
    ?? flight.operatingAirline?.code
    ?? fallbackCarrier
    ?? "XX";
}

function normalizeJourneyCandidates(
  source: AgilJourneySlice | AgilJourneySlice[] | undefined,
  direction: Itinerary["direction"],
  fallbackCarrier?: string,
): ItineraryCandidate[] {
  const slices = asArray(source);
  const candidates: ItineraryCandidate[] = [];

  slices.forEach((slice, sliceIndex) => {
    asArray(slice.segments).forEach((option, optionIndex) => {
      const flightSegments = asArray(option.flightSegments);
      if (flightSegments.length === 0) {
        return;
      }

      const normalizedSegments: Segment[] = flightSegments.map((flight, flightIndex) => {
        const marketingCarrier = segmentCarrierCode(flight, fallbackCarrier);
        return {
          id: `${direction}-${sliceIndex}-${option.segmentId ?? optionIndex}-${flightIndex}`,
          marketingCarrier,
          marketingCarrierName: normalizeAirlineDisplayName(flight.marketingAirline?.name) || undefined,
          operatingCarrier: flight.operatingAirline?.code ?? marketingCarrier,
          operatingCarrierName: normalizeAirlineDisplayName(flight.operatingAirline?.name) || undefined,
          flightNumber: String(flight.flightNumber ?? flightIndex + 1),
          origin: flight.departureAirport?.code ?? "",
          originName: flight.departureAirport?.name ?? undefined,
          destination: flight.arrivalAirport?.code ?? "",
          destinationName: flight.arrivalAirport?.name ?? undefined,
          departureAt: flight.departureDateTime ?? option.startDateTime ?? "",
          arrivalAt: flight.arrivalDateTime ?? option.endDateTime ?? "",
          durationMinutes: parseAgilDurationMinutes(
            flight.elapsedTime,
            flight.departureDateTime,
            flight.arrivalDateTime,
          ),
        };
      });

      const itinerary: Itinerary = {
        id: `${direction}-${sliceIndex}-${option.segmentId ?? optionIndex}`,
        direction,
        durationMinutes: parseAgilDurationMinutes(
          option.flightDuration,
          option.startDateTime ?? normalizedSegments[0]?.departureAt,
          option.endDateTime ?? normalizedSegments[normalizedSegments.length - 1]?.arrivalAt,
        ),
        stops: typeof option.stops === "number"
          ? option.stops
          : Math.max(0, normalizedSegments.length - 1),
        layoverMinutes: computeLayoverMinutes(normalizedSegments),
        segments: normalizedSegments,
      };

      candidates.push({
        itinerary,
        baggage: option.equipaje,
        seatsRemaining: minimumNumber(
          flightSegments.map((flight) => flight.seatsRemaining),
        ),
        key: `${sliceIndex}:${option.segmentId ?? optionIndex}`,
      });
    });
  });

  return candidates;
}

function buildBaggageSummary(...infos: Array<AgilBaggageInfo | undefined>): BaggageSummary | undefined {
  const checkedBags = minimumNumber(infos.map((info) => parseAgilNumericValue(info?.piezas)));
  const carryOnIncluded = combineIncludedFlags(infos.map(resolveAgilCarryOnIncluded));

  if (checkedBags === undefined && carryOnIncluded === undefined && !infos.some(hasAgilBaggageSignal)) {
    return undefined;
  }

  const checkedIncluded = typeof checkedBags === "number" ? checkedBags > 0 : undefined;

  let description = "";
  if (carryOnIncluded && checkedIncluded) {
    description = checkedBags === 1
      ? "Equipaje de mano y 1 maleta facturada"
      : `Equipaje de mano y ${checkedBags} maletas facturadas`;
  } else if (carryOnIncluded) {
    description = "Equipaje de mano incluido";
  } else if (checkedIncluded) {
    description = checkedBags === 1
      ? "1 maleta facturada"
      : `${checkedBags} maletas facturadas`;
  } else if (carryOnIncluded === false && checkedIncluded === false) {
    description = "Sin equipaje incluido";
  } else if (carryOnIncluded === false) {
    description = "Sin equipaje de mano";
  } else if (typeof checkedBags === "number" && checkedBags === 0) {
    description = "Sin maleta facturada";
  }

  return {
    carryOnIncluded,
    checkedIncluded,
    checkedBags: checkedIncluded ? checkedBags : undefined,
    description: description || undefined,
  };
}

function buildMoney(amount: number | undefined, currencyCode: string): Money | undefined {
  return typeof amount === "number"
    ? {
        amount,
        currencyCode,
      }
    : undefined;
}

export function buildLocalAgilSearchRedirectUrl(request: SearchRequest): string {
  const leg = request.legs[0];
  const url = new URL("https://www.agilsmart.com/home-user/flight-result");

  url.searchParams.set("flightType", request.tripType === "one-way" ? "1" : "0");
  url.searchParams.set("departureLocation", formatAgilSearchLocation(leg.origin, leg.originLabel));
  url.searchParams.set("arrivalLocation", formatAgilSearchLocation(leg.destination, leg.destinationLabel));
  if (leg.departureDate) {
    const [year, month, day] = leg.departureDate.split("-");
    url.searchParams.set("departureDate", `${day}/${month}/${year}`);
  }
  if (request.tripType !== "one-way" && leg.returnDate) {
    const [year, month, day] = leg.returnDate.split("-");
    url.searchParams.set("arrivalDate", `${day}/${month}/${year}`);
  }
  url.searchParams.set("adults", String(request.passengers.adults));
  url.searchParams.set("children", String(request.passengers.children));
  url.searchParams.set("infants", String(request.passengers.infants));
  url.searchParams.set("flightClass", String(cabinToAgilClass(request.cabin)));

  return url.toString();
}

function buildOfferSearchRequest(
  baseRequest: SearchRequest,
  itineraries: Itinerary[],
  origin: string,
  destination: string,
  tripType: SearchRequest["tripType"],
): SearchRequest {
  const outbound = itineraries.find((itinerary) => itinerary.direction === "outbound") ?? itineraries[0];
  const inbound = itineraries.find((itinerary) => itinerary.direction === "inbound");
  const departureDate = outbound?.segments[0]?.departureAt?.slice(0, 10) ?? "";
  const returnDate = inbound?.segments[0]?.departureAt?.slice(0, 10) ?? "";

  return {
    ...baseRequest,
    tripType,
    searchMode: "exact",
    legs: [
      {
        origin,
        destination,
        originLabel: baseRequest.legs[0]?.originLabel,
        destinationLabel: baseRequest.legs[0]?.destinationLabel,
        departureDate,
        returnDate: tripType === "round-trip" ? returnDate : undefined,
      },
    ],
  };
}

function mapAgilGeoTreeLocation(entry: AgilGeoTreeLocation): AgilLocationSuggestion | undefined {
  const code = normalizeLocationText(entry.aerocodiata)?.toUpperCase();
  const city = normalizeLocationText(entry.city);
  const country = normalizeLocationText(entry.country);
  if (!code || !city || !country) {
    return undefined;
  }

  const state = normalizeLocationText(entry.state);
  const locality = state ? `${city}, ${state}` : city;

  return {
    code,
    city,
    country,
    countryCode: normalizeLocationText(entry.country_id),
    state,
    cityCode: normalizeLocationText(entry.city_code)?.toUpperCase(),
    searchType: normalizeLocationText(entry.search_type),
    label: `${code} - ${locality}, ${country}`,
  };
}

export async function suggestLocalAgilLocations(query: string, limit = 8): Promise<AgilLocationSuggestion[]> {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length < 1) {
    return [];
  }

  const response = await fetchAgil(
    `${AGIL_BASE_URL}/mv/ubigeo/geotree/${encodeURIComponent(normalizedQuery)}`,
    {
      headers: {
        accept: "application/json, text/plain, */*",
        "not-loading": "true",
      },
    },
    "Agil location suggest",
  );

  if (!response.ok) {
    throw new Error(`Agil location suggest failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json() as AgilGeoTreeLocation[];
  const deduped = new Map<string, AgilLocationSuggestion>();

  for (const entry of payload) {
    const normalized = mapAgilGeoTreeLocation(entry);
    if (!normalized) {
      continue;
    }

    const key = [
      normalized.code,
      normalized.city.toLowerCase(),
      normalized.country.toLowerCase(),
    ].join("::");

    if (!deduped.has(key)) {
      deduped.set(key, normalized);
    }
  }

  return rankLocationSuggestions(normalizedQuery, [...deduped.values()], limit) as AgilLocationSuggestion[];
}

function buildPurchasePaths(request: SearchRequest): PurchasePath[] {
  return [
    {
      id: "agil-search",
      type: "search-redirect",
      provider: "agil-local",
      label: "Buscar en Agil",
      url: buildLocalAgilSearchRedirectUrl(request),
      precision: "exact-search",
      score: 0.9,
      requiresNewTab: true,
      commercialMode: "provider",
      state: "search_redirect",
    },
  ];
}

function buildManualReferenceText(
  itineraries: Itinerary[],
  validatingCarrier: string | undefined,
  totalAmount: number,
  currencyCode: string,
): string {
  const lines = [
    "REFERENCIA DE BUSQUEDA",
    validatingCarrier ? `Carrier: ${validatingCarrier}` : "",
    `Precio visto: ${currencyCode} ${totalAmount.toFixed(2)}`,
    "",
  ].filter(Boolean);

  itineraries.forEach((itinerary, itineraryIndex) => {
    const firstSegment = itinerary.segments[0];
    const lastSegment = itinerary.segments[itinerary.segments.length - 1];
    lines.push(
      `Tramo ${itineraryIndex + 1}: ${firstSegment?.origin ?? "?"} -> ${lastSegment?.destination ?? "?"}`,
    );

    itinerary.segments.forEach((segment) => {
      lines.push(
        `  ${segment.marketingCarrier}${segment.flightNumber}  ${segment.origin} ${segment.departureAt} -> ${segment.destination} ${segment.arrivalAt}`,
      );
    });

    lines.push("");
  });

  lines.push("Nota: el boton de Agil abre la busqueda equivalente, no una tarifa exacta bloqueada.");
  return lines.join("\n");
}

function buildStableOfferId(
  signature: string,
  totalAmount: number,
  currencyCode: string,
  baggage: BaggageSummary | undefined,
  tags: string[],
): string {
  const seed = [
    signature,
    totalAmount.toFixed(2),
    currencyCode,
    String(baggage?.checkedBags ?? ""),
    String(baggage?.carryOnIncluded ?? ""),
    tags.join("|"),
  ].join("::");

  return `agil-${sha1Hex(seed).slice(0, 16)}`;
}

function totalMinutes(offer: CanonicalOffer): number {
  return offer.itineraries.reduce((sum, itinerary) => sum + itinerary.durationMinutes, 0);
}

function dedupeAgilOffers(offers: CanonicalOffer[]): CanonicalOffer[] {
  const deduped = new Map<string, CanonicalOffer>();

  for (const offer of offers) {
    const baggageKey = [
      String(offer.baggage?.checkedBags ?? ""),
      String(offer.baggage?.carryOnIncluded ?? ""),
      String(offer.baggage?.checkedIncluded ?? ""),
    ].join(":");
    const key = [
      offer.signature,
      offer.price.total.amount.toFixed(2),
      offer.price.total.currencyCode,
      baggageKey,
    ].join("::");
    const existing = deduped.get(key);

    if (!existing) {
      deduped.set(key, offer);
      continue;
    }

    const existingSeats = existing.fareMeta?.seatsRemaining ?? 0;
    const currentSeats = offer.fareMeta?.seatsRemaining ?? 0;
    const existingDuration = totalMinutes(existing);
    const currentDuration = totalMinutes(offer);

    if (currentSeats > existingSeats || (currentSeats === existingSeats && currentDuration < existingDuration)) {
      deduped.set(key, offer);
    }
  }

  return [...deduped.values()];
}

function computeAgilBreakdownTotal(fareBreakDowns: AgilFareBreakdown[]): number | undefined {
  const total = fareBreakDowns.reduce((sum, breakdown) => {
    const passengerFare = breakdown.passengerFare;
    if (!passengerFare) {
      return sum;
    }

    const quantity = Math.max(1, Math.trunc(parseProviderAmount(breakdown.passengerType?.quantity) ?? 1));
    const fareTotal = parseProviderAmount(passengerFare.totalFare)
      ?? ((parseProviderAmount(passengerFare.baseFare) ?? 0) + (parseProviderAmount(passengerFare.taxes) ?? 0));
    const passengerTotal = fareTotal - (parseProviderAmount(passengerFare.dsctoTaxes) ?? 0);

    return passengerTotal > 0
      ? sum + (passengerTotal * quantity)
      : sum;
  }, 0);

  return total > 0 ? roundProviderAmount(total) : undefined;
}

function computeAgilTotalAmount(pricingInfo: AgilPricingInfo | undefined): number | undefined {
  const fareBreakDowns = asArray(pricingInfo?.itinTotalFare?.fareBreakDowns);
  const breakdownTotal = computeAgilBreakdownTotal(fareBreakDowns);
  const providerTotal = parseProviderAmount(pricingInfo?.totalFare);

  if (typeof providerTotal === "number" && providerTotal > 0) {
    if (!breakdownTotal || providerAmountsDiffer(providerTotal, breakdownTotal)) {
      return roundProviderAmount(providerTotal);
    }
  }

  if (typeof breakdownTotal === "number") {
    return breakdownTotal;
  }

  if (typeof providerTotal === "number" && providerTotal > 0) {
    return roundProviderAmount(providerTotal);
  }

  return undefined;
}

export function computeAgilTotalAmountForTests(pricingInfo: unknown): number | undefined {
  return computeAgilTotalAmount(pricingInfo as AgilPricingInfo | undefined);
}

export function extractAgilUsdToPenRate(
  pricingInfo: AgilPricingInfo | undefined,
  fallbackCurrencyCode?: string,
): number | undefined {
  const currencyCode = String(
    pricingInfo?.tipoCambio?.code
      ?? fallbackCurrencyCode
      ?? "",
  ).trim().toUpperCase();
  const rate = parseProviderAmount(pricingInfo?.tipoCambio?.rate);

  if (currencyCode !== "USD" || typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    return undefined;
  }

  return Number(rate.toFixed(4));
}

function mapGroupToOffers(group: AgilSearchGroup, request: SearchRequest): CanonicalOffer[] {
  if (group.display === false) {
    return [];
  }

  const currencyCode = group.pricingInfo?.tipoCambio?.code || request.currencyCode;
  const usdToPenRate = extractAgilUsdToPenRate(group.pricingInfo, currencyCode);
  const totalAmount = computeAgilTotalAmount(group.pricingInfo);
  if (typeof totalAmount !== "number") {
    return [];
  }

  const fareBreakDowns = asArray(group.pricingInfo?.itinTotalFare?.fareBreakDowns);
  const baseAmount = fareBreakDowns.reduce((sum, breakdown) => {
    const quantity = Math.max(1, Math.trunc(parseProviderAmount(breakdown.passengerType?.quantity) ?? 1));
    return sum + ((parseProviderAmount(breakdown.passengerFare?.baseFare) ?? 0) * quantity);
  }, 0);
  const taxesAmount = fareBreakDowns.reduce((sum, breakdown) => {
    const quantity = Math.max(1, Math.trunc(parseProviderAmount(breakdown.passengerType?.quantity) ?? 1));
    return sum + ((parseProviderAmount(breakdown.passengerFare?.taxes) ?? 0) * quantity);
  }, 0);

  const validatingCarrier = group.pricingInfo?.itinTotalFare?.validatingCarrier
    ?? group.airline?.code
    ?? undefined;
  const outboundCandidates = normalizeJourneyCandidates(
    group.departure,
    "outbound",
    validatingCarrier,
  );
  if (outboundCandidates.length === 0) {
    return [];
  }

  const inboundCandidates = request.tripType === "round-trip"
    ? normalizeJourneyCandidates(group.returns, "inbound", validatingCarrier)
    : [];
  if (request.tripType === "round-trip" && inboundCandidates.length === 0) {
    return [];
  }

  const tags = [
    group.lowCost ? "low-cost" : "",
    group.brandedFare ? "branded-fare" : "",
    group.isAdvanceSale ? "advance-sale" : "",
    group.esOnline ? "online" : "",
  ].filter(Boolean);

  const price = {
    total: {
      amount: totalAmount,
      currencyCode,
    },
    base: buildMoney(baseAmount > 0 ? Number(baseAmount.toFixed(2)) : undefined, currencyCode),
    taxes: buildMoney(taxesAmount > 0 ? Number(taxesAmount.toFixed(2)) : undefined, currencyCode),
  };
  const leg = request.legs[0];
  const candidatePairs: Array<{ outbound: ItineraryCandidate; inbound?: ItineraryCandidate }> = [];
  if (request.tripType === "round-trip") {
    for (const outbound of outboundCandidates) {
      for (const inbound of inboundCandidates) {
        candidatePairs.push({ outbound, inbound });
        if (candidatePairs.length >= PROVIDER_OFFER_VARIANT_LIMIT) break;
      }
      if (candidatePairs.length >= PROVIDER_OFFER_VARIANT_LIMIT) break;
    }
  } else {
    for (const outbound of outboundCandidates) {
      candidatePairs.push({ outbound, inbound: undefined });
      if (candidatePairs.length >= PROVIDER_OFFER_VARIANT_LIMIT) break;
    }
  }

  return takeProviderOfferVariants(candidatePairs).flatMap(({ outbound, inbound }) => {
    const itineraries = inbound
      ? [outbound.itinerary, inbound.itinerary]
      : [outbound.itinerary];
    const baggage = buildBaggageSummary(outbound.baggage, inbound?.baggage);
    const mainCarrier = outbound.itinerary.segments[0]?.marketingCarrier ?? validatingCarrier;
    const offer: CanonicalOffer = {
      id: "",
      signature: "",
      providerSource: "agil-local",
      providerOfferRef: [
        group.id ?? "group",
        outbound.key,
        inbound?.key ?? "ow",
      ].join(":"),
      tripType: request.tripType,
      validatingCarrier,
      mainCarrier,
      origin: leg.origin,
      destination: leg.destination,
      itineraries,
      price,
      usdToPenRate,
      baggage,
      fareMeta: {
        lastTicketingDate: parseLimitDate(group.pricingInfo?.itinTotalFare?.limitDate),
        seatsRemaining: minimumNumber([outbound.seatsRemaining, inbound?.seatsRemaining]),
      },
      priceConfidence: "live",
      priceStatus: "unverified",
      purchasePaths: [
        ...buildPurchasePaths(
          buildOfferSearchRequest(
            request,
            itineraries,
            leg.origin,
            leg.destination,
            inbound ? "round-trip" : "one-way",
          ),
        ),
        {
          id: "agil-reference",
          type: "manual-reference",
          provider: "agil-local",
          label: "Referencia de oferta",
          precision: "manual",
          score: 0.6,
          requiresNewTab: false,
          commercialMode: "manual",
          state: "manual",
          referenceText: buildManualReferenceText(
            itineraries,
            validatingCarrier,
            totalAmount,
            currencyCode,
          ),
        },
      ],
      comparisonMetrics: {
        totalDurationMinutes: 0,
        totalStops: 0,
        baggageScore: 0,
        purchasePathScore: 0,
      },
      tags,
      warnings: [],
      rawRefs: {
        agilGroupId: group.id,
        outboundKey: outbound.key,
        inboundKey: inbound?.key,
        gdsId: group.gds?.idGDS,
        webSessionId: group.gds?.webSessionID,
        officeId: group.gds?.officeId,
        iata: group.gds?.iata,
      },
    };

    offer.signature = buildOfferSignature(offer);
    offer.id = buildStableOfferId(
      offer.signature,
      offer.price.total.amount,
      offer.price.total.currencyCode,
      baggage,
      tags,
    );

    return [offer];
  });
}

function buildAgilMatrixVariantKey(offer: CanonicalOffer): string {
  return buildFlexibleVariantGroupKey({
    mainCarrier: offer.mainCarrier,
    validatingCarrier: offer.validatingCarrier,
    totalAmount: offer.price.total.amount,
    currencyCode: offer.price.total.currencyCode,
    itineraries: offer.itineraries,
    baggage: offer.baggage,
  });
}

function buildAgilCellQuoteFromOffer(offer: CanonicalOffer): AgilCellQuote {
  return {
    amount: offer.price.total.amount,
    currencyCode: offer.price.total.currencyCode,
    validatingCarrier: offer.validatingCarrier,
    variantKey: buildAgilMatrixVariantKey(offer),
    offer,
  };
}

function compareAgilCellQuotes(left: AgilCellQuote, right: AgilCellQuote): number {
  const priceDiff = left.amount - right.amount;
  if (priceDiff !== 0) {
    return priceDiff;
  }

  return String(left.variantKey ?? "").localeCompare(String(right.variantKey ?? ""));
}

function selectAgilMatrixQuote(groups: AgilSearchGroup[], request: SearchRequest): AgilCellQuote | undefined {
  return groups
    .flatMap((group) => mapGroupToOffers(group, request))
    .map(buildAgilCellQuoteFromOffer)
    .reduce<AgilCellQuote | undefined>((best, current) => {
      if (!best || compareAgilCellQuotes(current, best) < 0) {
        return current;
      }

      return best;
    }, undefined);
}

async function searchCellWithGds(
  session: AgilSessionData,
  request: SearchRequest,
  gds: number,
): Promise<AgilCellQuote | undefined> {
  const response = await fetchAgil(`${AGIL_BASE_URL}/mv/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.token}`,
      "not-loading": "true",
    },
    body: JSON.stringify(buildAgilSearchPayload(request, gds)),
  }, `Agil matrix search GDS ${gds}`);

  if (response.status === 401) {
    throw new Error("AGIL_TOKEN_EXPIRED");
  }

  if (!response.ok) {
    return undefined;
  }

  const json = await response.json() as AgilSearchResponse;
  const groups = Array.isArray(json.groups) ? json.groups : [];
  return selectAgilMatrixQuote(groups, request);
}

async function searchGroupsWithGds(
  session: AgilSessionData,
  request: SearchRequest,
  gds: number,
): Promise<AgilSearchGroup[]> {
  const response = await fetchAgil(`${AGIL_BASE_URL}/mv/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.token}`,
      "not-loading": "true",
    },
    body: JSON.stringify(buildAgilSearchPayload(request, gds)),
  }, `Agil search GDS ${gds}`);

  if (response.status === 401) {
    throw new Error("AGIL_TOKEN_EXPIRED");
  }

  if (!response.ok) {
    const detail = await readAgilErrorBody(response);
    throw new Error(
      detail
        ? `Agil GDS ${gds} failed with ${response.status} ${response.statusText}: ${detail}`
        : `Agil GDS ${gds} failed with ${response.status} ${response.statusText}`,
    );
  }

  const json = await response.json() as AgilSearchResponse;
  return Array.isArray(json.groups) ? json.groups : [];
}

async function startAgilSearch(
  session: AgilSessionData,
  request: SearchRequest,
): Promise<void> {
  const response = await fetchAgil(`${AGIL_BASE_URL}/mv/start-search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.token}`,
      "not-loading": "true",
    },
    body: JSON.stringify(buildAgilStartSearchPayload(request, crypto.randomUUID())),
  }, "Agil start-search");

  if (response.status === 401) {
    throw new Error("AGIL_TOKEN_EXPIRED");
  }

  if (!response.ok) {
    const detail = await readAgilErrorBody(response);
    throw new Error(
      detail
        ? `Agil start-search failed with ${response.status} ${response.statusText}: ${detail}`
        : `Agil start-search failed with ${response.status} ${response.statusText}`,
    );
  }
}

async function searchGroupsAcrossGds(
  baseSession: AgilSessionData,
  request: SearchRequest,
): Promise<AgilExactSearchOutcome> {
  let session = baseSession;

  const searchAll = async (): Promise<AgilExactSearchOutcome> => {
    await startAgilSearch(session, request);

    const outcomes = await mapConcurrent(AGIL_GDS_LIST, AGIL_CONCURRENCY.gdsSearch, async (gds) => {
      try {
        return {
          gds,
          groups: await searchGroupsWithGds(session, request, gds),
        };
      } catch (error) {
        if (error instanceof Error && error.message === "AGIL_TOKEN_EXPIRED") {
          throw error;
        }

        return {
          gds,
          groups: [],
          error: error instanceof Error ? error.message : `Agil GDS ${gds} failed.`,
        };
      }
    });

    const errorOutcomes = outcomes.filter((outcome) => "error" in outcome);
    const warnings = errorOutcomes
      .filter((outcome) => "error" in outcome)
      .map((outcome) => `Agil GDS ${outcome.gds} omitted: ${outcome.error}`);

    if (errorOutcomes.length === outcomes.length) {
      const firstError = errorOutcomes[0]?.error;
      return {
        groups: [],
        warnings: uniqueStrings([
          `Agil rejected this search in all configured GDS: ${requestSummary(request)}.`,
          firstError ? `Agil detail: ${firstError}` : "",
        ]),
        partial: true,
      };
    }

    return {
      groups: outcomes.flatMap((outcome) => outcome.groups),
      warnings: uniqueStrings(warnings),
      partial: warnings.length > 0,
    };
  };

  try {
    return await searchAll();
  } catch (error) {
    if (error instanceof Error && error.message === "AGIL_TOKEN_EXPIRED") {
      session = await refreshAgilToken(session);
      cachedSession = session;
      return searchAll();
    }

    throw error;
  }
}

async function searchCellPrice(baseSession: AgilSessionData, request: SearchRequest): Promise<AgilCellQuote | undefined> {
  let session = baseSession;

  const searchAll = async () => {
    await startAgilSearch(session, request);

    const results = await mapConcurrent(
      AGIL_GDS_LIST,
      AGIL_CONCURRENCY.gdsSearch,
      async (gds) => searchCellWithGds(session, request, gds),
    );
    return results.reduce<AgilCellQuote | undefined>((best, current) => {
      if (!current) {
        return best;
      }

      if (!best || current.amount < best.amount) {
        return current;
      }

      return best;
    }, undefined);
  };

  try {
    return await searchAll();
  } catch (error) {
    if (error instanceof Error && error.message === "AGIL_TOKEN_EXPIRED") {
      session = await refreshAgilToken(session);
      cachedSession = session;
      return searchAll();
    }

    throw error;
  }
}

function buildAgilMatrixCellFromQuote(
  cell: MatrixCell & { derivedRequest: SearchRequest; confidence: "loading" },
  quote: AgilCellQuote,
): MatrixCell {
  const purchasePaths = quote.offer.purchasePaths.length > 0
    ? quote.offer.purchasePaths
    : buildPurchasePaths(cell.derivedRequest);
  const offer = {
    ...quote.offer,
    purchasePaths,
  };

  return {
    ...cell,
    price: offer.price.total,
    variantKey: quote.variantKey,
    purchasePaths,
    offer,
    confidence: "live",
    selectable: true,
    stateCode: "live",
    tooltip: offer.validatingCarrier
      ? `Agil exact search. Cheapest validating carrier: ${offer.validatingCarrier}.`
      : "Agil exact search.",
  };
}

export async function searchLocalAgilExact(request: SearchRequest): Promise<ProviderSearchResult> {
  const session = await getAgilSession();
  const outcome = await searchGroupsAcrossGds(session, request);
  const offers = dedupeAgilOffers(
    outcome.groups.flatMap((group) => mapGroupToOffers(group, request)),
  );
  const warnings = uniqueStrings([...outcome.warnings]);

  if (offers.length === 0 && warnings.length === 0) {
    warnings.push("Agil returned no offers for this search.");
  }

  return {
    offers,
    warnings,
    partial: outcome.partial,
  };
}

export async function resolveLocalAgilUsdToPenRate(request: SearchRequest): Promise<number | undefined> {
  const session = await getAgilSession();
  const outcome = await searchGroupsAcrossGds(session, request);
  const rates = outcome.groups
    .map((group) => extractAgilUsdToPenRate(group.pricingInfo, request.currencyCode))
    .filter((rate): rate is number => typeof rate === "number" && Number.isFinite(rate) && rate > 0);

  if (rates.length === 0) {
    return undefined;
  }

  const counts = new Map<number, number>();
  rates.forEach((rate) => {
    counts.set(rate, (counts.get(rate) ?? 0) + 1);
  });

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])[0]?.[0];
}

export function createLocalAgilSearchDraft(
  request: SearchRequest,
  providerMeta: ProviderMeta,
): SearchResponse {
  const requestedAt = new Date().toISOString();
  const warning = request.searchMode === "stay-range"
    ? "Consultando Agil en paralelo. Los resultados se iran agregando."
    : "Consultando Agil. Los resultados se iran agregando.";

  return {
    offers: [],
    allOffers: [],
    searchMeta: {
      requestedAt,
      completedAt: requestedAt,
      providersUsed: ["agil-local"],
      warnings: [warning],
      partial: true,
      searchState: "search_partial",
    },
    providerMeta,
    warnings: [warning],
  };
}

export async function resolveLocalAgilExactProgressive(
  request: SearchRequest,
  onUpdate?: (result: ProviderSearchResult) => boolean | void,
): Promise<ProviderSearchResult> {
  let session = await getAgilSession();
  const groups: AgilSearchGroup[] = [];
  const warnings: string[] = [];
  let partial = false;
  let stopRequested = false;

  const searchAll = async (): Promise<void> => {
    await startAgilSearch(session, request);

    await mapConcurrent(AGIL_GDS_LIST, AGIL_CONCURRENCY.gdsSearch, async (gds) => {
      try {
        const resolvedGroups = await searchGroupsWithGds(session, request, gds);
        groups.push(...resolvedGroups);
        const offers = dedupeAgilOffers(
          groups.flatMap((group) => mapGroupToOffers(group, request)),
        );

        if (onUpdate?.({
          offers,
          warnings: uniqueStrings([...warnings]),
          partial: true,
        }) === false) {
          stopRequested = true;
        }
      } catch (error) {
        partial = true;
        const warning = error instanceof Error
          ? `Agil GDS ${gds} omitted: ${error.message}`
          : `Agil GDS ${gds} omitted due to an unknown error.`;
        warnings.push(warning);

        const offers = dedupeAgilOffers(
          groups.flatMap((group) => mapGroupToOffers(group, request)),
        );

        if (onUpdate?.({
          offers,
          warnings: uniqueStrings([...warnings]),
          partial: true,
        }) === false) {
          stopRequested = true;
        }
      }
    }, {
      canContinue: () => !stopRequested,
    });
  };

  try {
    await searchAll();
  } catch (error) {
    if (error instanceof Error && error.message === "AGIL_TOKEN_EXPIRED") {
      session = await refreshAgilToken(session);
      cachedSession = session;
      await searchAll();
    } else {
      throw error;
    }
  }

  const offers = dedupeAgilOffers(
    groups.flatMap((group) => mapGroupToOffers(group, request)),
  );
  const finalWarnings = uniqueStrings([...warnings]);

  if (offers.length === 0 && finalWarnings.length === 0) {
    finalWarnings.push("Agil returned no offers for this search.");
  }

  return {
    offers,
    warnings: finalWarnings,
    partial: partial || stopRequested,
  };
}

function enumerateStayRangeRequests(request: SearchRequest): SearchRequest[] {
  return enumerateUsefulFlexibleRequests(request);
}

export async function searchLocalAgilRange(request: SearchRequest): Promise<ProviderSearchResult> {
  const candidates = enumerateStayRangeRequests(request);

  const outcomes = await mapConcurrent(candidates, AGIL_CONCURRENCY.rangeSearch, async (derivedRequest) => {
    try {
      return {
        result: await searchLocalAgilExactWithRetry(derivedRequest),
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Agil range search failed.",
      };
    }
  });

  const warnings = uniqueStrings([
    ...outcomes.flatMap((outcome) => outcome.result?.warnings ?? []),
    ...outcomes.flatMap((outcome) => outcome.error ? [outcome.error] : []),
  ]);
  const partial = outcomes.some((outcome) => Boolean(outcome.error))
    || outcomes.some((outcome) => outcome.result?.partial);
  const offers = dedupeAgilOffers(
    outcomes.flatMap((outcome) => outcome.result?.offers ?? []),
  );

  if (offers.length === 0 && warnings.length === 0) {
    warnings.push("Agil returned no offers for this date range.");
  }

  return {
    offers,
    warnings,
    partial,
  };
}

export async function resolveLocalAgilRangeProgressive(
  request: SearchRequest,
  onUpdate?: (result: ProviderSearchResult) => boolean | void,
): Promise<ProviderSearchResult> {
  const candidates = enumerateStayRangeRequests(request);
  const aggregatedOffers: CanonicalOffer[] = [];
  const warnings: string[] = [];
  let partial = false;
  let stopRequested = false;

  await mapConcurrent(candidates, AGIL_CONCURRENCY.rangeSearch, async (derivedRequest) => {
    try {
      const result = await searchLocalAgilExactWithRetry(derivedRequest);
      aggregatedOffers.push(...result.offers);
      if (result.partial) {
        partial = true;
      }
      warnings.push(...result.warnings);
    } catch (error) {
      partial = true;
      warnings.push(error instanceof Error ? error.message : "Agil range search failed.");
    }

    if (onUpdate?.({
      offers: dedupeAgilOffers(aggregatedOffers),
      warnings: uniqueStrings([...warnings]),
      partial: true,
    }) === false) {
      stopRequested = true;
    }
  }, {
    canContinue: () => !stopRequested,
  });

  const offers = dedupeAgilOffers(aggregatedOffers);
  const finalWarnings = uniqueStrings([...warnings]);
  if (offers.length === 0 && finalWarnings.length === 0) {
    finalWarnings.push("Agil returned no offers for this date range.");
  }

  return {
    offers,
    warnings: finalWarnings,
    partial: partial || stopRequested,
  };
}

export function createLocalAgilMatrixDraft(
  request: SearchRequest,
  providerMeta: ProviderMeta,
): MatrixResponse {
  const leg = request.legs[0];
  if (!leg.departureStart || !leg.departureEnd) {
    throw new Error("Local Agil matrix requires departureStart and departureEnd.");
  }

  const departures = enumerateRange(leg.departureStart, leg.departureEnd);
  const requestedAt = new Date().toISOString();
  const pairs = request.tripType === "round-trip"
    ? enumerateUsefulRoundTripPairs(request)
    : [];
  const axes = request.tripType === "round-trip"
    ? enumerateRoundTripFlexibleAxes(request, pairs)
    : {
        departureDates: departures,
        returnDates: [] as string[],
      };
  const cells = request.tripType === "one-way"
    ? departures.map((departureDate) => ({
        key: departureDate,
        departureDate,
        confidence: "loading" as const,
        providerSource: "agil-local" as const,
        selectable: false,
        requiresRequery: true,
        stateCode: "ind" as const,
        tooltip: "Consultando Agil...",
        derivedRequest: buildDerivedOneWayRequest(request, departureDate),
      } satisfies MatrixCell))
    : pairs.map(({ departureDate, returnDate }) => ({
        key: `${departureDate}_${returnDate}`,
        departureDate,
        returnDate,
        stayNights: diffDays(departureDate, returnDate),
        confidence: "loading" as const,
        providerSource: "agil-local" as const,
        selectable: false,
        requiresRequery: true,
        stateCode: "ind" as const,
        tooltip: "Consultando Agil...",
        derivedRequest: buildDerivedRequest(request, departureDate, returnDate),
      } satisfies MatrixCell));

  return {
    cells,
    axes,
    confidenceSummary: buildMatrixConfidenceSummary(cells),
    recommendations: [
      "Matrix loading from Agil in parallel.",
      "Prices appear as each valid date combination resolves.",
    ],
    searchMeta: {
      requestedAt,
      completedAt: requestedAt,
      providersUsed: ["agil-local"],
      warnings: ["Matrix loading from Agil in parallel."],
      partial: true,
      searchState: "search_partial",
    },
    providerMeta,
    warnings: ["Matrix loading from Agil in parallel."],
  };
}

export async function resolveLocalAgilMatrixProgressive(
  request: SearchRequest,
  draft: MatrixResponse,
  onCellResolved?: (cell: MatrixCell) => boolean | void,
): Promise<MatrixResponse> {
  const session = await getAgilSession();
  let partial = false;
  let stopRequested = false;
  const prioritizedCells = prioritizeMatrixLoadingCells(draft.cells, draft.axes, request.tripType);

  const resolvedLoadingCells = await mapConcurrent(prioritizedCells, AGIL_CONCURRENCY.matrixCell, async (cell) => {
    try {
      const quote = await searchCellPrice(session, cell.derivedRequest);
      const nextCell = quote
        ? buildAgilMatrixCellFromQuote(cell, quote)
        : {
            ...cell,
            confidence: "unavailable" as const,
            selectable: false,
            stateCode: "chg" as const,
            tooltip: "Agil returned no live result for this combination.",
          } satisfies MatrixCell;

      if (onCellResolved?.(nextCell) === false) {
        stopRequested = true;
      }
      return nextCell;
    } catch (error) {
      partial = true;
      const nextCell = {
        ...cell,
        confidence: "unavailable" as const,
        selectable: false,
        stateCode: "chg" as const,
        tooltip: error instanceof Error
          ? `Agil error: ${error.message}`
          : "Agil error while resolving this combination.",
      } satisfies MatrixCell;
      if (onCellResolved?.(nextCell) === false) {
        stopRequested = true;
      }
      return nextCell;
    }
  }, {
    canContinue: () => !stopRequested,
  });
  const resolvedByKey = new Map(resolvedLoadingCells.map((cell) => [cell.key, cell]));
  const resolvedCells = draft.cells.map((cell) => resolvedByKey.get(cell.key) ?? cell);

  const warnings = partial
    ? ["Matrix finished with partial Agil failures."]
    : ["Matrix built from Agil exact searches in parallel."];

  return {
    ...draft,
    cells: resolvedCells,
    confidenceSummary: buildMatrixConfidenceSummary(resolvedCells),
    recommendations: [
      "Matrix built from Agil exact searches in parallel.",
      "Selecting a cell runs a full Agil exact search for offers.",
    ],
    searchMeta: {
      requestedAt: draft.searchMeta.requestedAt,
      completedAt: new Date().toISOString(),
      providersUsed: ["agil-local"],
      warnings,
      partial,
      searchState: partial ? "search_partial" : "search_live",
    },
    warnings,
  };
}

export async function buildLocalAgilMatrix(
  request: SearchRequest,
  providerMeta: ProviderMeta,
): Promise<MatrixResponse> {
  const draft = createLocalAgilMatrixDraft(request, providerMeta);
  return resolveLocalAgilMatrixProgressive(request, draft);
}
