const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_WINDOW_MS = 15 * 60 * 1_000;

export interface LoginAdmissionDecision {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export class LoginAdmissionController {
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private failures: number[] = [];

  constructor(options: { maxFailures?: number; windowMs?: number } = {}) {
    this.maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  }

  check(nowMs = Date.now()): LoginAdmissionDecision {
    this.removeExpired(nowMs);
    if (this.failures.length < this.maxFailures) {
      return { allowed: true };
    }

    const retryAtMs = this.failures[0]! + this.windowMs;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((retryAtMs - nowMs) / 1_000)),
    };
  }

  recordFailure(nowMs = Date.now()): void {
    this.removeExpired(nowMs);
    if (this.failures.length < this.maxFailures) {
      this.failures.push(nowMs);
    }
  }

  reset(): void {
    this.failures = [];
  }

  private removeExpired(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    while (this.failures.length > 0 && this.failures[0]! <= cutoff) {
      this.failures.shift();
    }
  }
}

const webLoginAdmission = new LoginAdmissionController();

export function checkWebLoginAdmission(nowMs = Date.now()): LoginAdmissionDecision {
  return webLoginAdmission.check(nowMs);
}

export function recordFailedWebLogin(nowMs = Date.now()): void {
  webLoginAdmission.recordFailure(nowMs);
}

export function resetWebLoginAdmission(): void {
  webLoginAdmission.reset();
}
