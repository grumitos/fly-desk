const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_WINDOW_MS = 15 * 60 * 1_000;
const DEFAULT_MAX_CLIENTS = 1_024;

export interface LoginAdmissionDecision {
  allowed: boolean;
  retryAfterSeconds?: number;
}

interface LoginAdmissionOptions {
  maxFailures?: number;
  windowMs?: number;
  maxClients?: number;
}

export class LoginAdmissionController {
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly maxClients: number;
  private readonly failuresByClient = new Map<string, number[]>();

  constructor(options: LoginAdmissionOptions = {}) {
    this.maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxClients = Math.max(1, Math.floor(options.maxClients ?? DEFAULT_MAX_CLIENTS));
  }

  check(clientKey: string, nowMs = Date.now()): LoginAdmissionDecision {
    const failures = this.activeFailures(clientKey, nowMs);
    if (!failures || failures.length < this.maxFailures) {
      return { allowed: true };
    }

    const retryAtMs = failures[0]! + this.windowMs;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((retryAtMs - nowMs) / 1_000)),
    };
  }

  recordFailure(clientKey: string, nowMs = Date.now()): void {
    let failures = this.activeFailures(clientKey, nowMs);
    if (!failures) {
      this.ensureClientCapacity(nowMs);
      failures = [];
      this.failuresByClient.set(clientKey, failures);
    }

    if (failures.length < this.maxFailures) {
      failures.push(nowMs);
    }
  }

  reset(clientKey?: string): void {
    if (clientKey === undefined) {
      this.failuresByClient.clear();
      return;
    }
    this.failuresByClient.delete(clientKey);
  }

  private activeFailures(clientKey: string, nowMs: number): number[] | undefined {
    const failures = this.failuresByClient.get(clientKey);
    if (!failures) {
      return undefined;
    }

    const cutoff = nowMs - this.windowMs;
    while (failures.length > 0 && failures[0]! <= cutoff) {
      failures.shift();
    }
    if (failures.length === 0) {
      this.failuresByClient.delete(clientKey);
      return undefined;
    }
    return failures;
  }

  private ensureClientCapacity(nowMs: number): void {
    for (const clientKey of this.failuresByClient.keys()) {
      this.activeFailures(clientKey, nowMs);
    }

    while (this.failuresByClient.size >= this.maxClients) {
      const oldestClient = this.failuresByClient.keys().next().value;
      if (oldestClient === undefined) {
        return;
      }
      this.failuresByClient.delete(oldestClient);
    }
  }
}

const webLoginAdmission = new LoginAdmissionController();

export function checkWebLoginAdmission(
  clientKey: string,
  nowMs = Date.now(),
): LoginAdmissionDecision {
  return webLoginAdmission.check(clientKey, nowMs);
}

export function recordFailedWebLogin(clientKey: string, nowMs = Date.now()): void {
  webLoginAdmission.recordFailure(clientKey, nowMs);
}

export function resetWebLoginAdmission(clientKey?: string): void {
  webLoginAdmission.reset(clientKey);
}
