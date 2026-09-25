import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { CanonicalOffer, SearchRequest } from "../../src/core/types";
import { routeRequest } from "../../src/http-router";
import { createProviderDiagnostics } from "../../src/provider-diagnostics";
import { getRuntime } from "../../src/runtime";

/*
 * What a poll of a search job sends. The offers are nearly all of it, so they
 * are serialized once per revision; the answer must still be the bytes a single
 * `JSON.stringify` of it would give.
 */

const API_TOKEN = "unit-test-api-token-0123456789abcdef";
const managedEnv = ["NODE_ENV", "FLY_DESK_API_TOKEN", "FLY_DESK_SEARCH_SERVICE_URL", "FLY_DESK_SESSION_DB_PATH"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  savedEnv = Object.fromEntries(managedEnv.map((name) => [name, process.env[name]]));
  /* The test runtime keeps its stores in memory and answers here, not through a runner. */
  process.env.NODE_ENV = "test";
  process.env.FLY_DESK_API_TOKEN = API_TOKEN;
  delete process.env.FLY_DESK_SEARCH_SERVICE_URL;
  delete process.env.FLY_DESK_SESSION_DB_PATH;
});

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

const request: SearchRequest = {
  tripType: "one-way",
  searchMode: "exact",
  legs: [{ origin: "LIM", destination: "CUZ", departureDate: "2026-12-01" }],
  passengers: { adults: 1, children: 0, infants: 0 },
  cabin: "ECONOMY",
  filters: {},
  coverageMode: "core",
  redirectMode: "best-effort",
  currencyCode: "USD",
};

function offer(id: string, departureAt = "2026-12-01T06:00:00"): CanonicalOffer {
  return {
    id,
    signature: `signature-${id}`,
    providerSource: "agil-local",
    providerOfferRef: id,
    tripType: "one-way",
    mainCarrier: "LA",
    validatingCarrier: "LA",
    origin: "LIM",
    destination: "CUZ",
    itineraries: [{
      id: `${id}-outbound`,
      direction: "outbound",
      durationMinutes: 80,
      stops: 0,
      layoverMinutes: [],
      segments: [{
        id: `${id}-segment`,
        marketingCarrier: "LA",
        flightNumber: "2021",
        origin: "LIM",
        destination: "CUZ",
        departureAt,
        arrivalAt: departureAt.replace("T06:", "T07:").replace(":00:00", ":20:00"),
        durationMinutes: 80,
      }],
    }],
    price: { total: { amount: 120, currencyCode: "USD" } },
    priceConfidence: "live",
    priceStatus: "unverified",
    purchasePaths: [],
    comparisonMetrics: { totalDurationMinutes: 80, totalStops: 0, baggageScore: 0, purchasePathScore: 0 },
    tags: [],
    rawRefs: { gds: 7 },
    warnings: ["Tarifa sujeta a disponibilidad — verificar"],
  } as CanonicalOffer;
}

/* The test's own serializations go through this one and are not counted. */
const stringify = JSON.stringify;

/* Counts every serialization of an answer's offers, whichever code does it. */
function countOfferSerializations() {
  let count = 0;
  JSON.stringify = function (value: unknown, ...rest: unknown[]) {
    if (value && typeof value === "object" && Object.hasOwn(value, "allOffers")) {
      count += 1;
    }
    return (stringify as (...args: unknown[]) => string).call(JSON, value, ...rest);
  } as typeof JSON.stringify;
  return {
    get count() {
      return count;
    },
    restore: () => {
      JSON.stringify = stringify;
    },
  };
}

async function poll(jobId: string, sinceRevision?: number): Promise<string> {
  const query = sinceRevision === undefined ? "" : `?sinceRevision=${sinceRevision}`;
  const response = await routeRequest(new Request(`http://127.0.0.1/api/search/${jobId}${query}`, {
    headers: { "x-flydesk-api-token": API_TOKEN },
  }));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
  return response.text();
}

describe("search job polls", () => {
  test("serialize a revision's offers once and send the same bytes a single JSON.stringify gives", async () => {
    const sessions = getRuntime().sessions;
    const job = sessions.createSearchJob({
      request,
      allOffers: [offer("first"), offer("second", "2026-12-01T09:00:00")],
      searchMeta: {
        requestedAt: "2026-09-25T12:00:00.000Z",
        completedAt: "2026-09-25T12:00:05.000Z",
        providersUsed: ["agil-local"],
        warnings: [],
        partial: true,
        searchState: "search_partial",
      },
      providerMeta: { exactProvider: "agil-local", coverageMode: "core" },
      warnings: [],
      providerDiagnostics: [createProviderDiagnostics("agil-local", "exact")],
      sortMode: "cheapest",
      status: "running",
    });
    const serializations = countOfferSerializations();
    try {
      const first = await poll(job.id);
      const second = await poll(job.id);
      expect(second).toBe(first);
      expect(serializations.count).toBe(1);

      const answer = JSON.parse(first) as Record<string, unknown> & { allOffers: Array<Record<string, unknown>> };
      expect(stringify(answer)).toBe(first);
      expect(Object.keys(answer)).toEqual([
        "searchJobId", "searchComplete", "searchStatus", "revision", "sortMode", "request", "searchMeta",
        "providerMeta", "warnings", "providerDiagnostics", "unchanged", "allOffers", "scheduleGroups",
      ]);
      expect(answer.allOffers.map((entry) => entry.id)).toEqual(["first", "second"]);
      expect(answer.allOffers.some((entry) => "rawRefs" in entry || "signature" in entry)).toBe(false);

      /* Diagnostics move within a revision, so they are never served from the cache. */
      const diagnostics = [createProviderDiagnostics("agil-local", "exact", "first_progress")];
      sessions.updateSearchJob(job.id, (current) => ({ ...current, providerDiagnostics: diagnostics }));
      const sameRevision = JSON.parse(await poll(job.id)) as { revision: number; providerDiagnostics: unknown };
      expect(sameRevision.revision).toBe(1);
      expect(sameRevision.providerDiagnostics).toEqual(JSON.parse(stringify(diagnostics)));
      expect(serializations.count).toBe(1);

      /* A new revision is serialized once more, and a caller already on it gets the short answer. */
      sessions.updateSearchJob(job.id, (current) => ({ ...current, allOffers: [...current.allOffers, offer("third", "2026-12-01T13:00:00")] }));
      const next = await poll(job.id, 1);
      expect(serializations.count).toBe(2);
      expect(stringify(JSON.parse(next))).toBe(next);
      expect((JSON.parse(next) as { allOffers: unknown[] }).allOffers).toHaveLength(3);
      expect(await poll(job.id, 1)).toBe(next);
      expect(serializations.count).toBe(2);
      expect(JSON.parse(await poll(job.id, 2))).toMatchObject({ revision: 2, unchanged: true });
      expect(Object.hasOwn(JSON.parse(await poll(job.id, 2)) as object, "allOffers")).toBe(false);
    } finally {
      serializations.restore();
    }
  });
});
