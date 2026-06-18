import { describe, expect, test } from "bun:test";
import {
  resolveSearchAdmissionLimits,
  SearchAdmissionController,
  SearchAdmissionError,
  type SearchAdmissionErrorCode,
} from "../src/search-admission";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function expectAdmissionError(
  promise: Promise<unknown>,
  code: SearchAdmissionErrorCode,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SearchAdmissionError);
    expect((error as SearchAdmissionError).code).toBe(code);
    return;
  }

  throw new Error(`Expected SearchAdmissionError ${code}.`);
}

describe("SearchAdmissionController", () => {
  test("default budget admits two heavy searches and queues the third", async () => {
    const controller = new SearchAdmissionController();

    try {
      const first = await controller.acquire({ kind: "range", jobId: "first-heavy" });
      const second = await controller.acquire({ kind: "matrix", jobId: "second-heavy" });
      let thirdStarted = false;
      const thirdPromise = controller.acquire({ kind: "range", jobId: "third-heavy" }).then((lease) => {
        thirdStarted = true;
        return lease;
      });

      await delay(10);

      expect(thirdStarted).toBe(false);
      expect(controller.getDiagnostics()).toEqual(expect.objectContaining({
        capacityUnits: 4,
        activeUnits: 4,
        queuedUnits: 2,
        activeCount: 2,
        queuedCount: 1,
      }));

      first.release();
      const third = await thirdPromise;
      expect(thirdStarted).toBe(true);
      expect(controller.getDiagnostics()).toEqual(expect.objectContaining({
        activeUnits: 4,
        queuedUnits: 0,
        activeCount: 2,
        queuedCount: 0,
      }));

      second.release();
      third.release();
    } finally {
      controller.dispose();
    }
  });

  test("queues work that would exceed capacity until an active lease is released", async () => {
    const controller = new SearchAdmissionController({
      capacityUnits: 2,
      exactCostUnits: 1,
      rangeCostUnits: 2,
      matrixCostUnits: 2,
      maxQueued: 4,
      queueTimeoutMs: 10_000,
    });

    try {
      const first = await controller.acquire({ kind: "range", jobId: "first" });
      let secondStarted = false;
      const secondPromise = controller.acquire({ kind: "exact", jobId: "second" }).then((lease) => {
        secondStarted = true;
        return lease;
      });

      await delay(10);

      expect(secondStarted).toBe(false);
      expect(controller.getDiagnostics()).toEqual(expect.objectContaining({
        capacityUnits: 2,
        activeUnits: 2,
        queuedUnits: 1,
        activeCount: 1,
        queuedCount: 1,
      }));

      first.release();
      const second = await secondPromise;

      expect(secondStarted).toBe(true);
      expect(controller.getDiagnostics()).toEqual(expect.objectContaining({
        activeUnits: 1,
        queuedUnits: 0,
        activeCount: 1,
        queuedCount: 0,
      }));

      second.release();
      expect(controller.getDiagnostics().activeUnits).toBe(0);
    } finally {
      controller.dispose();
    }
  });

  test("rejects new work when the queue is full", async () => {
    const controller = new SearchAdmissionController({
      capacityUnits: 1,
      exactCostUnits: 1,
      rangeCostUnits: 1,
      matrixCostUnits: 1,
      maxQueued: 1,
      queueTimeoutMs: 10_000,
    });

    try {
      const active = await controller.acquire({ kind: "exact", jobId: "active" });
      const queued = controller.acquire({ kind: "exact", jobId: "queued" });

      await expectAdmissionError(controller.acquire({ kind: "exact", jobId: "overflow" }), "queue-full");

      active.release();
      const queuedLease = await queued;
      queuedLease.release();
    } finally {
      controller.dispose();
    }
  });

  test("times out queued work without consuming capacity", async () => {
    const controller = new SearchAdmissionController({
      capacityUnits: 1,
      exactCostUnits: 1,
      rangeCostUnits: 1,
      matrixCostUnits: 1,
      maxQueued: 2,
      queueTimeoutMs: 15,
    });

    try {
      const active = await controller.acquire({ kind: "exact", jobId: "active" });
      const queued = controller.acquire({ kind: "exact", jobId: "queued" });

      await expectAdmissionError(queued, "queue-timeout");

      expect(controller.getDiagnostics()).toEqual(expect.objectContaining({
        activeUnits: 1,
        queuedUnits: 0,
        activeCount: 1,
        queuedCount: 0,
      }));

      active.release();
    } finally {
      controller.dispose();
    }
  });

  test("cancels queued work before it consumes capacity", async () => {
    const controller = new SearchAdmissionController({
      capacityUnits: 1,
      exactCostUnits: 1,
      rangeCostUnits: 1,
      matrixCostUnits: 1,
      maxQueued: 2,
      queueTimeoutMs: 10_000,
    });
    let keepGoing = true;

    try {
      const active = await controller.acquire({ kind: "exact", jobId: "active" });
      const queued = controller.acquire({
        kind: "exact",
        jobId: "queued",
        shouldContinue: () => keepGoing,
      });

      keepGoing = false;
      active.release();

      await expectAdmissionError(queued, "cancelled");
      expect(controller.getDiagnostics()).toEqual(expect.objectContaining({
        activeUnits: 0,
        queuedUnits: 0,
        activeCount: 0,
        queuedCount: 0,
      }));
    } finally {
      controller.dispose();
    }
  });

  test("uses conservative defaults and clamps invalid environment values", () => {
    const limits = resolveSearchAdmissionLimits({
      FLY_DESK_SEARCH_CAPACITY_UNITS: "0",
      FLY_DESK_SEARCH_MAX_QUEUED: "-1",
      FLY_DESK_SEARCH_QUEUE_TIMEOUT_MS: "abc",
      FLY_DESK_SEARCH_EXACT_COST_UNITS: "none",
      FLY_DESK_SEARCH_RANGE_COST_UNITS: "-2",
      FLY_DESK_SEARCH_MATRIX_COST_UNITS: "0",
    });

    expect(limits.capacityUnits).toBe(4);
    expect(limits.maxQueued).toBe(8);
    expect(limits.queueTimeoutMs).toBe(120_000);
    expect(limits.exactCostUnits).toBe(1);
    expect(limits.rangeCostUnits).toBe(2);
    expect(limits.matrixCostUnits).toBe(2);
  });
});
