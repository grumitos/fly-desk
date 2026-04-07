import { existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const FLY_DESK_TEMP_ARTIFACT_PREFIXES = [
  "playwright",
  "travel_quote_foundation_agil_",
  "travel_quote_foundation_costamar_",
  "flydesk-cdp-profile",
  "flydesk-cookie-",
  "flydesk-costamar-",
];

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
): Promise<void> {
  const targets: string[] = [];

  for (const root of readTempRoots()) {
    if (!existsSync(root)) {
      continue;
    }

    for (const name of readdirSync(root)) {
      if (!prefixes.some((prefix) => name.startsWith(prefix))) {
        continue;
      }

      targets.push(join(root, name));
    }
  }

  for (const targetPath of targets) {
    await removePathWithRetries(targetPath);
  }
}
