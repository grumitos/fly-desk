import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import {
  removePathWithRetries,
  registerActiveTempArtifact,
  unregisterActiveTempArtifact,
} from "./temp-artifacts";
import {
  buildDerivedOneWayRequest,
  buildDerivedRequest,
  diffDays,
  enumerateRoundTripFlexibleAxes,
  enumerateRange,
  enumerateUsefulRoundTripPairs,
  enumerateUsefulFlexibleRequests,
  isUsefulRoundTripCombination,
} from "./core/flexible-search";
import { normalizeAirlineDisplayName } from "./core/airline-names";
import {
  buildMatrixConfidenceSummary,
  mapConcurrent,
  prioritizeMatrixLoadingCells,
} from "./core/matrix";
import { buildOfferSignature } from "./core/offer-signature";
import { parseProviderAmount, roundProviderAmount } from "./core/provider-money";
import { buildOfferVariantGroupKey } from "./core/variant-group-key";
import { ProviderSearchResult } from "./core/provider";
import { enrichComparisonMetrics, maxStopsAcrossItineraries, totalDuration } from "./core/ranking";
import {
  BaggageSummary,
  CanonicalOffer,
  CostamarProviderContext,
  CostamarRedirectState,
  FareMeta,
  Itinerary,
  LocationSuggestion,
  MatrixCell,
  MatrixResponse,
  ProviderContext,
  ProviderMeta,
  RedirectVerification,
  SearchRequest,
  SearchResponse,
  Segment,
} from "./core/types";
import {
  extractCostamarSessionCandidates,
  getCostamarProviderContext,
  inspectCostamarBrandedToken,
  pickLatestCostamarSessionCandidate,
  rememberCostamarSessionCandidate,
  resolveChromeDevToolsBrowserWsEndpoint,
  resolveLatestCostamarProviderContext,
  resolveUsableCostamarBrandedToken,
} from "./provider-context";
import { recordProviderFirstHttpRequest } from "./provider-diagnostics";
import { openUrlLocally } from "./local-browser";
import {
  resolveMatrixCellConcurrency,
  resolveProviderSubrequestConcurrency,
  resolveRangeSearchConcurrency,
  SHARED_SEARCH_CONCURRENCY,
} from "./search-concurrency";
import {
  promptTerminalSecret,
  promptTerminalText,
  terminalPromptAvailable,
} from "./terminal-secret-prompt";
import { generateTotpCodeWithMetadata, totpCanSubmitSafely } from "./totp";
import { rankLocationSuggestions } from "./location-suggestions";
import { cityNameForIataCode, normalizeIataCode } from "./core/location-display";

interface CostamarEngineMetadata {
  code?: string;
  profile?: {
    id?: string;
    name?: string;
    countryCode?: string;
    currencyCode?: string;
    currency?: {
      code?: string;
      mask?: string;
    };
  };
}

interface CostamarAirport {
  code?: string;
  cityCode?: string;
  countryCode?: string;
  name?: string;
  cityName?: string;
}

interface CostamarAirline {
  code?: string;
  name?: string;
}

interface CostamarSegmentLike {
  id?: string;
  departureAirport?: CostamarAirport;
  arrivalAirport?: CostamarAirport;
  departureDateTime?: string;
  arrivalDateTime?: string;
  elapsedTime?: string | number;
  marketingAirline?: CostamarAirline;
  operatingAirline?: CostamarAirline;
  flightNumber?: string | number;
  bookingClass?: string | {
    code?: string;
  };
  fareBasisCode?: string;
  cabinType?: string;
  baggage?: unknown;
  handBaggage?: unknown;
}

interface CostamarFlight extends CostamarSegmentLike {
  segments?: CostamarSegmentLike[];
  brandedFare?: {
    name?: string;
  };
}

interface CostamarJourney {
  flights?: CostamarFlight[];
}

interface CostamarPricing {
  base?: number;
  taxes?: number;
  total?: number;
  fees?: unknown;
  discounts?: unknown;
  passengers?: {
    adults?: {
      base?: number | string;
      total?: number | string;
      contextCode?: string;
    };
    children?: {
      base?: number | string;
      total?: number | string;
      contextCode?: string;
    };
    infants?: {
      base?: number | string;
      total?: number | string;
      contextCode?: string;
    };
  };
  source?: string;
  fareQualifier?: string;
  commission?: number;
  validatingAirline?: string;
  totalAmount?: number;
}

interface CostamarRecommendation {
  id?: string;
  itinerary?: CostamarJourney[];
  pricing?: CostamarPricing;
  pos?: {
    systemProviderCode?: string;
    codeContext?: string;
    officeId?: string;
  };
}

interface CostamarSearchResponse {
  status?: number;
  data?: CostamarRecommendation[];
  message?: string;
}

interface CostamarAutocompleteResponse {
  airports?: Array<{
    code?: string;
    countryCode?: string;
    cityCode?: string;
    cityName?: string;
    type?: string;
    name?: string;
  }>;
}

type CostamarAutocompleteAirport = NonNullable<CostamarAutocompleteResponse["airports"]>[number];

interface CostamarSearchOutcome {
  offers: CanonicalOffer[];
  warnings: string[];
}

interface CostamarB2bPromptRequest {
  email?: boolean;
  password?: boolean;
  authCode?: boolean;
  challengeLabel?: string;
}

interface CostamarB2bPromptResponse {
  email?: string;
  password?: string;
  authCode?: string;
}

interface CostamarB2bAuthInputDescriptor {
  index: number;
  id: string;
  name: string;
  type: string;
  autocomplete: string;
  maxLength: number;
  visible: boolean;
}

interface CostamarB2bAuthSnapshot {
  text: string;
  inputs: CostamarB2bAuthInputDescriptor[];
}

interface CostamarKeyboardInputTarget {
  click(): Promise<unknown>;
  press(key: string): Promise<unknown>;
  type(text: string, options?: { delay?: number }): Promise<unknown>;
}

export interface CostamarB2bAuthChallenge {
  kind: "single" | "split";
  inputIndexes: number[];
}

interface CostamarMarkupApplied {
  amount?: {
    value?: number | string;
    percentage?: boolean;
    appliesToBase?: boolean;
    perPassenger?: boolean;
    perBooking?: boolean;
    passengersType?: string[];
  };
}

interface CostamarMarkupResponse {
  apply?: boolean;
  error?: {
    message?: string;
  } | string;
  markupsApplied?: CostamarMarkupApplied[];
  customMarkupApplied?: CostamarMarkupApplied[];
}

interface CostamarWarmupDiagnosticStep {
  name: string;
  ok: boolean;
  at: string;
  detail?: string;
}

interface CostamarWarmupDiagnostics {
  startedAt: string;
  terminalId?: string;
  credentialsPresent: boolean;
  totpConfigured: boolean;
  otpGenerated: boolean;
  authPromptResolved: boolean;
  tokenCaptured: boolean;
  tokenValidated: boolean;
  failureReason?: string;
  steps: CostamarWarmupDiagnosticStep[];
}

interface CostamarRedirectResolution {
  context: CostamarProviderContext;
  redirectVerification: RedirectVerification;
  diagnostics?: CostamarWarmupDiagnostics;
  warnings: string[];
}

const COSTAMAR_HTTP_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.COSTAMAR_HTTP_TIMEOUT_MS ?? 20000),
);
const COSTAMAR_AIR_API_BASE_URL = process.env.COSTAMAR_AIR_API_BASE_URL?.trim()
  || "https://api-zneith.zdev.tech/api-air-0.1";
const COSTAMAR_REDIRECT_SESSION_WARNING =
  "Costamar redirect token is missing, expired, or incompatible with this terminal.";
const COSTAMAR_SESSION_WARMUP_POLL_MS = 500;
const COSTAMAR_REDIRECT_VERIFY_TIMEOUT_MS = Math.max(
  1500,
  Number(process.env.COSTAMAR_REDIRECT_VERIFY_TIMEOUT_MS ?? 6000),
);
const COSTAMAR_REDIRECT_VERIFY_FAILURE_PATTERN =
  /login|iniciar\s+sesi[oó]n|auth|otp|captcha|expired|expirad|invalid|inv[aá]lid|unauthorized|forbidden/i;
const COSTAMAR_B2B_KEYSTROKE_DELAY_MS = 35;
const DEFAULT_COSTAMAR_B2B_BASE_URL = "https://b2b.clickandbook.com/lang/es/b2b";
const DEFAULT_CHROME_USER_DATA_DIR = join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "User Data");

const pendingCostamarSessionWarmups = new Map<string, Promise<CostamarProviderContext>>();
const recentCostamarSessionWarmups = new Map<string, number>();
let costamarWarmupOpener: typeof openUrlLocally = openUrlLocally;
let playwrightPromise: Promise<typeof import("playwright")> | undefined;
let liveCostamarBrowserConnection:
  | { endpoint: string; browser: Browser; context: BrowserContext }
  | undefined;
let pendingLiveCostamarBrowserConnection:
  | Promise<{ endpoint: string; browser: Browser; context: BrowserContext } | undefined>
  | undefined;
let liveCostamarBrowserRetryAfterMs = 0;

type CostamarWarmupGenerator = (
  request: SearchRequest,
  context: CostamarProviderContext,
) => Promise<CostamarProviderContext | undefined>;

type CostamarB2bPromptProvider = (
  request: CostamarB2bPromptRequest,
) => Promise<CostamarB2bPromptResponse | undefined>;

type CostamarSessionCandidate = ReturnType<typeof extractCostamarSessionCandidates>[number];

interface CostamarB2bFlightWarmupPayload {
  tripType: "one-way" | "round-trip";
  terminalId: string;
  origin: string;
  destination: string;
  departureDate: string;
  departureDisplayDate: string;
  returnDate?: string;
  returnDisplayDate?: string;
  adults: number;
  children: number;
  infants: number;
}

let costamarWarmupGenerator: CostamarWarmupGenerator = generateCostamarRedirectContextViaB2B;
let costamarB2bPromptProvider: CostamarB2bPromptProvider = promptCostamarB2bViaTerminal;
let cachedInteractiveCostamarB2bCredentials: { email?: string; password?: string } = {};
let pendingCostamarB2bCredentialPrompt:
  | Promise<{ email?: string; password?: string }>
  | undefined;
let pendingCostamarB2bAuthPrompt: Promise<string | undefined> | undefined;
let lastCostamarWarmupDiagnostics: CostamarWarmupDiagnostics | undefined;

export const COSTAMAR_CONCURRENCY = Object.freeze({
  get matrixMinimum() {
    return SHARED_SEARCH_CONCURRENCY.matrixMinimum;
  },
  get rangeMinimum() {
    return SHARED_SEARCH_CONCURRENCY.rangeMinimum;
  },
  get matrixCell() {
    return resolveMatrixCellConcurrency("COSTAMAR_MATRIX_CELL_CONCURRENCY");
  },
  get rangeSearch() {
    return resolveRangeSearchConcurrency("COSTAMAR_RANGE_SEARCH_CONCURRENCY");
  },
  get markup() {
    return resolveProviderSubrequestConcurrency("COSTAMAR_MARKUP_CONCURRENCY", 4, 2);
  },
  httpTimeoutMs: COSTAMAR_HTTP_TIMEOUT_MS,
});
const COSTAMAR_RANGE_DAY_RETRY_ATTEMPTS = Math.max(
  0,
  Math.trunc(Number(process.env.COSTAMAR_RANGE_DAY_RETRY_ATTEMPTS ?? 1)) || 0,
);
const COSTAMAR_RANGE_DAY_RETRY_DELAY_MS = Math.max(
  0,
  Math.trunc(Number(process.env.COSTAMAR_RANGE_DAY_RETRY_DELAY_MS ?? 250)) || 0,
);
const DEFAULT_COSTAMAR_PREWARM_ORIGIN = "LIM";
const DEFAULT_COSTAMAR_PREWARM_DESTINATION = "CUZ";
const DEFAULT_COSTAMAR_PREWARM_DEPARTURE_OFFSET_DAYS = 30;
const DEFAULT_COSTAMAR_PREWARM_STAY_NIGHTS = 3;

const engineCache = new Map<string, Promise<CostamarEngineMetadata>>();
const COSTAMAR_B2B_AUTH_HINT_PATTERN =
  /otp|authenticator|verification|verificaci[oó]n|token|one.?time|two.?factor|2fa|mfa|c[oó]digo|code|pin/i;
const COSTAMAR_B2B_AUTH_FIELD_PATTERN =
  /otp|auth|token|verification|verify|code|pin|2fa|mfa/i;

function costamarSessionWarmupEnabled(): boolean {
  return String(process.env.COSTAMAR_SESSION_WARMUP_ENABLED ?? "1").trim() !== "0";
}

function costamarSessionWarmupTimeoutMs(): number {
  return Math.max(0, Number(process.env.COSTAMAR_SESSION_WARMUP_TIMEOUT_MS ?? 8000));
}

function costamarSessionWarmupOpenBrowserFallbackEnabled(): boolean {
  return String(process.env.COSTAMAR_SESSION_WARMUP_OPEN_BROWSER_FALLBACK ?? "0").trim() !== "0";
}

function costamarSessionWarmupCooldownMs(): number {
  return Math.max(
    costamarSessionWarmupTimeoutMs(),
    Number(process.env.COSTAMAR_SESSION_WARMUP_COOLDOWN_MS ?? 30000),
  );
}

function canWarmCostamarSession(request: SearchRequest): boolean {
  return request.redirectMode !== "none" && costamarSessionWarmupEnabled();
}

function resolveCostamarChromeLaunchOptions(): { userDataDir?: string; profileDirectory?: string } {
  const userDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR?.trim()
    || process.env.COSTAMAR_AGENT_CHROME_USER_DATA_DIR?.trim()
    || process.env.AGIL_CHROME_USER_DATA_DIR?.trim()
    || DEFAULT_CHROME_USER_DATA_DIR
    || undefined;
  const profileDirectory = process.env.COSTAMAR_CHROME_PROFILE?.trim()
    || process.env.AGIL_CHROME_PROFILE?.trim()
    || undefined;

  return {
    ...(userDataDir ? { userDataDir } : {}),
    ...(profileDirectory ? { profileDirectory } : {}),
  };
}

function resolveCostamarChromeProfileName(): string {
  return resolveCostamarChromeLaunchOptions().profileDirectory || "Default";
}

function resolveCostamarChromeExecutable(): string {
  const configured = process.env.COSTAMAR_CHROME_EXECUTABLE?.trim();
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

function resolveCostamarB2bBaseUrl(): string {
  return process.env.COSTAMAR_B2B_BASE_URL?.trim() || DEFAULT_COSTAMAR_B2B_BASE_URL;
}

function resolveCostamarB2bCredentials(): { email?: string; password?: string } {
  const email = process.env.COSTAMAR_B2B_EMAIL?.trim()
    || process.env.COSTAMAR_B2B_USERNAME?.trim()
    || cachedInteractiveCostamarB2bCredentials.email?.trim()
    || undefined;
  const password = process.env.COSTAMAR_B2B_PASSWORD?.trim()
    || cachedInteractiveCostamarB2bCredentials.password?.trim()
    || undefined;
  return {
    ...(email ? { email } : {}),
    ...(password ? { password } : {}),
  };
}

function costamarB2bPromptEnabled(): boolean {
  return String(process.env.COSTAMAR_B2B_PROMPT_ENABLED ?? "1").trim() !== "0";
}

function resolveCostamarB2bTotpSecret(): string | undefined {
  const secret = process.env.COSTAMAR_B2B_TOTP_SECRET?.trim()
    || process.env.COSTAMAR_B2B_TOTP_URI?.trim()
    || undefined;
  return secret || undefined;
}

function costamarB2bTotpMinRemainingSeconds(): number {
  const configured = Number(process.env.COSTAMAR_B2B_TOTP_MIN_REMAINING_SECONDS ?? 5);
  return Number.isFinite(configured) ? Math.max(0, Math.trunc(configured)) : 5;
}

function costamarB2bInteractivePromptAvailable(): boolean {
  return costamarB2bPromptEnabled() && terminalPromptAvailable();
}

export async function applyCostamarB2bKeyboardInput(
  target: CostamarKeyboardInputTarget,
  value: string,
  options?: { clear?: boolean; typingDelayMs?: number },
): Promise<void> {
  const shouldClear = options?.clear !== false;
  const text = value ?? "";

  await target.click();
  if (shouldClear) {
    const selectAllKey = process.platform === "darwin" ? "Meta+A" : "Control+A";
    await target.press(selectAllKey).catch(() => undefined);
    await target.press("Backspace").catch(() => undefined);
  }

  if (text) {
    await target.type(text, {
      delay: options?.typingDelayMs ?? COSTAMAR_B2B_KEYSTROKE_DELAY_MS,
    });
  }
}

function rememberInteractiveCostamarB2bCredentials(credentials: { email?: string; password?: string }): void {
  cachedInteractiveCostamarB2bCredentials = {
    ...cachedInteractiveCostamarB2bCredentials,
    ...(credentials.email?.trim() ? { email: credentials.email.trim() } : {}),
    ...(credentials.password?.trim() ? { password: credentials.password.trim() } : {}),
  };
}

function clearInteractiveCostamarB2bCredentials(): void {
  cachedInteractiveCostamarB2bCredentials = {};
}

async function promptCostamarB2bViaTerminal(
  request: CostamarB2bPromptRequest,
): Promise<CostamarB2bPromptResponse | undefined> {
  if (!costamarB2bInteractivePromptAvailable()) {
    return undefined;
  }

  const response: CostamarB2bPromptResponse = {};
  if (request.email || request.password) {
    console.log("\nCostamar B2B necesita credenciales para continuar.");
  }
  if (request.authCode) {
    console.log(`\nCostamar B2B necesita ${request.challengeLabel ?? "un código Auth / OTP"} para continuar.`);
  }

  if (request.email) {
    response.email = await promptTerminalText("Email Costamar B2B: ");
  }
  if (request.password) {
    response.password = await promptTerminalSecret("Password Costamar B2B: ");
  }
  if (request.authCode) {
    response.authCode = await promptTerminalSecret(`${request.challengeLabel ?? "Código Auth / OTP de Costamar"}: `);
  }

  return Object.keys(response).length > 0 ? response : undefined;
}

async function resolveCostamarB2bCredentialsForAutomation(): Promise<{ email?: string; password?: string }> {
  const current = resolveCostamarB2bCredentials();
  if (current.email && current.password) {
    return current;
  }

  if (!costamarB2bInteractivePromptAvailable()) {
    return current;
  }

  if (!pendingCostamarB2bCredentialPrompt) {
    pendingCostamarB2bCredentialPrompt = (async () => {
      const prompted = await costamarB2bPromptProvider({
        email: !current.email,
        password: !current.password,
      });
      rememberInteractiveCostamarB2bCredentials(prompted ?? {});
      return resolveCostamarB2bCredentials();
    })().finally(() => {
      pendingCostamarB2bCredentialPrompt = undefined;
    });
  }

  return pendingCostamarB2bCredentialPrompt;
}

async function promptCostamarB2bAuthCode(challengeLabel?: string): Promise<string | undefined> {
  const configuredSecret = resolveCostamarB2bTotpSecret();
  if (configuredSecret) {
    try {
      const initial = generateTotpCodeWithMetadata(configuredSecret);
      const minRemainingSeconds = costamarB2bTotpMinRemainingSeconds();
      if (!totpCanSubmitSafely(Date.now(), initial.periodSeconds, minRemainingSeconds)) {
        await sleep((initial.remainingSeconds * 1000) + 250);
      }

      lastCostamarWarmupDiagnostics = lastCostamarWarmupDiagnostics
        ? {
            ...lastCostamarWarmupDiagnostics,
            otpGenerated: true,
          }
        : lastCostamarWarmupDiagnostics;
      return generateTotpCodeWithMetadata(configuredSecret).code;
    } catch {
      // Fall through to the interactive prompt below when the stored secret is invalid.
    }
  }

  if (!costamarB2bInteractivePromptAvailable()) {
    return undefined;
  }

  if (!pendingCostamarB2bAuthPrompt) {
    pendingCostamarB2bAuthPrompt = (async () => {
      const prompted = await costamarB2bPromptProvider({
        authCode: true,
        challengeLabel,
      });
      return prompted?.authCode?.trim() || undefined;
    })().finally(() => {
      pendingCostamarB2bAuthPrompt = undefined;
    });
  }

  return pendingCostamarB2bAuthPrompt;
}

function costamarB2bAutomationEnabled(): boolean {
  return String(process.env.COSTAMAR_B2B_AUTOMATION_ENABLED ?? "1").trim() !== "0";
}

function costamarB2bAutomationAllowsSessionOnly(): boolean {
  return String(process.env.COSTAMAR_B2B_AUTOMATION_ALLOW_SESSION_ONLY ?? "1").trim() !== "0";
}

function canGenerateCostamarTokenViaB2B(): boolean {
  if (!costamarB2bAutomationEnabled()) {
    return false;
  }

  const credentials = resolveCostamarB2bCredentials();
  return Boolean(
    (credentials.email && credentials.password)
    || costamarB2bInteractivePromptAvailable()
    || costamarB2bAutomationAllowsSessionOnly(),
  );
}

function shouldUseLiveCostamarBrowserContext(): boolean {
  const credentials = resolveCostamarB2bCredentials();
  const defaultValue = credentials.email && credentials.password ? "0" : "1";
  return String(process.env.COSTAMAR_B2B_USE_LIVE_BROWSER ?? defaultValue).trim() !== "0";
}

function costamarBrowserAutomationHeadless(): boolean {
  return String(process.env.COSTAMAR_BROWSER_HEADLESS ?? "1").trim() !== "0";
}

function costamarB2bDebugEnabled(): boolean {
  return String(process.env.COSTAMAR_B2B_DEBUG ?? "0").trim() === "1";
}

function costamarB2bPlaywrightFallbackEnabled(): boolean {
  return String(process.env.COSTAMAR_B2B_PLAYWRIGHT_FALLBACK_ENABLED ?? "0").trim() !== "0";
}

function logCostamarB2bDebug(stage: string, detail?: unknown): void {
  if (!costamarB2bDebugEnabled()) {
    return;
  }

  if (detail === undefined) {
    console.log(`[costamar-b2b] ${stage}`);
    return;
  }

  console.log(`[costamar-b2b] ${stage}`, detail);
}

async function getPlaywright(): Promise<typeof import("playwright")> {
  if (!playwrightPromise) {
    playwrightPromise = import("playwright");
  }

  return playwrightPromise;
}

function normalizeCostamarB2bTokenResponse(rawValue: unknown): string {
  if (typeof rawValue === "string") {
    const trimmed = rawValue.trim();
    if (!trimmed) {
      return "";
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "string") {
        return parsed.trim();
      }
      if (parsed && typeof parsed === "object" && typeof (parsed as { token?: unknown }).token === "string") {
        return ((parsed as { token: string }).token || "").trim();
      }
    } catch {
      // Fall back to the raw text below.
    }

    return trimmed.replace(/^"+|"+$/g, "").trim();
  }

  if (rawValue && typeof rawValue === "object" && typeof (rawValue as { token?: unknown }).token === "string") {
    return String((rawValue as { token: string }).token).trim();
  }

  return "";
}

export function isCostamarB2bAirlineSearchResponse(method: string, url: string): boolean {
  if (method.toUpperCase() !== "POST") {
    return false;
  }

  try {
    const parsed = new URL(url, resolveCostamarB2bBaseUrl());
    return /\/lang\/[^/]+\/airlinesearch\/?$/i.test(parsed.pathname)
      || /\/airlinesearch\/?$/i.test(parsed.pathname);
  } catch {
    return /(?:^|\/)(?:lang\/[^/]+\/)?airlinesearch(?:[/?#]|$)/i.test(url);
  }
}

async function closeLiveCostamarBrowserConnection(): Promise<void> {
  const cached = liveCostamarBrowserConnection;
  liveCostamarBrowserConnection = undefined;
  pendingLiveCostamarBrowserConnection = undefined;
  if (cached) {
    await closeCostamarBrowser(cached.browser);
  }
}

async function connectToLiveCostamarBrowserContext(): Promise<{
  endpoint: string;
  browser: Browser;
  context: BrowserContext;
} | undefined> {
  const userDataDir = resolveCostamarChromeLaunchOptions().userDataDir || DEFAULT_CHROME_USER_DATA_DIR;
  const browserWsEndpoint = resolveChromeDevToolsBrowserWsEndpoint(userDataDir);
  if (!browserWsEndpoint) {
    return undefined;
  }

  const nowMs = Date.now();
  if (nowMs < liveCostamarBrowserRetryAfterMs) {
    return undefined;
  }

  if (
    liveCostamarBrowserConnection
    && liveCostamarBrowserConnection.endpoint === browserWsEndpoint
  ) {
    return liveCostamarBrowserConnection;
  }

  if (pendingLiveCostamarBrowserConnection) {
    return pendingLiveCostamarBrowserConnection;
  }

  pendingLiveCostamarBrowserConnection = (async () => {
    try {
      const playwright = await getPlaywright();
      const browser = await playwright.chromium.connectOverCDP(browserWsEndpoint, {
        timeout: Math.max(5000, Math.min(15000, costamarSessionWarmupTimeoutMs())),
      });
      const context = browser.contexts()[0];
      if (!context) {
        await closeCostamarBrowser(browser);
        liveCostamarBrowserRetryAfterMs = Date.now() + costamarSessionWarmupCooldownMs();
        return undefined;
      }

      const connection = {
        endpoint: browserWsEndpoint,
        browser,
        context,
      };
      liveCostamarBrowserConnection = connection;
      browser.on("disconnected", () => {
        if (liveCostamarBrowserConnection?.browser === browser) {
          liveCostamarBrowserConnection = undefined;
        }
      });
      liveCostamarBrowserRetryAfterMs = 0;
      return connection;
    } catch {
      liveCostamarBrowserRetryAfterMs = Date.now() + costamarSessionWarmupCooldownMs();
      return undefined;
    } finally {
      pendingLiveCostamarBrowserConnection = undefined;
    }
  })();

  return pendingLiveCostamarBrowserConnection;
}

function copyPathSafe(source: string, destination: string): void {
  try {
    const stats = statSync(source);
    if (stats.isDirectory()) {
      mkdirSync(destination, { recursive: true });
      readdirSync(source, { withFileTypes: true }).forEach((entry) => {
        copyPathSafe(join(source, entry.name), join(destination, entry.name));
      });
      return;
    }

    mkdirSync(join(destination, ".."), { recursive: true });
    copyFileSync(source, destination);
  } catch {
    // Ignore locked or transient browser artifacts while cloning the profile.
  }
}

function shouldCloneCostamarChromeProfileForIsolatedAutomation(): boolean {
  const configured = process.env.COSTAMAR_B2B_CLONE_CHROME_PROFILE?.trim();
  if (configured) {
    return configured !== "0";
  }

  const credentials = resolveCostamarB2bCredentials();
  return !(credentials.email && credentials.password);
}

function prepareTemporaryCostamarChromeProfile(
  profileName: string,
  options: { cloneSourceProfile?: boolean } = {},
): string {
  const sourceRoot = resolveCostamarChromeLaunchOptions().userDataDir || DEFAULT_CHROME_USER_DATA_DIR;
  const tempRoot = join(tmpdir(), `travel_quote_foundation_costamar_browser_${crypto.randomUUID()}`);
  mkdirSync(join(tempRoot, profileName), { recursive: true });
  registerActiveTempArtifact(tempRoot);

  if (!options.cloneSourceProfile) {
    return tempRoot;
  }

  [
    "Local State",
    join(profileName, "Preferences"),
    join(profileName, "Secure Preferences"),
    join(profileName, "Network"),
    join(profileName, "Cookies"),
    join(profileName, "Local Storage"),
    join(profileName, "Session Storage"),
    join(profileName, "IndexedDB"),
    join(profileName, "WebStorage"),
    join(profileName, "Storage"),
    join(profileName, "Service Worker"),
    join(profileName, "Sessions"),
  ].forEach((relativePath) => {
    const source = join(sourceRoot, relativePath);
    if (existsSync(source)) {
      copyPathSafe(source, join(tempRoot, relativePath));
    }
  });

  return tempRoot;
}

function readSetCookieHeaders(headers: Headers): string[] {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  const cookies = extended.getSetCookie?.();
  if (cookies?.length) {
    return cookies;
  }

  const combined = headers.get("set-cookie");
  return combined ? [combined] : [];
}

function rememberCookieFromHeaders(headers: Headers, jar: Map<string, string>): void {
  for (const line of readSetCookieHeaders(headers)) {
    const [pair = ""] = line.split(";");
    const separator = pair.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    jar.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
}

async function fetchCostamarB2bWithCookies(
  url: string,
  jar: Map<string, string>,
  init: RequestInit = {},
): Promise<{ response: Response; body: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(5000, costamarSessionWarmupTimeoutMs()));
  try {
    const cookies = cookieHeader(jar);
    const response = await fetch(url, {
      redirect: "manual",
      ...init,
      headers: {
        ...(cookies ? { cookie: cookies } : {}),
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
    rememberCookieFromHeaders(response.headers, jar);
    return {
      response,
      body: await response.text(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function decodeCostamarB2bHtmlAttribute(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCharCode(Number.parseInt(decimal, 10)))
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function readCostamarB2bInputValues(html: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const tag of html.match(/<input[^>]+>/gi) ?? []) {
    const name = tag.match(/\bname=["']([^"']+)["']/i)?.[1];
    if (!name) {
      continue;
    }

    const value = tag.match(/\bvalue=["']([^"']*)["']/i)?.[1] ?? "";
    values[name] = decodeCostamarB2bHtmlAttribute(value);
  }

  return values;
}

function costamarB2bResponseRequiresAuthenticator(html: string): boolean {
  return /google\s+authenticator|2\s*factor|secretcode|login2factor/i.test(html);
}

async function generateCostamarRedirectContextViaB2BHttp(
  context: CostamarProviderContext,
): Promise<CostamarProviderContext | undefined> {
  const credentials = await resolveCostamarB2bCredentialsForAutomation();
  if (!credentials.email || !credentials.password || !context.terminalId) {
    return undefined;
  }

  const base = new URL(resolveCostamarB2bBaseUrl());
  const origin = base.origin;
  const jar = new Map<string, string>();

  try {
    await fetchCostamarB2bWithCookies(`${origin}/login`, jar, {
      headers: {
        accept: "text/html,application/xhtml+xml",
      },
    });

    const login = await fetchCostamarB2bWithCookies(`${origin}/lang/en/login`, jar, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/html,application/xhtml+xml",
        referer: `${origin}/login`,
      },
      body: new URLSearchParams({
        email: credentials.email,
        password: credentials.password,
        action: "",
      }),
    });
    logCostamarB2bDebug("http login response", {
      status: login.response.status,
      requiresAuthenticator: costamarB2bResponseRequiresAuthenticator(login.body),
    });

    if (costamarB2bResponseRequiresAuthenticator(login.body)) {
      const authCode = await promptCostamarB2bAuthCode("Codigo de Google Authenticator");
      if (!authCode) {
        return undefined;
      }

      const authFields = readCostamarB2bInputValues(login.body);
      const auth = await fetchCostamarB2bWithCookies(`${origin}/lang/en/login2factor`, jar, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "text/html,application/xhtml+xml",
          referer: `${origin}/lang/en/login`,
        },
        body: new URLSearchParams({
          ...authFields,
          secretcode: authCode,
          action: "",
        }),
      });
      logCostamarB2bDebug("http 2fa response", {
        status: auth.response.status,
        location: auth.response.headers.get("location"),
      });

      const location = auth.response.headers.get("location");
      if (auth.response.status >= 300 && auth.response.status < 400 && location) {
        await fetchCostamarB2bWithCookies(new URL(location, origin).toString(), jar, {
          headers: {
            accept: "text/html,application/xhtml+xml",
          },
        });
      } else if (/login|authenticator|secretcode/i.test(auth.body)) {
        return undefined;
      }
    } else {
      const location = login.response.headers.get("location");
      if (login.response.status >= 300 && login.response.status < 400 && location) {
        await fetchCostamarB2bWithCookies(new URL(location, origin).toString(), jar, {
          headers: {
            accept: "text/html,application/xhtml+xml",
          },
        });
      }
    }

    const tokenResponse = await fetchCostamarB2bWithCookies(`${origin}/lang/en/airlinesearch`, jar, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        accept: "application/json, text/javascript, */*; q=0.01",
        "x-requested-with": "XMLHttpRequest",
        referer: `${origin}/lang/en/b2b`,
      },
      body: new URLSearchParams({
        accountid: context.terminalId,
      }),
    });
    const token = normalizeCostamarB2bTokenResponse(tokenResponse.body);
    logCostamarB2bDebug("http airlinesearch response", {
      status: tokenResponse.response.status,
      hasToken: Boolean(token),
    });
    if (!resolveUsableCostamarBrandedToken(token, context.terminalId)) {
      return undefined;
    }

    rememberCostamarSessionCandidate({
      terminalId: context.terminalId,
      token,
      source: "b2b-http:airlinesearch",
    });
    return resolveLatestCostamarProviderContext({
      ...context,
      token,
    });
  } catch (error) {
    logCostamarB2bDebug("http automation failed", error instanceof Error ? error.message : "unknown error");
    return undefined;
  }
}

function collectCostamarCandidatesFromText(
  pool: Map<string, CostamarSessionCandidate>,
  text: string,
  source: string,
): void {
  extractCostamarSessionCandidates(text, source).forEach((candidate) => {
    pool.set(`${candidate.terminalId}::${candidate.token}`, candidate);
  });
}

function pickUsableCostamarCandidate(
  pool: Map<string, CostamarSessionCandidate>,
  terminalId: string | undefined,
): CostamarSessionCandidate | undefined {
  const scoped = terminalId?.trim()
    ? [...pool.values()].filter((candidate) => candidate.terminalId === terminalId.trim())
    : [...pool.values()];
  const candidate = pickLatestCostamarSessionCandidate(scoped);
  if (!candidate) {
    return undefined;
  }

  return resolveUsableCostamarBrandedToken(candidate.token, candidate.terminalId)
    ? candidate
    : undefined;
}

function observeCostamarPage(
  page: Page,
  pool: Map<string, CostamarSessionCandidate>,
  sourcePrefix: string,
): void {
  page.on("request", (request) => {
    collectCostamarCandidatesFromText(pool, request.url(), `${sourcePrefix}:request`);
  });
  page.on("response", (response) => {
    collectCostamarCandidatesFromText(pool, response.url(), `${sourcePrefix}:response`);
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      collectCostamarCandidatesFromText(pool, frame.url(), `${sourcePrefix}:frame`);
    }
  });
}

async function collectCostamarCandidatesFromPage(
  page: Page,
  pool: Map<string, CostamarSessionCandidate>,
  sourcePrefix: string,
): Promise<void> {
  collectCostamarCandidatesFromText(pool, page.url(), `${sourcePrefix}:url`);

  try {
    const snapshot = await page.evaluate(() => JSON.stringify({
      href: window.location.href,
      html: document.documentElement?.outerHTML ?? "",
      localStorage: Array.from({ length: localStorage.length }, (_, index) => {
        const key = localStorage.key(index) ?? "";
        return `${key}=${localStorage.getItem(key) ?? ""}`;
      }),
      sessionStorage: Array.from({ length: sessionStorage.length }, (_, index) => {
        const key = sessionStorage.key(index) ?? "";
        return `${key}=${sessionStorage.getItem(key) ?? ""}`;
      }),
    }));
    collectCostamarCandidatesFromText(pool, snapshot, `${sourcePrefix}:snapshot`);
  } catch {
    // Ignore pages that are not script-accessible yet.
  }
}

function observeCostamarBrowserPages(
  context: BrowserContext,
  pool: Map<string, CostamarSessionCandidate>,
  sourcePrefix: string,
  observedPages: Set<Page>,
): void {
  context.pages().forEach((page, index) => {
    if (observedPages.has(page)) {
      return;
    }

    observedPages.add(page);
    observeCostamarPage(page, pool, `${sourcePrefix}:${index}`);
  });
}

function splitIsoDateParts(
  dateIso?: string,
): { year: string; month: string; day: string } | undefined {
  const match = String(dateIso ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return undefined;
  }

  return {
    year: match[1],
    month: match[2],
    day: match[3],
  };
}

function toCostamarB2bDisplayDate(dateIso?: string): string | undefined {
  const parts = splitIsoDateParts(dateIso);
  if (!parts) {
    return undefined;
  }

  return `${parts.day}/${parts.month}/${parts.year}`;
}

function buildCostamarSessionCandidateFromToken(
  token: string,
  terminalId: string,
  source: string,
  brandBaseUrl = "https://booking.clickandbook.com/vuelos",
): CostamarSessionCandidate | undefined {
  const syntheticUrl = `${brandBaseUrl.replace(/\/+$/, "")}/b/LIM/MAD/2026-01-01/1/0/0`
    + `?terminalId=${encodeURIComponent(terminalId)}&lang=es&token=${encodeURIComponent(token)}`;
  return extractCostamarSessionCandidates(syntheticUrl, source).find((candidate) =>
    candidate.terminalId === terminalId && candidate.token === token);
}

export function buildCostamarB2bWarmupPayload(
  request: SearchRequest,
  context: CostamarProviderContext,
): CostamarB2bFlightWarmupPayload | undefined {
  const leg = request.legs[0];
  if (!leg || request.tripType === "multi-city") {
    return undefined;
  }

  const departureParts = splitIsoDateParts(leg.departureDate);
  const departureDisplayDate = toCostamarB2bDisplayDate(leg.departureDate);
  if (!departureParts || !departureDisplayDate || !context.terminalId) {
    return undefined;
  }

  if (request.tripType === "round-trip") {
    const returnParts = splitIsoDateParts(leg.returnDate);
    const returnDisplayDate = toCostamarB2bDisplayDate(leg.returnDate);
    if (!returnParts || !returnDisplayDate) {
      return undefined;
    }

    return {
      tripType: "round-trip",
      terminalId: context.terminalId,
      origin: leg.origin,
      destination: leg.destination,
      departureDate: `${departureParts.year}-${departureParts.month}-${departureParts.day}`,
      departureDisplayDate,
      returnDate: `${returnParts.year}-${returnParts.month}-${returnParts.day}`,
      returnDisplayDate,
      adults: request.passengers.adults,
      children: request.passengers.children,
      infants: request.passengers.infants,
    };
  }

  return {
    tripType: "one-way",
    terminalId: context.terminalId,
    origin: leg.origin,
    destination: leg.destination,
    departureDate: `${departureParts.year}-${departureParts.month}-${departureParts.day}`,
    departureDisplayDate,
    adults: request.passengers.adults,
    children: request.passengers.children,
    infants: request.passengers.infants,
  };
}

async function openCostamarB2bFlightsTab(page: Page): Promise<boolean> {
  const flightsTab = page.locator("a[href='#airlines']").first();
  if (await flightsTab.count() === 0) {
    return false;
  }

  await flightsTab.click({ force: true }).catch(() => undefined);
  await page.locator("#fairlines").first().waitFor({ state: "attached", timeout: 10000 }).catch(() => undefined);
  await page.waitForTimeout(500);

  return (await page.locator("#fairlines").first().count()) > 0;
}

async function primeCostamarB2bFlightForm(
  page: Page,
  payload: CostamarB2bFlightWarmupPayload,
): Promise<boolean> {
  return page.evaluate((flight) => {
    document.querySelector<HTMLElement>("a[href='#airlines']")?.click();
    document
      .querySelector<HTMLElement>(flight.tripType === "one-way" ? "#onewayfaux" : "#roundtripfaux")
      ?.click();

    const departureDate = flight.departureDate.split("-");
    const returnDate = flight.returnDate?.split("-") ?? [];
    const globalScope = globalThis as Record<string, unknown>;

    const fieldEntries: Array<[string, string]> = [
      ["#accountid", flight.terminalId],
      ["#fgoingfromauxairlines", flight.origin],
      ["#fgoingfromauxairlinestext", flight.origin],
      ["#fgoingtoauxairlines", flight.destination],
      ["#fgoingtoauxairlinestext", flight.destination],
      ["#fcheckin-dateairlines", flight.departureDisplayDate],
      ["#fcheckintextair", flight.departureDate],
      ["#flight_adults_custom", String(flight.adults)],
      ["#flight_children_custom", String(flight.children)],
      ["#flight_infants_custom", String(flight.infants)],
    ];
    for (const [selector, value] of fieldEntries) {
      const input = document.querySelector<HTMLInputElement | HTMLSelectElement>(selector);
      if (!input) {
        continue;
      }

      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    if (flight.tripType === "round-trip" && flight.returnDate && flight.returnDisplayDate) {
      const returnEntries: Array<[string, string]> = [
        ["#fcheckout-dateairlines", flight.returnDisplayDate],
        ["#fcheckouttextair", flight.returnDate],
      ];
      for (const [selector, value] of returnEntries) {
        const input = document.querySelector<HTMLInputElement | HTMLSelectElement>(selector);
        if (!input) {
          continue;
        }

        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }

    globalScope.accountidBo = flight.terminalId;
    globalScope.fleavingaux = flight.origin;
    globalScope.fgoingtoauxairlines = flight.destination;
    globalScope.fsdayaux = departureDate[2] ?? "";
    globalScope.fsmonthaux = departureDate[1] ?? "";
    globalScope.fsyearaux = departureDate[0] ?? "";
    globalScope.comparegds = false;

    if (flight.tripType === "round-trip" && flight.returnDate) {
      globalScope.fedayaux = returnDate[2] ?? "";
      globalScope.femonthaux = returnDate[1] ?? "";
      globalScope.feyearaux = returnDate[0] ?? "";
    } else {
      globalScope.fedayaux = "";
      globalScope.femonthaux = "";
      globalScope.feyearaux = "";
      const returnDateInput = document.querySelector<HTMLInputElement | HTMLSelectElement>("#fcheckout-dateairlines");
      if (returnDateInput) {
        returnDateInput.value = "";
        returnDateInput.dispatchEvent(new Event("input", { bubbles: true }));
        returnDateInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const returnTextInput = document.querySelector<HTMLInputElement | HTMLSelectElement>("#fcheckouttextair");
      if (returnTextInput) {
        returnTextInput.value = "";
        returnTextInput.dispatchEvent(new Event("input", { bubbles: true }));
        returnTextInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }

    const compareGds = document.querySelector<HTMLInputElement>("#comparegds");
    if (compareGds) {
      compareGds.checked = false;
      compareGds.dispatchEvent(new Event("change", { bubbles: true }));
    }

    return Boolean(document.querySelector("#fsairlines"));
  }, payload).catch((error) => {
    logCostamarB2bDebug("form prime failed", error instanceof Error ? error.message : "unknown error");
    return false;
  });
}

async function submitCostamarB2bFlightSearch(
  page: Page,
  request: SearchRequest,
  context: CostamarProviderContext,
  pool: Map<string, CostamarSessionCandidate>,
  sourcePrefix: string,
  observedPages: Set<Page>,
): Promise<CostamarSessionCandidate | undefined> {
  const payload = buildCostamarB2bWarmupPayload(request, context);
  if (!payload) {
    return undefined;
  }

  const hasFlightsTab = await openCostamarB2bFlightsTab(page);
  logCostamarB2bDebug("flights tab", { hasFlightsTab, url: page.url() });
  if (!hasFlightsTab) {
    return undefined;
  }

  const primed = await primeCostamarB2bFlightForm(page, payload);
  logCostamarB2bDebug("form primed", {
    primed,
    tripType: payload.tripType,
    origin: payload.origin,
    destination: payload.destination,
  });
  if (!primed) {
    return undefined;
  }

  observeCostamarBrowserPages(page.context(), pool, `${sourcePrefix}:observed`, observedPages);
  await collectCostamarCandidatesFromPage(page, pool, `${sourcePrefix}:ready`);

  const searchTrigger = page.locator("#fsairlines").first();
  if (await searchTrigger.count() === 0) {
    return undefined;
  }

  const airlineSearchTokenPromise = page.waitForResponse((response) =>
    isCostamarB2bAirlineSearchResponse(response.request().method(), response.url()), {
    timeout: Math.max(1500, Math.min(4000, costamarSessionWarmupTimeoutMs())),
  }).then(async (response) => {
    const token = normalizeCostamarB2bTokenResponse(await response.text().catch(() => ""));
    logCostamarB2bDebug("airlinesearch response", {
      status: response.status(),
      hasToken: Boolean(token),
    });
    if (!resolveUsableCostamarBrandedToken(token, context.terminalId)) {
      return undefined;
    }

    return buildCostamarSessionCandidateFromToken(
      token,
      context.terminalId,
      `${sourcePrefix}:airlinesearch`,
      context.brandBaseUrl,
    );
  }).catch(() => undefined);

  await searchTrigger.click({ force: true }).catch(async () => {
    await page.evaluate(() => {
      document.querySelector<HTMLElement>("#fsairlines")?.click();
    }).catch(() => undefined);
  });
  logCostamarB2bDebug("search trigger clicked");

  const airlineSearchCandidate = await airlineSearchTokenPromise;
  if (airlineSearchCandidate) {
    pool.set(
      `${airlineSearchCandidate.terminalId}::${airlineSearchCandidate.token}`,
      airlineSearchCandidate,
    );
    logCostamarB2bDebug("airlinesearch candidate", { source: airlineSearchCandidate.source });
    return airlineSearchCandidate;
  }
  logCostamarB2bDebug("airlinesearch candidate", { found: false });

  const deadline = Date.now() + Math.max(2500, Math.min(6000, costamarSessionWarmupTimeoutMs()));
  while (Date.now() < deadline) {
    observeCostamarBrowserPages(page.context(), pool, `${sourcePrefix}:popup`, observedPages);
    logCostamarB2bDebug("observed pages", { count: page.context().pages().length });

    for (const [index, currentPage] of page.context().pages().entries()) {
      await collectCostamarCandidatesFromPage(currentPage, pool, `${sourcePrefix}:page:${index}`);
    }

    const candidate = pickUsableCostamarCandidate(pool, context.terminalId);
    if (candidate) {
      logCostamarB2bDebug("pool candidate", { terminalId: candidate.terminalId, source: candidate.source });
      return candidate;
    }

    await sleep(COSTAMAR_SESSION_WARMUP_POLL_MS);
  }

  return undefined;
}

function costamarB2bAuthInputPriority(input: CostamarB2bAuthInputDescriptor): number {
  const metadata = `${input.id} ${input.name} ${input.autocomplete}`.trim().toLowerCase();
  let score = 0;

  if (input.autocomplete.toLowerCase().includes("one-time-code")) {
    score -= 40;
  }
  if (COSTAMAR_B2B_AUTH_FIELD_PATTERN.test(metadata)) {
    score -= 20;
  }
  if (input.type === "tel" || input.type === "number") {
    score -= 6;
  }
  if (input.maxLength > 0 && input.maxLength <= 8) {
    score -= 4;
  }

  return score + input.index;
}

export function detectCostamarB2bAuthChallenge(
  snapshot: Partial<CostamarB2bAuthSnapshot> | undefined,
): CostamarB2bAuthChallenge | undefined {
  const text = String(snapshot?.text ?? "");
  const visibleInputs = (snapshot?.inputs ?? []).filter((input) => {
    const type = input.type.toLowerCase();
    if (!input.visible) {
      return false;
    }

    return !["hidden", "submit", "button", "checkbox", "radio"].includes(type);
  });

  const directMatches = visibleInputs.filter((input) =>
    COSTAMAR_B2B_AUTH_FIELD_PATTERN.test(`${input.id} ${input.name} ${input.autocomplete}`.trim().toLowerCase())
    || input.autocomplete.toLowerCase().includes("one-time-code"));

  const textSuggestsAuth = COSTAMAR_B2B_AUTH_HINT_PATTERN.test(text.toLowerCase());
  const fallbackMatches = textSuggestsAuth
    ? visibleInputs.filter((input) => {
      const metadata = `${input.id} ${input.name}`.trim().toLowerCase();
      if (/(email|password|user|account|terminal)/i.test(metadata)) {
        return false;
      }

      const type = input.type.toLowerCase();
      if (!["", "text", "tel", "number", "password"].includes(type)) {
        return false;
      }

      return input.maxLength === 1
        || (input.maxLength >= 4 && input.maxLength <= 8)
        || input.autocomplete.toLowerCase().includes("one-time-code");
    })
    : [];

  const matches = (directMatches.length > 0 ? directMatches : fallbackMatches)
    .sort((left, right) => costamarB2bAuthInputPriority(left) - costamarB2bAuthInputPriority(right));

  if (matches.length === 0) {
    return undefined;
  }

  const splitMatches = matches.filter((input) => input.maxLength === 1);
  if (splitMatches.length >= 4 && splitMatches.length <= 8 && splitMatches.length === matches.length) {
    return {
      kind: "split",
      inputIndexes: splitMatches.map((input) => input.index),
    };
  }

  return {
    kind: "single",
    inputIndexes: [matches[0].index],
  };
}

async function readCostamarB2bAuthSnapshot(page: Page): Promise<CostamarB2bAuthSnapshot | undefined> {
  try {
    return await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll("input"))
        .map((input, index) => ({
          index,
          id: input.id ?? "",
          name: input.getAttribute("name") ?? "",
          type: input.getAttribute("type") ?? "text",
          autocomplete: input.getAttribute("autocomplete") ?? "",
          maxLength: typeof input.maxLength === "number" ? input.maxLength : 0,
          visible: Boolean(
            input instanceof HTMLElement
            && (input.offsetParent !== null || input.getClientRects().length > 0)
          ),
        }));

      return {
        text: document.body?.innerText ?? "",
        inputs,
      };
    }) as CostamarB2bAuthSnapshot;
  } catch {
    return undefined;
  }
}

function resolveCostamarB2bAuthChallengeLabel(text: string): string {
  if (/google\s+authenticator/i.test(text)) {
    return "Código de Google Authenticator";
  }
  if (/authenticator/i.test(text)) {
    return "Código del autenticador";
  }
  if (/otp/i.test(text)) {
    return "Código OTP de Costamar";
  }
  if (/token/i.test(text)) {
    return "Token de Costamar";
  }

  return "Código Auth / OTP de Costamar";
}

async function detectCostamarB2bAuthPrompt(page: Page): Promise<{
  challenge: CostamarB2bAuthChallenge;
  label: string;
} | undefined> {
  const snapshot = await readCostamarB2bAuthSnapshot(page);
  const challenge = detectCostamarB2bAuthChallenge(snapshot);
  if (!challenge) {
    return undefined;
  }

  return {
    challenge,
    label: resolveCostamarB2bAuthChallengeLabel(snapshot?.text ?? ""),
  };
}

async function submitCostamarB2bAuthPrompt(
  page: Page,
  challenge: CostamarB2bAuthChallenge,
  authCode: string,
): Promise<void> {
  const inputLocator = page.locator("input");
  const normalizedCode = authCode.trim();

  if (challenge.kind === "split") {
    const characters = [...normalizedCode];
    for (let index = 0; index < challenge.inputIndexes.length; index += 1) {
      await applyCostamarB2bKeyboardInput(
        inputLocator.nth(challenge.inputIndexes[index]),
        characters[index] ?? "",
      );
    }
  } else {
    await applyCostamarB2bKeyboardInput(
      inputLocator.nth(challenge.inputIndexes[0]),
      normalizedCode,
    );
  }

  const submitSelectors = [
    "#btnsubmit",
    "button[type='submit']",
    "input[type='submit']",
    "button[id*='verify' i]",
    "button[name*='verify' i]",
    "button[id*='submit' i]",
    "button[name*='submit' i]",
  ];

  let submitted = false;
  for (const selector of submitSelectors) {
    const control = page.locator(selector).first();
    if (await control.count() === 0) {
      continue;
    }

    const visible = await control.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }

    await control.click().catch(() => undefined);
    submitted = true;
    break;
  }

  if (!submitted) {
    const lastInput = inputLocator.nth(challenge.inputIndexes[challenge.inputIndexes.length - 1]);
    await lastInput.press("Enter").catch(() => undefined);
  }

  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
}

async function waitForCostamarB2bSessionTransition(
  page: Page,
  timeoutMs = 10000,
): Promise<void> {
  const deadline = Date.now() + Math.max(2000, timeoutMs);
  while (Date.now() < deadline) {
    const loginVisible = await pageShowsCostamarB2bLogin(page);
    const authPromptVisible = Boolean(await detectCostamarB2bAuthPrompt(page));
    if (!loginVisible && !authPromptVisible) {
      return;
    }

    await page.waitForLoadState("domcontentloaded", { timeout: 1500 }).catch(() => undefined);
    await page.waitForTimeout(500);
  }
}

async function completeCostamarB2bAuthPrompt(page: Page): Promise<boolean> {
  const prompt = await detectCostamarB2bAuthPrompt(page);
  if (!prompt) {
    return true;
  }

  const authCode = await promptCostamarB2bAuthCode(prompt.label);
  if (!authCode) {
    return false;
  }

  await submitCostamarB2bAuthPrompt(page, prompt.challenge, authCode);
  await waitForCostamarB2bSessionTransition(page);
  return !(await pageShowsCostamarB2bLogin(page))
    && !(await detectCostamarB2bAuthPrompt(page));
}

async function pageShowsCostamarB2bLogin(page: Page): Promise<boolean> {
  try {
    const email = page.locator("#email").first();
    const password = page.locator("#password").first();
    if (await email.count() === 0 || await password.count() === 0) {
      return false;
    }

    return await email.isVisible().catch(() => false)
      && await password.isVisible().catch(() => false);
  } catch {
    return false;
  }
}

async function ensureCostamarB2bSession(page: Page): Promise<boolean> {
  const baseUrl = resolveCostamarB2bBaseUrl();
  if (!page.url().startsWith(baseUrl)) {
    await page.goto(baseUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await page.waitForTimeout(1500);
  } else {
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => undefined);
  }

  if (!(await pageShowsCostamarB2bLogin(page))) {
    return completeCostamarB2bAuthPrompt(page);
  }

  const credentials = await resolveCostamarB2bCredentialsForAutomation();
  if (!credentials.email || !credentials.password) {
    return false;
  }

  await applyCostamarB2bKeyboardInput(page.locator("#email"), credentials.email);
  await applyCostamarB2bKeyboardInput(page.locator("#password"), credentials.password);
  await page.locator("#btnsubmit").click();
  await page.waitForLoadState("domcontentloaded", { timeout: 45000 }).catch(() => undefined);
  await waitForCostamarB2bSessionTransition(page, 8000);

  if (!(await pageShowsCostamarB2bLogin(page))) {
    return completeCostamarB2bAuthPrompt(page);
  }

  clearInteractiveCostamarB2bCredentials();
  return false;
}

async function launchCostamarBrowserContext(): Promise<{
  context: BrowserContext;
  tempRoot: string;
  profileName: string;
  browser?: Browser;
}> {
  const profileName = resolveCostamarChromeProfileName();
  const cloneSourceProfile = shouldCloneCostamarChromeProfileForIsolatedAutomation();
  const tempRoot = cloneSourceProfile
    ? prepareTemporaryCostamarChromeProfile(profileName, { cloneSourceProfile })
    : "";
  try {
    const playwright = await getPlaywright();
    const configuredExecutable = process.env.COSTAMAR_CHROME_EXECUTABLE?.trim();
    const executablePath = cloneSourceProfile
      ? resolveCostamarChromeExecutable()
      : configuredExecutable && existsSync(configuredExecutable)
        ? configuredExecutable
        : undefined;
    const launchOptions = {
      ...(executablePath ? { executablePath } : {}),
      headless: costamarBrowserAutomationHeadless(),
      args: [
        "--no-first-run",
        "--no-default-browser-check",
      ],
    };

    if (!cloneSourceProfile) {
      const browser = await playwright.chromium.launch(launchOptions);
      const context = await browser.newContext();
      logCostamarB2bDebug("isolated browser launched", { cloneSourceProfile, profileName });

      return {
        context,
        tempRoot,
        profileName,
        browser,
      };
    }

    const context = await playwright.chromium.launchPersistentContext(tempRoot, {
      ...launchOptions,
      args: [
        `--profile-directory=${profileName}`,
        ...launchOptions.args,
      ],
    });
    logCostamarB2bDebug("isolated browser launched", { cloneSourceProfile, profileName });

    return {
      context,
      tempRoot,
      profileName,
    };
  } catch (error) {
    if (tempRoot) {
      await removePathWithRetries(tempRoot, 6, 250);
      unregisterActiveTempArtifact(tempRoot);
    }
    throw error;
  }
}

async function launchCostamarBrowserContextWithin(timeoutMs: number): Promise<{
  context: BrowserContext;
  tempRoot: string;
  profileName: string;
  browser?: Browser;
}> {
  const launchPromise = launchCostamarBrowserContext();
  try {
    return await withCostamarB2bTimeout(
      launchPromise,
      timeoutMs,
      "Costamar isolated browser launch",
    );
  } catch (error) {
    void launchPromise.then(async (launched) => {
      await closeCostamarBrowserContext(launched.context);
      await closeCostamarBrowser(launched.browser);
      if (launched.tempRoot) {
        await removePathWithRetries(launched.tempRoot, 6, 250);
        unregisterActiveTempArtifact(launched.tempRoot);
      }
    }).catch(() => undefined);
    throw error;
  }
}

async function generateCostamarRedirectContextViaB2B(
  request: SearchRequest,
  context: CostamarProviderContext,
): Promise<CostamarProviderContext | undefined> {
  if (!canGenerateCostamarTokenViaB2B()) {
    return undefined;
  }

  const warmupTimeoutMs = Math.max(2000, costamarSessionWarmupTimeoutMs());
  const browserLaunchTimeoutMs = Math.max(10000, warmupTimeoutMs);
  const pool = new Map<string, CostamarSessionCandidate>();
  const observedPages = new Set<Page>();
  const searchUrl = buildCostamarBrandedSearchUrl(request, {
    ...context,
    token: "",
  });
  let liveBrowser: Browser | undefined;
  let livePage: Page | undefined;
  let closeLivePage = false;
  let resetLiveBrowserConnection = false;
  let browserContext: BrowserContext | undefined;
  let isolatedBrowser: Browser | undefined;
  let tempRoot = "";

  const httpContext = await generateCostamarRedirectContextViaB2BHttp(context);
  if (httpContext && resolveUsableCostamarBrandedToken(httpContext.token, httpContext.terminalId)) {
    return httpContext;
  }

  if (!costamarB2bPlaywrightFallbackEnabled()) {
    return undefined;
  }

  if (shouldUseLiveCostamarBrowserContext()) {
    try {
      const liveSession = await withCostamarB2bTimeout(
        connectToLiveCostamarBrowserContext(),
        warmupTimeoutMs,
        "Costamar live browser connection",
      );
      if (liveSession) {
        liveBrowser = liveSession.browser;
        livePage = await withCostamarB2bTimeout(
          liveSession.context.newPage(),
          warmupTimeoutMs,
          "Costamar live page creation",
        );
        closeLivePage = true;

        observeCostamarBrowserPages(liveSession.context, pool, "live-b2b", observedPages);
        const hasLiveSession = await withCostamarB2bTimeout(
          ensureCostamarB2bSession(livePage),
          warmupTimeoutMs,
          "Costamar live B2B session",
        );
        logCostamarB2bDebug("live session resolved", { hasLiveSession });
        await withCostamarB2bTimeout(
          collectCostamarCandidatesFromPage(livePage, pool, "live-b2b"),
          warmupTimeoutMs,
          "Costamar live token collection",
        );
        if (hasLiveSession) {
          const generatedCandidate = await withCostamarB2bTimeout(
            submitCostamarB2bFlightSearch(
              livePage,
              request,
              context,
              pool,
              "live-b2b",
              observedPages,
            ),
            warmupTimeoutMs,
            "Costamar live B2B flight search",
          );
          logCostamarB2bDebug("live candidate", generatedCandidate
            ? { terminalId: generatedCandidate.terminalId, source: generatedCandidate.source }
            : { found: false });
          if (generatedCandidate) {
            rememberCostamarSessionCandidate({
              terminalId: generatedCandidate.terminalId,
              token: generatedCandidate.token,
              source: `b2b-live:${generatedCandidate.source}`,
            });
            return resolveLatestCostamarProviderContext({
              ...context,
              terminalId: generatedCandidate.terminalId,
              token: generatedCandidate.token,
            });
          }
        }

        const liveCandidate = pickUsableCostamarCandidate(pool, context.terminalId);
        if (liveCandidate) {
          rememberCostamarSessionCandidate({
            terminalId: liveCandidate.terminalId,
            token: liveCandidate.token,
            source: `b2b-live:${liveCandidate.source}`,
          });
          return resolveLatestCostamarProviderContext({
            ...context,
            terminalId: liveCandidate.terminalId,
            token: liveCandidate.token,
          });
        }
      }
    } catch {
      logCostamarB2bDebug("live automation failed");
      resetLiveBrowserConnection = Boolean(liveBrowser);
      // Fall through to the isolated-profile automation below.
    } finally {
      if (closeLivePage && livePage) {
        await withCostamarB2bTimeout(
          livePage.close().catch(() => undefined),
          2000,
          "Costamar live page close",
        ).catch(() => undefined);
      }
      if (resetLiveBrowserConnection) {
        await closeLiveCostamarBrowserConnection();
      }
    }
  }

  try {
    const launched = await launchCostamarBrowserContextWithin(browserLaunchTimeoutMs);
    browserContext = launched.context;
    isolatedBrowser = launched.browser;
    tempRoot = launched.tempRoot;

    observeCostamarBrowserPages(browserContext, pool, "existing", observedPages);

    const sessionPage = browserContext.pages()[0] ?? await withCostamarB2bTimeout(
      browserContext.newPage(),
      warmupTimeoutMs,
      "Costamar isolated page creation",
    );
    observeCostamarBrowserPages(browserContext, pool, "b2b", observedPages);
    const hasSession = await withCostamarB2bTimeout(
      ensureCostamarB2bSession(sessionPage),
      warmupTimeoutMs,
      "Costamar isolated B2B session",
    );
    logCostamarB2bDebug("isolated session resolved", { hasSession, url: sessionPage.url() });
    await withCostamarB2bTimeout(
      collectCostamarCandidatesFromPage(sessionPage, pool, "b2b"),
      warmupTimeoutMs,
      "Costamar isolated token collection",
    );
    if (!hasSession) {
      return undefined;
    }

    const generatedCandidate = await withCostamarB2bTimeout(
      submitCostamarB2bFlightSearch(
        sessionPage,
        request,
        context,
        pool,
        "b2b",
        observedPages,
      ),
      warmupTimeoutMs,
      "Costamar isolated B2B flight search",
    );
    logCostamarB2bDebug("isolated candidate", generatedCandidate
      ? { terminalId: generatedCandidate.terminalId, source: generatedCandidate.source }
      : { found: false });
    if (generatedCandidate) {
      rememberCostamarSessionCandidate({
        terminalId: generatedCandidate.terminalId,
        token: generatedCandidate.token,
        source: `b2b-automation:${generatedCandidate.source}`,
      });
      return resolveLatestCostamarProviderContext({
        ...context,
        terminalId: generatedCandidate.terminalId,
        token: generatedCandidate.token,
      });
    }

    const searchPage = await withCostamarB2bTimeout(
      browserContext.newPage(),
      warmupTimeoutMs,
      "Costamar branded search page creation",
    );
    observeCostamarBrowserPages(browserContext, pool, "search", observedPages);
    await withCostamarB2bTimeout(
      searchPage.goto(searchUrl, {
        waitUntil: "domcontentloaded",
        timeout: warmupTimeoutMs,
      }),
      warmupTimeoutMs,
      "Costamar branded search navigation",
    ).catch(() => undefined);

    const deadline = Date.now() + Math.max(2000, costamarSessionWarmupTimeoutMs());
    while (Date.now() < deadline) {
      for (const [index, page] of browserContext.pages().entries()) {
        await collectCostamarCandidatesFromPage(page, pool, `page:${index}`);
      }

      const candidate = pickUsableCostamarCandidate(pool, context.terminalId);
      if (candidate) {
        rememberCostamarSessionCandidate({
          terminalId: candidate.terminalId,
          token: candidate.token,
          source: `b2b-automation:${candidate.source}`,
        });
        return resolveLatestCostamarProviderContext({
          ...context,
          terminalId: candidate.terminalId,
          token: candidate.token,
        });
      }

      await sleep(COSTAMAR_SESSION_WARMUP_POLL_MS);
    }
  } catch (error) {
    logCostamarB2bDebug("isolated automation failed", error instanceof Error ? error.message : "unknown error");
    return undefined;
  } finally {
    await closeCostamarBrowserContext(browserContext);
    await closeCostamarBrowser(isolatedBrowser);
    if (tempRoot) {
      await removePathWithRetries(tempRoot, 6, 250);
      unregisterActiveTempArtifact(tempRoot);
    }
  }

  return undefined;
}

function createCostamarWarmupDiagnostics(context: CostamarProviderContext): CostamarWarmupDiagnostics {
  const credentials = resolveCostamarB2bCredentials();
  return {
    startedAt: new Date().toISOString(),
    ...(context.terminalId ? { terminalId: context.terminalId } : {}),
    credentialsPresent: Boolean(credentials.email && credentials.password),
    totpConfigured: Boolean(resolveCostamarB2bTotpSecret()),
    otpGenerated: false,
    authPromptResolved: false,
    tokenCaptured: false,
    tokenValidated: false,
    steps: [],
  };
}

function recordCostamarWarmupStep(
  diagnostics: CostamarWarmupDiagnostics | undefined,
  name: string,
  ok: boolean,
  detail?: string,
): void {
  if (!diagnostics) {
    return;
  }

  diagnostics.steps.push({
    name,
    ok,
    at: new Date().toISOString(),
    ...(detail ? { detail } : {}),
  });
  if (!ok && detail && !diagnostics.failureReason) {
    diagnostics.failureReason = detail;
  }
}

export function getLastCostamarWarmupDiagnosticsForTests(): CostamarWarmupDiagnostics | undefined {
  return lastCostamarWarmupDiagnostics
    ? JSON.parse(JSON.stringify(lastCostamarWarmupDiagnostics)) as CostamarWarmupDiagnostics
    : undefined;
}

export function getLastCostamarWarmupDiagnostics(): CostamarWarmupDiagnostics | undefined {
  return getLastCostamarWarmupDiagnosticsForTests();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withCostamarB2bTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const boundedTimeoutMs = Math.max(1000, Math.trunc(timeoutMs));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} timed out after ${boundedTimeoutMs}ms.`));
        }, boundedTimeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function closeCostamarBrowserContext(context: BrowserContext | undefined): Promise<void> {
  if (!context) {
    return;
  }

  await withCostamarB2bTimeout(
    context.close().catch(() => undefined),
    2000,
    "Costamar browser context close",
  ).catch(() => undefined);
}

async function closeCostamarBrowser(browser: Browser | undefined): Promise<void> {
  if (!browser) {
    return;
  }

  const childProcess = (browser as Browser & {
    process?: () => { exitCode: number | null; kill: () => unknown } | null;
  }).process?.();

  await withCostamarB2bTimeout(
    browser.close().catch(() => undefined),
    2000,
    "Costamar browser close",
  ).catch(() => undefined);

  if (childProcess && childProcess.exitCode === null) {
    try {
      childProcess.kill();
    } catch {
      // Browser cleanup is best-effort after a failed warm-up.
    }
  }
}

export async function warmCostamarRedirectContext(
  request: SearchRequest,
  context: CostamarProviderContext,
  options: { force?: boolean } = {},
): Promise<CostamarProviderContext> {
  if (!canWarmCostamarSession(request)) {
    return context;
  }

  const initialInspection = inspectCostamarBrandedToken(context.token, context.terminalId);
  if (!options.force && initialInspection.usable && !initialInspection.nearExpiry && !initialInspection.opaque) {
    return context;
  }

  const timeoutMs = costamarSessionWarmupTimeoutMs();
  if (timeoutMs <= 0) {
    return context;
  }

  const warmupKey = context.terminalId || "default";
  const pending = pendingCostamarSessionWarmups.get(warmupKey);
  if (pending) {
    return pending;
  }

  const nowMs = Date.now();
  const lastAttemptAt = recentCostamarSessionWarmups.get(warmupKey) ?? 0;
  if (!options.force && (nowMs - lastAttemptAt) < costamarSessionWarmupCooldownMs()) {
    return resolveLatestCostamarProviderContext({
      ...context,
      token: "",
    });
  }

  const promise = (async () => {
    recentCostamarSessionWarmups.set(warmupKey, Date.now());
    const seedContext = {
      ...context,
      token: "",
    };

    const generatedContext = await costamarWarmupGenerator(request, seedContext).catch(() => undefined);
    if (generatedContext && resolveUsableCostamarBrandedToken(generatedContext.token, generatedContext.terminalId)) {
      rememberCostamarSessionCandidate({
        terminalId: generatedContext.terminalId,
        token: generatedContext.token,
        source: "warmup-generator",
      });
      return resolveLatestCostamarProviderContext(generatedContext);
    }

    if (costamarSessionWarmupOpenBrowserFallbackEnabled()) {
      try {
        await costamarWarmupOpener(
          resolveCostamarB2bBaseUrl(),
          "chrome",
          resolveCostamarChromeLaunchOptions(),
        );
        await sleep(750);
        await costamarWarmupOpener(
          buildCostamarBrandedSearchUrl(request, seedContext),
          "chrome",
          resolveCostamarChromeLaunchOptions(),
        );
      } catch {
        // Ignore launcher failures and still re-check any ambient session changes.
      }
    }

    const deadline = Date.now() + timeoutMs;
    let latest = resolveLatestCostamarProviderContext(seedContext);
    while (Date.now() < deadline) {
      if (resolveUsableCostamarBrandedToken(latest.token, latest.terminalId)) {
        return latest;
      }

      await sleep(COSTAMAR_SESSION_WARMUP_POLL_MS);
      latest = resolveLatestCostamarProviderContext(seedContext);
    }

    return latest;
  })();

  pendingCostamarSessionWarmups.set(warmupKey, promise);
  try {
    return await promise;
  } finally {
    pendingCostamarSessionWarmups.delete(warmupKey);
  }
}

export function setCostamarWarmupOpenerForTests(
  opener?: typeof openUrlLocally,
): void {
  costamarWarmupOpener = opener ?? openUrlLocally;
}

export function setCostamarWarmupGeneratorForTests(
  generator?: CostamarWarmupGenerator,
): void {
  costamarWarmupGenerator = generator ?? generateCostamarRedirectContextViaB2B;
}

export function setCostamarB2bPromptProviderForTests(
  provider?: CostamarB2bPromptProvider,
): void {
  costamarB2bPromptProvider = provider ?? promptCostamarB2bViaTerminal;
}

export function resetCostamarWarmupStateForTests(): void {
  engineCache.clear();
  pendingCostamarSessionWarmups.clear();
  recentCostamarSessionWarmups.clear();
  costamarWarmupOpener = openUrlLocally;
  costamarWarmupGenerator = generateCostamarRedirectContextViaB2B;
  costamarB2bPromptProvider = promptCostamarB2bViaTerminal;
  cachedInteractiveCostamarB2bCredentials = {};
  pendingCostamarB2bCredentialPrompt = undefined;
  pendingCostamarB2bAuthPrompt = undefined;
  lastCostamarWarmupDiagnostics = undefined;
  void closeLiveCostamarBrowserConnection();
  liveCostamarBrowserRetryAfterMs = 0;
  playwrightPromise = undefined;
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name] ?? fallback);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.trunc(parsed)
    : fallback;
}

function costamarProviderB2bPrewarmEnabled(): boolean {
  return String(process.env.COSTAMAR_PROVIDER_B2B_PREWARM_ENABLED ?? "0").trim() !== "0";
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function buildCostamarPrewarmRequest(now = new Date()): SearchRequest {
  const departureOffsetDays = readPositiveIntegerEnv(
    "COSTAMAR_PREWARM_DEPARTURE_OFFSET_DAYS",
    DEFAULT_COSTAMAR_PREWARM_DEPARTURE_OFFSET_DAYS,
  );
  const stayNights = readPositiveIntegerEnv(
    "COSTAMAR_PREWARM_STAY_NIGHTS",
    DEFAULT_COSTAMAR_PREWARM_STAY_NIGHTS,
  );
  const departureDate = addUtcDays(now, departureOffsetDays);
  const returnDate = addUtcDays(departureDate, stayNights);
  const origin = process.env.COSTAMAR_PREWARM_ORIGIN?.trim().toUpperCase()
    || DEFAULT_COSTAMAR_PREWARM_ORIGIN;
  const destination = process.env.COSTAMAR_PREWARM_DESTINATION?.trim().toUpperCase()
    || DEFAULT_COSTAMAR_PREWARM_DESTINATION;

  return {
    providerId: "costamar",
    tripType: "round-trip",
    searchMode: "exact",
    legs: [
      {
        origin,
        destination,
        departureDate: isoDate(departureDate),
        returnDate: isoDate(returnDate),
      },
    ],
    passengers: {
      adults: 1,
      children: 0,
      infants: 0,
    },
    cabin: "ECONOMY",
    filters: {},
    coverageMode: "core",
    redirectMode: "best-effort",
    currencyCode: "USD",
    locale: "es-PE",
    market: "PE",
  };
}

export async function prewarmLocalCostamarContext(): Promise<void> {
  const context = resolveLatestCostamarProviderContext();
  if (!costamarProviderB2bPrewarmEnabled()) {
    return;
  }

  await warmCostamarRedirectContext(buildCostamarPrewarmRequest(), context);
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

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

async function searchLocalCostamarExactWithRetry(
  request: SearchRequest,
  providerContext?: ProviderContext,
): Promise<ProviderSearchResult> {
  let attempt = 0;
  while (true) {
    try {
      return await searchLocalCostamarExact(request, providerContext);
    } catch (error) {
      if (attempt >= COSTAMAR_RANGE_DAY_RETRY_ATTEMPTS) {
        throw error;
      }

      attempt += 1;
      const retryDelayMs = COSTAMAR_RANGE_DAY_RETRY_DELAY_MS * attempt;
      if (retryDelayMs > 0) {
        await waitMs(retryDelayMs);
      }
    }
  }
}

function toCostamarDayStart(dateIso?: string): string | undefined {
  if (!dateIso) {
    return undefined;
  }

  return new Date(`${dateIso}T00:00:00-05:00`).toISOString();
}

function toCostamarDayStartMs(dateIso?: string): number | undefined {
  const normalized = toCostamarDayStart(dateIso);
  if (!normalized) {
    return undefined;
  }

  const timestamp = new Date(normalized).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function toCompactDate(dateIso?: string): string | undefined {
  return dateIso ? dateIso.replaceAll("-", "") : undefined;
}

function numberValue(value: unknown): number | undefined {
  return parseProviderAmount(value);
}

function parseDurationMinutes(value: unknown, departureAt?: string, arrivalAt?: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      if (trimmed.length === 4) {
        const hours = Number(trimmed.slice(0, 2));
        const minutes = Number(trimmed.slice(2));
        if (minutes < 60) {
          return (hours * 60) + minutes;
        }
      }

      return Math.max(0, Number(trimmed));
    }

    const hhmm = trimmed.match(/^(\d{1,2}):(\d{2})$/);
    if (hhmm) {
      return (Number(hhmm[1]) * 60) + Number(hhmm[2]);
    }

    const iso = trimmed.match(/^PT(?:(\d+)H)?(?:(\d+)M)?$/i);
    if (iso) {
      return (Number(iso[1] ?? 0) * 60) + Number(iso[2] ?? 0);
    }
  }

  if (departureAt && arrivalAt) {
    const diff = new Date(arrivalAt).getTime() - new Date(departureAt).getTime();
    if (Number.isFinite(diff) && diff > 0) {
      return Math.round(diff / 60000);
    }
  }

  return 0;
}

function computeLayovers(segments: Segment[]): number[] {
  const layovers: number[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    const current = segments[index];
    const diff = Math.round(
      (new Date(current.departureAt).getTime() - new Date(previous.arrivalAt).getTime()) / 60000,
    );
    layovers.push(Math.max(0, diff));
  }
  return layovers;
}

function baggageEntryList(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (value && typeof value === "object") {
    return [value];
  }

  return [];
}

function asBaggageRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function parseBaggageFlag(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return undefined;
    }

    if (["1", "true", "yes", "si", "sí", "included", "incluido"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "excluded", "excluido"].includes(normalized)) {
      return false;
    }
  }

  return undefined;
}

function isCostamarCodeLikeDescription(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return normalized === "dynamic"
    || normalized.startsWith("bagg ")
    || normalized.startsWith("hand ");
}

function buildBaggageSummaryFromSegments(segments: CostamarSegmentLike[]): BaggageSummary | undefined {
  let carryOnIncluded = false;
  let checkedIncluded = false;
  let checkedBags = 0;
  const descriptions: string[] = [];

  for (const segment of segments) {
    const entries = [
      ...baggageEntryList(segment.baggage).map((entry) => ({ entry, scope: "checked" as const })),
      ...baggageEntryList(segment.handBaggage).map((entry) => ({ entry, scope: "hand" as const })),
    ];
    for (const { entry, scope } of entries) {
      const record = asBaggageRecord(entry);
      if (!record) {
        continue;
      }

      const type = String(
        record.type
        ?? record.baggageType
        ?? record.code
        ?? record.category
        ?? "",
      ).toLowerCase();
      const description = String(record.description ?? record.name ?? "").trim();
      const normalizedDescription = description.toLowerCase();
      const quantity = numberValue(
        record.quantity
        ?? record.amount
        ?? record.pieces
        ?? record.qty,
      );
      const explicitIncluded = parseBaggageFlag(
        record.included
        ?? record.isIncluded
        ?? record.include
        ?? record.hasBaggage
        ?? record.available,
      );
      const carrySignal = scope === "hand"
        || type.includes("carry")
        || type.includes("hand")
        || type.includes("cab")
        || normalizedDescription.includes("carry")
        || normalizedDescription.includes("hand")
        || normalizedDescription.includes("mano")
        || normalizedDescription.includes("cabina");
      const checkedSignal = scope === "checked"
        || type.includes("check")
        || type.includes("hold")
        || type.includes("bagg")
        || normalizedDescription.includes("bodega")
        || normalizedDescription.includes("factur")
        || normalizedDescription.includes("check")
        || normalizedDescription.includes("bagg");

      if (carrySignal) {
        if (explicitIncluded === true || (typeof quantity === "number" && quantity > 0) || scope === "hand") {
          carryOnIncluded = true;
        }
      }

      if (checkedSignal) {
        if (explicitIncluded === true || (typeof quantity === "number" && quantity > 0)) {
          checkedIncluded = true;
        }
        if (typeof quantity === "number" && quantity > 0) {
          checkedBags = Math.max(checkedBags, quantity);
        }
        if (description && !isCostamarCodeLikeDescription(description)) {
          descriptions.push(description);
        }
      }
    }
  }

  if (!carryOnIncluded && !checkedIncluded && checkedBags === 0 && descriptions.length === 0) {
    return undefined;
  }

  return {
    carryOnIncluded,
    checkedIncluded,
    checkedBags: checkedBags || undefined,
    description: uniqueStrings(descriptions).join(", ") || undefined,
  };
}

function buildCostamarOfferId(
  signature: string,
  totalAmount: number,
  currencyCode: string,
): string {
  const seed = `${signature}::${totalAmount.toFixed(2)}::${currencyCode}`;
  return `costamar-${sha1Hex(seed).slice(0, 16)}`;
}

function dedupeCostamarOffers(offers: CanonicalOffer[]): CanonicalOffer[] {
  const deduped = new Map<string, CanonicalOffer>();

  for (const offer of offers) {
    const key = [
      offer.signature,
      offer.price.total.amount.toFixed(2),
      offer.price.total.currencyCode,
      String(offer.baggage?.checkedBags ?? ""),
      String(offer.baggage?.carryOnIncluded ?? ""),
    ].join("::");
    const existing = deduped.get(key);
    if (!existing || compareByPriceThenDuration(offer, existing) < 0) {
      deduped.set(key, offer);
    }
  }

  return [...deduped.values()];
}

function compareByPriceThenDuration(left: CanonicalOffer, right: CanonicalOffer): number {
  const priceDiff = left.price.total.amount - right.price.total.amount;
  if (priceDiff !== 0) {
    return priceDiff;
  }

  return totalDuration(left) - totalDuration(right);
}

function money(amount: number | undefined, currencyCode: string) {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    return undefined;
  }

  return {
    amount: Number(amount.toFixed(2)),
    currencyCode,
  };
}

function roundMoneyAmount(amount: number): number {
  return roundProviderAmount(amount);
}

function resolveCostamarOfferCurrencyCode(
  request: SearchRequest,
  engine: CostamarEngineMetadata,
): string {
  const requestedCurrencyCode = String(request.currencyCode ?? "").trim().toUpperCase();
  if (requestedCurrencyCode) {
    return requestedCurrencyCode;
  }

  const engineCurrencyCode = String(
    engine.profile?.currencyCode
      ?? engine.profile?.currency?.code
      ?? "USD",
  ).trim().toUpperCase();

  return engineCurrencyCode || "USD";
}

function ensureCostamarCredentials(context: CostamarProviderContext): void {
  if (!context.terminalId) {
    throw new Error("Costamar terminalId is required.");
  }
}

async function fetchCostamar(
  context: CostamarProviderContext,
  path: string,
  init: RequestInit,
  action: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), COSTAMAR_HTTP_TIMEOUT_MS);
  recordProviderFirstHttpRequest(action);

  try {
    return await fetch(`${context.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/json, text/plain, */*",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new Error(`${action} failed: ${detail}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchCostamarJson<T>(
  context: CostamarProviderContext,
  path: string,
  init: RequestInit,
  action: string,
): Promise<T> {
  const response = await fetchCostamar(context, path, init, action);
  const bodyText = await response.text();
  let parsed: T | undefined;

  try {
    parsed = bodyText ? JSON.parse(bodyText) as T : undefined;
  } catch {
    parsed = undefined;
  }

  if (!response.ok) {
    throw new Error(
      bodyText
        ? `${action} failed with ${response.status} ${response.statusText}: ${bodyText}`
        : `${action} failed with ${response.status} ${response.statusText}`,
    );
  }

  return parsed as T;
}

async function getEngineMetadata(context: CostamarProviderContext): Promise<CostamarEngineMetadata> {
  const cacheKey = `${context.apiBaseUrl}::${context.terminalId}`;
  const cached = engineCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const request = fetchCostamarJson<CostamarEngineMetadata>(
    context,
    `/engines/${encodeURIComponent(context.terminalId)}`,
    { method: "GET" },
    "Costamar engine metadata",
  ).catch((error) => {
    engineCache.delete(cacheKey);
    throw error;
  });

  engineCache.set(cacheKey, request);
  return request;
}

export function buildCostamarSearchBody(
  request: SearchRequest,
  context: CostamarProviderContext,
  flexible = false,
): Record<string, unknown> {
  const leg = request.legs[0];
  const departureDate = toCompactDate(leg.departureDate);
  const returnDate = toCompactDate(leg.returnDate);
  if (!departureDate) {
    throw new Error("Costamar exact search requires departureDate.");
  }

  const itinerary = [
    {
      origin: leg.origin,
      destination: leg.destination,
      date: departureDate,
    },
  ];

  if (request.tripType === "round-trip") {
    if (!returnDate) {
      throw new Error("Costamar round-trip search requires returnDate.");
    }

    itinerary.push({
      origin: leg.destination,
      destination: leg.origin,
      date: returnDate,
    });
  }

  const validationToken = resolveUsableCostamarBrandedToken(context.token, context.terminalId);

  return {
    flightType: request.tripType === "one-way" ? "OW" : "RT",
    terminalId: context.terminalId,
    itinerary,
    passengers: {
      adults: request.passengers.adults,
      children: request.passengers.children,
      infants: request.passengers.infants,
    },
    startDate: toCostamarDayStart(leg.departureDate),
    endDate: toCostamarDayStart(request.tripType === "round-trip" ? leg.returnDate : leg.departureDate),
    ...(validationToken ? { token: validationToken } : {}),
    hasValidationToken: Boolean(validationToken),
    flexible,
  };
}

export function buildCostamarSearchWarning(payload: CostamarSearchResponse): string | undefined {
  const status = payload.status;
  if (typeof status !== "number" || status < 400) {
    return undefined;
  }

  const message = payload.message?.trim();
  if (message) {
    return `Costamar rejected this search (${status}): ${message}`;
  }

  if (status === 401) {
    return "Costamar rejected this search: the branded token is invalid, expired, or no longer belongs to this agency.";
  }

  if (status === 402) {
    return "Costamar rejected this search: the validation token is missing for this branded flow.";
  }

  return `Costamar rejected this search with status ${status}.`;
}

function normalizeSegment(
  value: CostamarSegmentLike,
  idSeed: string,
): Segment | undefined {
  const departureAt = value.departureDateTime;
  const arrivalAt = value.arrivalDateTime;
  const origin = value.departureAirport?.code?.trim().toUpperCase();
  const destination = value.arrivalAirport?.code?.trim().toUpperCase();

  if (!departureAt || !arrivalAt || !origin || !destination) {
    return undefined;
  }

  const marketingCarrier = value.marketingAirline?.code?.trim().toUpperCase() || "XX";
  const rawFlightNumber = String(value.flightNumber ?? "").trim();

  return {
    id: `${idSeed}-${origin}-${destination}-${rawFlightNumber || "0"}`,
    marketingCarrier,
    marketingCarrierName: normalizeAirlineDisplayName(value.marketingAirline?.name) || undefined,
    operatingCarrier: value.operatingAirline?.code?.trim().toUpperCase(),
    operatingCarrierName: normalizeAirlineDisplayName(value.operatingAirline?.name) || undefined,
    flightNumber: rawFlightNumber,
    origin,
    originName: normalizeCostamarAirportCityName(value.departureAirport),
    destination,
    destinationName: normalizeCostamarAirportCityName(value.arrivalAirport),
    departureAt,
    arrivalAt,
    durationMinutes: parseDurationMinutes(value.elapsedTime, departureAt, arrivalAt),
  };
}

function normalizeCostamarAirportCityLabel(value?: string, code?: string): string | undefined {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return undefined;
  }

  const normalizedCode = normalizeIataCode(code);
  const normalizedValue = normalizeIataCode(normalized);
  if (
    /^[A-Z]{3}$/.test(normalizedValue)
    && (!normalizedCode || normalizedValue === normalizedCode)
  ) {
    return undefined;
  }

  if (/^[A-Z]{2}$/.test(normalizedValue)) {
    return undefined;
  }

  return normalized;
}

function normalizeCostamarAirportCityName(airport?: CostamarAirport): string | undefined {
  const code = normalizeIataCode(airport?.code);
  return normalizeCostamarAirportCityLabel(airport?.cityName, code)
    ?? cityNameForIataCode(code)
    ?? normalizeCostamarAirportCityLabel(airport?.name, code);
}

function normalizeItinerary(
  recommendation: CostamarRecommendation,
  direction: "outbound" | "inbound",
  journey: CostamarJourney,
  index: number,
): { itinerary?: Itinerary; rawSegments: CostamarSegmentLike[] } {
  const selectedFlight = asArray(journey.flights)[0];
  if (!selectedFlight) {
    return { rawSegments: [] };
  }

  const flightSegments = asArray(selectedFlight.segments);
  const rawSegments = flightSegments.length > 0
    ? [selectedFlight, ...flightSegments]
    : [selectedFlight];
  const segments = (flightSegments.length > 0 ? flightSegments : [selectedFlight])
    .map((segment, segmentIndex) => normalizeSegment(
      segment,
      `${recommendation.id ?? "recommendation"}-${direction}-${index}-${segmentIndex}`,
    ))
    .filter((segment): segment is Segment => Boolean(segment));

  if (segments.length === 0) {
    return { rawSegments };
  }

  const layoverMinutes = computeLayovers(segments);
  const first = segments[0];
  const last = segments[segments.length - 1];

  return {
    rawSegments,
    itinerary: {
      id: `${recommendation.id ?? "recommendation"}-${direction}-${index}`,
      direction,
      durationMinutes: parseDurationMinutes(
        selectedFlight.elapsedTime,
        first.departureAt,
        last.arrivalAt,
      ),
      stops: Math.max(0, segments.length - 1),
      layoverMinutes,
      segments,
    },
  };
}

function costamarRedirectVerification(
  state: CostamarRedirectState,
  verified: boolean,
  reason?: string,
): RedirectVerification {
  return {
    provider: "costamar",
    state,
    verified,
    ...(reason ? { reason } : {}),
    checkedAt: new Date().toISOString(),
  };
}

function costamarRedirectVerificationFromContext(context: CostamarProviderContext): RedirectVerification {
  const inspection = inspectCostamarBrandedToken(context.token, context.terminalId);
  if (!inspection.hasToken) {
    return costamarRedirectVerification("missing", false, "No redirect token is available.");
  }
  if (!inspection.terminalMatches) {
    return costamarRedirectVerification("blocked", false, "The redirect token belongs to another Costamar terminal.");
  }
  if (inspection.expired) {
    return costamarRedirectVerification("missing", false, "The redirect token is expired.");
  }
  if (inspection.nearExpiry) {
    return costamarRedirectVerification("near_expiry", false, "The redirect token is close to expiry and should be refreshed.");
  }
  if (inspection.opaque) {
    return costamarRedirectVerification("cached_unverified", false, "The redirect token is opaque and requires live validation.");
  }

  return costamarRedirectVerification("fresh_unverified", false, "The redirect token is locally usable but has not been validated against the branded redirect.");
}

function costamarRedirectResponseLooksValid(status: number, location: string, body: string): boolean {
  if (status === 401 || status === 403 || status >= 500) {
    return false;
  }
  if (COSTAMAR_REDIRECT_VERIFY_FAILURE_PATTERN.test(location)
    || COSTAMAR_REDIRECT_VERIFY_FAILURE_PATTERN.test(body)) {
    return false;
  }

  return status >= 200 && status < 400;
}

export async function verifyCostamarRedirectCandidate(
  request: SearchRequest,
  context: CostamarProviderContext,
): Promise<RedirectVerification> {
  const localVerification = costamarRedirectVerificationFromContext(context);
  if (!inspectCostamarBrandedToken(context.token, context.terminalId).usable) {
    return localVerification;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), COSTAMAR_REDIRECT_VERIFY_TIMEOUT_MS);
  try {
    const response = await fetch(buildCostamarBrandedSearchUrl(request, context), {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml",
      },
    });
    const location = response.headers.get("location") ?? "";
    const body = response.status >= 300 && response.status < 400
      ? ""
      : (await response.text().catch(() => "")).slice(0, 4096);
    if (costamarRedirectResponseLooksValid(response.status, location, body)) {
      return costamarRedirectVerification("verified", true, "The branded redirect accepted the token.");
    }

    return costamarRedirectVerification("blocked", false, `The branded redirect rejected the token with HTTP ${response.status}.`);
  } catch (error) {
    return costamarRedirectVerification(
      "fresh_unverified",
      false,
      error instanceof Error ? `Redirect validation failed: ${error.message}` : "Redirect validation failed.",
    );
  } finally {
    clearTimeout(timeout);
  }
}

function redirectStateRequiresRefresh(state: CostamarRedirectState): boolean {
  return state === "missing"
    || state === "near_expiry"
    || state === "refresh_failed"
    || state === "blocked";
}

export function shouldWarnCostamarRedirectUnavailable(
  offerCount: number,
  verification: RedirectVerification,
): boolean {
  return offerCount > 0
    && (verification.state === "missing"
      || verification.state === "refresh_failed"
      || verification.state === "blocked");
}

function buildCostamarRedirectWarning(verification: RedirectVerification): string {
  if (verification.state === "blocked") {
    return `Costamar redirect is blocked: ${verification.reason ?? "token validation failed"}.`;
  }
  if (verification.state === "refresh_failed") {
    return `Costamar redirect token refresh failed: ${verification.reason ?? "no usable token was captured"}.`;
  }

  return COSTAMAR_REDIRECT_SESSION_WARNING;
}

export async function resolveCostamarRedirectForRequest(
  request: SearchRequest,
  seedContext: CostamarProviderContext,
  options: { force?: boolean; validateLive?: boolean; forceOnUnverified?: boolean } = {},
): Promise<CostamarRedirectResolution> {
  let context = resolveLatestCostamarProviderContext(seedContext);
  let redirectVerification = costamarRedirectVerificationFromContext(context);
  const diagnostics = createCostamarWarmupDiagnostics(context);
  lastCostamarWarmupDiagnostics = diagnostics;

  const shouldRefresh = options.force
    || redirectStateRequiresRefresh(redirectVerification.state)
    || (options.forceOnUnverified && !redirectVerification.verified);

  if (shouldRefresh) {
    recordCostamarWarmupStep(diagnostics, "refresh-start", true, redirectVerification.reason);
    const warmed = await warmCostamarRedirectContext(request, context, { force: options.force || options.forceOnUnverified });
    context = warmed;
    const refreshedVerification = costamarRedirectVerificationFromContext(context);
    const inspection = inspectCostamarBrandedToken(context.token, context.terminalId);
    diagnostics.tokenCaptured = inspection.hasToken;
    if (!inspection.usable) {
      redirectVerification = costamarRedirectVerification(
        "refresh_failed",
        false,
        refreshedVerification.reason ?? "No usable redirect token was captured after refresh.",
      );
      recordCostamarWarmupStep(diagnostics, "refresh-result", false, redirectVerification.reason);
    } else {
      redirectVerification = refreshedVerification;
      recordCostamarWarmupStep(diagnostics, "refresh-result", true, redirectVerification.reason);
    }
  }

  if (options.validateLive && inspectCostamarBrandedToken(context.token, context.terminalId).usable) {
    redirectVerification = await verifyCostamarRedirectCandidate(request, context);
    diagnostics.tokenValidated = redirectVerification.verified;
    recordCostamarWarmupStep(diagnostics, "live-validation", redirectVerification.verified, redirectVerification.reason);
    if (!redirectVerification.verified && options.forceOnUnverified && !shouldRefresh) {
      const warmed = await warmCostamarRedirectContext(request, context, { force: true });
      context = warmed;
      redirectVerification = await verifyCostamarRedirectCandidate(request, context);
      diagnostics.tokenCaptured = inspectCostamarBrandedToken(context.token, context.terminalId).hasToken;
      diagnostics.tokenValidated = redirectVerification.verified;
      recordCostamarWarmupStep(diagnostics, "forced-refresh-validation", redirectVerification.verified, redirectVerification.reason);
    }
  }

  const warnings = shouldWarnCostamarRedirectUnavailable(1, redirectVerification)
    ? [buildCostamarRedirectWarning(redirectVerification)]
    : [];

  return {
    context,
    redirectVerification,
    diagnostics,
    warnings,
  };
}

export function buildCostamarPurchasePaths(
  request: SearchRequest,
  context: CostamarProviderContext,
  redirectVerification = costamarRedirectVerificationFromContext(context),
): CanonicalOffer["purchasePaths"] {
  return [
    {
      id: "costamar-search",
      type: "search-redirect",
      provider: "costamar",
      label: "Buscar en Costamar",
      url: buildCostamarBrandedSearchUrl(request, context),
      precision: "exact-search",
      score: 0.9,
      requiresNewTab: true,
      commercialMode: "provider",
      state: "search_redirect",
      redirectVerification,
    },
  ];
}

export function buildCostamarBrandedSearchUrl(
  request: SearchRequest,
  context: CostamarProviderContext,
): string {
  const leg = request.legs[0];
  const base = new URL(`${context.brandBaseUrl.replace(/\/+$/, "")}/`);
  const pathParts = [
    "b",
    leg.origin,
    leg.destination,
    leg.departureDate ?? "",
  ];

  if (request.tripType === "round-trip") {
    pathParts.push(leg.returnDate ?? "");
  }

  pathParts.push(
    String(request.passengers.adults),
    String(request.passengers.children),
    String(request.passengers.infants),
  );

  base.pathname = `${base.pathname.replace(/\/+$/, "")}/${pathParts.join("/")}`;
  return applyCostamarContextToBrandedSearchUrl(base.toString(), context);
}

export function applyCostamarContextToBrandedSearchUrl(
  input: string,
  context: CostamarProviderContext,
): string {
  const branded = new URL(input);
  branded.searchParams.set("terminalId", context.terminalId);
  branded.searchParams.set("lang", context.lang);
  const redirectToken = resolveUsableCostamarBrandedToken(context.token, context.terminalId);
  if (redirectToken) {
    branded.searchParams.set("token", redirectToken);
  } else {
    branded.searchParams.delete("token");
  }

  return branded.toString();
}

function buildLocationsPayload(
  itineraries: Itinerary[],
): Array<{ cityCode?: string; countryCode?: string; date?: number }> {
  return itineraries.map((itinerary) => ({
    cityCode: itinerary.segments[0]?.origin ?? "",
    countryCode: "",
    date: toCostamarDayStartMs(itinerary.segments[0]?.departureAt?.slice(0, 10)),
  }));
}

function buildMarkupFlightsPayload(
  recommendation: CostamarRecommendation,
): Array<Record<string, unknown>> {
  return asArray(recommendation.itinerary).flatMap((journey, index) => {
    const selectedFlight = asArray(journey.flights)[0];
    if (!selectedFlight) {
      return [];
    }

    const segments: CostamarSegmentLike[] = asArray(selectedFlight.segments).length > 0
      ? asArray(selectedFlight.segments)
      : [selectedFlight];
    const normalizedSegments = segments.map((segment) => ({
      bookingClass: typeof segment.bookingClass === "string"
        ? segment.bookingClass
        : segment.bookingClass?.code,
      fareBasisCode: segment.fareBasisCode,
      marketingAirline: {
        code: segment.marketingAirline?.code,
      },
      operatingAirline: {
        code: segment.operatingAirline?.code ?? segment.marketingAirline?.code,
      },
      flightNumber: segment.flightNumber,
      cabinType: segment.cabinType,
    }));

    return [{
      segments: normalizedSegments,
      duration: parseDurationMinutes(selectedFlight.elapsedTime),
      refNumber: index,
    }];
  });
}

function shouldApplyCostamarBaggageMarkup(
  recommendation: CostamarRecommendation,
): boolean {
  const firstFlight = asArray(asArray(recommendation.itinerary)[0]?.flights)[0];
  if (!firstFlight || firstFlight.marketingAirline?.code === "VV") {
    return false;
  }

  const baggage = firstFlight.baggage as Record<string, unknown> | undefined;
  if (!baggage) {
    return false;
  }

  return String(baggage.pieces ?? "") !== "0";
}

function buildMarkupRequest(
  engine: CostamarEngineMetadata,
  request: SearchRequest,
  recommendation: CostamarRecommendation,
  itineraries: Itinerary[],
): Record<string, unknown> {
  const passengerTypes: string[] = ["ADT"];

  if (request.passengers.children > 0) {
    passengerTypes.push("CHD");
  }
  if (request.passengers.infants > 0) {
    passengerTypes.push("INF");
  }

  return {
    engineCode: engine.code ?? request.providerId ?? "costamar",
    profileId: engine.profile?.id,
    locations: buildLocationsPayload(itineraries),
    passengersQuantity: request.passengers.adults + request.passengers.children + request.passengers.infants,
    passengersType: passengerTypes,
    flights: buildMarkupFlightsPayload(recommendation),
    applyBaggage: shouldApplyCostamarBaggageMarkup(recommendation),
    tripType: request.tripType === "one-way" ? "OW" : "RT",
    routeType: recommendation.pricing?.fareQualifier,
    fareType: recommendation.pricing?.source === "PRIVATE"
      ? "PRIVATED"
      : recommendation.pricing?.source,
    validatingAirline: recommendation.pricing?.validatingAirline,
    validatingGds: recommendation.pos?.systemProviderCode,
  };
}

function buildCostamarPassengerFareBreakdowns(
  recommendation: CostamarRecommendation,
  request: SearchRequest,
): Array<{
  code: "ADT" | "CHD" | "INF";
  passengerFare: {
    base: number;
    total: number;
  };
  quantity: number;
}> {
  const passengers = recommendation.pricing?.passengers;
  return [
    {
      code: "ADT" as const,
      passengerFare: {
        base: numberValue(passengers?.adults?.base) ?? 0,
        total: numberValue(passengers?.adults?.total) ?? 0,
      },
      quantity: request.passengers.adults,
    },
    {
      code: "CHD" as const,
      passengerFare: {
        base: numberValue(passengers?.children?.base) ?? 0,
        total: numberValue(passengers?.children?.total) ?? 0,
      },
      quantity: request.passengers.children,
    },
    {
      code: "INF" as const,
      passengerFare: {
        base: numberValue(passengers?.infants?.base) ?? 0,
        total: numberValue(passengers?.infants?.total) ?? 0,
      },
      quantity: request.passengers.infants,
    },
  ].filter((entry) => entry.quantity > 0);
}

function computeCostamarMarkupValue(
  markup: CostamarMarkupApplied,
  recommendation: CostamarRecommendation,
  request: SearchRequest,
): number {
  const markupAmount = numberValue(markup.amount?.value);
  if (typeof markupAmount !== "number") {
    return 0;
  }

  const pricing = recommendation.pricing ?? {};
  const totalAmount = numberValue(pricing.total) ?? numberValue(pricing.totalAmount) ?? 0;
  if (markup.amount?.perBooking) {
    if (markup.amount?.percentage) {
      return roundMoneyAmount((roundMoneyAmount(totalAmount) * markupAmount) / 100);
    }

    return roundMoneyAmount(markupAmount);
  }

  const passengerTypes = asArray(markup.amount?.passengersType).map((value) => String(value));
  let computed = 0;

  buildCostamarPassengerFareBreakdowns(recommendation, request).forEach((breakdown) => {
    if (passengerTypes.length > 0 && !passengerTypes.includes(breakdown.code)) {
      return;
    }

    if (markup.amount?.percentage) {
      const baseValue = markup.amount?.appliesToBase
        ? breakdown.passengerFare.base
        : breakdown.passengerFare.total;
      computed += roundMoneyAmount((roundMoneyAmount(baseValue) * markupAmount) / 100) * breakdown.quantity;
      return;
    }

    computed += markupAmount * breakdown.quantity;
  });

  return roundMoneyAmount(computed);
}

function resolveCostamarMarkupError(markupResponse: CostamarMarkupResponse): string | undefined {
  if (typeof markupResponse.error === "string") {
    return markupResponse.error.trim() || undefined;
  }

  if (typeof markupResponse.error?.message === "string") {
    return markupResponse.error.message.trim() || undefined;
  }

  return undefined;
}

function sumCostamarMarkupTotals(
  markupResponse: CostamarMarkupResponse,
  recommendation: CostamarRecommendation,
  request: SearchRequest,
): number {
  return [
    ...asArray(markupResponse.markupsApplied),
    ...asArray(markupResponse.customMarkupApplied),
  ].reduce((sum, markup) => sum + computeCostamarMarkupValue(markup, recommendation, request), 0);
}

async function applyMarkupToOffer(
  context: CostamarProviderContext,
  engine: CostamarEngineMetadata,
  request: SearchRequest,
  recommendation: CostamarRecommendation,
  offer: CanonicalOffer,
  rawSegments: CostamarSegmentLike[],
): Promise<CanonicalOffer> {
  if (!engine.profile?.id || rawSegments.length === 0) {
    return offer;
  }

  try {
    const markupResponse = await fetchCostamarJson<CostamarMarkupResponse>(
      context,
      "/flights/markups/apply",
      {
        method: "POST",
        body: JSON.stringify(buildMarkupRequest(engine, request, recommendation, offer.itineraries)),
      },
      "Costamar markup apply",
    );

    const markups = sumCostamarMarkupTotals(markupResponse, recommendation, request);
    const markupError = resolveCostamarMarkupError(markupResponse);
    if (markups <= 0) {
      return markupError
        ? {
            ...offer,
            warnings: [
              ...offer.warnings,
              `Costamar markup omitted: ${markupError}`,
            ],
          }
        : offer;
    }

    const total = roundMoneyAmount(offer.price.total.amount + markups);
    return {
      ...offer,
      id: buildCostamarOfferId(offer.signature, total, offer.price.total.currencyCode),
      price: {
        ...offer.price,
        total: {
          ...offer.price.total,
          amount: total,
        },
      },
    };
  } catch (error) {
    return {
      ...offer,
      warnings: [
        ...offer.warnings,
        error instanceof Error
          ? `Costamar markup omitted: ${error.message}`
          : "Costamar markup omitted.",
      ],
    };
  }
}

export function mapCostamarRecommendationToOffer(
  recommendation: CostamarRecommendation,
  request: SearchRequest,
  context: CostamarProviderContext,
  engine: CostamarEngineMetadata,
  redirectVerification = costamarRedirectVerificationFromContext(context),
): { offer?: CanonicalOffer; rawSegments: CostamarSegmentLike[] } {
  const journeys = asArray(recommendation.itinerary);
  const outboundNormalized = normalizeItinerary(recommendation, "outbound", journeys[0] ?? {}, 0);
  if (!outboundNormalized.itinerary) {
    return { rawSegments: [] };
  }

  const inboundNormalized = request.tripType === "round-trip"
    ? normalizeItinerary(recommendation, "inbound", journeys[1] ?? {}, 1)
    : { rawSegments: [] as CostamarSegmentLike[] };
  if (request.tripType === "round-trip" && !inboundNormalized.itinerary) {
    return { rawSegments: [] };
  }

  const itineraries = request.tripType === "round-trip"
    ? [outboundNormalized.itinerary, inboundNormalized.itinerary].filter((entry): entry is Itinerary => Boolean(entry))
    : [outboundNormalized.itinerary];
  const maxStops = typeof request.filters.maxStops === "number"
    ? Math.max(0, request.filters.maxStops)
    : undefined;
  if (typeof maxStops === "number" && maxStopsAcrossItineraries(itineraries) > maxStops) {
    return { rawSegments: [] };
  }

  const pricing = recommendation.pricing ?? {};
  const currencyCode = resolveCostamarOfferCurrencyCode(request, engine);
  const totalAmount = numberValue(pricing.total) ?? numberValue(pricing.totalAmount);
  if (typeof totalAmount !== "number") {
    return { rawSegments: [] };
  }

  const baggage = buildBaggageSummaryFromSegments([
    ...outboundNormalized.rawSegments,
    ...inboundNormalized.rawSegments,
  ]);
  const firstSegment = outboundNormalized.itinerary.segments[0];
  const offer: CanonicalOffer = {
    id: "",
    signature: "",
    providerSource: "costamar",
    providerOfferRef: String(recommendation.id ?? sha1Hex(JSON.stringify(recommendation))),
    tripType: request.tripType,
    validatingCarrier: pricing.validatingAirline ?? firstSegment.marketingCarrier,
    mainCarrier: firstSegment.marketingCarrier,
    origin: firstSegment.origin,
    destination: outboundNormalized.itinerary.segments[outboundNormalized.itinerary.segments.length - 1]?.destination ?? request.legs[0].destination,
    itineraries,
    price: {
      total: {
        amount: Number(totalAmount.toFixed(2)),
        currencyCode,
      },
      base: money(numberValue(pricing.base), currencyCode),
      taxes: money(numberValue(pricing.taxes), currencyCode),
    },
    baggage,
    fareMeta: {
      seatsRemaining: undefined,
      lastTicketingDate: undefined,
      refundable: undefined,
      changeable: undefined,
    } satisfies FareMeta,
    priceConfidence: "live",
    priceStatus: "unverified",
    purchasePaths: buildCostamarPurchasePaths(request, context, redirectVerification),
    redirectVerification,
    comparisonMetrics: {
      totalDurationMinutes: 0,
      totalStops: 0,
      baggageScore: 0,
      purchasePathScore: 0,
    },
    tags: uniqueStrings([
      pricing.fareQualifier ? String(pricing.fareQualifier).toLowerCase() : "",
      pricing.source ? String(pricing.source).toLowerCase() : "",
    ]),
    warnings: [],
    rawRefs: {
      recommendationId: recommendation.id,
      pos: recommendation.pos,
    },
  };

  const signature = buildOfferSignature(offer);

  return {
    rawSegments: [...outboundNormalized.rawSegments, ...inboundNormalized.rawSegments],
    offer: {
      ...offer,
      signature,
      id: buildCostamarOfferId(signature, offer.price.total.amount, currencyCode),
    },
  };
}

async function searchRecommendations(
  request: SearchRequest,
  providerContext?: ProviderContext,
  flexible = false,
): Promise<CostamarSearchOutcome> {
  const baseContext = getCostamarProviderContext(providerContext);
  const redirectResolution = await resolveCostamarRedirectForRequest(
    request,
    resolveLatestCostamarProviderContext(baseContext),
    { validateLive: false },
  );
  let redirectContext = redirectResolution.context;
  let redirectVerification = redirectResolution.redirectVerification;

  const context = resolveUsableCostamarBrandedToken(redirectContext.token, redirectContext.terminalId)
    ? {
        ...baseContext,
        terminalId: redirectContext.terminalId,
        token: redirectContext.token,
        lang: redirectContext.lang,
      }
    : baseContext;

  ensureCostamarCredentials(context);

  const engine = await getEngineMetadata(context);
  const search = (searchContext: CostamarProviderContext) => fetchCostamarJson<CostamarSearchResponse>(
    searchContext,
    "/flights/search",
    {
      method: "POST",
      body: JSON.stringify(buildCostamarSearchBody(request, searchContext, flexible)),
    },
    "Costamar flight search",
  );

  let payload = await search(context);
  let tokenSearchRejected = false;
  if (
    context.token
    && (payload.status === 401 || payload.status === 402)
  ) {
    tokenSearchRejected = true;
    const fallbackPayload = await search({
      ...context,
      token: "",
    });
    if (typeof fallbackPayload.status !== "number" || fallbackPayload.status < 400) {
      payload = fallbackPayload;
    }
  }

  if (tokenSearchRejected) {
    const forcedRedirect = await resolveCostamarRedirectForRequest(request, redirectContext, {
      force: true,
      validateLive: false,
    });
    redirectContext = forcedRedirect.context;
    redirectVerification = forcedRedirect.redirectVerification;
  }

  const responseWarning = buildCostamarSearchWarning(payload);
  const recommendations = responseWarning ? [] : asArray(payload.data);
  const mapped = await mapConcurrent(recommendations, COSTAMAR_CONCURRENCY.markup, async (recommendation) => {
    const normalized = mapCostamarRecommendationToOffer(
      recommendation,
      request,
      redirectContext,
      engine,
      redirectVerification,
    );
    if (!normalized.offer) {
      return undefined;
    }

    return applyMarkupToOffer(
      context,
      engine,
      request,
      recommendation,
      normalized.offer,
      normalized.rawSegments,
    );
  });

  const offers = dedupeCostamarOffers(mapped.filter((offer): offer is CanonicalOffer => Boolean(offer)));
  const redirectWarning = shouldWarnCostamarRedirectUnavailable(offers.length, redirectVerification)
    ? buildCostamarRedirectWarning(redirectVerification)
    : undefined;
  const warnings = uniqueStrings([
    ...(responseWarning ? [responseWarning] : []),
    ...(redirectWarning ? [redirectWarning] : []),
    ...offers.flatMap((offer) => offer.warnings),
  ]);

  if (offers.length === 0 && warnings.length === 0) {
    warnings.push("Costamar returned no offers for this search.");
  }

  return {
    offers,
    warnings,
  };
}

export async function searchLocalCostamarExact(
  request: SearchRequest,
  providerContext?: ProviderContext,
): Promise<ProviderSearchResult> {
  if (request.searchMode === "stay-range") {
    return searchLocalCostamarRange(request, providerContext);
  }

  const outcome = await searchRecommendations(request, providerContext, false);
  return {
    offers: outcome.offers,
    warnings: outcome.warnings,
    partial: false,
  };
}

export function createLocalCostamarSearchDraft(
  request: SearchRequest,
  providerMeta: ProviderMeta,
): SearchResponse {
  const requestedAt = new Date().toISOString();
  const warning = request.searchMode === "stay-range"
    ? "Consultando Costamar en paralelo. Los resultados se iran agregando."
    : "Consultando Costamar. Los resultados se iran agregando.";

  return {
    offers: [],
    allOffers: [],
    searchMeta: {
      requestedAt,
      completedAt: requestedAt,
      providersUsed: ["costamar"],
      warnings: [warning],
      partial: true,
      searchState: "search_partial",
    },
    providerMeta,
    warnings: [warning],
  };
}

export async function resolveLocalCostamarExactProgressive(
  request: SearchRequest,
  providerContext?: ProviderContext,
  onUpdate?: (result: ProviderSearchResult) => boolean | void,
): Promise<ProviderSearchResult> {
  const result = await searchLocalCostamarExact({
    ...request,
    searchMode: "exact",
  }, providerContext);
  onUpdate?.({
    ...result,
    partial: true,
  });
  return result;
}

function enumerateRangeRequests(request: SearchRequest): SearchRequest[] {
  return enumerateUsefulFlexibleRequests(request);
}

export async function searchLocalCostamarRange(
  request: SearchRequest,
  providerContext?: ProviderContext,
): Promise<ProviderSearchResult> {
  const candidates = enumerateRangeRequests(request);
  const outcomes = await mapConcurrent(candidates, COSTAMAR_CONCURRENCY.rangeSearch, async (derivedRequest) => {
    try {
      return {
        result: await searchLocalCostamarExactWithRetry(derivedRequest, providerContext),
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Costamar range search failed.",
      };
    }
  });

  const warnings = uniqueStrings([
    ...outcomes.flatMap((outcome) => outcome.result?.warnings ?? []),
    ...outcomes.flatMap((outcome) => outcome.error ? [outcome.error] : []),
  ]);
  const offers = dedupeCostamarOffers(
    outcomes.flatMap((outcome) => outcome.result?.offers ?? []),
  );

  if (offers.length === 0 && warnings.length === 0) {
    warnings.push("Costamar returned no offers for this date range.");
  }

  return {
    offers,
    warnings,
    partial: outcomes.some((outcome) => Boolean(outcome.error)),
  };
}

export async function resolveLocalCostamarRangeProgressive(
  request: SearchRequest,
  providerContext?: ProviderContext,
  onUpdate?: (result: ProviderSearchResult) => boolean | void,
): Promise<ProviderSearchResult> {
  const candidates = enumerateRangeRequests(request);
  const aggregatedOffers: CanonicalOffer[] = [];
  const warnings: string[] = [];
  let partial = false;
  let stopRequested = false;

  await mapConcurrent(candidates, COSTAMAR_CONCURRENCY.rangeSearch, async (derivedRequest) => {
    try {
      const result = await searchLocalCostamarExactWithRetry(derivedRequest, providerContext);
      aggregatedOffers.push(...result.offers);
      warnings.push(...result.warnings);
    } catch (error) {
      partial = true;
      warnings.push(error instanceof Error ? error.message : "Costamar range search failed.");
    }

    if (onUpdate?.({
      offers: dedupeCostamarOffers(aggregatedOffers),
      warnings: uniqueStrings(warnings),
      partial: true,
    }) === false) {
      stopRequested = true;
    }
  }, {
    canContinue: () => !stopRequested,
  });

  const offers = dedupeCostamarOffers(aggregatedOffers);
  const finalWarnings = uniqueStrings(warnings);
  if (offers.length === 0 && finalWarnings.length === 0) {
    finalWarnings.push("Costamar returned no offers for this date range.");
  }

  return {
    offers,
    warnings: finalWarnings,
    partial: partial || stopRequested,
  };
}

export function createLocalCostamarMatrixDraft(
  request: SearchRequest,
  providerMeta: ProviderMeta,
): MatrixResponse {
  const leg = request.legs[0];
  if (!leg.departureStart || !leg.departureEnd) {
    throw new Error("Costamar matrix requires departureStart and departureEnd.");
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
        providerSource: "costamar" as const,
        selectable: false,
        requiresRequery: true,
        stateCode: "ind" as const,
        tooltip: "Consultando Costamar...",
        derivedRequest: buildDerivedOneWayRequest(request, departureDate),
      } satisfies MatrixCell))
    : pairs.map(({ departureDate, returnDate }) => ({
        key: `${departureDate}_${returnDate}`,
        departureDate,
        returnDate,
        stayNights: diffDays(departureDate, returnDate),
        confidence: "loading" as const,
        providerSource: "costamar" as const,
        selectable: false,
        requiresRequery: true,
        stateCode: "ind" as const,
        tooltip: "Consultando Costamar...",
        derivedRequest: buildDerivedRequest(request, departureDate, returnDate),
      } satisfies MatrixCell));

  return {
    cells,
    axes,
    confidenceSummary: buildMatrixConfidenceSummary(cells),
    recommendations: [
      "Matrix loading from Costamar with useful date combinations only.",
      "Only valid flexible combinations are materialized for Costamar.",
    ],
    searchMeta: {
      requestedAt,
      completedAt: requestedAt,
      providersUsed: ["costamar"],
      warnings: ["Matrix loading from Costamar with useful date combinations only."],
      partial: true,
      searchState: "search_partial",
    },
    providerMeta,
    warnings: ["Matrix loading from Costamar with useful date combinations only."],
  };
}

function spansExactFlexibleWindow(start?: string, end?: string): boolean {
  return Boolean(start && end && diffDays(start, end) === 6);
}

export function matchesCostamarNativeFlexibleWindow(request: SearchRequest): boolean {
  const leg = request.legs[0];
  if (request.tripType !== "round-trip") {
    return false;
  }

  return spansExactFlexibleWindow(leg.departureStart, leg.departureEnd)
    && spansExactFlexibleWindow(leg.returnStart, leg.returnEnd);
}

async function seedMatrixWithFlexibleSearch(
  request: SearchRequest,
  providerContext?: ProviderContext,
): Promise<Map<string, CanonicalOffer>> {
  if (!matchesCostamarNativeFlexibleWindow(request)) {
    return new Map();
  }

  const leg = request.legs[0];
  const seedRequest: SearchRequest = {
    ...request,
    searchMode: "exact",
    legs: [
      {
        ...leg,
        departureDate: leg.departureStart ? enumerateRange(leg.departureStart, leg.departureEnd ?? leg.departureStart)[3] : undefined,
        returnDate: leg.returnStart ? enumerateRange(leg.returnStart, leg.returnEnd ?? leg.returnStart)[3] : undefined,
      },
    ],
  };
  const search = await searchRecommendations(seedRequest, providerContext, true);
  const byKey = new Map<string, CanonicalOffer>();

  for (const offer of search.offers) {
    const outbound = offer.itineraries.find((itinerary) => itinerary.direction === "outbound") ?? offer.itineraries[0];
    const inbound = offer.itineraries.find((itinerary) => itinerary.direction === "inbound");
    const departureDate = outbound?.segments[0]?.departureAt?.slice(0, 10);
    const returnDate = inbound?.segments[0]?.departureAt?.slice(0, 10);

    if (!departureDate || !returnDate) {
      continue;
    }

    if (!isUsefulRoundTripCombination(request, departureDate, returnDate)) {
      continue;
    }

    const key = `${departureDate}_${returnDate}`;
    const existing = byKey.get(key);
    if (!existing || offer.price.total.amount < existing.price.total.amount) {
      byKey.set(key, offer);
    }
  }

  return byKey;
}

function buildMatrixCellFromOffer(
  cell: MatrixCell & { derivedRequest: SearchRequest; confidence: "loading" },
  offer: CanonicalOffer,
  providerContext?: ProviderContext,
): MatrixCell {
  const purchasePaths = offer.purchasePaths.length > 0
    ? offer.purchasePaths
    : providerContext?.costamar
      ? buildCostamarPurchasePaths(cell.derivedRequest, providerContext.costamar)
      : [];

  return {
    ...cell,
    price: {
      amount: offer.price.total.amount,
      currencyCode: offer.price.total.currencyCode,
    },
    variantKey: buildOfferVariantGroupKey(offer),
    purchasePaths,
    offer: {
      ...offer,
      purchasePaths,
    },
    confidence: "live",
    selectable: true,
    stateCode: "live",
    tooltip: "Costamar live search.",
  };
}

async function resolveCellPrice(
  derivedRequest: SearchRequest,
  providerContext?: ProviderContext,
): Promise<CanonicalOffer | undefined> {
  const search = await searchLocalCostamarExact(derivedRequest, providerContext);
  const offers = enrichComparisonMetrics(search.offers);

  return offers.reduce<CanonicalOffer | undefined>((best, current) => {
    if (!best || compareByPriceThenDuration(current, best) < 0) {
      return current;
    }

    return best;
  }, undefined);
}

export async function resolveLocalCostamarMatrixProgressive(
  request: SearchRequest,
  providerContext: ProviderContext | undefined,
  draft: MatrixResponse,
  onCellResolved?: (cell: MatrixCell) => boolean | void,
): Promise<MatrixResponse> {
  let partial = false;
  let stopRequested = false;
  const seeded = await seedMatrixWithFlexibleSearch(request, providerContext).catch(() => new Map<string, CanonicalOffer>());
  const seededKeys = new Set<string>();
  const seededCells = draft.cells.map((cell) => {
    if (cell.confidence !== "loading" || !cell.derivedRequest) {
      return cell;
    }

    const seededOffer = seeded.get(cell.key);
    if (!seededOffer) {
      return cell;
    }

    seededKeys.add(cell.key);
    const nextCell = buildMatrixCellFromOffer(
      cell as MatrixCell & { derivedRequest: SearchRequest; confidence: "loading" },
      seededOffer,
      providerContext,
    );
    if (onCellResolved?.(nextCell) === false) {
      stopRequested = true;
    }
    return nextCell;
  });

  const prioritizedCells = prioritizeMatrixLoadingCells(seededCells, draft.axes, request.tripType)
    .filter((cell) => !stopRequested && !seededKeys.has(cell.key));
  const resolvedLoadingCells = await mapConcurrent(prioritizedCells, COSTAMAR_CONCURRENCY.matrixCell, async (cell) => {
    try {
      const offer = await resolveCellPrice(cell.derivedRequest, providerContext);
      const nextCell = offer
        ? buildMatrixCellFromOffer(cell, offer, providerContext)
        : {
            ...cell,
            confidence: "unavailable" as const,
            selectable: false,
            stateCode: "chg" as const,
            tooltip: "Costamar returned no live result for this combination.",
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
          ? `Costamar error: ${error.message}`
          : "Costamar error while resolving this combination.",
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
  const resolvedCells = seededCells.map((cell) => resolvedByKey.get(cell.key) ?? cell);
  const warnings = partial
    ? ["Matrix finished with partial Costamar failures."]
    : [seeded.size > 0
        ? "Matrix seeded from Costamar native flexible search and completed with exact searches."
        : "Matrix built from Costamar exact searches over useful date combinations."];

  return {
    ...draft,
    cells: resolvedCells,
    confidenceSummary: buildMatrixConfidenceSummary(resolvedCells),
    recommendations: [
      "Matrix keeps only useful date combinations based on the requested stay window.",
      seeded.size > 0
        ? "Costamar native flexible search was used as a seed before exact lookups."
        : "Selecting a cell runs a full Costamar exact search for offers.",
    ],
    searchMeta: {
      requestedAt: draft.searchMeta.requestedAt,
      completedAt: new Date().toISOString(),
      providersUsed: ["costamar"],
      warnings,
      partial,
      searchState: partial ? "search_partial" : "search_live",
    },
    warnings,
  };
}

export async function buildLocalCostamarMatrix(
  request: SearchRequest,
  providerContext: ProviderContext | undefined,
  providerMeta: ProviderMeta,
): Promise<MatrixResponse> {
  const draft = createLocalCostamarMatrixDraft(request, providerMeta);
  return resolveLocalCostamarMatrixProgressive(request, providerContext, draft);
}

function mapLocationSuggestion(
  entry: CostamarAutocompleteAirport,
): LocationSuggestion | undefined {
  const code = entry.code?.trim().toUpperCase();
  const city = entry.cityName?.trim();
  const countryCode = entry.countryCode?.trim().toUpperCase();
  const label = entry.name?.trim();
  if (!code || !city || !countryCode || !label) {
    return undefined;
  }

  return {
    code,
    city,
    country: countryCode,
    countryCode,
    cityCode: entry.cityCode?.trim().toUpperCase(),
    searchType: entry.type?.trim(),
    label,
  };
}

export async function suggestLocalCostamarLocations(
  query: string,
  limit = 8,
): Promise<LocationSuggestion[]> {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length < 1) {
    return [];
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), COSTAMAR_HTTP_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${COSTAMAR_AIR_API_BASE_URL}/autocomplete/airports/search?language=es&query=${encodeURIComponent(normalizedQuery)}`,
      {
        headers: {
          accept: "application/json, text/plain, */*",
        },
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      throw new Error(`Costamar location suggest failed: ${response.status} ${response.statusText}`);
    }

    const payload = await response.json() as CostamarAutocompleteResponse;
    const suggestions = asArray(payload.airports)
      .map((entry) => mapLocationSuggestion(entry))
      .filter((entry): entry is LocationSuggestion => Boolean(entry));

    return rankLocationSuggestions(normalizedQuery, suggestions, limit);
  } finally {
    clearTimeout(timeout);
  }
}
