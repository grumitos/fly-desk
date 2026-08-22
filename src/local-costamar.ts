import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import { normalizeLocationSuggestionType } from "./core/location-suggestion";
import {
  buildMatrixConfidenceSummary,
  mapConcurrent,
  prioritizeMatrixLoadingCells,
} from "./core/matrix";
import { buildOfferSignature } from "./core/offer-signature";
import { parseProviderAmount } from "./core/provider-money";
import { PROVIDER_OFFER_VARIANT_LIMIT, takeProviderOfferVariants } from "./core/provider-offer-limits";
import { buildOfferVariantGroupKey } from "./core/variant-group-key";
import { ProviderSearchResult } from "./core/provider";
import { enrichComparisonMetrics, totalDuration } from "./core/ranking";
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
import { providerPublicFailureMessage } from "./provider-status";
import { openUrlLocally } from "./local-browser";
import {
  resolveMatrixCellConcurrency,
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
import {
  buildCostamarB2bWarmupPayload,
  buildCostamarSearchBody,
  type CostamarB2bFlightWarmupPayload,
} from "./providers/costamar/search-payloads";

export { buildCostamarB2bWarmupPayload, buildCostamarSearchBody };

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
  scheduleGroupScope?: string;
  scheduleVariantsTruncated?: boolean;
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
  pricedItineraries?: {
    pricedItinerary?: CbPlusPricedItinerary | CbPlusPricedItinerary[];
  };
}

interface CbPlusAirport {
  locationCode?: string;
  code?: string;
  codeContext?: string;
}

interface CbPlusAirline {
  code?: string;
  companyShortName?: string;
  name?: string;
}

interface CbPlusBookingClassAvail {
  resBookDesigCode?: string;
  code?: string;
}

interface CbPlusFlightSegment {
  id?: string;
  departureAirport?: CbPlusAirport;
  arrivalAirport?: CbPlusAirport;
  departureDateTime?: string | { value?: string };
  arrivalDateTime?: string | { value?: string };
  elapsedTime?: string | number;
  marketingAirline?: CbPlusAirline;
  operatingAirline?: CbPlusAirline;
  flightNumber?: string | number;
  fareBasisCode?: string;
  bookingClass?: string | { code?: string };
  bookingClassAvails?: Array<{
    bookingClassAvail?: CbPlusBookingClassAvail | CbPlusBookingClassAvail[];
  }>;
  cabinType?: string;
  tpaextensions?: unknown;
  tpaExtensions?: unknown;
  baggage?: unknown;
  handBaggage?: unknown;
}

interface CbPlusOriginDestinationOption {
  refNumber?: string | number;
  rph?: string | number;
  flightSegment?: CbPlusFlightSegment | CbPlusFlightSegment[];
}

interface CbPlusPricedItinerary {
  id?: string | number;
  sequenceNumber?: string | number;
  airItinerary?: {
    originDestinationOptions?: {
      originDestinationOption?: CbPlusOriginDestinationOption | CbPlusOriginDestinationOption[];
    };
  };
  airItineraryPricingInfo?: Record<string, unknown>;
  ticketingInfo?: {
    pricingSystem?: {
      code?: string;
      codeContext?: string;
      pseudoCityCode?: string;
    };
    pseudoCityCode?: string;
  };
}

export interface CostamarAutocompleteAirport {
  code?: string;
  countryCode?: string;
  cityCode?: string;
  cityName?: string;
  type?: string;
  name?: string;
}

interface CostamarSearchOutcome {
  offers: CanonicalOffer[];
  warnings: string[];
  partial: boolean;
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

function cbPlusEnv(primaryName: string, legacyName: string): string | undefined {
  return process.env[primaryName]?.trim() || process.env[legacyName]?.trim() || undefined;
}

const COSTAMAR_HTTP_TIMEOUT_MS = Math.max(
  5000,
  Number(cbPlusEnv("CBPLUS_HTTP_TIMEOUT_MS", "COSTAMAR_HTTP_TIMEOUT_MS") ?? 20000),
);
const COSTAMAR_AIR_API_BASE_URL = process.env.CBPLUS_AIR_API_BASE_URL?.trim()
  || process.env.COSTAMAR_AIR_API_BASE_URL?.trim()
  || "https://api-zneith.zdev.tech/api-air-0.1";
const COSTAMAR_REDIRECT_SESSION_WARNING =
  "Click and Book Plus redirect token is missing, expired, or incompatible with this terminal.";
const COSTAMAR_SESSION_WARMUP_POLL_MS = 500;
const COSTAMAR_REDIRECT_VERIFY_TIMEOUT_MS = Math.max(
  1500,
  Number(cbPlusEnv("CBPLUS_REDIRECT_VERIFY_TIMEOUT_MS", "COSTAMAR_REDIRECT_VERIFY_TIMEOUT_MS") ?? 6000),
);
const COSTAMAR_REDIRECT_VERIFY_FAILURE_PATTERN =
  /login|iniciar\s+sesi[oó]n|google\s+authenticator|auth(?:entication|orization)?\s*(?:required|failed|failure|error)|(?:required|failed|failure|error)\s+auth(?:entication|orization)?|otp|captcha|expired|expirad|invalid|inv[aá]lid|unauthorized|forbidden/i;
const COSTAMAR_B2B_KEYSTROKE_DELAY_MS = 35;
const COSTAMAR_PAGE_SNAPSHOT_HTML_MAX_CHARS = 64 * 1024;
const COSTAMAR_PAGE_STORAGE_MAX_ENTRIES = 50;
const COSTAMAR_PAGE_STORAGE_VALUE_MAX_CHARS = 4096;
const DEFAULT_COSTAMAR_B2B_BASE_URL = "https://b2b.clickandbook.com/lang/es/b2b";
const COSTAMAR_B2B_ALLOWED_ORIGINS = new Set(["https://b2b.clickandbook.com"]);
const DEFAULT_CHROME_USER_DATA_DIR = join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "User Data");

const pendingCostamarSessionWarmups = new Map<string, Promise<CostamarProviderContext>>();
const recentCostamarSessionWarmups = new Map<string, number>();
let costamarWarmupOpener: typeof openUrlLocally = openUrlLocally;
/*
 * How long the browser fallback lets Chrome settle between the B2B page and the
 * branded one. A real Chrome needs the pause; a stubbed opener writes its
 * artifact synchronously and only pays for it, so tests may shorten it. The
 * default is the production value and nothing outside a test changes it.
 */
const COSTAMAR_WARMUP_BROWSER_SETTLE_MS = 750;
let costamarWarmupBrowserSettleMs = COSTAMAR_WARMUP_BROWSER_SETTLE_MS;
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
    return resolveMatrixCellConcurrency(["CBPLUS_MATRIX_CELL_CONCURRENCY", "COSTAMAR_MATRIX_CELL_CONCURRENCY"]);
  },
  get rangeSearch() {
    return resolveRangeSearchConcurrency(["CBPLUS_RANGE_SEARCH_CONCURRENCY", "COSTAMAR_RANGE_SEARCH_CONCURRENCY"]);
  },
  httpTimeoutMs: COSTAMAR_HTTP_TIMEOUT_MS,
});
const COSTAMAR_RANGE_DAY_RETRY_ATTEMPTS = Math.max(
  0,
  Math.trunc(Number(cbPlusEnv("CBPLUS_RANGE_DAY_RETRY_ATTEMPTS", "COSTAMAR_RANGE_DAY_RETRY_ATTEMPTS") ?? 1)) || 0,
);
const COSTAMAR_RANGE_DAY_RETRY_DELAY_MS = Math.max(
  0,
  Math.trunc(Number(cbPlusEnv("CBPLUS_RANGE_DAY_RETRY_DELAY_MS", "COSTAMAR_RANGE_DAY_RETRY_DELAY_MS") ?? 250)) || 0,
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
  return String(cbPlusEnv("CBPLUS_SESSION_WARMUP_ENABLED", "COSTAMAR_SESSION_WARMUP_ENABLED") ?? "1").trim() !== "0";
}

function costamarSessionWarmupTimeoutMs(): number {
  return Math.max(0, Number(cbPlusEnv("CBPLUS_SESSION_WARMUP_TIMEOUT_MS", "COSTAMAR_SESSION_WARMUP_TIMEOUT_MS") ?? 8000));
}

function costamarSessionWarmupOpenBrowserFallbackEnabled(): boolean {
  return String(cbPlusEnv("CBPLUS_SESSION_WARMUP_OPEN_BROWSER_FALLBACK", "COSTAMAR_SESSION_WARMUP_OPEN_BROWSER_FALLBACK") ?? "0").trim() !== "0";
}

function costamarSessionWarmupCooldownMs(): number {
  return Math.max(
    costamarSessionWarmupTimeoutMs(),
    Number(cbPlusEnv("CBPLUS_SESSION_WARMUP_COOLDOWN_MS", "COSTAMAR_SESSION_WARMUP_COOLDOWN_MS") ?? 30000),
  );
}

function canWarmCostamarSession(request: SearchRequest): boolean {
  return request.redirectMode !== "none" && costamarSessionWarmupEnabled();
}

function resolveCostamarChromeLaunchOptions(): { userDataDir?: string; profileDirectory?: string } {
  const userDataDir = process.env.CBPLUS_CHROME_USER_DATA_DIR?.trim()
    || process.env.COSTAMAR_CHROME_USER_DATA_DIR?.trim()
    || process.env.CBPLUS_AGENT_CHROME_USER_DATA_DIR?.trim()
    || process.env.COSTAMAR_AGENT_CHROME_USER_DATA_DIR?.trim()
    || process.env.AGIL_CHROME_USER_DATA_DIR?.trim()
    || DEFAULT_CHROME_USER_DATA_DIR
    || undefined;
  const profileDirectory = process.env.CBPLUS_CHROME_PROFILE?.trim()
    || process.env.COSTAMAR_CHROME_PROFILE?.trim()
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
  const configured = process.env.CBPLUS_CHROME_EXECUTABLE?.trim()
    || process.env.COSTAMAR_CHROME_EXECUTABLE?.trim();
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
  const configured = process.env.CBPLUS_B2B_BASE_URL?.trim()
    || process.env.COSTAMAR_B2B_BASE_URL?.trim()
    || DEFAULT_COSTAMAR_B2B_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("Click and Book Plus B2B base URL must use the official HTTPS origin.");
  }

  if (parsed.protocol !== "https:" || !COSTAMAR_B2B_ALLOWED_ORIGINS.has(parsed.origin)) {
    throw new Error("Click and Book Plus B2B base URL must use the official HTTPS origin.");
  }

  return parsed.toString();
}

function resolveCostamarB2bCredentials(): { email?: string; password?: string } {
  const email = process.env.CBPLUS_B2B_EMAIL?.trim()
    || process.env.COSTAMAR_B2B_EMAIL?.trim()
    || process.env.CBPLUS_B2B_USERNAME?.trim()
    || process.env.COSTAMAR_B2B_USERNAME?.trim()
    || cachedInteractiveCostamarB2bCredentials.email?.trim()
    || undefined;
  const password = process.env.CBPLUS_B2B_PASSWORD?.trim()
    || process.env.COSTAMAR_B2B_PASSWORD?.trim()
    || cachedInteractiveCostamarB2bCredentials.password?.trim()
    || undefined;
  return {
    ...(email ? { email } : {}),
    ...(password ? { password } : {}),
  };
}

function costamarB2bPromptEnabled(): boolean {
  return String(cbPlusEnv("CBPLUS_B2B_PROMPT_ENABLED", "COSTAMAR_B2B_PROMPT_ENABLED") ?? "1").trim() !== "0";
}

function resolveCostamarB2bTotpSecret(): string | undefined {
  const secret = process.env.CBPLUS_B2B_TOTP_SECRET?.trim()
    || process.env.COSTAMAR_B2B_TOTP_SECRET?.trim()
    || process.env.CBPLUS_B2B_TOTP_URI?.trim()
    || process.env.COSTAMAR_B2B_TOTP_URI?.trim()
    || undefined;
  return secret || undefined;
}

function costamarB2bTotpMinRemainingSeconds(): number {
  const configured = Number(cbPlusEnv("CBPLUS_B2B_TOTP_MIN_REMAINING_SECONDS", "COSTAMAR_B2B_TOTP_MIN_REMAINING_SECONDS") ?? 5);
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
    console.log("\nClick and Book Plus B2B necesita credenciales para continuar.");
  }
  if (request.authCode) {
    console.log(`\nClick and Book Plus B2B necesita ${request.challengeLabel ?? "un código Auth / OTP"} para continuar.`);
  }

  if (request.email) {
    response.email = await promptTerminalText("Email Click and Book Plus B2B: ");
  }
  if (request.password) {
    response.password = await promptTerminalSecret("Password Click and Book Plus B2B: ");
  }
  if (request.authCode) {
    response.authCode = await promptTerminalSecret(`${request.challengeLabel ?? "Código Auth / OTP de Click and Book Plus"}: `);
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
  return String(cbPlusEnv("CBPLUS_B2B_AUTOMATION_ENABLED", "COSTAMAR_B2B_AUTOMATION_ENABLED") ?? "1").trim() !== "0";
}

function costamarB2bAutomationAllowsSessionOnly(): boolean {
  return String(cbPlusEnv("CBPLUS_B2B_AUTOMATION_ALLOW_SESSION_ONLY", "COSTAMAR_B2B_AUTOMATION_ALLOW_SESSION_ONLY") ?? "1").trim() !== "0";
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
  return String(cbPlusEnv("CBPLUS_B2B_USE_LIVE_BROWSER", "COSTAMAR_B2B_USE_LIVE_BROWSER") ?? defaultValue).trim() !== "0";
}

function costamarBrowserAutomationHeadless(): boolean {
  return String(cbPlusEnv("CBPLUS_BROWSER_HEADLESS", "COSTAMAR_BROWSER_HEADLESS") ?? "1").trim() !== "0";
}

function costamarB2bDebugEnabled(): boolean {
  return String(cbPlusEnv("CBPLUS_B2B_DEBUG", "COSTAMAR_B2B_DEBUG") ?? "0").trim() === "1";
}

function costamarB2bPlaywrightFallbackEnabled(): boolean {
  return String(cbPlusEnv("CBPLUS_B2B_PLAYWRIGHT_FALLBACK_ENABLED", "COSTAMAR_B2B_PLAYWRIGHT_FALLBACK_ENABLED") ?? "0").trim() !== "0";
}

type CostamarB2bDebugDetail = Record<string, string | number | boolean | undefined>;

function safeCostamarB2bDebugUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "[invalid-url]";
  }
}

function sanitizeCostamarB2bDebugDetail(detail: CostamarB2bDebugDetail): CostamarB2bDebugDetail {
  return Object.fromEntries(Object.entries(detail).map(([key, value]) => {
    if (value === undefined) {
      return [key, value];
    }
    if (/^(?:token|password|secret|cookie|authorization|authCode|otp)$/i.test(key)) {
      return [key, "[redacted]"];
    }
    if (typeof value === "string" && /^(?:url|location)$/i.test(key)) {
      return [key, safeCostamarB2bDebugUrl(value)];
    }
    if (typeof value === "string") {
      return [key, value
        .replace(/([?&]token=)[^&\s]+/gi, "$1[redacted]")
        .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
        .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted]")];
    }
    return [key, value];
  }));
}

function logCostamarB2bDebug(stage: string, detail?: CostamarB2bDebugDetail): void {
  if (!costamarB2bDebugEnabled()) {
    return;
  }

  if (detail === undefined) {
    console.log(`[costamar-b2b] ${stage}`);
    return;
  }

  console.log(`[costamar-b2b] ${stage}`, sanitizeCostamarB2bDebugDetail(detail));
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

function copyPathSafe(source: string, destination: string): void {
  try {
    const stats = lstatSync(source);
    if (stats.isSymbolicLink()) {
      return;
    }

    if (stats.isDirectory()) {
      mkdirPrivate(destination);
      readdirSync(source, { withFileTypes: true }).forEach((entry) => {
        copyPathSafe(join(source, entry.name), join(destination, entry.name));
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

function shouldCloneCostamarChromeProfileForIsolatedAutomation(): boolean {
  const configured = cbPlusEnv("CBPLUS_B2B_CLONE_CHROME_PROFILE", "COSTAMAR_B2B_CLONE_CHROME_PROFILE");
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
  const tempRoot = mkdtempSync(join(tmpdir(), "travel_quote_foundation_costamar_browser_"));
  mkdirPrivate(join(tempRoot, profileName));
  registerActiveTempArtifact(tempRoot);

  if (!options.cloneSourceProfile) {
    return tempRoot;
  }

  [
    "Local State",
    join(profileName, "Preferences"),
    join(profileName, "Network", "Cookies"),
    join(profileName, "Cookies"),
  ].forEach((relativePath) => {
    const source = join(sourceRoot, relativePath);
    if (existsSync(source)) {
      copyPathSafe(source, join(tempRoot, relativePath));
    }
  });

  return tempRoot;
}

export function prepareTemporaryCostamarChromeProfileForTests(
  profileName: string,
  options: { cloneSourceProfile?: boolean } = {},
): string {
  return prepareTemporaryCostamarChromeProfile(profileName, options);
}

export async function cleanupTemporaryCostamarChromeProfileForTests(tempRoot: string): Promise<void> {
  await removePathWithRetries(tempRoot, 6, 250);
  unregisterActiveTempArtifact(tempRoot);
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
  trustedOrigin: string,
  jar: Map<string, string>,
  init: RequestInit = {},
): Promise<{ response: Response; body: string }> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error("Click and Book Plus B2B request URL is invalid.");
  }
  if (target.protocol !== "https:" || target.origin !== trustedOrigin) {
    throw new Error("Click and Book Plus B2B request left the official origin.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(5000, costamarSessionWarmupTimeoutMs()));
  try {
    const cookies = cookieHeader(jar);
    const response = await fetch(target, {
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

function resolveCostamarB2bRedirectUrl(location: string, trustedOrigin: string): string | undefined {
  try {
    const target = new URL(location, `${trustedOrigin}/`);
    return target.protocol === "https:" && target.origin === trustedOrigin
      ? target.toString()
      : undefined;
  } catch {
    return undefined;
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
    await fetchCostamarB2bWithCookies(`${origin}/login`, origin, jar, {
      headers: {
        accept: "text/html,application/xhtml+xml",
      },
    });

    const login = await fetchCostamarB2bWithCookies(`${origin}/lang/en/login`, origin, jar, {
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
      const auth = await fetchCostamarB2bWithCookies(`${origin}/lang/en/login2factor`, origin, jar, {
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
        hasRedirect: Boolean(auth.response.headers.get("location")),
      });

      const location = auth.response.headers.get("location");
      if (auth.response.status >= 300 && auth.response.status < 400 && location) {
        const redirectUrl = resolveCostamarB2bRedirectUrl(location, origin);
        if (!redirectUrl) {
          return undefined;
        }
        await fetchCostamarB2bWithCookies(redirectUrl, origin, jar, {
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
        const redirectUrl = resolveCostamarB2bRedirectUrl(location, origin);
        if (!redirectUrl) {
          return undefined;
        }
        await fetchCostamarB2bWithCookies(redirectUrl, origin, jar, {
          headers: {
            accept: "text/html,application/xhtml+xml",
          },
        });
      }
    }

    const tokenResponse = await fetchCostamarB2bWithCookies(`${origin}/lang/en/airlinesearch`, origin, jar, {
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
  } catch {
    logCostamarB2bDebug("http automation failed");
    return undefined;
  }
}

export async function generateCostamarRedirectContextViaB2BHttpForTests(
  context: CostamarProviderContext,
): Promise<CostamarProviderContext | undefined> {
  return generateCostamarRedirectContextViaB2BHttp(context);
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

function isCostamarBrowserUrlAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      return false;
    }

    const allowedHosts = new Set([
      "flights.zdev.tech",
      "booking.clickandbook.com",
      new URL(resolveCostamarB2bBaseUrl()).hostname.toLowerCase(),
    ]);
    return allowedHosts.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function collectCostamarCandidatesFromBrowserUrl(
  pool: Map<string, CostamarSessionCandidate>,
  url: string,
  source: string,
): void {
  if (isCostamarBrowserUrlAllowed(url)) {
    collectCostamarCandidatesFromText(pool, url, source);
  }
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
    collectCostamarCandidatesFromBrowserUrl(pool, request.url(), `${sourcePrefix}:request`);
  });
  page.on("response", (response) => {
    collectCostamarCandidatesFromBrowserUrl(pool, response.url(), `${sourcePrefix}:response`);
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      collectCostamarCandidatesFromBrowserUrl(pool, frame.url(), `${sourcePrefix}:frame`);
    }
  });
}

function observeCostamarControlledPage(
  page: Page,
  pool: Map<string, CostamarSessionCandidate>,
  sourcePrefix: string,
  observedPages: Set<Page>,
): void {
  if (observedPages.has(page)) {
    return;
  }

  observedPages.add(page);
  observeCostamarPage(page, pool, sourcePrefix);
}

async function collectCostamarCandidatesFromPage(
  page: Page,
  pool: Map<string, CostamarSessionCandidate>,
  sourcePrefix: string,
): Promise<void> {
  const pageUrl = page.url();
  if (!isCostamarBrowserUrlAllowed(pageUrl)) {
    return;
  }

  collectCostamarCandidatesFromText(pool, pageUrl, `${sourcePrefix}:url`);

  try {
    const snapshot = await page.evaluate((limits) => {
      const clip = (value: string, maxChars: number) => value.length > maxChars
        ? value.slice(0, maxChars)
        : value;
      const readStorage = (storage: Storage) => {
        const entries: string[] = [];
        for (let index = 0; index < Math.min(storage.length, limits.maxStorageEntries); index += 1) {
          const key = storage.key(index) ?? "";
          entries.push(`${clip(key, 256)}=${clip(storage.getItem(key) ?? "", limits.maxStorageValueChars)}`);
        }
        return entries;
      };

      return JSON.stringify({
        href: window.location.href,
        html: clip(document.documentElement?.outerHTML ?? "", limits.maxHtmlChars),
        localStorage: readStorage(localStorage),
        sessionStorage: readStorage(sessionStorage),
      });
    }, {
      maxHtmlChars: COSTAMAR_PAGE_SNAPSHOT_HTML_MAX_CHARS,
      maxStorageEntries: COSTAMAR_PAGE_STORAGE_MAX_ENTRIES,
      maxStorageValueChars: COSTAMAR_PAGE_STORAGE_VALUE_MAX_CHARS,
    });
    collectCostamarCandidatesFromText(pool, snapshot, `${sourcePrefix}:snapshot`);
  } catch {
    // Ignore pages that are not script-accessible yet.
  }
}

export async function collectCostamarCandidatesFromPageForTests(
  page: Pick<Page, "url" | "evaluate">,
): Promise<CostamarSessionCandidate[]> {
  const pool = new Map<string, CostamarSessionCandidate>();
  await collectCostamarCandidatesFromPage(page as Page, pool, "test");
  return [...pool.values()];
}

function observeCostamarBrowserPages(
  context: BrowserContext,
  pool: Map<string, CostamarSessionCandidate>,
  sourcePrefix: string,
  observedPages: Set<Page>,
): void {
  context.pages().forEach((page, index) => {
    if (observedPages.has(page) || !isCostamarBrowserUrlAllowed(page.url())) {
      return;
    }

    observeCostamarControlledPage(page, pool, `${sourcePrefix}:${index}`, observedPages);
  });
}

function buildCostamarSessionCandidateFromToken(
  token: string,
  terminalId: string,
  source: string,
  brandBaseUrl = "https://flights.zdev.tech/vuelos/pro",
): CostamarSessionCandidate | undefined {
  const syntheticUrl = `${brandBaseUrl.replace(/\/+$/, "")}/b/LIM/MAD/2026-01-01/1/0/0`
    + `?terminalId=${encodeURIComponent(terminalId)}&lang=es&token=${encodeURIComponent(token)}`;
  return extractCostamarSessionCandidates(syntheticUrl, source).find((candidate) =>
    candidate.terminalId === terminalId && candidate.token === token);
}

async function openCostamarB2bFlightsTab(page: Page): Promise<boolean> {
  if (!isCostamarB2bUrlAllowed(page.url())) {
    return false;
  }
  const flightsTab = page.locator("a[href='#airlines']").first();
  if (await flightsTab.count() === 0) {
    return false;
  }

  await flightsTab.click({ force: true }).catch(() => undefined);
  if (!isCostamarB2bUrlAllowed(page.url())) {
    return false;
  }
  await page.locator("#fairlines").first().waitFor({ state: "attached", timeout: 10000 }).catch(() => undefined);
  await page.waitForTimeout(500);

  return (await page.locator("#fairlines").first().count()) > 0;
}

async function primeCostamarB2bFlightForm(
  page: Page,
  payload: CostamarB2bFlightWarmupPayload,
): Promise<boolean> {
  if (!isCostamarB2bUrlAllowed(page.url())) {
    return false;
  }
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
  }, payload).catch(() => {
    logCostamarB2bDebug("form prime failed");
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
  if (!isCostamarB2bUrlAllowed(page.url())) {
    return undefined;
  }
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

  observeCostamarControlledPage(page, pool, `${sourcePrefix}:observed`, observedPages);
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
  if (!isCostamarB2bUrlAllowed(page.url())) {
    return undefined;
  }
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
    return "Código OTP de Click and Book Plus";
  }
  if (/token/i.test(text)) {
    return "Token de Click and Book Plus";
  }

  return "Código Auth / OTP de Click and Book Plus";
}

async function detectCostamarB2bAuthPrompt(page: Page): Promise<{
  challenge: CostamarB2bAuthChallenge;
  label: string;
} | undefined> {
  if (!isCostamarB2bUrlAllowed(page.url())) {
    return undefined;
  }
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
): Promise<boolean> {
  if (!isCostamarB2bUrlAllowed(page.url())) {
    return false;
  }
  const inputLocator = page.locator("input");
  const normalizedCode = authCode.trim();

  if (challenge.kind === "split") {
    const characters = [...normalizedCode];
    for (let index = 0; index < challenge.inputIndexes.length; index += 1) {
      if (!isCostamarB2bUrlAllowed(page.url())) {
        return false;
      }
      await applyCostamarB2bKeyboardInput(
        inputLocator.nth(challenge.inputIndexes[index]),
        characters[index] ?? "",
      );
    }
  } else {
    if (!isCostamarB2bUrlAllowed(page.url())) {
      return false;
    }
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
    if (!isCostamarB2bUrlAllowed(page.url())) {
      return false;
    }
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
    if (!isCostamarB2bUrlAllowed(page.url())) {
      return false;
    }
    const lastInput = inputLocator.nth(challenge.inputIndexes[challenge.inputIndexes.length - 1]);
    await lastInput.press("Enter").catch(() => undefined);
  }

  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
  return isCostamarB2bUrlAllowed(page.url());
}

async function waitForCostamarB2bSessionTransition(
  page: Page,
  timeoutMs = 10000,
): Promise<void> {
  const deadline = Date.now() + Math.max(2000, timeoutMs);
  while (Date.now() < deadline) {
    if (!isCostamarB2bUrlAllowed(page.url())) {
      return;
    }
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
  if (!isCostamarB2bUrlAllowed(page.url())) {
    return false;
  }
  const prompt = await detectCostamarB2bAuthPrompt(page);
  if (!prompt) {
    return true;
  }

  const authCode = await promptCostamarB2bAuthCode(prompt.label);
  if (!authCode) {
    return false;
  }

  if (!isCostamarB2bUrlAllowed(page.url())) {
    return false;
  }
  if (!(await submitCostamarB2bAuthPrompt(page, prompt.challenge, authCode))) {
    return false;
  }
  await waitForCostamarB2bSessionTransition(page);
  if (!isCostamarB2bUrlAllowed(page.url())) {
    return false;
  }
  return !(await pageShowsCostamarB2bLogin(page))
    && !(await detectCostamarB2bAuthPrompt(page));
}

async function pageShowsCostamarB2bLogin(page: Page): Promise<boolean> {
  if (!isCostamarB2bUrlAllowed(page.url())) {
    return false;
  }
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

  if (!isCostamarB2bUrlAllowed(page.url())) {
    return false;
  }

  if (!(await pageShowsCostamarB2bLogin(page))) {
    return completeCostamarB2bAuthPrompt(page);
  }

  const credentials = await resolveCostamarB2bCredentialsForAutomation();
  if (!credentials.email || !credentials.password) {
    return false;
  }

  if (!isCostamarB2bUrlAllowed(page.url())) {
    return false;
  }
  await applyCostamarB2bKeyboardInput(page.locator("#email"), credentials.email);
  if (!isCostamarB2bUrlAllowed(page.url())) {
    return false;
  }
  await applyCostamarB2bKeyboardInput(page.locator("#password"), credentials.password);
  if (!isCostamarB2bUrlAllowed(page.url())) {
    return false;
  }
  await page.locator("#btnsubmit").click();
  await page.waitForLoadState("domcontentloaded", { timeout: 45000 }).catch(() => undefined);
  await waitForCostamarB2bSessionTransition(page, 8000);

  if (!isCostamarB2bUrlAllowed(page.url())) {
    return false;
  }

  if (!(await pageShowsCostamarB2bLogin(page))) {
    return completeCostamarB2bAuthPrompt(page);
  }

  clearInteractiveCostamarB2bCredentials();
  return false;
}

export async function ensureCostamarB2bSessionForTests(
  page: Pick<Page, "url" | "goto" | "waitForTimeout" | "waitForLoadState" | "locator">,
): Promise<boolean> {
  return ensureCostamarB2bSession(page as Page);
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
    const configuredExecutable = cbPlusEnv("CBPLUS_CHROME_EXECUTABLE", "COSTAMAR_CHROME_EXECUTABLE");
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
      "Click and Book Plus isolated browser launch",
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
        "Click and Book Plus live browser connection",
      );
      if (liveSession) {
        liveBrowser = liveSession.browser;
        livePage = await withCostamarB2bTimeout(
          liveSession.context.newPage(),
          warmupTimeoutMs,
          "Click and Book Plus live page creation",
        );
        closeLivePage = true;

        observeCostamarControlledPage(livePage, pool, "live-b2b", observedPages);
        const hasLiveSession = await withCostamarB2bTimeout(
          ensureCostamarB2bSession(livePage),
          warmupTimeoutMs,
          "Click and Book Plus live B2B session",
        );
        logCostamarB2bDebug("live session resolved", { hasLiveSession });
        await withCostamarB2bTimeout(
          collectCostamarCandidatesFromPage(livePage, pool, "live-b2b"),
          warmupTimeoutMs,
          "Click and Book Plus live token collection",
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
            "Click and Book Plus live B2B flight search",
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
          "Click and Book Plus live page close",
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
      "Click and Book Plus isolated page creation",
    );
    observeCostamarControlledPage(sessionPage, pool, "b2b", observedPages);
    observeCostamarBrowserPages(browserContext, pool, "b2b", observedPages);
    const hasSession = await withCostamarB2bTimeout(
      ensureCostamarB2bSession(sessionPage),
      warmupTimeoutMs,
      "Click and Book Plus isolated B2B session",
    );
    logCostamarB2bDebug("isolated session resolved", { hasSession, url: sessionPage.url() });
    await withCostamarB2bTimeout(
      collectCostamarCandidatesFromPage(sessionPage, pool, "b2b"),
      warmupTimeoutMs,
      "Click and Book Plus isolated token collection",
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
      "Click and Book Plus isolated B2B flight search",
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
      "Click and Book Plus branded search page creation",
    );
    observeCostamarControlledPage(searchPage, pool, "search", observedPages);
    observeCostamarBrowserPages(browserContext, pool, "search", observedPages);
    await withCostamarB2bTimeout(
      searchPage.goto(searchUrl, {
        waitUntil: "domcontentloaded",
        timeout: warmupTimeoutMs,
      }),
      warmupTimeoutMs,
      "Click and Book Plus branded search navigation",
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
    logCostamarB2bDebug("isolated automation failed");
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

export function getLastCostamarWarmupDiagnostics(): CostamarWarmupDiagnostics | undefined {
  return lastCostamarWarmupDiagnostics
    ? JSON.parse(JSON.stringify(lastCostamarWarmupDiagnostics)) as CostamarWarmupDiagnostics
    : undefined;
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
    "Click and Book Plus browser context close",
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
    "Click and Book Plus browser close",
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
        await sleep(costamarWarmupBrowserSettleMs);
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

export function setCostamarWarmupBrowserSettleMsForTests(
  settleMs?: number,
): void {
  costamarWarmupBrowserSettleMs = settleMs === undefined
    ? COSTAMAR_WARMUP_BROWSER_SETTLE_MS
    : Math.max(0, Math.trunc(settleMs));
}

export function resetCostamarWarmupStateForTests(): void {
  engineCache.clear();
  pendingCostamarSessionWarmups.clear();
  recentCostamarSessionWarmups.clear();
  costamarWarmupOpener = openUrlLocally;
  costamarWarmupBrowserSettleMs = COSTAMAR_WARMUP_BROWSER_SETTLE_MS;
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

function readPositiveIntegerEnv(primaryName: string, legacyName: string, fallback: number): number {
  const parsed = Number(cbPlusEnv(primaryName, legacyName) ?? fallback);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.trunc(parsed)
    : fallback;
}

function costamarProviderB2bPrewarmEnabled(): boolean {
  return String(cbPlusEnv("CBPLUS_PROVIDER_B2B_PREWARM_ENABLED", "COSTAMAR_PROVIDER_B2B_PREWARM_ENABLED") ?? "0").trim() !== "0";
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
    "CBPLUS_PREWARM_DEPARTURE_OFFSET_DAYS",
    "COSTAMAR_PREWARM_DEPARTURE_OFFSET_DAYS",
    DEFAULT_COSTAMAR_PREWARM_DEPARTURE_OFFSET_DAYS,
  );
  const stayNights = readPositiveIntegerEnv(
    "CBPLUS_PREWARM_STAY_NIGHTS",
    "COSTAMAR_PREWARM_STAY_NIGHTS",
    DEFAULT_COSTAMAR_PREWARM_STAY_NIGHTS,
  );
  const departureDate = addUtcDays(now, departureOffsetDays);
  const returnDate = addUtcDays(departureDate, stayNights);
  const origin = cbPlusEnv("CBPLUS_PREWARM_ORIGIN", "COSTAMAR_PREWARM_ORIGIN")?.toUpperCase()
    || DEFAULT_COSTAMAR_PREWARM_ORIGIN;
  const destination = cbPlusEnv("CBPLUS_PREWARM_DESTINATION", "COSTAMAR_PREWARM_DESTINATION")?.toUpperCase()
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
  let carryOnIncluded: boolean | undefined;
  let checkedIncluded: boolean | undefined;
  let checkedBags = 0;
  let sawCarrySignal = false;
  let sawCheckedSignal = false;
  const descriptions: string[] = [];

  const rememberIncludedFlag = (
    current: boolean | undefined,
    next: boolean | undefined,
  ): boolean | undefined => {
    if (next === undefined) {
      return current;
    }

    if (current === false || next === false) {
      return false;
    }

    return true;
  };

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
      const includedFlag = explicitIncluded ?? (typeof quantity === "number" ? quantity > 0 : undefined);

      if (carrySignal) {
        sawCarrySignal = true;
        carryOnIncluded = rememberIncludedFlag(carryOnIncluded, includedFlag);
      }

      if (checkedSignal) {
        sawCheckedSignal = true;
        checkedIncluded = rememberIncludedFlag(checkedIncluded, includedFlag);
        if (typeof quantity === "number" && quantity > 0) {
          checkedBags = Math.max(checkedBags, quantity);
        }
        if (description && !isCostamarCodeLikeDescription(description)) {
          descriptions.push(description);
        }
      }
    }
  }

  if (!sawCarrySignal && !sawCheckedSignal && checkedBags === 0 && descriptions.length === 0) {
    return undefined;
  }

  return {
    carryOnIncluded: sawCarrySignal ? carryOnIncluded ?? false : undefined,
    checkedIncluded: sawCheckedSignal ? checkedIncluded ?? false : undefined,
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

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstRecordValue(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    return recordValue(value[0]);
  }

  return recordValue(value);
}

function stringValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return stringValue(value[0]);
  }

  if (typeof value === "string") {
    return value.trim() || undefined;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  const record = recordValue(value);
  if (record) {
    return stringValue(record.value ?? record.amount ?? record.code ?? record.locationCode);
  }

  return undefined;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeCbPlusXmlText(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function collectCbPlusXmlStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string") {
    if (value.includes("<")) {
      output.push(value);
    }
    return output;
  }

  if (Array.isArray(value)) {
    value.forEach((entry) => collectCbPlusXmlStrings(entry, output));
    return output;
  }

  const record = recordValue(value);
  if (record) {
    Object.values(record).forEach((entry) => collectCbPlusXmlStrings(entry, output));
  }

  return output;
}

function cbPlusXmlHasTag(xmlStrings: string[], tagNames: string[]): boolean {
  return xmlStrings.some((xml) => tagNames.some((tagName) =>
    new RegExp(`<(?:\\w+:)?${escapeRegex(tagName)}\\b`, "i").test(xml),
  ));
}

function cbPlusXmlAttribute(
  xmlStrings: string[],
  tagNames: string[],
  attributeNames: string[],
): string | undefined {
  for (const xml of xmlStrings) {
    for (const tagName of tagNames) {
      const tagMatch = xml.match(new RegExp(`<(?:\\w+:)?${escapeRegex(tagName)}\\b[^>]*>`, "i"))?.[0];
      if (!tagMatch) {
        continue;
      }

      for (const attributeName of attributeNames) {
        const attributeMatch = tagMatch.match(
          new RegExp(`\\b${escapeRegex(attributeName)}=["']([^"']+)["']`, "i"),
        );
        if (attributeMatch?.[1]) {
          return decodeCbPlusXmlText(attributeMatch[1]);
        }
      }
    }
  }

  return undefined;
}

function cbPlusXmlTagValue(xmlStrings: string[], tagNames: string[]): string | undefined {
  for (const xml of xmlStrings) {
    for (const tagName of tagNames) {
      const match = xml.match(
        new RegExp(`<(?:\\w+:)?${escapeRegex(tagName)}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${escapeRegex(tagName)}>`, "i"),
      );
      if (match?.[1]) {
        return decodeCbPlusXmlText(match[1].replace(/<[^>]+>/g, " "));
      }
    }
  }

  return undefined;
}

function cbPlusXmlNumber(
  xmlStrings: string[],
  tagNames: string[],
  attributeNames: string[],
): number | undefined {
  return numberValue(
    cbPlusXmlAttribute(xmlStrings, tagNames, attributeNames)
      ?? cbPlusXmlTagValue(xmlStrings, attributeNames),
  );
}

function buildCbPlusBaggageEntries(
  segment: CbPlusFlightSegment,
  scope: "checked" | "hand",
): unknown[] {
  const directEntries = baggageEntryList(scope === "hand" ? segment.handBaggage : segment.baggage);
  if (directEntries.length > 0) {
    return directEntries;
  }

  const xmlStrings = collectCbPlusXmlStrings(segment.tpaextensions ?? segment.tpaExtensions);
  const tagNames = scope === "hand"
    ? ["handBaggage", "handBaggageInformation", "carryOnBaggage", "cabinBaggage"]
    : ["baggageInformation", "checkedBaggage", "holdBaggage", "baggage"];
  if (!cbPlusXmlHasTag(xmlStrings, tagNames)) {
    return [];
  }

  const quantity = cbPlusXmlNumber(xmlStrings, tagNames, ["pieces", "piece", "quantity", "qty", "amount"]);
  const description = cbPlusXmlAttribute(xmlStrings, tagNames, ["description", "name", "text"])
    ?? cbPlusXmlTagValue(xmlStrings, ["description", "name"]);

  return [{
    type: scope === "hand" ? "hand" : "checked",
    pieces: quantity,
    included: quantity === undefined ? true : quantity > 0,
    description,
  }];
}

function mapCbPlusAirport(airport: CbPlusAirport | undefined): CostamarAirport | undefined {
  const code = stringValue(airport?.locationCode ?? airport?.code)?.toUpperCase();
  if (!code) {
    return undefined;
  }

  return {
    code,
    cityName: stringValue(airport?.codeContext),
  };
}

function mapCbPlusAirline(airline: CbPlusAirline | undefined): CostamarAirline | undefined {
  const code = stringValue(airline?.code)?.toUpperCase();
  const name = stringValue(airline?.companyShortName ?? airline?.name);
  if (!code && !name) {
    return undefined;
  }

  return {
    ...(code ? { code } : {}),
    ...(name ? { name } : {}),
  };
}

function cbPlusBookingClass(segment: CbPlusFlightSegment): string | { code?: string } | undefined {
  if (segment.bookingClass) {
    return segment.bookingClass;
  }

  for (const availability of asArray(segment.bookingClassAvails)) {
    const bookingClass = asArray(availability.bookingClassAvail)[0];
    const code = stringValue(bookingClass?.resBookDesigCode ?? bookingClass?.code);
    if (code) {
      return { code };
    }
  }

  return undefined;
}

function cbPlusSegmentElapsedTime(segment: CbPlusFlightSegment | undefined): string | number | undefined {
  if (!segment) {
    return undefined;
  }

  const explicitElapsedTime = stringValue(segment.elapsedTime) ?? segment.elapsedTime;
  if (explicitElapsedTime) {
    return explicitElapsedTime;
  }

  return cbPlusXmlTagValue(
    collectCbPlusXmlStrings(segment.tpaextensions ?? segment.tpaExtensions),
    ["elapsedTime", "journeyDuration", "duration"],
  );
}

function isCbPlusAggregateFlightSegment(
  segment: CbPlusFlightSegment,
  index: number,
  allSegments: CbPlusFlightSegment[],
): boolean {
  if (stringValue(segment.flightNumber)) {
    return false;
  }

  const xmlStrings = collectCbPlusXmlStrings(segment.tpaextensions ?? segment.tpaExtensions);
  if (cbPlusXmlHasTag(xmlStrings, ["flightDetails", "offerInformation", "connectionLocationList", "brandedFare"])) {
    return true;
  }

  return allSegments.length > 1
    && index === allSegments.length - 1
    && !segment.operatingAirline;
}

function cbPlusBrandedFareName(segment: CbPlusFlightSegment | undefined): string | undefined {
  if (!segment) {
    return undefined;
  }

  return cbPlusXmlAttribute(
    collectCbPlusXmlStrings(segment.tpaextensions ?? segment.tpaExtensions),
    ["brandedFare"],
    ["brandName", "name", "brandID"],
  );
}

function mapCbPlusSegmentToCostamarSegment(
  segment: CbPlusFlightSegment,
  fallbackId: string,
): CostamarSegmentLike | undefined {
  const departureAirport = mapCbPlusAirport(segment.departureAirport);
  const arrivalAirport = mapCbPlusAirport(segment.arrivalAirport);
  const departureDateTime = stringValue(segment.departureDateTime);
  const arrivalDateTime = stringValue(segment.arrivalDateTime);
  if (!departureAirport?.code || !arrivalAirport?.code || !departureDateTime || !arrivalDateTime) {
    return undefined;
  }

  return {
    id: stringValue(segment.id) ?? fallbackId,
    departureAirport,
    arrivalAirport,
    departureDateTime,
    arrivalDateTime,
    elapsedTime: cbPlusSegmentElapsedTime(segment),
    marketingAirline: mapCbPlusAirline(segment.marketingAirline),
    operatingAirline: mapCbPlusAirline(segment.operatingAirline),
    flightNumber: segment.flightNumber,
    bookingClass: cbPlusBookingClass(segment),
    fareBasisCode: stringValue(segment.fareBasisCode),
    cabinType: stringValue(segment.cabinType),
    baggage: buildCbPlusBaggageEntries(segment, "checked"),
    handBaggage: buildCbPlusBaggageEntries(segment, "hand"),
  };
}

function mapCbPlusOptionToCostamarFlight(
  option: CbPlusOriginDestinationOption,
  recommendationId: string,
  optionIndex: number,
): CostamarFlight | undefined {
  const rawSegments = asArray(option.flightSegment);
  const aggregateSegment = rawSegments.find((segment, segmentIndex) =>
    isCbPlusAggregateFlightSegment(segment, segmentIndex, rawSegments));
  const flightSegments = rawSegments.filter((segment, segmentIndex) =>
    !isCbPlusAggregateFlightSegment(segment, segmentIndex, rawSegments));
  const segments = flightSegments
    .map((segment, segmentIndex) => mapCbPlusSegmentToCostamarSegment(
      segment,
      `${recommendationId}-${optionIndex}-${segmentIndex}`,
    ))
    .filter((segment): segment is CostamarSegmentLike => Boolean(segment));
  if (segments.length === 0) {
    return undefined;
  }

  const first = segments[0];
  const last = segments[segments.length - 1];
  const elapsedTime = cbPlusSegmentElapsedTime(aggregateSegment)
    ?? parseDurationMinutes(undefined, first.departureDateTime, last.arrivalDateTime);
  const brandedFareName = cbPlusBrandedFareName(aggregateSegment);

  return {
    id: `${recommendationId}-option-${String(option.refNumber ?? optionIndex)}-${String(option.rph ?? optionIndex)}`,
    departureAirport: first.departureAirport,
    arrivalAirport: last.arrivalAirport,
    departureDateTime: first.departureDateTime,
    arrivalDateTime: last.arrivalDateTime,
    elapsedTime,
    marketingAirline: first.marketingAirline,
    operatingAirline: first.operatingAirline,
    flightNumber: first.flightNumber,
    bookingClass: first.bookingClass,
    fareBasisCode: first.fareBasisCode,
    cabinType: first.cabinType,
    baggage: aggregateSegment ? buildCbPlusBaggageEntries(aggregateSegment, "checked") : first.baggage,
    handBaggage: aggregateSegment ? buildCbPlusBaggageEntries(aggregateSegment, "hand") : first.handBaggage,
    ...(brandedFareName ? { brandedFare: { name: brandedFareName } } : {}),
    segments,
  };
}

function cbPlusOptionJourneyKey(
  option: CbPlusOriginDestinationOption,
  request: SearchRequest,
  optionIndex: number,
): string {
  const refNumber = stringValue(option.refNumber);
  if (refNumber !== undefined) {
    return refNumber;
  }

  if (request.tripType === "one-way") {
    return "0";
  }

  const firstSegment = asArray(option.flightSegment)[0];
  const origin = stringValue(firstSegment?.departureAirport?.locationCode ?? firstSegment?.departureAirport?.code)?.toUpperCase();
  const destination = stringValue(firstSegment?.arrivalAirport?.locationCode ?? firstSegment?.arrivalAirport?.code)?.toUpperCase();
  const leg = request.legs[0];
  if (origin === leg.origin.toUpperCase() && destination !== leg.origin.toUpperCase()) {
    return "0";
  }
  if (origin === leg.destination.toUpperCase() && destination !== leg.destination.toUpperCase()) {
    return "1";
  }

  return String(optionIndex);
}

function cbPlusMoneyAmount(value: unknown): number | undefined {
  if (Array.isArray(value)) {
    return cbPlusMoneyAmount(value[0]);
  }

  const record = recordValue(value);
  return numberValue(record ? record.amount ?? record.value : value);
}

function cbPlusAmountEntries(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => cbPlusAmountEntries(entry));
  }

  const record = recordValue(value);
  if (!record) {
    return [value];
  }

  if (record.amount !== undefined || record.value !== undefined) {
    return [record];
  }

  return [
    ...cbPlusAmountEntries(record.fee ?? record.fees),
    ...cbPlusAmountEntries(record.discount ?? record.discounts),
    ...cbPlusAmountEntries(record.tax ?? record.taxes),
  ];
}

function cbPlusAdjustmentDescription(value: unknown): string {
  const record = recordValue(value);
  return String(
    record?.description
      ?? record?.name
      ?? record?.code
      ?? record?.type
      ?? "",
  ).trim();
}

function sumCbPlusAmounts(
  value: unknown,
  predicate: (entry: unknown) => boolean = () => true,
): number {
  return cbPlusAmountEntries(value)
    .filter(predicate)
    .reduce<number>((sum, entry) => sum + (cbPlusMoneyAmount(entry) ?? 0), 0);
}

function cbPlusRecordPath(root: Record<string, unknown>, ...keys: string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = firstRecordValue(root[key]);
    if (value) {
      return value;
    }
  }

  return undefined;
}

function mapCbPlusPricing(pricedItinerary: CbPlusPricedItinerary): CostamarPricing {
  const pricing = pricedItinerary.airItineraryPricingInfo ?? {};
  const totalFareContainer = cbPlusRecordPath(
    pricing,
    "itinTotalFare",
    "itineraryTotalFare",
    "totalFare",
    "total",
  ) ?? pricing;
  const baseFare = cbPlusRecordPath(totalFareContainer, "baseFare", "base");
  const taxes = cbPlusRecordPath(totalFareContainer, "taxes", "tax");
  const totalFare = cbPlusRecordPath(totalFareContainer, "totalFare", "equivFare")
    ?? cbPlusRecordPath(pricing, "totalFare", "total");
  const baseAmount = cbPlusMoneyAmount(baseFare);
  const taxesAmount = cbPlusMoneyAmount(taxes);
  const rawTotalAmount = cbPlusMoneyAmount(totalFare);
  const feeSource = totalFareContainer.fees ?? pricing.fees;
  const discountSource = totalFareContainer.discounts ?? pricing.discounts;
  const feeTotal = sumCbPlusAmounts(feeSource);
  const discountTotal = sumCbPlusAmounts(discountSource, (entry) => {
    const description = cbPlusAdjustmentDescription(entry);
    return !description || /discount|descuento|igv/i.test(description);
  });
  const subtotal = rawTotalAmount
    ?? (baseAmount !== undefined || taxesAmount !== undefined
      ? (baseAmount ?? 0) + (taxesAmount ?? 0)
      : undefined);
  const totalAmount = subtotal === undefined ? undefined : subtotal + feeTotal - discountTotal;
  const pricingSystem = pricedItinerary.ticketingInfo?.pricingSystem;
  const validatingAirline = stringValue(
    pricing.validatingAirlineCode
      ?? pricing.validatingAirline
      ?? recordValue(pricing.validatingAirline)?.code,
  );

  return {
    base: baseAmount,
    taxes: taxesAmount,
    total: totalAmount === undefined ? undefined : Number(totalAmount.toFixed(2)),
    fees: feeSource,
    discounts: discountSource,
    source: stringValue(pricingSystem?.code),
    fareQualifier: stringValue(pricing.fareQualifier ?? pricing.fareType),
    validatingAirline,
    totalAmount: totalAmount === undefined ? undefined : Number(totalAmount.toFixed(2)),
  };
}

function mapCbPlusPricedItineraryToCostamarRecommendation(
  pricedItinerary: CbPlusPricedItinerary,
  index: number,
  request: SearchRequest,
): CostamarRecommendation | undefined {
  const recommendationId = `cbplus-${stringValue(pricedItinerary.sequenceNumber ?? pricedItinerary.id) ?? index}`;
  const options = asArray(
    pricedItinerary.airItinerary?.originDestinationOptions?.originDestinationOption,
  );
  if (options.length === 0) {
    return undefined;
  }

  const optionsByJourney = new Map<string, Array<{ option: CbPlusOriginDestinationOption; index: number }>>();
  options.forEach((option, optionIndex) => {
    const key = cbPlusOptionJourneyKey(option, request, optionIndex);
    const group = optionsByJourney.get(key) ?? [];
    group.push({ option, index: optionIndex });
    optionsByJourney.set(key, group);
  });

  const journeyCount = request.tripType === "round-trip" ? 2 : 1;
  const journeyKeys = [...optionsByJourney.keys()]
    .sort((left, right) => (Number(left) || 0) - (Number(right) || 0))
    .slice(0, journeyCount);
  const itinerary = journeyKeys.map((key) => ({
    flights: (optionsByJourney.get(key) ?? [])
      .map(({ option, index: optionIndex }) =>
        mapCbPlusOptionToCostamarFlight(option, recommendationId, optionIndex))
      .filter((flight): flight is CostamarFlight => Boolean(flight)),
  })).filter((journey) => journey.flights.length > 0);

  if (itinerary.length < journeyCount) {
    return undefined;
  }

  const pricingSystem = pricedItinerary.ticketingInfo?.pricingSystem;
  return {
    id: recommendationId,
    itinerary,
    pricing: mapCbPlusPricing(pricedItinerary),
    pos: {
      systemProviderCode: stringValue(pricingSystem?.code),
      codeContext: stringValue(pricingSystem?.codeContext),
      officeId: stringValue(pricingSystem?.pseudoCityCode ?? pricedItinerary.ticketingInfo?.pseudoCityCode),
    },
  };
}

function extractCostamarRecommendations(
  payload: CostamarSearchResponse,
  request: SearchRequest,
): CostamarRecommendation[] {
  const legacyRecommendations = asArray(payload.data);
  if (legacyRecommendations.length > 0) {
    return legacyRecommendations;
  }

  return asArray(payload.pricedItineraries?.pricedItinerary)
    .map((pricedItinerary, index) => mapCbPlusPricedItineraryToCostamarRecommendation(
      pricedItinerary,
      index,
      request,
    ))
    .filter((recommendation): recommendation is CostamarRecommendation => Boolean(recommendation));
}

function ensureCostamarCredentials(context: CostamarProviderContext): void {
  if (!context.terminalId) {
    throw new Error("Click and Book Plus terminalId is required.");
  }
  if (!resolveUsableCostamarBrandedToken(context.token, context.terminalId)) {
    throw new Error("Click and Book Plus token is required.");
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
        "Client-Id": "1d3X65B.e92dCDJss315",
        "Client-Name": "CBPLUS",
        "Application-Name": "cbplus-app",
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
  } catch (error) {
    const timedOut = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
    throw new Error(
      timedOut
        ? `${action} timed out.`
        : `${action} failed before receiving a response.`,
    );
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
  return readCostamarJsonResponse<T>(response, action);
}

function isCostamarB2bUrlAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && COSTAMAR_B2B_ALLOWED_ORIGINS.has(parsed.origin);
  } catch {
    return false;
  }
}

export async function readCostamarJsonResponse<T = Record<string, unknown>>(
  response: Response,
  action: string,
): Promise<T> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${action} failed with HTTP ${response.status}.`);
  }

  const bodyText = await response.text();
  if (!bodyText.trim()) {
    throw new Error(`${action} returned an empty JSON response.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new Error(`${action} returned invalid JSON.`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${action} returned an invalid JSON payload.`);
  }

  return parsed as T;
}

async function getEngineMetadata(context: CostamarProviderContext): Promise<CostamarEngineMetadata> {
  const engineBaseUrl = context.engineBaseUrl?.replace(/\/+$/, "") || context.apiBaseUrl;
  const cacheKey = `${engineBaseUrl}::${context.terminalId}`;
  const cached = engineCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const request = fetchCostamarJson<CostamarEngineMetadata>(
    {
      ...context,
      apiBaseUrl: engineBaseUrl,
    },
    `/engines/${encodeURIComponent(context.terminalId)}`,
    { method: "GET" },
    "Click and Book Plus engine metadata",
  ).catch((error) => {
    engineCache.delete(cacheKey);
    throw error;
  });

  engineCache.set(cacheKey, request);
  return request;
}

export function buildCostamarSearchWarning(payload: CostamarSearchResponse): string | undefined {
  const status = payload.status;
  if (typeof status !== "number" || status < 400) {
    return undefined;
  }

  if (status === 401) {
    return "Click and Book Plus rejected this search: the branded token is invalid, expired, or no longer belongs to this agency.";
  }

  if (status === 402) {
    return "Click and Book Plus rejected this search: the validation token is missing for this branded flow.";
  }

  if (status === 403) {
    return "Click and Book Plus rejected this search: agency or permission validation failed.";
  }

  if (status === 429) {
    return "Click and Book Plus temporarily rate-limited this search.";
  }

  if (status >= 500) {
    return "Click and Book Plus is temporarily unavailable.";
  }

  return `Click and Book Plus rejected this search with status ${status}.`;
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

  const marketingCarrier = value.marketingAirline?.code?.trim().toUpperCase() || "";
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

function costamarRecommendationStableId(recommendation: CostamarRecommendation): string {
  return String(recommendation.id ?? sha1Hex(JSON.stringify(recommendation))).trim() || "recommendation";
}

function buildCostamarScheduleGroupScope(request: SearchRequest): string | undefined {
  const leg = request.legs[0];
  const departureDate = leg?.departureDate;
  const returnDate = request.tripType === "round-trip" ? leg?.returnDate : undefined;
  if (!leg || !departureDate || (request.tripType === "round-trip" && !returnDate)) {
    return undefined;
  }

  return JSON.stringify([
    "costamar",
    request.tripType,
    leg.origin.trim().toUpperCase(),
    leg.destination.trim().toUpperCase(),
    departureDate,
    returnDate ?? null,
  ]);
}

function scheduleVariantProductExceedsLimit(
  optionsByJourney: ReadonlyArray<ReadonlyArray<unknown>>,
): boolean {
  let product = 1;
  for (const options of optionsByJourney) {
    if (options.length > Math.floor(PROVIDER_OFFER_VARIANT_LIMIT / product)) {
      return true;
    }
    product *= options.length;
  }
  return false;
}

function expandCostamarRecommendationFlightOptions(
  recommendation: CostamarRecommendation,
  request: SearchRequest,
): CostamarRecommendation[] {
  const journeys = asArray(recommendation.itinerary);
  const journeyCount = request.tripType === "round-trip" ? 2 : 1;
  const relevantJourneys = journeys.slice(0, journeyCount);
  if (relevantJourneys.length < journeyCount) {
    return [recommendation];
  }

  const optionsByJourney = relevantJourneys.map((journey) =>
    asArray(journey.flights).map((flight, index) => ({ flight, index })),
  );
  if (optionsByJourney.some((options) => options.length === 0)) {
    return [recommendation];
  }
  if (optionsByJourney.every((options) => options.length === 1)) {
    return [recommendation];
  }

  const baseId = costamarRecommendationStableId(recommendation);
  const scheduleVariantsTruncated = scheduleVariantProductExceedsLimit(optionsByJourney);
  let variants: Array<Array<{ flight: CostamarFlight; index: number }>> = [[]];
  for (const options of optionsByJourney) {
    const next: Array<Array<{ flight: CostamarFlight; index: number }>> = [];
    for (const prefix of variants) {
      for (const option of options) {
        next.push([...prefix, option]);
        if (next.length >= PROVIDER_OFFER_VARIANT_LIMIT) break;
      }
      if (next.length >= PROVIDER_OFFER_VARIANT_LIMIT) break;
    }
    variants = next;
  }

  return takeProviderOfferVariants(variants).map((variant) => ({
    ...recommendation,
    id: `${baseId}:${variant.map((option) => option.index).join("-")}`,
    scheduleVariantsTruncated,
    itinerary: relevantJourneys.map((journey, index) => ({
      ...journey,
      flights: [variant[index].flight],
    })),
  }));
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
    return costamarRedirectVerification("blocked", false, "The redirect token belongs to another Click and Book Plus terminal.");
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
  } catch {
    return costamarRedirectVerification(
      "fresh_unverified",
      false,
      "Click and Book Plus redirect validation could not be completed.",
    );
  } finally {
    clearTimeout(timeout);
  }
}

export function safeCostamarRedirectFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : "";
  if (/^La validacion del redirect de Click and Book Plus tardo mas de \d+ms\.$/.test(message)) {
    return message;
  }
  return "No se pudo validar el redirect de Click and Book Plus.";
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
    return `Click and Book Plus redirect is blocked: ${verification.reason ?? "token validation failed"}.`;
  }
  if (verification.state === "refresh_failed") {
    return `Click and Book Plus redirect token refresh failed: ${verification.reason ?? "no usable token was captured"}.`;
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
    || redirectStateRequiresRefresh(redirectVerification.state);

  if (shouldRefresh) {
    recordCostamarWarmupStep(diagnostics, "refresh-start", true, redirectVerification.reason);
    const warmed = await warmCostamarRedirectContext(request, context, { force: options.force });
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
      label: "Buscar en Click and Book Plus",
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

export function isAllowedCostamarBrandedSearchLocation(
  input: string,
  request: SearchRequest,
  context: CostamarProviderContext,
): boolean {
  let candidate: URL;
  try {
    candidate = new URL(input);
  } catch {
    return false;
  }

  if (candidate.protocol !== "https:" || candidate.username || candidate.password) {
    return false;
  }

  const allowedBaseUrls = [
    context.brandBaseUrl,
    "https://booking.clickandbook.com/vuelos",
  ];

  return allowedBaseUrls.some((brandBaseUrl) => {
    try {
      const base = new URL(brandBaseUrl);
      if (
        base.protocol !== "https:"
        || base.username
        || base.password
        || (base.hostname !== "flights.zdev.tech" && base.hostname !== "booking.clickandbook.com")
      ) {
        return false;
      }

      const expected = new URL(buildCostamarBrandedSearchUrl(request, {
        ...context,
        brandBaseUrl: base.toString(),
        token: "",
      }));
      return candidate.origin === expected.origin && candidate.pathname === expected.pathname;
    } catch {
      return false;
    }
  });
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
      scheduleGroupScope: recommendation.scheduleGroupScope,
      scheduleVariantsTruncated: recommendation.scheduleVariantsTruncated === true,
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

  // The engine metadata is only needed when mapping, so it travels alongside the
  // search instead of gating it. Awaiting it after the search keeps today's error
  // semantics (an engine failure still fails the whole search); the no-op catch
  // only prevents an unhandled rejection while the search is in flight.
  const enginePromise = getEngineMetadata(context);
  enginePromise.catch(() => undefined);
  const search = (searchContext: CostamarProviderContext) => fetchCostamarJson<CostamarSearchResponse>(
    searchContext,
    "/searchFlights",
    {
      method: "POST",
      body: JSON.stringify(buildCostamarSearchBody(request, searchContext, flexible)),
    },
    "Click and Book Plus flight search",
  );

  // Start the search without waiting for the metadata, then await the metadata
  // first so an engine failure still wins over a search failure, as it did when
  // the two calls were sequential.
  const initialSearch = (async () => search(context))();
  initialSearch.catch(() => undefined);
  const engine = await enginePromise;
  let payload = await initialSearch;
  let tokenSearchRejected = false;
  if (
    context.token
    && (payload.status === 401 || payload.status === 402)
  ) {
    tokenSearchRejected = true;
  }

  if (tokenSearchRejected) {
    const forcedRedirect = await resolveCostamarRedirectForRequest(request, redirectContext, {
      force: true,
      validateLive: false,
    });
    redirectContext = forcedRedirect.context;
    redirectVerification = forcedRedirect.redirectVerification;
    const refreshedToken = resolveUsableCostamarBrandedToken(redirectContext.token, redirectContext.terminalId);
    if (refreshedToken && refreshedToken !== context.token) {
      payload = await search({
        ...context,
        terminalId: redirectContext.terminalId,
        token: refreshedToken,
        lang: redirectContext.lang,
      });
    }
  }

  const responseWarning = buildCostamarSearchWarning(payload);
  const scheduleGroupScope = buildCostamarScheduleGroupScope(request);
  const recommendations = responseWarning
    ? []
    : extractCostamarRecommendations(payload, request).map((recommendation) => ({
      ...recommendation,
      scheduleGroupScope,
    }));
  const recommendationVariants = recommendations.flatMap((recommendation) =>
    expandCostamarRecommendationFlightOptions(recommendation, request),
  );
  const mapped = recommendationVariants.map((recommendation) => {
    const normalized = mapCostamarRecommendationToOffer(
      recommendation,
      request,
      redirectContext,
      engine,
      redirectVerification,
    );
    return normalized.offer;
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
    warnings.push("Click and Book Plus returned no offers for this search.");
  }

  return {
    offers,
    warnings,
    partial: Boolean(responseWarning),
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
    partial: outcome.partial,
  };
}

export function createLocalCostamarSearchDraft(
  request: SearchRequest,
  providerMeta: ProviderMeta,
): SearchResponse {
  const requestedAt = new Date().toISOString();
  const warning = request.searchMode === "stay-range"
    ? "Consultando Click and Book Plus en paralelo. Los resultados se iran agregando."
    : "Consultando Click and Book Plus. Los resultados se iran agregando.";

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
        error: providerPublicFailureMessage("costamar", error),
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
    warnings.push("Click and Book Plus returned no offers for this date range.");
  }

  return {
    offers,
    warnings,
    partial: outcomes.some((outcome) => Boolean(outcome.error) || outcome.result?.partial === true),
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
    let progressOffers: CanonicalOffer[] = [];
    let progressWarnings: string[] = [];
    try {
      const result = await searchLocalCostamarExactWithRetry(derivedRequest, providerContext);
      aggregatedOffers.push(...result.offers);
      progressOffers = result.offers;
      progressWarnings = result.warnings;
      warnings.push(...result.warnings);
      partial = partial || result.partial;
    } catch (error) {
      const warning = providerPublicFailureMessage("costamar", error);
      partial = true;
      warnings.push(warning);
      progressWarnings = [warning];
    }

    if (onUpdate?.({
      offers: progressOffers,
      warnings: uniqueStrings(progressWarnings),
      partial: true,
      incremental: true,
    }) === false) {
      stopRequested = true;
    }
  }, {
    canContinue: () => !stopRequested,
  });

  const offers = dedupeCostamarOffers(aggregatedOffers);
  const finalWarnings = uniqueStrings(warnings);
  if (offers.length === 0 && finalWarnings.length === 0) {
    finalWarnings.push("Click and Book Plus returned no offers for this date range.");
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
    throw new Error("Click and Book Plus matrix requires departureStart and departureEnd.");
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
        tooltip: "Consultando Click and Book Plus...",
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
        tooltip: "Consultando Click and Book Plus...",
        derivedRequest: buildDerivedRequest(request, departureDate, returnDate),
      } satisfies MatrixCell));

  return {
    cells,
    axes,
    confidenceSummary: buildMatrixConfidenceSummary(cells),
    recommendations: [
      "Matrix loading from Click and Book Plus with useful date combinations only.",
      "Only valid flexible combinations are materialized for Click and Book Plus.",
    ],
    searchMeta: {
      requestedAt,
      completedAt: requestedAt,
      providersUsed: ["costamar"],
      warnings: ["Matrix loading from Click and Book Plus with useful date combinations only."],
      partial: true,
      searchState: "search_partial",
    },
    providerMeta,
    warnings: ["Matrix loading from Click and Book Plus with useful date combinations only."],
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
): Promise<{ offers: Map<string, CanonicalOffer>; partial: boolean }> {
  if (!matchesCostamarNativeFlexibleWindow(request)) {
    return { offers: new Map(), partial: false };
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

  return {
    offers: byKey,
    partial: search.partial,
  };
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
    tooltip: "Click and Book Plus live search.",
  };
}

async function resolveCellPrice(
  derivedRequest: SearchRequest,
  providerContext?: ProviderContext,
): Promise<{ offer?: CanonicalOffer; partial: boolean; warnings: string[] }> {
  const search = await searchLocalCostamarExact(derivedRequest, providerContext);
  const offers = enrichComparisonMetrics(search.offers);

  const offer = offers.reduce<CanonicalOffer | undefined>((best, current) => {
    if (!best || compareByPriceThenDuration(current, best) < 0) {
      return current;
    }

    return best;
  }, undefined);

  return {
    offer,
    partial: search.partial,
    warnings: search.warnings,
  };
}

export async function resolveLocalCostamarMatrixProgressive(
  request: SearchRequest,
  providerContext: ProviderContext | undefined,
  draft: MatrixResponse,
  onCellResolved?: (cell: MatrixCell) => boolean | void,
): Promise<MatrixResponse> {
  let partial = false;
  let stopRequested = false;
  const seedResult = await seedMatrixWithFlexibleSearch(request, providerContext).catch(() => ({
    offers: new Map<string, CanonicalOffer>(),
    partial: true,
  }));
  const seeded = seedResult.offers;
  partial = seedResult.partial;
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
      const resolution = await resolveCellPrice(cell.derivedRequest, providerContext);
      partial = partial || resolution.partial;
      const offer = resolution.offer;
      const nextCell = offer
        ? buildMatrixCellFromOffer(cell, offer, providerContext)
        : {
            ...cell,
            confidence: "unavailable" as const,
            selectable: false,
            stateCode: "chg" as const,
            tooltip: resolution.partial
              ? resolution.warnings[0] ?? "Click and Book Plus search was only partially available."
              : "Click and Book Plus returned no live result for this combination.",
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
        tooltip: providerPublicFailureMessage("costamar", error),
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
    ? ["Matrix finished with partial Click and Book Plus failures."]
    : [seeded.size > 0
        ? "Matrix seeded from Click and Book Plus native flexible search and completed with exact searches."
        : "Matrix built from Click and Book Plus exact searches over useful date combinations."];

  return {
    ...draft,
    cells: resolvedCells,
    confidenceSummary: buildMatrixConfidenceSummary(resolvedCells),
    recommendations: [
      "Matrix keeps only useful date combinations based on the requested stay window.",
      seeded.size > 0
        ? "Click and Book Plus native flexible search was used as a seed before exact lookups."
        : "Selecting a cell runs a full Click and Book Plus exact search for offers.",
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

export function mapCostamarLocationSuggestion(
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
    type: normalizeLocationSuggestionType(entry.type),
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
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Click and Book Plus location suggest failed with HTTP ${response.status}.`);
    }

    const rawPayload = await response.json() as unknown;
    const rawAirports = rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload)
      ? (rawPayload as { airports?: unknown }).airports
      : undefined;
    const airports = Array.isArray(rawAirports)
      ? rawAirports.filter((entry): entry is CostamarAutocompleteAirport => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
      : [];
    const suggestions = airports
      .map((entry) => mapCostamarLocationSuggestion(entry))
      .filter((entry): entry is LocationSuggestion => Boolean(entry));

    return rankLocationSuggestions(normalizedQuery, suggestions, limit);
  } finally {
    clearTimeout(timeout);
  }
}
