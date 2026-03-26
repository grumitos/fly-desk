import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

function applyEnvFile(filePath: string): void {
  if (!existsSync(filePath)) {
    return;
  }

  const lines = readFileSync(filePath, "utf-8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex < 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();

    if (key && !process.env[key]) {
      process.env[key] = value;
    }
  }
}

export function loadRuntimeConfig(): void {
  const rootDir = path.resolve(__dirname, "..");
  applyEnvFile(path.join(rootDir, ".env"));
}
