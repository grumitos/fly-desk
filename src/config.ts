const DEFAULT_SERVER_HOST = "127.0.0.1";

export function resolveServerHost(): string {
  const configured = Bun.env.HOST?.trim();
  return configured || DEFAULT_SERVER_HOST;
}
