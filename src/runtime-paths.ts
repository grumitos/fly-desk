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

  return join(process.cwd(), "output", "cache", defaultFileName);
}
