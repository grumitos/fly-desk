import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  getLocationUsageSuggestions,
  recordLocationUsageFromSearch,
} from "../frontend/src/lib/location-usage-suggestions";
import type { SearchRequest } from "../frontend/src/types";

function buildSearchRequest(origin: string, destination: string): SearchRequest {
  return {
    origin,
    destination,
    departureDate: "2026-06-15",
    tripType: "round-trip",
    adults: 1,
    children: 0,
    infants: 0,
    searchMode: "exact",
  };
}

test("location usage suggestions are read from the global API", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const suggestions = await getLocationUsageSuggestions({
    fetchImpl: async (input, init) => {
      calls.push({ input, init });
      return Response.json({
        suggestions: {
          origin: ["LIM", "lim", "12", "CUZ"],
          destination: ["MAD", "BOG"],
        },
      });
    },
  });

  assert.equal(calls[0]?.input, "/api/location-usage-suggestions");
  assert.equal(calls[0]?.init?.method, "GET");
  assert.deepEqual(suggestions, {
    origin: ["LIM", "CUZ"],
    destination: ["MAD", "BOG"],
  });
});

test("recording location usage posts the search route to the global API", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const suggestions = await recordLocationUsageFromSearch(buildSearchRequest("lim - Lima, Peru", "mad"), {
    fetchImpl: async (input, init) => {
      calls.push({ input, init });
      return Response.json({
        suggestions: {
          origin: ["LIM"],
          destination: ["MAD"],
        },
      });
    },
  });

  assert.equal(calls[0]?.input, "/api/location-usage-suggestions");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    origin: "lim - Lima, Peru",
    destination: "mad",
  });
  assert.deepEqual(suggestions, {
    origin: ["LIM"],
    destination: ["MAD"],
  });
});

test("location usage client falls back to empty suggestions on API failure", async () => {
  const suggestions = await getLocationUsageSuggestions({
    fetchImpl: async () => new Response("nope", { status: 500 }),
  });

  assert.deepEqual(suggestions, {
    origin: [],
    destination: [],
  });
});
