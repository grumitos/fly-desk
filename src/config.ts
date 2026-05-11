export const DEFAULT_SERVER_HOST = "127.0.0.1";

export function loadRuntimeConfig(): void {
  // Bun loads .env, .env.{NODE_ENV}, and .env.local automatically.
}

export function resolveServerHost(): string {
  const configured = Bun.env.HOST?.trim();
  return configured || DEFAULT_SERVER_HOST;
}
