import { describe, expect, test } from "bun:test";
import { LoginAdmissionController } from "../src/login-admission";

describe("LoginAdmissionController", () => {
  test("blocks attempts after the bounded failure limit", () => {
    const controller = new LoginAdmissionController({ maxFailures: 3, windowMs: 1_000 });

    controller.recordFailure("client-a", 10);
    controller.recordFailure("client-a", 20);
    controller.recordFailure("client-a", 30);

    expect(controller.check("client-a", 40)).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  test("reset removes prior failures for one client", () => {
    const controller = new LoginAdmissionController({ maxFailures: 2, windowMs: 1_000 });

    controller.recordFailure("client-a", 10);
    controller.recordFailure("client-a", 20);
    controller.reset("client-a");

    expect(controller.check("client-a", 30)).toEqual({ allowed: true });
  });

  test("expired failures no longer consume admission capacity", () => {
    const controller = new LoginAdmissionController({ maxFailures: 2, windowMs: 1_000 });

    controller.recordFailure("client-a", 10);
    controller.recordFailure("client-a", 20);

    expect(controller.check("client-a", 1_010)).toEqual({ allowed: true });
  });

  test("isolates failure buckets by client key", () => {
    const controller = new LoginAdmissionController({ maxFailures: 2, windowMs: 1_000 });

    controller.recordFailure("client-a", 10);
    controller.recordFailure("client-a", 20);

    expect(controller.check("client-a", 30)).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(controller.check("client-b", 30)).toEqual({ allowed: true });
  });

  test("bounds retained client buckets by evicting the oldest client", () => {
    const controller = new LoginAdmissionController({
      maxFailures: 1,
      windowMs: 1_000,
      maxClients: 2,
    });

    controller.recordFailure("client-a", 10);
    controller.recordFailure("client-b", 20);
    controller.recordFailure("client-c", 30);

    expect(controller.check("client-a", 40)).toEqual({ allowed: true });
    expect(controller.check("client-b", 40)).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(controller.check("client-c", 40)).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });
});
