import { join } from "node:path";

function isTestProcess(): boolean {
  return process.env.NODE_ENV === "test";
}

export function resolvePersistPath(envKey: string, defaultFileName: string): string | undefined {
  const explicit = process.env[envKey]?.trim();
  if (explicit) {
    return explicit;
  }

  if (isTestProcess()) {
    return undefined;
  }

  const appDataDir = process.env.FLY_DESK_APP_DATA_DIR?.trim();
  if (appDataDir) {
    return join(appDataDir, defaultFileName);
  }

  return join(process.cwd(), "output", "cache", defaultFileName);
}
