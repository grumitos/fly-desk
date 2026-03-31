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

test("accepts exact searches inside the rolling date window", async () => {
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
              origin: "LIM",
              destination: "MIA",
              departureDate: "2027-01-01",
              returnDate: "2027-01-08",
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
        },
      }),
    });

    assert.equal(response.status, 200);
  });
});

test("rejects exact searches outside the rolling date window", async () => {
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
              origin: "LIM",
              destination: "MIA",
              departureDate: "2027-04-01",
              returnDate: "2027-04-08",
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
        },
      }),
    });

    assert.equal(response.status, 400);
    const payload = await response.json() as { errors?: string[] };
    assert.ok(payload.errors?.some((message) => message.includes("Departure date must be on or before 2027-03-31.")));
  });
});

test("costamar search keeps provider token out of the public job response", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "costamar",
        providerConfig: {
          costamar: {
            terminalId: "0721808110",
            token: "super-secret-token",
            apiBaseUrl: "https://127.0.0.1:1/vuelos/api",
            brandBaseUrl: "https://booking.clickandbook.com/vuelos",
            lang: "es",
          },
        },
        request: {
          tripType: "round-trip",
          searchMode: "exact",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureDate: "2026-06-01",
              returnDate: "2026-06-08",
            },
          ],
          passengers: {
            adults: 1,
            children: 1,
            infants: 1,
          },
        },
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      request?: { providerId?: string };
      providerMeta?: { exactProvider?: string };
      warnings?: string[];
    };

    assert.equal(payload.request?.providerId, "costamar");
    assert.equal(payload.providerMeta?.exactProvider, "costamar");
    assert.equal(JSON.stringify(payload).includes("super-secret-token"), false);
  });
});

test("explicit costamar search accepts a terminal without token", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "costamar",
        providerConfig: {
          costamar: {
            terminalId: "0721808110",
            apiBaseUrl: "https://127.0.0.1:1/vuelos/api",
            brandBaseUrl: "https://booking.clickandbook.com/vuelos",
            lang: "es",
          },
        },
        request: {
          tripType: "round-trip",
          searchMode: "exact",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureDate: "2026-06-01",
              returnDate: "2026-06-08",
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
        },
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      request?: { providerId?: string };
      providerMeta?: { exactProvider?: string };
    };

    assert.equal(payload.request?.providerId, "costamar");
    assert.equal(payload.providerMeta?.exactProvider, "costamar");
  });
});

test("explicit costamar search falls back to the default terminal when none is provided", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "costamar",
        request: {
          tripType: "round-trip",
          searchMode: "exact",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureDate: "2026-06-01",
              returnDate: "2026-06-08",
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
        },
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      request?: { providerId?: string };
      providerMeta?: { exactProvider?: string };
    };

    assert.equal(payload.request?.providerId, "costamar");
    assert.equal(payload.providerMeta?.exactProvider, "costamar");
  });
});

test("default search keeps Costamar enabled even when its token is missing", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        request: {
          tripType: "round-trip",
          searchMode: "exact",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureDate: "2026-06-01",
              returnDate: "2026-06-08",
            },
          ],
          passengers: {
            adults: 1,
            children: 1,
            infants: 1,
          },
        },
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      searchMeta?: { providersUsed?: string[] };
    };

    assert.deepEqual(payload.searchMeta?.providersUsed, ["agil-local", "costamar"]);
  });
});

test("default matrix keeps both providers enabled when no providerId is specified", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/matrix`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        request: {
          tripType: "round-trip",
          searchMode: "roundtrip-grid",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureStart: "2026-06-01",
              departureEnd: "2026-06-03",
              returnStart: "2026-06-08",
              returnEnd: "2026-06-10",
              minNights: 7,
              maxNights: 7,
            },
          ],
          passengers: {
            adults: 1,
            children: 1,
            infants: 1,
          },
        },
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      searchMeta?: { providersUsed?: string[] };
      matrixStatus?: string;
    };

    assert.deepEqual(payload.searchMeta?.providersUsed, ["agil-local", "costamar"]);
    assert.equal(payload.matrixStatus, "running");
  });
});
