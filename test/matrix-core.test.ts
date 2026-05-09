import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  buildMatrixConfidenceSummary,
  mapConcurrent,
  prioritizeMatrixLoadingCells,
} from "../src/core/matrix";
import { SearchRequest } from "../src/core/types";

function buildRequest(overrides?: Partial<SearchRequest>): SearchRequest {
  return {
    tripType: "round-trip",
    searchMode: "exact",
    legs: [
      {
        origin: "LIM",
        destination: "MIA",
        departureDate: "2026-04-01",
        returnDate: "2026-04-08",
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
    ...overrides,
  };
}

test("buildMatrixConfidenceSummary counts each confidence bucket", () => {
  const summary = buildMatrixConfidenceSummary([
    {
      key: "a",
      departureDate: "2026-04-01",
      confidence: "loading",
      providerSource: "costamar",
      selectable: false,
      requiresRequery: true,
      stateCode: "ind",
    },
    {
      key: "b",
      departureDate: "2026-04-02",
      confidence: "validated",
      providerSource: "agil-local",
      selectable: true,
      requiresRequery: false,
      stateCode: "ok",
    },
    {
      key: "c",
      departureDate: "2026-04-03",
      confidence: "validated",
      providerSource: "costamar",
      selectable: true,
      requiresRequery: false,
      stateCode: "ok",
    },
  ]);

  assert.deepEqual(summary, {
    loading: 1,
    validated: 2,
  });
});

test("prioritizeMatrixLoadingCells keeps one-way cells in departure order", () => {
  const baseRequest = buildRequest({ tripType: "one-way" });
  const ordered = prioritizeMatrixLoadingCells(
    [
      {
        key: "2026-04-03",
        departureDate: "2026-04-03",
        confidence: "loading",
        providerSource: "costamar",
        selectable: false,
        requiresRequery: true,
        stateCode: "ind",
        derivedRequest: baseRequest,
      },
      {
        key: "skip",
        departureDate: "2026-04-02",
        confidence: "loading",
        providerSource: "costamar",
        selectable: false,
        requiresRequery: true,
        stateCode: "ind",
      },
      {
        key: "2026-04-01",
        departureDate: "2026-04-01",
        confidence: "loading",
        providerSource: "costamar",
        selectable: false,
        requiresRequery: true,
        stateCode: "ind",
        derivedRequest: baseRequest,
      },
    ],
    {
      departureDates: ["2026-04-01", "2026-04-02", "2026-04-03"],
      returnDates: [],
    },
    "one-way",
  );

  assert.deepEqual(ordered.map((cell) => cell.departureDate), ["2026-04-01", "2026-04-03"]);
});

test("prioritizeMatrixLoadingCells uses departure and return waves for round-trip matrices", () => {
  const baseRequest = buildRequest();
  const ordered = prioritizeMatrixLoadingCells(
    [
      {
        key: "late-wave",
        departureDate: "2026-04-02",
        returnDate: "2026-04-09",
        confidence: "loading",
        providerSource: "agil-local",
        selectable: false,
        requiresRequery: true,
        stateCode: "ind",
        derivedRequest: baseRequest,
      },
      {
        key: "first-wave-a",
        departureDate: "2026-04-01",
        returnDate: "2026-04-09",
        confidence: "loading",
        providerSource: "agil-local",
        selectable: false,
        requiresRequery: true,
        stateCode: "ind",
        derivedRequest: baseRequest,
      },
      {
        key: "first-wave-b",
        departureDate: "2026-04-02",
        returnDate: "2026-04-08",
        confidence: "loading",
        providerSource: "agil-local",
        selectable: false,
        requiresRequery: true,
        stateCode: "ind",
        derivedRequest: baseRequest,
      },
    ],
    {
      departureDates: ["2026-04-01", "2026-04-02"],
      returnDates: ["2026-04-08", "2026-04-09"],
    },
    "round-trip",
  );

  assert.deepEqual(ordered.map((cell) => cell.key), ["first-wave-a", "first-wave-b", "late-wave"]);
});

test("mapConcurrent preserves input order", async () => {
  const values = [3, 1, 2];
  const results = await mapConcurrent(values, 3, async (value) => {
    await new Promise((resolve) => setTimeout(resolve, value * 5));
    return value * 10;
  });

  assert.deepEqual(results, [30, 10, 20]);
});
