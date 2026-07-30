import { test } from "bun:test";
import assert from "node:assert/strict";
import { getLocationUsageSuggestions } from "../frontend/src/lib/location-usage-suggestions";

test("location usage suggestions read additive frequent and session-recent groups", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const suggestions = await getLocationUsageSuggestions({
    clientSessionId: "browser-session-client-a",
    fetchImpl: async (input, init) => {
      calls.push({ input, init });
      return Response.json({
        frequent: {
          origin: ["LIM", "lim", "12", "CUZ"],
          destination: ["MAD", "BOG"],
        },
        recent: {
          origin: ["AQP", "CUZ"],
          destination: ["SCL"],
        },
      });
    },
  });

  assert.equal(calls[0]?.input, "/api/location-usage-suggestions?clientSessionId=browser-session-client-a");
  assert.equal(calls[0]?.init?.method, "GET");
  assert.equal(calls[0]?.init?.cache, "no-store");
  assert.deepEqual(suggestions, {
    frequent: {
      origin: ["LIM", "CUZ"],
      destination: ["MAD", "BOG"],
    },
    recent: {
      origin: ["AQP", "CUZ"],
      destination: ["SCL"],
    },
  });
});

test("location usage client remains compatible with the legacy suggestions envelope", async () => {
  const suggestions = await getLocationUsageSuggestions({
    fetchImpl: async () => Response.json({
      suggestions: {
        origin: ["LIM", "CUZ"],
        destination: ["MAD"],
      },
    }),
  });

  assert.deepEqual(suggestions, {
    frequent: {
      origin: ["LIM", "CUZ"],
      destination: ["MAD"],
    },
    recent: {
      origin: [],
      destination: [],
    },
  });
});

test("location usage client falls back to empty suggestions on API failure", async () => {
  const suggestions = await getLocationUsageSuggestions({
    fetchImpl: async () => new Response("nope", { status: 500 }),
  });

  assert.deepEqual(suggestions, {
    frequent: {
      origin: [],
      destination: [],
    },
    recent: {
      origin: [],
      destination: [],
    },
  });
});
