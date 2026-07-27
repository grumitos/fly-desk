import { describe, expect, test } from "bun:test";
import { LoginAdmissionController } from "../src/login-admission";

describe("LoginAdmissionController", () => {
  test("blocks attempts after the bounded failure limit", () => {
    const controller = new LoginAdmissionController({ maxFailures: 3, windowMs: 1_000 });

    controller.recordFailure(10);
    controller.recordFailure(20);
    controller.recordFailure(30);

    expect(controller.check(40)).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  test("reset removes prior failures", () => {
    const controller = new LoginAdmissionController({ maxFailures: 2, windowMs: 1_000 });

    controller.recordFailure(10);
    controller.recordFailure(20);
    controller.reset();

    expect(controller.check(30)).toEqual({ allowed: true });
  });

  test("expired failures no longer consume admission capacity", () => {
    const controller = new LoginAdmissionController({ maxFailures: 2, windowMs: 1_000 });

    controller.recordFailure(10);
    controller.recordFailure(20);

    expect(controller.check(1_010)).toEqual({ allowed: true });
  });
});
