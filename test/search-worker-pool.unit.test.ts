import { test } from "bun:test";
import assert from "node:assert/strict";
import type { ProviderId, SearchRequest } from "../src/core/types";
import {
  createSearchWorkerPoolForTests,
  type SearchWorkerChild,
} from "../src/search-worker-client";
import type {
  ProviderSearchWorkerInbound,
  ProviderSearchWorkerMessage,
  ProviderSearchWorkerRequest,
} from "../src/search-worker-protocol";

interface FakeWorker {
  child: SearchWorkerChild;
  providerId: ProviderId;
  inbound: ProviderSearchWorkerInbound[];
  stdinEnded: boolean;
  killed: boolean;
  emit: (message: ProviderSearchWorkerMessage) => void;
  exit: (code: number) => void;
}

const decoder = new TextDecoder();

function createFakeWorker(providerId: ProviderId, pid: number): FakeWorker {
  let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller;
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });

  let resolveExited: (code: number) => void = () => undefined;
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });

  const worker: FakeWorker = {
    providerId,
    inbound: [],
    stdinEnded: false,
    killed: false,
    emit: (message) => {
      stdoutController?.enqueue(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
    },
    exit: (code) => {
      stdoutController?.close();
      stdoutController = undefined;
      resolveExited(code);
    },
    child: {
      pid,
      stdin: {
        write: (chunk: Uint8Array) => {
          decoder
            .decode(chunk)
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .forEach((line) => {
              worker.inbound.push(JSON.parse(line) as ProviderSearchWorkerInbound);
            });
          return chunk.byteLength;
        },
        end: () => {
          worker.stdinEnded = true;
          return 0;
        },
        flush: () => 0,
      },
      stdout,
      stderr,
      exited,
      kill: () => {
        worker.killed = true;
        worker.exit(143);
      },
    },
  };

  return worker;
}

function createFakePool(options: { maxJobs?: number } = {}) {
  const spawned: FakeWorker[] = [];
  const pool = createSearchWorkerPoolForTests({
    maxJobs: options.maxJobs,
    spawn: (providerId) => {
      const worker = createFakeWorker(providerId, 1000 + spawned.length);
      spawned.push(worker);
      return worker.child;
    },
  });
  return { pool, spawned };
}

function buildRequest(id: string): ProviderSearchWorkerRequest {
  const request: SearchRequest = {
    providerId: "agil-local",
    tripType: "one-way",
    searchMode: "exact",
    legs: [
      {
        origin: "LIM",
        destination: "MAD",
        departureDate: "2026-05-28",
      },
    ],
    passengers: {
      adults: 1,
      children: 0,
      infants: 0,
    },
    cabin: "ECONOMY",
    filters: {},
    coverageMode: "core",
    redirectMode: "best-effort",
    currencyCode: "USD",
    locale: "es-PE",
    market: "PE",
  };

  return {
    id,
    kind: "exact",
    providerId: "agil-local",
    request,
  };
}

/* The pool reads stdout through a stream, so every assertion about routing has
   to let the reader run first. */
function settle(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the pooled worker.");
    }
    await settle(5);
  }
}

test("one pooled worker multiplexes two jobs with interleaved progress", async () => {
  const { pool, spawned } = createFakePool();
  const firstProgress: number[] = [];
  const secondProgress: number[] = [];

  const first = pool.run(buildRequest("job-1"), (message) => {
    if (message.type === "search-progress") {
      firstProgress.push(message.offers.length);
    }
  });
  const second = pool.run(buildRequest("job-2"), (message) => {
    if (message.type === "search-progress") {
      secondProgress.push(message.offers.length);
    }
  });

  assert.equal(spawned.length, 1);
  const worker = spawned[0]!;
  await waitFor(() => worker.inbound.length === 2);

  worker.emit({ id: "job-1", type: "search-progress", offers: [], warnings: [], partial: true });
  worker.emit({ id: "job-2", type: "search-progress", offers: [], warnings: [], partial: true });
  worker.emit({
    id: "job-2",
    type: "search-progress",
    offers: [{} as never, {} as never],
    warnings: [],
    partial: true,
  });
  worker.emit({ id: "job-2", type: "search-complete", offers: [], warnings: ["second"], partial: false });
  worker.emit({ id: "job-1", type: "search-complete", offers: [], warnings: ["first"], partial: false });

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.type, "search-complete");
  assert.equal(secondResult.type, "search-complete");
  assert.deepEqual(firstProgress, [0]);
  assert.deepEqual(secondProgress, [0, 2]);
  assert.equal(spawned.length, 1);
  assert.equal(pool.workerPidForTests("agil-local"), worker.child.pid);
});

test("a progress callback that stops the search cancels only that job", async () => {
  const { pool, spawned } = createFakePool();
  const survivor = pool.run(buildRequest("keep"), () => undefined);
  const abandoned = pool.run(buildRequest("drop"), (_message, handle) => handle.kill());

  const worker = spawned[0]!;
  await waitFor(() => worker.inbound.length === 2);
  worker.emit({ id: "drop", type: "search-progress", offers: [], warnings: [], partial: true });

  await assert.rejects(abandoned, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Search worker cancelled.");
    return true;
  });

  const cancel = worker.inbound.find((message) => "type" in message && message.type === "cancel");
  assert.deepEqual(cancel, { id: "drop", type: "cancel" });
  assert.equal(worker.killed, false);

  /* Messages that arrive for a cancelled id after the fact are dropped, and the
     other job on the same worker keeps running. */
  worker.emit({ id: "drop", type: "search-complete", offers: [], warnings: [], partial: false });
  worker.emit({ id: "keep", type: "search-complete", offers: [], warnings: [], partial: false });
  const result = await survivor;
  assert.equal(result.type, "search-complete");
});

test("a shouldContinue poll that turns false cancels the pooled job", async () => {
  const { pool, spawned } = createFakePool();
  let keepGoing = true;
  const pending = pool.run(buildRequest("polled"), () => undefined, () => keepGoing);

  /* The cancellation poll is unref'd, so under `bun test` nothing else holds the
     loop open long enough for it to fire. The server does that in production. */
  const keepLoopAlive = setInterval(() => undefined, 25);
  try {
    const worker = spawned[0]!;
    await waitFor(() => worker.inbound.length === 1);
    keepGoing = false;

    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Search worker cancelled.");
      return true;
    });
    assert.ok(worker.inbound.some((message) => "type" in message && message.type === "cancel"));
  } finally {
    clearInterval(keepLoopAlive);
  }
});

test("worker death rejects every in-flight job and the next job respawns", async () => {
  const { pool, spawned } = createFakePool();
  const first = pool.run(buildRequest("a"), () => undefined);
  const second = pool.run(buildRequest("b"), () => undefined);

  const worker = spawned[0]!;
  await waitFor(() => worker.inbound.length === 2);
  worker.exit(3);

  for (const pending of [first, second]) {
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Search worker stopped before completing \(exit code 3\)\./);
      return true;
    });
  }

  const third = pool.run(buildRequest("c"), () => undefined);
  assert.equal(spawned.length, 2);
  const replacement = spawned[1]!;
  await waitFor(() => replacement.inbound.length === 1);
  replacement.emit({ id: "c", type: "search-complete", offers: [], warnings: [], partial: false });
  assert.equal((await third).type, "search-complete");
});

test("a pooled worker retires once it is idle and has run its job budget", async () => {
  const { pool, spawned } = createFakePool({ maxJobs: 2 });
  const first = pool.run(buildRequest("one"), () => undefined);
  const worker = spawned[0]!;
  await waitFor(() => worker.inbound.length === 1);
  worker.emit({ id: "one", type: "search-complete", offers: [], warnings: [], partial: false });
  await first;
  assert.equal(worker.stdinEnded, false);

  const second = pool.run(buildRequest("two"), () => undefined);
  assert.equal(spawned.length, 1);
  await waitFor(() => worker.inbound.length === 2);
  worker.emit({ id: "two", type: "search-complete", offers: [], warnings: [], partial: false });
  await second;
  assert.equal(worker.stdinEnded, true);
  assert.equal(pool.workerPidForTests("agil-local"), undefined);

  const third = pool.run(buildRequest("three"), () => undefined);
  assert.equal(spawned.length, 2);
  const replacement = spawned[1]!;
  await waitFor(() => replacement.inbound.length === 1);
  replacement.emit({ id: "three", type: "search-complete", offers: [], warnings: [], partial: false });
  assert.equal((await third).type, "search-complete");
});

test("prewarm rides the same pooled worker and reports provider failures", async () => {
  const { pool, spawned } = createFakePool();
  const prewarmed = pool.prewarm("costamar");
  const worker = spawned[0]!;
  assert.equal(worker.providerId, "costamar");
  await waitFor(() => worker.inbound.length === 1);

  const sent = worker.inbound[0]!;
  assert.ok("type" in sent && sent.type === "prewarm");
  const prewarmId = sent.id;
  worker.emit({ id: prewarmId, type: "prewarm-complete" });
  await prewarmed;

  const failing = pool.prewarm("costamar");
  await waitFor(() => worker.inbound.length === 2);
  const secondSent = worker.inbound[1]!;
  worker.emit({ id: secondSent.id, type: "error", message: "Costamar prewarm failed." });
  await assert.rejects(failing, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Costamar prewarm failed.");
    return true;
  });
  assert.equal(spawned.length, 1);
});

test("stopping the pool kills its workers and rejects what they were running", async () => {
  const { pool, spawned } = createFakePool();
  const pending = pool.run(buildRequest("stopped"), () => undefined);
  const worker = spawned[0]!;
  await waitFor(() => worker.inbound.length === 1);

  pool.stop();
  assert.equal(worker.killed, true);
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Search worker stopped before completing/);
    return true;
  });
  assert.equal(pool.workerPidForTests("agil-local"), undefined);
});
