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
const COSTAMAR_BRANDED_URL_REGEX = /https:\/\/booking\.clickandbook\.com\/vuelos\/b\/[A-Z]{3}\/[A-Z]{3}(?:\/\d{4}-\d{2}-\d{2}){1,2}\/\d+\/\d+\/\d+\?[^\s\x00]*/gi;
const COSTAMAR_JWT_PREFIX_REGEX = /^([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/;
const COSTAMAR_TOKEN_SAFE_PREFIX_REGEX = /^[A-Za-z0-9._-]+/;
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

let cachedCostamarSession:
  | { readAtMs: number; candidate?: CostamarSessionCandidate }
  | undefined;

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

function decodeJwtTimes(token: string): { iatMs: number; expMs: number } {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1]?.replace(/-/g, "+").replace(/_/g, "/") ?? "", "base64").toString("utf8"),
    ) as { iat?: number; exp?: number };

    return {
      iatMs: typeof payload.iat === "number" ? payload.iat * 1000 : 0,
      expMs: typeof payload.exp === "number" ? payload.exp * 1000 : 0,
    };
  } catch {
    return {
      iatMs: 0,
      expMs: 0,
    };
  }
}

function sanitizeExtractedCostamarToken(token: string): string {
  const normalized = token.trim();
  if (!normalized) {
    return "";
  }

  const jwtMatch = normalized.match(COSTAMAR_JWT_PREFIX_REGEX);
  if (jwtMatch?.[1]) {
    return jwtMatch[1];
  }

  return normalized.match(COSTAMAR_TOKEN_SAFE_PREFIX_REGEX)?.[0] ?? normalized;
}

function resolveChromeUserDataDir(): string {
  return stringOrFallback(
    process.env.COSTAMAR_CHROME_USER_DATA_DIR?.trim()
      ?? process.env.AGIL_CHROME_USER_DATA_DIR?.trim(),
    DEFAULT_CHROME_USER_DATA_DIR,
  );
}

function readChromeProfileCandidates(): string[] {
  const configured = process.env.COSTAMAR_CHROME_PROFILE?.trim()
    ?? process.env.AGIL_CHROME_PROFILE?.trim();
  if (configured) {
    return [configured];
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

  try {
    const localStatePath = join(resolveChromeUserDataDir(), "Local State");
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
    readdirSync(resolveChromeUserDataDir(), { withFileTypes: true })
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

export function extractCostamarSessionCandidates(
  text: string,
  source = "session",
): CostamarSessionCandidate[] {
  const matches = text.match(COSTAMAR_BRANDED_URL_REGEX) ?? [];
  const deduped = new Map<string, CostamarSessionCandidate>();

  for (const rawMatch of matches) {
    const sanitized = rawMatch.split("\x00")[0];

    try {
      const parsed = new URL(sanitized);
      const token = sanitizeExtractedCostamarToken(parsed.searchParams.get("token")?.trim() ?? "");
      const terminalId = parsed.searchParams.get("terminalId")?.trim() ?? "";
      if (!token || !terminalId) {
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

function copyCostamarSessionsToTemp(profileName: string): string | undefined {
  const source = join(resolveChromeUserDataDir(), profileName, "Sessions");
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
    .filter((name) => /^(Session|Tabs)_/.test(name))
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

function copyChromeArtifactToTemp(profileName: string, relativePath: string): string | undefined {
  const source = join(resolveChromeUserDataDir(), profileName, relativePath);
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
  profileName: string,
  relativePath: string,
): CostamarSessionCandidate[] {
  const tempFile = copyChromeArtifactToTemp(profileName, relativePath);
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
  profileName: string,
  relativePath: string,
): CostamarSessionCandidate[] {
  const directory = join(resolveChromeUserDataDir(), profileName, relativePath);
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

function readCostamarSessionCandidateFromChrome(): CostamarSessionCandidate | undefined {
  if (cachedCostamarSession && (Date.now() - cachedCostamarSession.readAtMs) < COSTAMAR_SESSION_CACHE_TTL_MS) {
    return cachedCostamarSession.candidate;
  }

  const candidates: CostamarSessionCandidate[] = [];

  for (const profileName of readChromeProfileCandidates()) {
    const tempSessionsDir = copyCostamarSessionsToTemp(profileName);
    if (tempSessionsDir) {
      try {
        candidates.push(...readCostamarSessionCandidatesFromCopiedDir(tempSessionsDir, profileName));
      } finally {
        rmSync(tempSessionsDir, { recursive: true, force: true });
      }
    }

    candidates.push(
      ...readCostamarCandidatesFromChromeArtifact(profileName, "History"),
      ...readCostamarCandidatesFromChromeArtifact(profileName, "Favicons"),
      ...readCostamarCandidatesFromChromeArtifactDirectory(profileName, "Session Storage"),
      ...readCostamarCandidatesFromChromeArtifactDirectory(profileName, join("Local Storage", "leveldb")),
    );
  }

  const candidate = pickLatestCostamarSessionCandidate(candidates);
  cachedCostamarSession = {
    readAtMs: Date.now(),
    candidate,
  };
  return candidate;
}

export function resetCostamarSessionCacheForTests(): void {
  cachedCostamarSession = undefined;
}

export function resolveProviderId(providerId?: ProviderId): ProviderId {
  return providerId === "costamar" ? "costamar" : "agil-local";
}

export function normalizeCostamarProviderContext(
  input?: CostamarProviderConfigInput,
): CostamarProviderContext {
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
    token: stringOrFallback(
      input?.token ?? process.env.COSTAMAR_TOKEN,
      "",
    ),
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
  if (normalized.token && normalized.terminalId) {
    return normalized;
  }

  const sessionCandidate = readCostamarSessionCandidateFromChrome();
  return normalizeCostamarProviderContext({
    ...normalized,
    terminalId: normalized.terminalId || sessionCandidate?.terminalId,
    token: normalized.token || sessionCandidate?.token,
  });
}

export function resolveLatestCostamarProviderContext(
  input?: CostamarProviderConfigInput,
): CostamarProviderContext {
  const normalized = normalizeCostamarProviderContext(input);
  const sessionCandidate = readCostamarSessionCandidateFromChrome();
  if (!sessionCandidate) {
    return normalized;
  }

  return normalizeCostamarProviderContext({
    ...normalized,
    terminalId: sessionCandidate.terminalId || normalized.terminalId,
    token: sessionCandidate.token || normalized.token,
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
