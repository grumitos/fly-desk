import test from "node:test";
import assert from "node:assert/strict";
import { withServer } from "./helpers/server";

test("rejects exact searches when origin and destination are omitted", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sortMode: "cheapest",
        request: {
          tripType: "round-trip",
          searchMode: "exact",
          legs: [
            {
              departureDate: "2026-04-15",
              returnDate: "2026-04-22",
            },
          ],
        },
      }),
    });

    assert.equal(response.status, 400);
    const payload = await response.json() as { errors?: string[] };
    assert.ok(payload.errors?.some((message) => message.includes("Origin is required")));
    assert.ok(payload.errors?.some((message) => message.includes("Destination is required")));
  });
});
