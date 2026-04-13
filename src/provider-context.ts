import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CostamarProviderContext,
  CostamarProviderConfigInput,
  ProviderConfigInput,
  ProviderContext,
  ProviderId,
} from "./core/types";

export const DEFAULT_COSTAMAR_API_BASE_URL = "https://costamar.com.pe/vuelos/api";
export const DEFAULT_COSTAMAR_BRAND_BASE_URL = "https://booking.clickandbook.com/vuelos";
export const DEFAULT_COSTAMAR_TERMINAL_ID = "0721808110";
const DEFAULT_CHROME_USER_DATA_DIR = join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "User Data");
const COSTAMAR_SESSION_CACHE_TTL_MS = 30000;
const COSTAMAR_TOKEN_REFRESH_WINDOW_MS = 2 * 60 * 1000;
const COSTAMAR_BRANDED_URL_REGEX = /https:\/\/booking\.clickandbook\.com\/vuelos\/b\/[^\s\x00?]+\?[^\s\x00]*/gi;
const COSTAMAR_BRANDED_URL_ENCODED_REGEX =
  /https%(?:25)?3A%(?:25)?2F%(?:25)?2Fbooking\.clickandbook\.com%(?:25)?2Fvuelos%(?:25)?2Fb%(?:25)?2F[A-Za-z0-9%._~!$'()*+,;=:@/?&-]*/gi;
const COSTAMAR_BRANDED_URL_ESCAPED_REGEX =
  /https:\\\/\\\/booking\.clickandbook\.com\\\/vuelos\\\/b\\\/[A-Za-z0-9%._~!$'()*+,;=:@/?&=-]*/gi;
const COSTAMAR_JWT_PREFIX_REGEX = /^([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/;
const COSTAMAR_TOKEN_SAFE_PREFIX_REGEX = /^[A-Za-z0-9._-]+/;
const COSTAMAR_SESSION_FILE_REGEX = /^(?:(?:Session|Tabs)_\d+|(?:Current|Last) (?:Session|Tabs))$/;
const COSTAMAR_STORAGE_ARTIFACT_REGEX = /\.(?:ldb|log)$/i;
const COSTAMAR_STORAGE_ARTIFACT_LIMIT = 12;
const COSTAMAR_API_HOSTS = new Set(["costamar.com.pe"]);
const COSTAMAR_BRAND_HOSTS = new Set(["booking.clickandbook.com"]);

interface CostamarSessionCandidate {
  terminalId: string;
  token: string;
  iatMs: number;
  expMs: number;
  source: string;
}

let cachedCostamarSessions:
  | { readAtMs: number; candidates: CostamarSessionCandidate[] }
  | undefined;
const runtimeCostamarSessionCandidates = new Map<string, CostamarSessionCandidate>();

function costamarCdpTabScanEnabled(): boolean {
  return String(process.env.COSTAMAR_CDP_TAB_SCAN_ENABLED ?? "0").trim() !== "0";
}

function stringOrFallback(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized ? normalized : fallback;
}

function normalizeAllowedHttpsUrl(
  value: string | undefined,
  fallback: string,
  allowedHosts: Set<string>,
  label: string,
): string {
  const normalized = stringOrFallback(value, fallback);
  let parsed: URL;

  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL.`);
  }

  if (parsed.protocol !== "https:" || !allowedHosts.has(parsed.hostname.toLowerCase())) {
    throw new Error(`${label} must use https and an approved host.`);
  }

  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString();
}

function decodeCostamarJwtPayload(
  token: string,
): { iat?: number; exp?: number; id?: string; terminalId?: string } {
  try {
    return JSON.parse(
      Buffer.from(token.split(".")[1]?.replace(/-/g, "+").replace(/_/g, "/") ?? "", "base64").toString("utf8"),
    ) as { iat?: number; exp?: number; id?: string; terminalId?: string };
  } catch {
    return {};
  }
}

function decodeJwtHeader(token: string): { alg?: string; typ?: string } {
  try {
    return JSON.parse(
      Buffer.from(token.split(".")[0]?.replace(/-/g, "+").replace(/_/g, "/") ?? "", "base64").toString("utf8"),
    ) as { alg?: string; typ?: string };
  } catch {
    return {};
  }
}

function expectedJwtSignatureLength(token: string): number | undefined {
  const algorithm = decodeJwtHeader(token).alg;
  if (algorithm === "HS256") {
    return 43;
  }

  if (algorithm === "HS384") {
    return 64;
  }

  if (algorithm === "HS512") {
    return 86;
  }

  return undefined;
}

function decodeJwtTimes(token: string): { iatMs: number; expMs: number } {
  const payload = decodeCostamarJwtPayload(token);
  return {
    iatMs: typeof payload.iat === "number" ? payload.iat * 1000 : 0,
    expMs: typeof payload.exp === "number" ? payload.exp * 1000 : 0,
  };
}

function decodeCostamarTokenTerminalId(token: string): string | undefined {
  const payload = decodeCostamarJwtPayload(token);
  const terminalId = typeof payload.id === "string"
    ? payload.id
    : typeof payload.terminalId === "string"
      ? payload.terminalId
      : undefined;
  return terminalId?.trim() || undefined;
}

export function sanitizeCostamarToken(token: string | undefined): string {
  const normalized = token?.trim() ?? "";
  if (!normalized) {
    return "";
  }

  const jwtMatch = normalized.match(COSTAMAR_JWT_PREFIX_REGEX);
  if (jwtMatch?.[1]) {
    const jwtToken = jwtMatch[1];
    const expectedSignatureLength = expectedJwtSignatureLength(jwtToken);
    if (!expectedSignatureLength) {
      return jwtToken;
    }

    const segments = jwtToken.split(".");
    if (segments.length !== 3) {
      return jwtToken;
    }

    const [header, payload, signature] = segments;
    if (signature.length <= expectedSignatureLength) {
      return jwtToken;
    }

    return `${header}.${payload}.${signature.slice(0, expectedSignatureLength)}`;
  }

  return normalized.match(COSTAMAR_TOKEN_SAFE_PREFIX_REGEX)?.[0] ?? normalized;
}

export function costamarTokenMatchesTerminal(
  token: string | undefined,
  terminalId: string | undefined,
): boolean {
  const normalizedTerminalId = terminalId?.trim();
  if (!normalizedTerminalId) {
    return true;
  }

  const normalizedToken = sanitizeCostamarToken(token);
  if (!normalizedToken) {
    return true;
  }

  const tokenTerminalId = decodeCostamarTokenTerminalId(normalizedToken);
  return !tokenTerminalId || tokenTerminalId === normalizedTerminalId;
}

export function resolveUsableCostamarBrandedToken(
  token: string | undefined,
  terminalId: string | undefined,
  nowMs = Date.now(),
): string | undefined {
  const normalized = sanitizeCostamarToken(token);
  if (!normalized || !costamarTokenMatchesTerminal(normalized, terminalId)) {
    return undefined;
  }

  const { expMs } = decodeJwtTimes(normalized);
  if (expMs > 0 && expMs <= nowMs) {
    return undefined;
  }

  return normalized;
}

function runtimeCostamarCandidates(): CostamarSessionCandidate[] {
  return [...runtimeCostamarSessionCandidates.values()];
}

export function rememberCostamarSessionCandidate(
  input: { terminalId?: string; token?: string; source?: string },
): void {
  const token = sanitizeCostamarToken(input.token);
  const terminalId = input.terminalId?.trim() || decodeCostamarTokenTerminalId(token);
  if (!token || !terminalId || !costamarTokenMatchesTerminal(token, terminalId)) {
    return;
  }

  const { iatMs, expMs } = decodeJwtTimes(token);
  if (expMs > 0 && expMs <= Date.now()) {
    return;
  }

  const nextCandidate: CostamarSessionCandidate = {
    terminalId,
    token,
    iatMs,
    expMs,
    source: input.source?.trim() || "runtime",
  };
  const previous = runtimeCostamarSessionCandidates.get(terminalId);
  if (!previous) {
    runtimeCostamarSessionCandidates.set(terminalId, nextCandidate);
    return;
  }

  const preferred = pickLatestCostamarSessionCandidate([previous, nextCandidate]);
  runtimeCostamarSessionCandidates.set(terminalId, preferred ?? nextCandidate);
}

function readRepoCostamarUserDataDirCandidates(): string[] {
  return [
    join(process.cwd(), "profiles", "costamar-agent"),
    join(process.cwd(), "output", "chrome-costamar-manual"),
  ].filter((candidate) => existsSync(candidate));
}

function readChromeUserDataDirCandidates(includeConfiguredOnly = false): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const explicitCostamarUserDataDirs = [
    process.env.COSTAMAR_CHROME_USER_DATA_DIR?.trim(),
    process.env.COSTAMAR_AGENT_CHROME_USER_DATA_DIR?.trim(),
  ].filter((value): value is string => Boolean(value));
  const pushUnique = (value?: string) => {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) {
      return;
    }

    seen.add(normalized);
    candidates.push(normalized);
  };

  explicitCostamarUserDataDirs.forEach((candidate) => pushUnique(candidate));
  if (explicitCostamarUserDataDirs.length > 0) {
    return candidates;
  }

  if (explicitCostamarUserDataDirs.length === 0) {
    readRepoCostamarUserDataDirCandidates().forEach((candidate) => pushUnique(candidate));
  }

  if (!includeConfiguredOnly) {
    pushUnique(process.env.AGIL_CHROME_USER_DATA_DIR?.trim());
    pushUnique(DEFAULT_CHROME_USER_DATA_DIR);
  }

  return candidates;
}

function resolveConfiguredChromeProfile(): string | undefined {
  const configured = process.env.COSTAMAR_CHROME_PROFILE?.trim()
    ?? process.env.AGIL_CHROME_PROFILE?.trim();
  return configured || undefined;
}

export function resolveChromeDevToolsBrowserWsEndpoint(userDataDir: string): string | undefined {
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
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      return undefined;
    }

    if (!normalizedPath.startsWith("/")) {
      return undefined;
    }

    return `ws://127.0.0.1:${port}${normalizedPath}`;
  } catch {
    return undefined;
  }
}

function readChromeProfileCandidates(userDataDir: string, includeConfiguredOnly = false): string[] {
  const configured = resolveConfiguredChromeProfile();
  if (configured) {
    if (includeConfiguredOnly) {
      return [configured];
    }
  }

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

  pushUnique(configured);

  try {
    const localStatePath = join(userDataDir, "Local State");
    const raw = readFileSync(localStatePath, "utf8");
    const parsed = JSON.parse(raw) as {
      profile?: { last_used?: string; info_cache?: Record<string, unknown> };
    };
    pushUnique(parsed.profile?.last_used);
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
    // Ignore and fall back to Default.
  }

  pushUnique("Default");
  return candidates;
}

function isCostamarTokenNearExpiry(
  token: string | undefined,
  terminalId: string | undefined,
  nowMs = Date.now(),
  refreshWindowMs = COSTAMAR_TOKEN_REFRESH_WINDOW_MS,
): boolean {
  const usableToken = resolveUsableCostamarBrandedToken(token, terminalId, nowMs);
  if (!usableToken) {
    return false;
  }

  const { expMs } = decodeJwtTimes(usableToken);
  return expMs > 0 && expMs <= (nowMs + refreshWindowMs);
}

function decodeEmbeddedUrl(raw: string): string {
  let current = raw;

  for (let iteration = 0; iteration < 3; iteration += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (!decoded || decoded === current) {
        break;
      }
      current = decoded;
    } catch {
      break;
    }
  }

  return current;
}

export function extractCostamarSessionCandidates(
  text: string,
  source = "session",
): CostamarSessionCandidate[] {
  const matches = [
    ...(text.match(COSTAMAR_BRANDED_URL_REGEX) ?? []),
    ...(text.match(COSTAMAR_BRANDED_URL_ENCODED_REGEX) ?? []).map((match) => decodeEmbeddedUrl(match.split("&")[0] ?? match)),
    ...(text.match(COSTAMAR_BRANDED_URL_ESCAPED_REGEX) ?? []).map((match) => match.replace(/\\\//g, "/")),
  ];
  const deduped = new Map<string, CostamarSessionCandidate>();

  for (const rawMatch of matches) {
    const sanitized = rawMatch.split("\x00")[0];

    try {
      const parsed = new URL(sanitized);
      const token = sanitizeCostamarToken(parsed.searchParams.get("token")?.trim() ?? "");
      const terminalId = parsed.searchParams.get("terminalId")?.trim() ?? "";
      if (!token || !terminalId || !costamarTokenMatchesTerminal(token, terminalId)) {
        continue;
      }

      const { iatMs, expMs } = decodeJwtTimes(token);
      const key = `${terminalId}::${token}`;
      deduped.set(key, {
        terminalId,
        token,
        iatMs,
        expMs,
        source,
      });
    } catch {
      // Ignore malformed matches.
    }
  }

  return [...deduped.values()];
}

function extractCostamarSessionCandidatesFromBuffer(
  buffer: Buffer,
  source: string,
): CostamarSessionCandidate[] {
  const deduped = new Map<string, CostamarSessionCandidate>();
  const variants = [
    extractCostamarSessionCandidates(buffer.toString("latin1"), source),
    extractCostamarSessionCandidates(buffer.toString("utf16le"), `${source}:utf16le`),
  ];

  variants.flat().forEach((candidate) => {
    deduped.set(`${candidate.terminalId}::${candidate.token}`, candidate);
  });

  return [...deduped.values()];
}

export function pickLatestCostamarSessionCandidate(
  candidates: CostamarSessionCandidate[],
  nowMs = Date.now(),
): CostamarSessionCandidate | undefined {
  const pool = candidates.filter((candidate) => candidate.expMs > nowMs);
  const ranked = (pool.length > 0 ? pool : candidates)
    .slice()
    .sort((left, right) => {
      if (right.expMs !== left.expMs) return right.expMs - left.expMs;
      return right.iatMs - left.iatMs;
    });

  return ranked[0];
}

function pickLatestCostamarSessionCandidateForTerminal(
  candidates: CostamarSessionCandidate[],
  terminalId: string | undefined,
  nowMs = Date.now(),
): CostamarSessionCandidate | undefined {
  const normalizedTerminalId = terminalId?.trim();
  const scoped = normalizedTerminalId
    ? candidates.filter((candidate) => candidate.terminalId === normalizedTerminalId)
    : candidates;
  return pickLatestCostamarSessionCandidate(scoped, nowMs);
}

function shouldRefreshCostamarToken(
  currentToken: string | undefined,
  candidate: CostamarSessionCandidate | undefined,
  nowMs = Date.now(),
  preferCandidateForOpaqueToken = false,
): boolean {
  const normalized = currentToken?.trim();
  if (!candidate) {
    return false;
  }

  if (!normalized) {
    return true;
  }

  if (!costamarTokenMatchesTerminal(normalized, candidate.terminalId)) {
    return true;
  }

  if (candidate.token === normalized) {
    return false;
  }

  const currentTimes = decodeJwtTimes(normalized);
  if (currentTimes.expMs > 0 && currentTimes.expMs <= nowMs) {
    return true;
  }

  if (candidate.expMs > 0 && candidate.expMs <= nowMs) {
    return false;
  }

  if (currentTimes.iatMs === 0 && currentTimes.expMs === 0) {
    return preferCandidateForOpaqueToken;
  }

  if (candidate.iatMs > currentTimes.iatMs) {
    return true;
  }

  if (candidate.expMs > currentTimes.expMs) {
    return true;
  }

  return false;
}

function copyCostamarSessionsToTemp(userDataDir: string, profileName: string): string | undefined {
  const source = join(userDataDir, profileName, "Sessions");
  if (!existsSync(source)) {
    return undefined;
  }

  const destination = join(tmpdir(), `travel_quote_foundation_costamar_${randomUUID()}`);
  mkdirSync(destination, { recursive: true });

  for (const entry of readdirSync(source)) {
    try {
      copyFileSync(join(source, entry), join(destination, entry));
    } catch {
      // Skip locked session files.
    }
  }

  return destination;
}

function readCostamarSessionCandidatesFromCopiedDir(
  directory: string,
  profileName: string,
): CostamarSessionCandidate[] {
  const files = readdirSync(directory)
    .filter((name) => COSTAMAR_SESSION_FILE_REGEX.test(name))
    .map((name) => ({
      name,
      fullPath: join(directory, name),
      mtimeMs: statSync(join(directory, name)).mtimeMs,
    }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  const candidates: CostamarSessionCandidate[] = [];
  for (const file of files) {
    try {
      const buffer = readFileSync(file.fullPath);
      candidates.push(
        ...extractCostamarSessionCandidatesFromBuffer(buffer, `${profileName}/${file.name}`),
      );
    } catch {
      // Ignore individual session files.
    }
  }

  return candidates;
}

function copyChromeArtifactToTemp(userDataDir: string, profileName: string, relativePath: string): string | undefined {
  const source = join(userDataDir, profileName, relativePath);
  if (!existsSync(source)) {
    return undefined;
  }

  const destination = join(
    tmpdir(),
    `travel_quote_foundation_costamar_${relativePath.replace(/[\\\/:\s]+/g, "_")}_${randomUUID()}`,
  );

  try {
    copyFileSync(source, destination);
    return destination;
  } catch {
    return undefined;
  }
}

function readCostamarCandidatesFromChromeArtifact(
  userDataDir: string,
  profileName: string,
  relativePath: string,
): CostamarSessionCandidate[] {
  const tempFile = copyChromeArtifactToTemp(userDataDir, profileName, relativePath);
  if (!tempFile) {
    return [];
  }

  try {
    const buffer = readFileSync(tempFile);
    return extractCostamarSessionCandidatesFromBuffer(buffer, `${profileName}/${relativePath}`);
  } catch {
    return [];
  } finally {
    rmSync(tempFile, { force: true });
  }
}

function readCostamarCandidatesFromChromeArtifactDirectory(
  userDataDir: string,
  profileName: string,
  relativePath: string,
): CostamarSessionCandidate[] {
  const directory = join(userDataDir, profileName, relativePath);
  if (!existsSync(directory)) {
    return [];
  }

  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && COSTAMAR_STORAGE_ARTIFACT_REGEX.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      fullPath: join(directory, entry.name),
      mtimeMs: statSync(join(directory, entry.name)).mtimeMs,
    }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, COSTAMAR_STORAGE_ARTIFACT_LIMIT);

  const candidates: CostamarSessionCandidate[] = [];
  for (const file of files) {
    const tempFile = join(
      tmpdir(),
      `travel_quote_foundation_costamar_${relativePath.replace(/[\\\/:\s]+/g, "_")}_${randomUUID()}_${file.name}`,
    );

    try {
      copyFileSync(file.fullPath, tempFile);
      const buffer = readFileSync(tempFile);
      candidates.push(
        ...extractCostamarSessionCandidatesFromBuffer(buffer, `${profileName}/${relativePath}/${file.name}`),
      );
    } catch {
      // Ignore locked or malformed storage artifacts.
    } finally {
      rmSync(tempFile, { force: true });
    }
  }

  return candidates;
}

function collectCostamarSessionCandidatesFromChromeProfiles(
  userDataDir: string,
  profileNames: string[],
): CostamarSessionCandidate[] {
  const candidates: CostamarSessionCandidate[] = [];

  for (const profileName of profileNames) {
    const tempSessionsDir = copyCostamarSessionsToTemp(userDataDir, profileName);
    if (tempSessionsDir) {
      try {
        candidates.push(...readCostamarSessionCandidatesFromCopiedDir(tempSessionsDir, profileName));
      } finally {
        rmSync(tempSessionsDir, { recursive: true, force: true });
      }
    }

    candidates.push(
      ...readCostamarCandidatesFromChromeArtifact(userDataDir, profileName, "History"),
      ...readCostamarCandidatesFromChromeArtifact(userDataDir, profileName, "Favicons"),
      ...readCostamarCandidatesFromChromeArtifactDirectory(userDataDir, profileName, "Session Storage"),
      ...readCostamarCandidatesFromChromeArtifactDirectory(userDataDir, profileName, join("Local Storage", "leveldb")),
    );
  }

  return candidates;
}

function readCostamarCandidatesViaCDP(userDataDir: string): CostamarSessionCandidate[] {
  if (!costamarCdpTabScanEnabled()) {
    return [];
  }

  const browserWsEndpoint = resolveChromeDevToolsBrowserWsEndpoint(userDataDir);
  if (!browserWsEndpoint) {
    return [];
  }

  const script = [
    "const endpoint = process.argv[1];",
    "const finish = (value = '') => { try { process.stdout.write(value); } catch {} process.exit(0); };",
    "const fail = () => finish('');",
    "const socket = new WebSocket(endpoint);",
    "const timer = setTimeout(fail, 4000);",
    "socket.addEventListener('open', () => {",
    "  socket.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }));",
    "});",
    "socket.addEventListener('message', (event) => {",
    "  try {",
    "    const payload = JSON.parse(String(event.data));",
    "    if (payload?.id !== 1) return;",
    "    clearTimeout(timer);",
    "    finish(JSON.stringify(payload?.result?.targetInfos ?? []));",
    "  } catch {",
    "    fail();",
    "  }",
    "});",
    "socket.addEventListener('error', fail);",
    "socket.addEventListener('close', () => clearTimeout(timer));",
  ].join("");

  const result = spawnSync(process.execPath, ["-e", script, browserWsEndpoint], {
    timeout: 5000,
    encoding: "utf8",
    windowsHide: true,
  });

  if (result.status !== 0 || !result.stdout) return [];

  try {
    const tabs = JSON.parse(result.stdout);
    if (!Array.isArray(tabs)) return [];

    const candidates: CostamarSessionCandidate[] = [];
    for (const tab of tabs) {
      const url = typeof tab?.url === "string" ? tab.url : "";
      if (url) {
        candidates.push(...extractCostamarSessionCandidates(url, "cdp"));
      }
    }
    return candidates;
  } catch {
    return [];
  }
}

function collectCostamarSessionCandidatesFromChromeUserDataDir(
  userDataDir: string,
  includeConfiguredProfilesOnly = false,
): CostamarSessionCandidate[] {
  const profileNames = readChromeProfileCandidates(userDataDir, includeConfiguredProfilesOnly);
  return [
    ...collectCostamarSessionCandidatesFromChromeProfiles(userDataDir, profileNames),
    ...readCostamarCandidatesViaCDP(userDataDir),
  ];
}

function readCostamarSessionCandidateFromChrome(
  terminalId?: string,
  options?: { bypassCache?: boolean },
): CostamarSessionCandidate | undefined {
  if (
    !options?.bypassCache
    && cachedCostamarSessions
    && (Date.now() - cachedCostamarSessions.readAtMs) < COSTAMAR_SESSION_CACHE_TTL_MS
  ) {
    return pickLatestCostamarSessionCandidateForTerminal(
      [...runtimeCostamarCandidates(), ...cachedCostamarSessions.candidates],
      terminalId,
    );
  }

  const configuredUserDataDirs = readChromeUserDataDirCandidates(true);
  const allUserDataDirs = readChromeUserDataDirCandidates();
  const configuredProfile = resolveConfiguredChromeProfile();
  let candidates = configuredUserDataDirs.flatMap((userDataDir) =>
    collectCostamarSessionCandidatesFromChromeUserDataDir(userDataDir, true)
  );
  let preferredCandidate = pickLatestCostamarSessionCandidateForTerminal(candidates, terminalId);
  let preferredCandidateIsUsable = Boolean(
    preferredCandidate && resolveUsableCostamarBrandedToken(preferredCandidate.token, preferredCandidate.terminalId),
  );

  if (!preferredCandidateIsUsable && configuredProfile) {
    candidates = candidates.concat(
      configuredUserDataDirs.flatMap((userDataDir) =>
        collectCostamarSessionCandidatesFromChromeUserDataDir(userDataDir)
      ),
    );
    preferredCandidate = pickLatestCostamarSessionCandidateForTerminal(candidates, terminalId);
    preferredCandidateIsUsable = Boolean(
      preferredCandidate && resolveUsableCostamarBrandedToken(preferredCandidate.token, preferredCandidate.terminalId),
    );
  }

  if (!preferredCandidateIsUsable) {
    const fallbackUserDataDirs = allUserDataDirs.filter((userDataDir) => !configuredUserDataDirs.includes(userDataDir));
    candidates = candidates.concat(
      fallbackUserDataDirs.flatMap((userDataDir) =>
        collectCostamarSessionCandidatesFromChromeUserDataDir(userDataDir)
      ),
    );
  }

  cachedCostamarSessions = {
    readAtMs: Date.now(),
    candidates,
  };
  return pickLatestCostamarSessionCandidateForTerminal(
    [...runtimeCostamarCandidates(), ...candidates],
    terminalId,
  );
}

function maybeRefreshCostamarSessionCandidate(
  currentToken: string | undefined,
  terminalId: string | undefined,
  candidate: CostamarSessionCandidate | undefined,
  nowMs = Date.now(),
): CostamarSessionCandidate | undefined {
  const currentTokenIsUsable = Boolean(resolveUsableCostamarBrandedToken(currentToken, terminalId, nowMs));
  const candidateIsUsable = Boolean(
    candidate && resolveUsableCostamarBrandedToken(candidate.token, candidate.terminalId, nowMs),
  );
  if (
    currentTokenIsUsable || candidateIsUsable
  ) {
    if (
      isCostamarTokenNearExpiry(currentToken, terminalId, nowMs)
      || (candidate && isCostamarTokenNearExpiry(candidate.token, candidate.terminalId, nowMs))
    ) {
      return readCostamarSessionCandidateFromChrome(terminalId, { bypassCache: true }) ?? candidate;
    }

    return candidate;
  }

  return readCostamarSessionCandidateFromChrome(terminalId, { bypassCache: true }) ?? candidate;
}

export function resetCostamarSessionCacheForTests(): void {
  cachedCostamarSessions = undefined;
  runtimeCostamarSessionCandidates.clear();
}

export function resolveProviderId(providerId?: ProviderId): ProviderId {
  return providerId === "costamar" ? "costamar" : "agil-local";
}

export function normalizeCostamarProviderContext(
  input?: CostamarProviderConfigInput,
): CostamarProviderContext {
  const normalizedToken = sanitizeCostamarToken(input?.token ?? process.env.COSTAMAR_TOKEN ?? "");
  return {
    apiBaseUrl: normalizeAllowedHttpsUrl(
      process.env.COSTAMAR_API_BASE_URL,
      DEFAULT_COSTAMAR_API_BASE_URL,
      COSTAMAR_API_HOSTS,
      "COSTAMAR_API_BASE_URL",
    ),
    brandBaseUrl: normalizeAllowedHttpsUrl(
      process.env.COSTAMAR_BRAND_BASE_URL,
      DEFAULT_COSTAMAR_BRAND_BASE_URL,
      COSTAMAR_BRAND_HOSTS,
      "COSTAMAR_BRAND_BASE_URL",
    ),
    terminalId: stringOrFallback(
      input?.terminalId ?? process.env.COSTAMAR_TERMINAL_ID,
      DEFAULT_COSTAMAR_TERMINAL_ID,
    ),
    token: normalizedToken,
    lang: stringOrFallback(
      input?.lang ?? process.env.COSTAMAR_LANG,
      "es",
    ),
  };
}

export function resolveCostamarProviderContext(
  input?: CostamarProviderConfigInput,
): CostamarProviderContext {
  const normalized = normalizeCostamarProviderContext(input);
  const compatibleToken = costamarTokenMatchesTerminal(normalized.token, normalized.terminalId)
    ? normalized.token
    : "";
  const nowMs = Date.now();
  const sessionCandidate = maybeRefreshCostamarSessionCandidate(
    compatibleToken,
    normalized.terminalId,
    readCostamarSessionCandidateFromChrome(normalized.terminalId),
    nowMs,
  );
  const shouldRefresh = shouldRefreshCostamarToken(compatibleToken, sessionCandidate, nowMs);
  if (compatibleToken && normalized.terminalId && !shouldRefresh) {
    return {
      ...normalized,
      token: compatibleToken,
    };
  }

  return normalizeCostamarProviderContext({
    ...normalized,
    terminalId: normalized.terminalId || sessionCandidate?.terminalId,
    token: shouldRefresh
      ? sessionCandidate?.token || compatibleToken
      : compatibleToken || sessionCandidate?.token,
  });
}

export function resolveLatestCostamarProviderContext(
  input?: CostamarProviderConfigInput,
): CostamarProviderContext {
  const normalized = normalizeCostamarProviderContext(input);
  const compatibleToken = costamarTokenMatchesTerminal(normalized.token, normalized.terminalId)
    ? normalized.token
    : "";
  const nowMs = Date.now();
  const sessionCandidate = maybeRefreshCostamarSessionCandidate(
    compatibleToken,
    normalized.terminalId,
    readCostamarSessionCandidateFromChrome(normalized.terminalId),
    nowMs,
  );
  const shouldRefresh = shouldRefreshCostamarToken(compatibleToken, sessionCandidate, nowMs, true);
  if (!sessionCandidate) {
    return {
      ...normalized,
      token: compatibleToken,
    };
  }

  return normalizeCostamarProviderContext({
    ...normalized,
    terminalId: normalized.terminalId || sessionCandidate.terminalId,
    token: shouldRefresh
      ? sessionCandidate.token || compatibleToken
      : compatibleToken || sessionCandidate.token,
  });
}

export function buildProviderContext(
  providerId: ProviderId,
  providerConfig?: ProviderConfigInput,
): ProviderContext | undefined {
  if (providerId !== "costamar") {
    return undefined;
  }

  return {
    costamar: resolveCostamarProviderContext(providerConfig?.costamar),
  };
}

export function getCostamarProviderContext(providerContext?: ProviderContext): CostamarProviderContext {
  return resolveCostamarProviderContext(providerContext?.costamar);
}

export interface CostamarTokenStatus {
  terminalId: string;
  hasToken: boolean;
  tokenUsable: boolean;
  tokenExpiresAt?: string;
  minutesRemaining?: number;
}

export function getCostamarTokenStatus(): CostamarTokenStatus {
  const context = resolveLatestCostamarProviderContext();
  const usableToken = resolveUsableCostamarBrandedToken(context.token, context.terminalId);
  const times = usableToken ? decodeJwtTimes(usableToken) : { iatMs: 0, expMs: 0 };

  return {
    terminalId: context.terminalId,
    hasToken: Boolean(context.token),
    tokenUsable: Boolean(usableToken),
    tokenExpiresAt: times.expMs > 0 ? new Date(times.expMs).toISOString() : undefined,
    minutesRemaining: times.expMs > 0 ? Math.max(0, Math.round((times.expMs - Date.now()) / 60000)) : undefined,
  };
}

export async function verifyCostamarTokenLive(
  context?: CostamarProviderContext,
): Promise<{ valid: boolean; reason?: string }> {
  const ctx = context ?? resolveLatestCostamarProviderContext();
  const usableToken = resolveUsableCostamarBrandedToken(ctx.token, ctx.terminalId);
  if (!usableToken) {
    return { valid: false, reason: "Token expirado o incompatible" };
  }

  try {
    const response = await fetch(
      `${ctx.apiBaseUrl}/engines/${encodeURIComponent(ctx.terminalId)}`,
      {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (response.ok) {
      return { valid: true };
    }
    return { valid: false, reason: `API respondió ${response.status}` };
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : "Error desconocido" };
  }
}
