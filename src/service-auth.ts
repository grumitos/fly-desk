import { createHmac } from "node:crypto";

const INTERNAL_SEARCH_SERVICE_TOKEN_CONTEXT = "fly-desk:search-service:v1";
const MIN_INTERNAL_SECRET_LENGTH = 32;

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export function resolveDerivedSearchServiceApiToken(): string | undefined {
  const sessionSecret = readEnv("FLY_DESK_WEB_SESSION_SECRET");
  if (!sessionSecret || sessionSecret.length < MIN_INTERNAL_SECRET_LENGTH) {
    return undefined;
  }

  return createHmac("sha256", sessionSecret)
    .update(INTERNAL_SEARCH_SERVICE_TOKEN_CONTEXT)
    .digest("base64url");
}

export function resolveSearchServiceProxyApiToken(): string | undefined {
  return readEnv("FLY_DESK_SEARCH_SERVICE_API_TOKEN")
    ?? readEnv("FLY_DESK_API_TOKEN")
    ?? resolveDerivedSearchServiceApiToken();
}

export function resolveAcceptedApiAccessTokens(): string[] {
  return unique([
    readEnv("FLY_DESK_API_TOKEN"),
    readEnv("FLY_DESK_SEARCH_SERVICE_API_TOKEN"),
    resolveDerivedSearchServiceApiToken(),
  ]);
}
