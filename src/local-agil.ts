import { createHash, randomUUID } from "node:crypto";
import { spawn, ChildProcess, execFileSync } from "node:child_process";
import { readFileSync, rmSync, mkdirSync, cpSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Browser, BrowserContext, Page } from "playwright";
import { buildOfferSignature } from "./core/offer-signature";
import {
  ProviderSearchResult,
  RepriceResult,
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
  SearchMeta,
  SearchResponse,
  SearchRequest,
  Segment,
} from "./core/types";

interface BrowserStorageSnapshot {
  tokenSearchFlight: string;
  userData: string;
  ip: string;
}

interface AgilSessionData {
  token: string;
  expiresAtMs: number;
  userCode: number;
  internalCode: string;
  ip: string;
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
  piezas?: number;
  cabina?: {
    piezas?: number;
  };
}

interface AgilFareBreakdown {
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
const DEFAULT_AGIL_APIM_SUBSCRIPTION_KEY = "e9c66b5e1b4348ae9de63ff98d66cbbe";
const AGIL_STORAGE_ORIGINS = [
  "https://www.agilsmart.com/home-user",
  "https://motorvuelos.expertiatravel.com/",
] as const;
const AGIL_MIN_FLEXIBLE_PARALLELISM = 10;
const AGIL_GDS_SEARCH_CONCURRENCY = Math.max(
  1,
  Number(process.env.AGIL_GDS_SEARCH_CONCURRENCY ?? 2),
);
const AGIL_MATRIX_CELL_CONCURRENCY = Math.max(
  AGIL_MIN_FLEXIBLE_PARALLELISM,
  Number(process.env.AGIL_MATRIX_CELL_CONCURRENCY ?? AGIL_MIN_FLEXIBLE_PARALLELISM),
);
const AGIL_RANGE_SEARCH_CONCURRENCY = Math.max(
  AGIL_MIN_FLEXIBLE_PARALLELISM,
  Number(process.env.AGIL_RANGE_SEARCH_CONCURRENCY ?? AGIL_MIN_FLEXIBLE_PARALLELISM),
);
const AGIL_APIM_SUBSCRIPTION_KEY = process.env.AGIL_APIM_SUBSCRIPTION_KEY?.trim()
  || DEFAULT_AGIL_APIM_SUBSCRIPTION_KEY;

export const AGIL_CONCURRENCY = Object.freeze({
  flexibleMinimum: AGIL_MIN_FLEXIBLE_PARALLELISM,
  gdsSearch: AGIL_GDS_SEARCH_CONCURRENCY,
  matrixCell: AGIL_MATRIX_CELL_CONCURRENCY,
  rangeSearch: AGIL_RANGE_SEARCH_CONCURRENCY,
});

let playwrightPromise: Promise<typeof import("playwright")> | undefined;
let cachedSession: AgilSessionData | undefined;

function addDays(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function diffDays(fromIso: string, toIso: string): number {
  const from = new Date(`${fromIso}T00:00:00Z`).getTime();
  const to = new Date(`${toIso}T00:00:00Z`).getTime();
  return Math.round((to - from) / 86400000);
}

function enumerateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  let current = start;
  while (current <= end) {
    dates.push(current);
    current = addDays(current, 1);
  }
  return dates;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
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

function resolveBrowserUserDataDir(): string {
  const configured = process.env.AGIL_CHROME_USER_DATA_DIR?.trim();
  if (configured) {
    return configured;
  }

  return join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "User Data");
}

function readChromeProfileName(): string {
  const localStatePath = join(resolveBrowserUserDataDir(), "Local State");

  const raw = readFileSync(localStatePath, "utf8");
  const parsed = JSON.parse(raw) as { profile?: { last_used?: string } };
  return parsed.profile?.last_used || "Default";
}

function readChromeProfileCandidates(): string[] {
  const configured = process.env.AGIL_CHROME_PROFILE?.trim();
  if (configured) {
    return [configured];
  }

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

  try {
    pushUnique(readChromeProfileName());
  } catch {
    pushUnique("Default");
  }

  try {
    const localStatePath = join(resolveBrowserUserDataDir(), "Local State");
    const raw = readFileSync(localStatePath, "utf8");
    const parsed = JSON.parse(raw) as { profile?: { info_cache?: Record<string, unknown> } };
    Object.keys(parsed.profile?.info_cache ?? {}).forEach((profileName) => pushUnique(profileName));
  } catch {
    // Ignore and fall back to directory enumeration.
  }

  try {
    const userDataDir = resolveBrowserUserDataDir();
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

  try {
    const output = execFileSync("nslookup", ["agilsmart.com", "8.8.8.8"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const lines = output.split(/\r?\n/);
    const addressLine = lines
      .map((line) => line.trim())
      .find((line) => /^Address:\s+\d{1,3}(?:\.\d{1,3}){3}$/.test(line));
    return addressLine?.replace(/^Address:\s+/, "").trim();
  } catch {
    return undefined;
  }
}

function prepareTemporaryChromeProfile(profileName: string): string {
  const sourceRoot = resolveBrowserUserDataDir();
  const tempRoot = join(tmpdir(), `travel_quote_foundation_agil_${randomUUID()}`);
  const profileRoot = join(tempRoot, profileName);
  mkdirSync(profileRoot, { recursive: true });

  const items = [
    "Local State",
    join(profileName, "Preferences"),
    join(profileName, "Secure Preferences"),
    join(profileName, "Local Storage"),
    join(profileName, "Session Storage"),
    join(profileName, "IndexedDB"),
    join(profileName, "WebStorage"),
  ];

  for (const relativePath of items) {
    const source = join(sourceRoot, relativePath);
    if (!existsSync(source)) {
      continue;
    }

    const destination = join(tempRoot, relativePath);
    mkdirSync(join(destination, ".."), { recursive: true });
    cpSync(source, destination, { recursive: true, force: true });
  }

  return tempRoot;
}

function resolveChromeProfileName(): string {
  const configured = process.env.AGIL_CHROME_PROFILE?.trim();
  if (configured) {
    return configured;
  }

  return readChromeProfileName();
}

function launchChromeForCdp(userDataDir: string, profileName: string, port: number): ChildProcess {
  const chromePath = findChromeExecutable();
  const args = [
    `--user-data-dir=${userDataDir}`,
    `--profile-directory=${profileName}`,
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

  return spawn(chromePath, args, {
    stdio: "ignore",
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
        || Boolean(localStorage.getItem("user_data"))
        || Boolean(localStorage.getItem("ip"))
      ), {
        timeout: 5000,
      });
    } catch {
      // Some origins may not persist data for the active session.
    }

    return page.evaluate(() => ({
      tokenSearchFlight: localStorage.getItem("tokenSearchFlight") || "",
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
          || Boolean(localStorage.getItem("user_data"))
          || Boolean(localStorage.getItem("ip"))
        ), {
          timeout: 5000,
        });
      } catch {
        // Some origins may not persist data for the active session.
      }

      return await page.evaluate(() => ({
        tokenSearchFlight: localStorage.getItem("tokenSearchFlight") || "",
        userData: localStorage.getItem("user_data") || "",
        ip: localStorage.getItem("ip") || "",
      }));
    } finally {
      await page.close().catch(() => undefined);
    }
  });
}

async function extractBrowserStorageSnapshot(): Promise<BrowserStorageSnapshot> {
  const profileNames = readChromeProfileCandidates();
  const failures: string[] = [];

  for (const profileName of profileNames) {
    const userDataDir = prepareTemporaryChromeProfile(profileName);
    const port = 9400 + Math.floor(Math.random() * 200);
    const chrome = launchChromeForCdp(userDataDir, profileName, port);
    let browser: Browser | undefined;

    try {
      await waitForDebugger(port);
      const playwright = await getPlaywright();
      browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const context = browser.contexts()[0];
      return await readAgilStorageSnapshotFromContext(context);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unable to read Agil storage";
      failures.push(`${profileName}: ${detail}`);
    } finally {
      if (browser) {
        await browser.close().catch(() => undefined);
      }

      chrome.kill("SIGTERM");
      try {
        rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        // Chrome can keep transient locks on the copied profile for a moment.
      }
    }
  }

  throw new Error(`Unable to extract Agil session from Chrome profiles. ${failures.join(" | ")}`.trim());
}

export function parseAgilSessionData(snapshot: BrowserStorageSnapshot): AgilSessionData {
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
  const response = await fetch(`${AGIL_BASE_URL}/auth/api/auth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Ocp-Apim-Subscription-Key": AGIL_APIM_SUBSCRIPTION_KEY,
    },
    body: JSON.stringify({
      trackingCode: randomUUID(),
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
  });

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
  };
}

async function getAgilSession(): Promise<AgilSessionData> {
  const now = Date.now();
  if (cachedSession && cachedSession.expiresAtMs - now > 5 * 60 * 1000) {
    return cachedSession;
  }

  const extracted = parseAgilSessionData(await extractBrowserStorageSnapshot());
  cachedSession = await refreshAgilToken(extracted);
  return cachedSession;
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

function buildDerivedRequest(baseRequest: SearchRequest, departureDate: string, returnDate: string): SearchRequest {
  return {
    ...baseRequest,
    tripType: "round-trip",
    searchMode: "exact",
    legs: [
      {
        origin: baseRequest.legs[0].origin,
        destination: baseRequest.legs[0].destination,
        originLabel: baseRequest.legs[0].originLabel,
        destinationLabel: baseRequest.legs[0].destinationLabel,
        departureDate,
        returnDate,
      },
    ],
  };
}

function buildDerivedOneWayRequest(baseRequest: SearchRequest, departureDate: string): SearchRequest {
  return {
    ...baseRequest,
    tripType: "one-way",
    searchMode: "exact",
    legs: [
      {
        origin: baseRequest.legs[0].origin,
        destination: baseRequest.legs[0].destination,
        originLabel: baseRequest.legs[0].originLabel,
        destinationLabel: baseRequest.legs[0].destinationLabel,
        departureDate,
      },
    ],
  };
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function parseIsoDiffMinutes(start?: string, end?: string): number {
  if (!start || !end) {
    return 0;
  }

  const diff = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(diff) ? Math.max(0, Math.round(diff / 60000)) : 0;
}

function parseAgilDurationMinutes(value?: string, start?: string, end?: string): number {
  if (value) {
    const match = value.match(/^(\d+)\.(\d{2})$/);
    if (match) {
      return Number(match[1]) * 60 + Number(match[2]);
    }
  }

  return parseIsoDiffMinutes(start, end);
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

function minimumNumber(values: Array<number | undefined>): number | undefined {
  const numeric = values.filter((value): value is number => typeof value === "number");
  if (numeric.length === 0) {
    return undefined;
  }

  return Math.min(...numeric);
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
          operatingCarrier: flight.operatingAirline?.code ?? marketingCarrier,
          flightNumber: String(flight.flightNumber ?? flightIndex + 1),
          origin: flight.departureAirport?.code ?? "",
          destination: flight.arrivalAirport?.code ?? "",
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
  const checkedBags = minimumNumber(infos.map((info) => info?.piezas));
  const cabinPieces = minimumNumber(infos.map((info) => info?.cabina?.piezas));

  if (checkedBags === undefined && cabinPieces === undefined) {
    return undefined;
  }

  const carryOnIncluded = typeof cabinPieces === "number" ? cabinPieces > 0 : undefined;
  const checkedIncluded = typeof checkedBags === "number" ? checkedBags > 0 : undefined;

  let description = "";
  if (checkedIncluded) {
    description = checkedBags === 1
      ? "Equipaje de mano y 1 maleta facturada"
      : `Equipaje de mano y ${checkedBags} maletas facturadas`;
  } else if (carryOnIncluded) {
    description = "Equipaje de mano incluido";
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

function parseLimitDate(value?: string): string | undefined {
  if (!value || !/^\d{6}$/.test(value)) {
    return undefined;
  }

  const day = value.slice(0, 2);
  const month = value.slice(2, 4);
  const year = `20${value.slice(4, 6)}`;
  return `${year}-${month}-${day}`;
}

function formatAgilSearchLocation(code: string, label?: string): string {
  const normalizedCode = code.trim().toUpperCase();
  const normalizedLabel = label?.trim() ?? "";
  if (!normalizedLabel) {
    return normalizedCode;
  }

  const labelWithoutCode = normalizedLabel
    .replace(new RegExp(`^${normalizedCode}\\s*-?\\s*`, "i"), "")
    .trim();

  return labelWithoutCode
    ? `${normalizedCode} ${labelWithoutCode}`
    : normalizedCode;
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

function normalizeLocationText(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed === "\\N") {
    return undefined;
  }

  return trimmed;
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
  if (normalizedQuery.length < 2) {
    return [];
  }

  const response = await fetch(
    `${AGIL_BASE_URL}/mv/ubigeo/geotree/${encodeURIComponent(normalizedQuery)}`,
    {
      headers: {
        accept: "application/json, text/plain, */*",
        "not-loading": "true",
        "Ocp-Apim-Subscription-Key": AGIL_APIM_SUBSCRIPTION_KEY,
      },
    },
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

  return [...deduped.values()].slice(0, Math.max(1, limit));
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

  return `agil-${createHash("sha1").update(seed).digest("hex").slice(0, 16)}`;
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

function computeAgilTotalAmount(pricingInfo: AgilPricingInfo | undefined): number | undefined {
  const fareBreakDowns = asArray(pricingInfo?.itinTotalFare?.fareBreakDowns);
  const breakdownTotal = fareBreakDowns.reduce((sum, breakdown) => {
    const passengerFare = breakdown.passengerFare;
    if (!passengerFare) {
      return sum;
    }

    return sum
      + (passengerFare.totalFare ?? 0)
      + (passengerFare.feeNMV ?? 0)
      + (passengerFare.feePTA ?? 0)
      - (passengerFare.dsctoTaxes ?? 0);
  }, 0);

  if (breakdownTotal > 0) {
    return Number(breakdownTotal.toFixed(2));
  }

  if (typeof pricingInfo?.totalFare === "number") {
    return Number(pricingInfo.totalFare.toFixed(2));
  }

  return undefined;
}

function mapGroupToOffers(group: AgilSearchGroup, request: SearchRequest): CanonicalOffer[] {
  if (group.display === false) {
    return [];
  }

  const currencyCode = group.pricingInfo?.tipoCambio?.code || request.currencyCode;
  const totalAmount = computeAgilTotalAmount(group.pricingInfo);
  if (typeof totalAmount !== "number") {
    return [];
  }

  const fareBreakDowns = asArray(group.pricingInfo?.itinTotalFare?.fareBreakDowns);
  const baseAmount = fareBreakDowns.reduce((sum, breakdown) => {
    return sum + (breakdown.passengerFare?.baseFare ?? 0);
  }, 0);
  const taxesAmount = fareBreakDowns.reduce((sum, breakdown) => {
    return sum + (breakdown.passengerFare?.taxes ?? 0);
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

  const leg = request.legs[0];
  const outbound = outboundCandidates[0];
  const inbound = request.tripType === "round-trip"
    ? inboundCandidates[0]
    : undefined;
  const itineraries = inbound
    ? [outbound.itinerary, inbound.itinerary]
    : [outbound.itinerary];
  const baggage = buildBaggageSummary(outbound.baggage, inbound?.baggage);
  const mainCarrier = outbound.itinerary.segments[0]?.marketingCarrier ?? validatingCarrier;
  const price = {
    total: {
      amount: totalAmount,
      currencyCode,
    },
    base: buildMoney(baseAmount > 0 ? Number(baseAmount.toFixed(2)) : undefined, currencyCode),
    taxes: buildMoney(taxesAmount > 0 ? Number(taxesAmount.toFixed(2)) : undefined, currencyCode),
  };

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
      gdsId: group.gds?.idGDS,
      webSessionId: group.gds?.webSessionID,
      officeId: group.gds?.officeId,
      iata: group.gds?.iata,
    },
    valueScore: 0,
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
}

async function searchCellWithGds(
  session: AgilSessionData,
  request: SearchRequest,
  gds: number,
): Promise<AgilCellQuote | undefined> {
  const response = await fetch(`${AGIL_BASE_URL}/mv/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.token}`,
      "not-loading": "true",
      "Ocp-Apim-Subscription-Key": AGIL_APIM_SUBSCRIPTION_KEY,
    },
    body: JSON.stringify(buildAgilSearchPayload(request, gds)),
  });

  if (response.status === 401) {
    throw new Error("AGIL_TOKEN_EXPIRED");
  }

  if (!response.ok) {
    return undefined;
  }

  const json = await response.json() as AgilSearchResponse;
  const groups = Array.isArray(json.groups) ? json.groups : [];
  return groups.reduce<AgilCellQuote | undefined>((best, group) => {
    const totalFare = computeAgilTotalAmount(group.pricingInfo);
    if (typeof totalFare !== "number") {
      return best;
    }

    if (!best || totalFare < best.amount) {
      return {
        amount: totalFare,
        currencyCode: group.pricingInfo?.tipoCambio?.code || request.currencyCode,
        validatingCarrier: group.pricingInfo?.itinTotalFare?.validatingCarrier,
      };
    }

    return best;
  }, undefined);
}

async function searchGroupsWithGds(
  session: AgilSessionData,
  request: SearchRequest,
  gds: number,
): Promise<AgilSearchGroup[]> {
  const response = await fetch(`${AGIL_BASE_URL}/mv/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.token}`,
      "not-loading": "true",
      "Ocp-Apim-Subscription-Key": AGIL_APIM_SUBSCRIPTION_KEY,
    },
    body: JSON.stringify(buildAgilSearchPayload(request, gds)),
  });

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
  const response = await fetch(`${AGIL_BASE_URL}/mv/start-search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.token}`,
      "not-loading": "true",
      "Ocp-Apim-Subscription-Key": AGIL_APIM_SUBSCRIPTION_KEY,
    },
    body: JSON.stringify(buildAgilStartSearchPayload(request, randomUUID())),
  });

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

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

async function searchGroupsAcrossGds(
  baseSession: AgilSessionData,
  request: SearchRequest,
): Promise<AgilExactSearchOutcome> {
  let session = baseSession;

  const searchAll = async (): Promise<AgilExactSearchOutcome> => {
    await startAgilSearch(session, request);

    const outcomes = await mapConcurrent(AGIL_GDS_LIST, AGIL_GDS_SEARCH_CONCURRENCY, async (gds) => {
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
      AGIL_GDS_SEARCH_CONCURRENCY,
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
  onUpdate?: (result: ProviderSearchResult) => void,
): Promise<ProviderSearchResult> {
  let session = await getAgilSession();
  const groups: AgilSearchGroup[] = [];
  const warnings: string[] = [];
  let partial = false;

  await mapConcurrent(AGIL_GDS_LIST, AGIL_GDS_SEARCH_CONCURRENCY, async (gds) => {
    try {
      let resolvedGroups: AgilSearchGroup[];
      try {
        resolvedGroups = await searchGroupsWithGds(session, request, gds);
      } catch (error) {
        if (error instanceof Error && error.message === "AGIL_TOKEN_EXPIRED") {
          session = await refreshAgilToken(session);
          cachedSession = session;
          resolvedGroups = await searchGroupsWithGds(session, request, gds);
        } else {
          throw error;
        }
      }

      groups.push(...resolvedGroups);
      const offers = dedupeAgilOffers(
        groups.flatMap((group) => mapGroupToOffers(group, request)),
      );

      onUpdate?.({
        offers,
        warnings: uniqueStrings([...warnings]),
        partial: true,
      });
    } catch (error) {
      partial = true;
      const warning = error instanceof Error
        ? `Agil GDS ${gds} omitted: ${error.message}`
        : `Agil GDS ${gds} omitted due to an unknown error.`;
      warnings.push(warning);

      const offers = dedupeAgilOffers(
        groups.flatMap((group) => mapGroupToOffers(group, request)),
      );

      onUpdate?.({
        offers,
        warnings: uniqueStrings([...warnings]),
        partial: true,
      });
    }
  });

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
    partial,
  };
}

function enumerateStayRangeRequests(request: SearchRequest): SearchRequest[] {
  const leg = request.legs[0];
  if (!leg.departureStart || !leg.departureEnd) {
    throw new Error("Agil range search requires departureStart and departureEnd.");
  }

  const departures = enumerateRange(leg.departureStart, leg.departureEnd);
  if (request.tripType === "one-way") {
    return departures.map((departureDate) => buildDerivedOneWayRequest(request, departureDate));
  }

  if (!leg.returnStart || !leg.returnEnd) {
    throw new Error("Agil round-trip range search requires returnStart and returnEnd.");
  }

  const returns = enumerateRange(leg.returnStart, leg.returnEnd);
  return departures.flatMap((departureDate) => returns
    .filter((returnDate) => returnDate > departureDate)
    .map((returnDate) => buildDerivedRequest(request, departureDate, returnDate)));
}

export async function searchLocalAgilRange(request: SearchRequest): Promise<ProviderSearchResult> {
  const candidates = enumerateStayRangeRequests(request);

  const outcomes = await mapConcurrent(candidates, AGIL_RANGE_SEARCH_CONCURRENCY, async (derivedRequest) => {
    try {
      return {
        result: await searchLocalAgilExact(derivedRequest),
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
  onUpdate?: (result: ProviderSearchResult) => void,
): Promise<ProviderSearchResult> {
  const candidates = enumerateStayRangeRequests(request);
  const aggregatedOffers: CanonicalOffer[] = [];
  const warnings: string[] = [];
  let partial = false;

  await mapConcurrent(candidates, AGIL_RANGE_SEARCH_CONCURRENCY, async (derivedRequest) => {
    try {
      const result = await searchLocalAgilExact(derivedRequest);
      aggregatedOffers.push(...result.offers);
      if (result.partial) {
        partial = true;
      }
      warnings.push(...result.warnings);
    } catch (error) {
      partial = true;
      warnings.push(error instanceof Error ? error.message : "Agil range search failed.");
    }

    onUpdate?.({
      offers: dedupeAgilOffers(aggregatedOffers),
      warnings: uniqueStrings([...warnings]),
      partial: true,
    });
  });

  const offers = dedupeAgilOffers(aggregatedOffers);
  const finalWarnings = uniqueStrings([...warnings]);
  if (offers.length === 0 && finalWarnings.length === 0) {
    finalWarnings.push("Agil returned no offers for this date range.");
  }

  return {
    offers,
    warnings: finalWarnings,
    partial,
  };
}

function buildExactRequestFromOffer(
  offer: CanonicalOffer,
  baseRequest: SearchRequest,
): SearchRequest {
  const outbound = offer.itineraries.find((itinerary) => itinerary.direction === "outbound") ?? offer.itineraries[0];
  const inbound = offer.itineraries.find((itinerary) => itinerary.direction === "inbound");
  const departureDate = outbound?.segments[0]?.departureAt?.slice(0, 10);
  const returnDate = inbound?.segments[0]?.departureAt?.slice(0, 10);

  if (!departureDate) {
    throw new Error("Offer is missing outbound departure date.");
  }

  return {
    ...baseRequest,
    tripType: inbound ? "round-trip" : "one-way",
    searchMode: "exact",
    legs: [
      {
        origin: offer.origin,
        destination: offer.destination,
        originLabel: baseRequest.legs[0]?.originLabel,
        destinationLabel: baseRequest.legs[0]?.destinationLabel,
        departureDate,
        returnDate,
      },
    ],
  };
}

export async function repriceLocalAgilOffer(
  existingOffer: CanonicalOffer,
  request: SearchRequest,
): Promise<RepriceResult> {
  const exactRequest = request.searchMode === "exact"
    ? request
    : buildExactRequestFromOffer(existingOffer, request);
  const search = await searchLocalAgilExact(exactRequest);
  const sameSignature = search.offers.filter((offer) => offer.signature === existingOffer.signature);
  const matched = sameSignature.find(
    (offer) => offer.price.total.amount === existingOffer.price.total.amount,
  ) ?? sameSignature[0];

  if (!matched) {
    return {
      status: "unavailable",
      warnings: [...search.warnings, "Agil no longer returned this itinerary during reprice."],
    };
  }

  const priceChanged = matched.price.total.amount !== existingOffer.price.total.amount;
  return {
    status: priceChanged ? "changed" : "verified",
    offer: {
      ...matched,
      priceConfidence: "validated",
      priceStatus: priceChanged ? "repriced_changed" : "verified",
      priceVerifiedAt: new Date().toISOString(),
      warnings: priceChanged
        ? [...matched.warnings, "Price changed during reprice."]
        : matched.warnings,
    },
    warnings: search.warnings,
  };
}

function buildMatrixConfidenceSummary(cells: MatrixCell[]): Record<string, number> {
  return cells.reduce<Record<string, number>>((acc, cell) => {
    acc[cell.confidence] = (acc[cell.confidence] ?? 0) + 1;
    return acc;
  }, {});
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
  const returns = request.tripType === "round-trip"
    ? (() => {
        if (!leg.returnStart || !leg.returnEnd) {
          throw new Error("Local Agil round-trip matrix requires returnStart and returnEnd.");
        }
        return enumerateRange(leg.returnStart, leg.returnEnd);
      })()
    : [];
  const requestedAt = new Date().toISOString();
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
    : departures.flatMap((departureDate) => returns.map((returnDate) => {
        if (returnDate <= departureDate) {
          return {
            key: `${departureDate}_${returnDate}`,
            departureDate,
            returnDate,
            confidence: "empty" as const,
            providerSource: "agil-local" as const,
            selectable: false,
            requiresRequery: true,
            stateCode: "emp" as const,
            tooltip: "Return date must be after departure date.",
          } satisfies MatrixCell;
        }

        return {
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
        } satisfies MatrixCell;
      }));

  return {
    cells,
    axes: {
      departureDates: departures,
      returnDates: returns,
    },
    confidenceSummary: buildMatrixConfidenceSummary(cells),
    recommendations: [
      "Matrix loading from Agil in parallel.",
      "Prices appear as each date combination resolves.",
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
  onCellResolved?: (cell: MatrixCell) => void,
): Promise<MatrixResponse> {
  const session = await getAgilSession();
  let partial = false;

  const resolvedCells = await mapConcurrent(draft.cells, AGIL_MATRIX_CELL_CONCURRENCY, async (cell) => {
    if (cell.confidence !== "loading" || !cell.derivedRequest) {
      return cell;
    }

    try {
      const quote = await searchCellPrice(session, cell.derivedRequest);
      const nextCell = quote
        ? {
            ...cell,
            price: {
              amount: quote.amount,
              currencyCode: quote.currencyCode || request.currencyCode,
            },
            confidence: "live" as const,
            selectable: true,
            stateCode: "live" as const,
            tooltip: quote.validatingCarrier
              ? `Agil exact search. Cheapest validating carrier: ${quote.validatingCarrier}.`
              : "Agil exact search.",
          } satisfies MatrixCell
        : {
            ...cell,
            confidence: "unavailable" as const,
            selectable: false,
            stateCode: "chg" as const,
            tooltip: "Agil returned no live result for this combination.",
          } satisfies MatrixCell;

      onCellResolved?.(nextCell);
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
      onCellResolved?.(nextCell);
      return nextCell;
    }
  });

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
