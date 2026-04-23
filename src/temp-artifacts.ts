import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const FLY_DESK_TEMP_ARTIFACT_PREFIXES = [
  "playwright",
  "travel_quote_foundation_agil_",
  "travel_quote_foundation_costamar_",
  "travel_quote_foundation_costamar_browser_",
  "flydesk-cdp-profile",
  "flydesk-cookie-",
  "flydesk-costamar-",
];

export const TEMP_ARTIFACT_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
export const TEMP_ARTIFACT_SWEEP_MIN_AGE_MS = 2 * 60 * 60 * 1000;
export const TEMP_ARTIFACT_ACTIVE_MARKER_NAME = ".flydesk-active.json";

const activeTempArtifacts = new Set<string>();

interface CleanupTempArtifactOptions {
  olderThanMs?: number;
}

interface ScanTempArtifactOptions {
  includeSizeBytes?: boolean;
}

interface TempArtifactEntry {
  prefix: string;
  path: string;
  name: string;
  sizeBytes: number;
  mtimeMs: number;
  active: boolean;
}

function readTempRoots(): string[] {
  return [
    process.env.TEMP,
    process.env.TMP,
    tmpdir(),
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.trim())
    .filter((value, index, all) => value.length > 0 && all.indexOf(value) === index);
}

function pathSizeBytes(targetPath: string): number {
  try {
    const stats = statSync(targetPath);
    if (!stats.isDirectory()) {
      return stats.size;
    }

    return readdirSync(targetPath).reduce((total, name) => total + pathSizeBytes(join(targetPath, name)), 0);
  } catch {
    return 0;
  }
}

function isProcessAlive(processId: number): boolean {
  if (!Number.isInteger(processId) || processId <= 0) {
    return false;
  }

  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveActiveMarkerPath(targetPath: string): string {
  try {
    return statSync(targetPath).isDirectory()
      ? join(targetPath, TEMP_ARTIFACT_ACTIVE_MARKER_NAME)
      : `${targetPath}.${TEMP_ARTIFACT_ACTIVE_MARKER_NAME}`;
  } catch {
    return join(targetPath, TEMP_ARTIFACT_ACTIVE_MARKER_NAME);
  }
}

function hasLiveActiveMarker(targetPath: string): boolean {
  try {
    const payload = JSON.parse(readFileSync(resolveActiveMarkerPath(targetPath), "utf8")) as { pid?: unknown };
    return isProcessAlive(Number(payload?.pid));
  } catch {
    return false;
  }
}

function writeActiveMarker(targetPath: string): void {
  const markerPath = resolveActiveMarkerPath(targetPath);
  const tempPath = `${markerPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify({
      pid: process.pid,
      updatedAt: new Date().toISOString(),
    }), "utf8");
    try {
      renameSync(tempPath, markerPath);
    } catch {
      rmSync(markerPath, { force: true });
      renameSync(tempPath, markerPath);
    }
  } catch {
    // Marker writes are best-effort: cleanup still has the in-process set as a fallback.
  } finally {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Ignore marker temp cleanup failures.
    }
  }
}

function removeActiveMarker(targetPath: string): void {
  try {
    unlinkSync(resolveActiveMarkerPath(targetPath));
  } catch {
    // Marker cleanup is best-effort.
  }
}

function scanTempArtifacts(
  prefixes = FLY_DESK_TEMP_ARTIFACT_PREFIXES,
  options: ScanTempArtifactOptions = {},
): TempArtifactEntry[] {
  const entries: TempArtifactEntry[] = [];
  const includeSizeBytes = options.includeSizeBytes === true;

  for (const root of readTempRoots()) {
    if (!existsSync(root)) {
      continue;
    }

    for (const name of readdirSync(root)) {
      const prefix = prefixes.find((candidate) => name.startsWith(candidate));
      if (!prefix) {
        continue;
      }

      const path = join(root, name);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        mtimeMs = 0;
      }

      entries.push({
        prefix,
        path,
        name,
        sizeBytes: includeSizeBytes ? pathSizeBytes(path) : 0,
        mtimeMs,
        active: activeTempArtifacts.has(path) || hasLiveActiveMarker(path),
      });
    }
  }

  return entries;
}

export function registerActiveTempArtifact(targetPath: string): void {
  if (!targetPath) {
    return;
  }

  activeTempArtifacts.add(targetPath);
  writeActiveMarker(targetPath);
}

export function unregisterActiveTempArtifact(targetPath: string): void {
  if (!targetPath) {
    return;
  }

  activeTempArtifacts.delete(targetPath);
  removeActiveMarker(targetPath);
}

export async function removePathWithRetries(
  targetPath: string,
  attempts = 4,
  delayMs = 150,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      rmSync(targetPath, { recursive: true, force: true });
      return;
    } catch {
      if (attempt === attempts - 1) {
        return;
      }

      await delay(delayMs);
    }
  }
}

export async function cleanupPrefixedTempArtifacts(
  prefixes = FLY_DESK_TEMP_ARTIFACT_PREFIXES,
  options: CleanupTempArtifactOptions = {},
): Promise<void> {
  const olderThanMs = Math.max(0, Math.trunc(options.olderThanMs ?? 0));
  const cutoffMs = Date.now() - olderThanMs;
  const targets = scanTempArtifacts(prefixes)
    .filter((entry) => !entry.active)
    .filter((entry) => olderThanMs === 0 || entry.mtimeMs <= cutoffMs)
    .map((entry) => entry.path);

  for (const targetPath of targets) {
    await removePathWithRetries(targetPath);
  }
}

export function collectTempArtifactDiagnostics(prefixes = FLY_DESK_TEMP_ARTIFACT_PREFIXES) {
  const entries = scanTempArtifacts(prefixes, { includeSizeBytes: true });
  const byPrefix = prefixes.map((prefix) => {
    const matches = entries.filter((entry) => entry.prefix === prefix);
    return {
      prefix,
      count: matches.length,
      bytes: matches.reduce((total, entry) => total + entry.sizeBytes, 0),
      activeCount: matches.filter((entry) => entry.active).length,
      newestMtimeMs: matches.reduce((latest, entry) => Math.max(latest, entry.mtimeMs), 0),
      oldestMtimeMs: matches.reduce((oldest, entry) => {
        if (oldest === 0) {
          return entry.mtimeMs;
        }
        return Math.min(oldest, entry.mtimeMs);
      }, 0),
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    roots: readTempRoots(),
    totals: {
      count: entries.length,
      bytes: entries.reduce((total, entry) => total + entry.sizeBytes, 0),
      activeCount: entries.filter((entry) => entry.active).length,
    },
    activeArtifacts: entries.filter((entry) => entry.active).map((entry) => basename(entry.path)),
    byPrefix,
  };
}
