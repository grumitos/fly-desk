import { test } from "bun:test";
import assert from "node:assert/strict";
import { getLocationUsageSuggestions } from "../frontend/src/lib/location-usage-suggestions";

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
  assert.equal(calls[0]?.init?.cache, "no-store");
  assert.deepEqual(suggestions, {
    origin: ["LIM", "CUZ"],
    destination: ["MAD", "BOG"],
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
