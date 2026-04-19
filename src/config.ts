import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

export const DEFAULT_SERVER_HOST = "127.0.0.1";

function decodeQuotedEnvValue(value: string, quote: '"' | "'"): string {
  const decoded = value;
  if (quote === "'") {
    return decoded;
  }

  return decoded
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\")
    .replace(/\\"/g, '"');
}

function parseEnvValue(rawValue: string): string {
  const trimmedLeft = rawValue.trimStart();
  if (!trimmedLeft) {
    return "";
  }

  const quote = trimmedLeft[0];
  if (quote === '"' || quote === "'") {
    let escaped = false;
    let value = "";
    for (let index = 1; index < trimmedLeft.length; index += 1) {
      const char = trimmedLeft[index];
      if (!escaped && char === quote) {
        return decodeQuotedEnvValue(value, quote);
      }

      if (quote === '"' && char === "\\" && !escaped) {
        escaped = true;
        continue;
      }

      if (escaped) {
        value += `\\${char}`;
        escaped = false;
      } else {
        value += char;
      }
    }

    return decodeQuotedEnvValue(value, quote);
  }

  for (let index = 0; index < trimmedLeft.length; index += 1) {
    const char = trimmedLeft[index];
    if (char !== "#") {
      continue;
    }

    if (index === 0 || /\s/.test(trimmedLeft[index - 1] ?? "")) {
      return trimmedLeft.slice(0, index).trimEnd();
    }
  }

  return trimmedLeft.trimEnd();
}

function parseEnvAssignment(line: string): { key: string; value: string } | undefined {
  const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
  if (!match) {
    return undefined;
  }

  const key = match[1]?.trim();
  if (!key) {
    return undefined;
  }

  return {
    key,
    value: parseEnvValue(match[2] ?? ""),
  };
}

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

    const parsed = parseEnvAssignment(line);
    if (!parsed) {
      continue;
    }

    if (process.env[parsed.key] === undefined) {
      process.env[parsed.key] = parsed.value;
    }
  }
}

export function loadRuntimeConfig(): void {
  const rootDir = path.resolve(__dirname, "..");
  applyEnvFile(path.join(rootDir, ".env"));
}

export function resolveServerHost(): string {
  const configured = process.env.HOST?.trim();
  return configured || DEFAULT_SERVER_HOST;
}
