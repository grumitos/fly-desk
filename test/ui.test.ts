import test from "node:test";
import assert from "node:assert/strict";
import { chromium, type Page, type Route } from "playwright";
import { withServer } from "./helpers/server";

function buildSearchMeta(searchState: "search_partial" | "search_live" | "search_failed" = "search_partial") {
  const timestamp = "2026-03-26T00:00:00.000Z";
  return {
    requestedAt: timestamp,
    completedAt: timestamp,
    providersUsed: ["agil-local"],
    warnings: [],
    partial: searchState !== "search_live",
    searchState,
    searchSessionId: "job-search-1",
  };
}

function buildMatrixResponse(overrides: Record<string, unknown> = {}) {
  return {
    matrixJobId: "matrix-job-1",
    matrixComplete: false,
    matrixStatus: "running",
    request: {
      tripType: "round-trip",
      searchMode: "roundtrip-grid",
      legs: [
        {
          origin: "LIM",
          destination: "MIA",
          departureStart: "2026-04-15",
          departureEnd: "2026-04-15",
          returnStart: "2026-04-19",
          returnEnd: "2026-04-19",
        },
      ],
      passengers: {
        adults: 1,
        children: 0,
        infants: 0,
      },
      cabin: "ECONOMY",
      filters: {
        maxResults: 25,
      },
      coverageMode: "core",
      redirectMode: "best-effort",
      currencyCode: "USD",
      locale: "es-PE",
      market: "PE",
    },
    cells: [
      {
        key: "2026-04-15_2026-04-19",
        departureDate: "2026-04-15",
        returnDate: "2026-04-19",
        stayNights: 4,
        confidence: "loading",
        providerSource: "agil-local",
        selectable: false,
        requiresRequery: true,
        stateCode: "ind",
        tooltip: "Consultando Agil...",
        derivedRequest: {
          tripType: "round-trip",
          searchMode: "exact",
          legs: [
            {
              origin: "LIM",
              destination: "MIA",
              departureDate: "2026-04-15",
              returnDate: "2026-04-19",
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
          cabin: "ECONOMY",
          filters: {
            maxResults: 25,
          },
          coverageMode: "core",
          redirectMode: "best-effort",
          currencyCode: "USD",
          locale: "es-PE",
          market: "PE",
        },
      },
    ],
    axes: {
      departureDates: ["2026-04-15"],
      returnDates: ["2026-04-19"],
    },
    confidenceSummary: {
      loading: 1,
    },
    recommendations: [],
    searchMeta: buildSearchMeta(),
    providerMeta: {
      exactProvider: "agil-local",
      coverageMode: "core",
    },
    warnings: [],
    ...overrides,
  };
}

function buildOffer(overrides: Record<string, unknown> = {}) {
  return {
    id: "offer-1",
    origin: "LIM",
    destination: "MIA",
    mainCarrier: "LA",
    validatingCarrier: "LA",
    priceConfidence: "live",
    comparisonMetrics: {
      totalDurationMinutes: 480,
      totalStops: 0,
    },
    baggage: {
      carryOnIncluded: true,
      checkedIncluded: true,
      checkedBags: 1,
      description: "23kg",
    },
    price: {
      total: {
        amount: 512,
        currencyCode: "USD",
      },
      base: {
        amount: 420,
        currencyCode: "USD",
      },
      taxes: {
        amount: 92,
        currencyCode: "USD",
      },
    },
    itineraries: [
      {
        direction: "outbound",
        durationMinutes: 480,
        stops: 0,
        segments: [
          {
            flightNumber: "LA 123",
            origin: "LIM",
            destination: "MIA",
            departureAt: "2026-04-15T14:00:00Z",
            arrivalAt: "2026-04-15T22:00:00Z",
          },
        ],
      },
      {
        direction: "inbound",
        durationMinutes: 470,
        stops: 0,
        segments: [
          {
            flightNumber: "LA 456",
            origin: "MIA",
            destination: "LIM",
            departureAt: "2026-04-22T15:00:00Z",
            arrivalAt: "2026-04-22T22:50:00Z",
          },
        ],
      },
    ],
    purchasePaths: [
      {
        provider: "agil-local",
        type: "deep-link",
        label: "Agil",
        url: "https://example.test/agil",
      },
    ],
    ...overrides,
  };
}

async function openDesktop(page: Page, baseUrl: string) {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.setViewportSize({ width: 1440, height: 960 });
}

async function setDateValue(page: Page, id: string, value: string) {
  await page.evaluate(([targetId, targetValue]) => {
    const input = document.getElementById(targetId) as HTMLInputElement | null;
    if (!input) throw new Error(`Missing input ${targetId}`);
    input.value = targetValue;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, [id, value]);
}

test("desktop search rail keeps mode first and the rest of the flow in travel order", async () => {
  await withServer(async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
      await openDesktop(page, baseUrl);
      const order = await page.locator("[data-search-order]").evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-search-order")),
      );

      assert.deepEqual(order, [
        "mode",
        "trip",
        "origin",
        "swap",
        "destination",
        "dates",
        "passengers",
        "submit",
      ]);
    } finally {
      await browser.close();
    }
  });
});

test("desktop refinements no longer render removed max stops, currency, max price, or cabin controls", async () => {
  await withServer(async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
      await openDesktop(page, baseUrl);
      const maxStopsCount = await page.locator("#maxStops").count();
      const currencyControlCount = await page.locator("#currencyCode").count();
      const maxPriceCount = await page.locator("#maxPrice").count();
      const cabinCount = await page.locator("#cabinTrigger").count();
      const loadingOverlayCount = await page.locator("#loadingOverlay").count();
      const progressBarCount = await page.locator("#progressBar").count();
      assert.equal(maxStopsCount, 0);
      assert.equal(currencyControlCount, 0);
      assert.equal(maxPriceCount, 0);
      assert.equal(cabinCount, 0);
      assert.equal(loadingOverlayCount, 0);
      assert.equal(progressBarCount, 0);
    } finally {
      await browser.close();
    }
  });
});

test("search payload keeps USD fixed without rendering a currency control", async () => {
  await withServer(async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    let capturedCurrencyCode = "";
    let capturedCabin = "";
    let capturedOriginLabel = "";
    let capturedDestinationLabel = "";

    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      const body = route.request().postDataJSON();
      capturedCurrencyCode = body?.request?.currencyCode ?? "";
      capturedCabin = body?.request?.cabin ?? "";
      capturedOriginLabel = body?.request?.legs?.[0]?.originLabel ?? "";
      capturedDestinationLabel = body?.request?.legs?.[0]?.destinationLabel ?? "";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "search-job-1",
          searchComplete: true,
          searchStatus: "completed",
          sortMode: "cheapest",
          request: {
            tripType: "round-trip",
            searchMode: "exact",
            legs: [
              {
                origin: "LIM",
                destination: "MIA",
                departureDate: "2026-04-15",
                returnDate: "2026-04-22",
              },
            ],
            passengers: {
              adults: 1,
              children: 0,
              infants: 0,
            },
            cabin: "ECONOMY",
            filters: {
              maxResults: 25,
            },
            coverageMode: "core",
            redirectMode: "best-effort",
            currencyCode: "USD",
            locale: "es-PE",
            market: "PE",
          },
          offers: [],
          allOffers: [],
          searchMeta: buildSearchMeta("search_live"),
          providerMeta: {
            exactProvider: "agil-local",
            coverageMode: "core",
          },
          warnings: [],
        }),
      });
    });

    try {
      await openDesktop(page, baseUrl);
      await page.evaluate(() => {
        const origin = document.getElementById("origin") as HTMLInputElement | null;
        const destination = document.getElementById("destination") as HTMLInputElement | null;
        if (!origin || !destination) {
          throw new Error("Missing location inputs");
        }

        origin.value = "LIM - Lima, Peru";
        origin.dataset.code = "LIM";
        origin.dataset.label = "LIM - Lima, Peru";
        origin.dispatchEvent(new Event("input", { bubbles: true }));
        origin.dispatchEvent(new Event("change", { bubbles: true }));

        destination.value = "MIA - Miami, Usa";
        destination.dataset.code = "MIA";
        destination.dataset.label = "MIA - Miami, Usa";
        destination.dispatchEvent(new Event("input", { bubbles: true }));
        destination.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await setDateValue(page, "departureDate", "2026-04-15");
      await setDateValue(page, "returnDate", "2026-04-22");
      await page.click("#submitButton");
      await page.waitForTimeout(200);

      assert.equal(capturedCurrencyCode, "USD");
      assert.equal(capturedCabin, "ECONOMY");
      assert.equal(capturedOriginLabel, "LIM - Lima, Peru");
      assert.equal(capturedDestinationLabel, "MIA - Miami, Usa");
      assert.equal(await page.locator("#currencyCode").count(), 0);
    } finally {
      await browser.close();
    }
  });
});

test("theme switch applies light and dark styles to the shell and overlays", async () => {
  await withServer(async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
      await openDesktop(page, baseUrl);

      await page.click('[data-theme-value="light"]');
      await page.click("#paxTrigger");
      const lightPax = await page.evaluate(() => {
        const shell = document.querySelector(".search-shell");
        const popover = document.getElementById("paxPopover");
        return {
          theme: document.documentElement.dataset.theme,
          shellBg: shell ? getComputedStyle(shell).backgroundColor : "",
          popoverBg: popover ? getComputedStyle(popover).backgroundColor : "",
          popoverBorder: popover ? getComputedStyle(popover).borderColor : "",
        };
      });

      await page.click("body", { position: { x: 20, y: 20 } });
      await page.click("#dateTrigger");
      const lightCalendar = await page.evaluate(() => {
        const popover = document.getElementById("calendarPopover");
        return {
          theme: document.documentElement.dataset.theme,
          calendarBg: popover ? getComputedStyle(popover).backgroundColor : "",
          calendarBorder: popover ? getComputedStyle(popover).borderColor : "",
        };
      });

      await page.click('[data-theme-value="dark"]');
      await page.click("#paxTrigger");
      const darkPax = await page.evaluate(() => {
        const shell = document.querySelector(".search-shell");
        const popover = document.getElementById("paxPopover");
        return {
          theme: document.documentElement.dataset.theme,
          shellBg: shell ? getComputedStyle(shell).backgroundColor : "",
          popoverBg: popover ? getComputedStyle(popover).backgroundColor : "",
          popoverBorder: popover ? getComputedStyle(popover).borderColor : "",
        };
      });

      await page.click("body", { position: { x: 20, y: 20 } });
      await page.click("#dateTrigger");
      const darkCalendar = await page.evaluate(() => {
        const popover = document.getElementById("calendarPopover");
        return {
          theme: document.documentElement.dataset.theme,
          calendarBg: popover ? getComputedStyle(popover).backgroundColor : "",
          calendarBorder: popover ? getComputedStyle(popover).borderColor : "",
        };
      });

      assert.equal(lightPax.theme, "light");
      assert.equal(lightCalendar.theme, "light");
      assert.equal(darkPax.theme, "dark");
      assert.equal(darkCalendar.theme, "dark");
      assert.notEqual(lightPax.shellBg, darkPax.shellBg);
      assert.notEqual(lightPax.popoverBg, "rgba(0, 0, 0, 0)");
      assert.notEqual(lightCalendar.calendarBg, "rgba(0, 0, 0, 0)");
      assert.notEqual(darkPax.popoverBg, "rgba(0, 0, 0, 0)");
      assert.notEqual(darkCalendar.calendarBg, "rgba(0, 0, 0, 0)");
      assert.notEqual(lightPax.popoverBg, darkPax.popoverBg);
      assert.notEqual(lightCalendar.calendarBg, darkCalendar.calendarBg);
      assert.notEqual(lightPax.popoverBorder, darkPax.popoverBorder);
      assert.notEqual(lightCalendar.calendarBorder, darkCalendar.calendarBorder);
    } finally {
      await browser.close();
    }
  });
});

test("custom calendar writes exact and flexible dates back into the hidden form fields", async () => {
  await withServer(async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
      await openDesktop(page, baseUrl);

      await page.click("#dateTrigger");
      await page.click('[data-date-value="2026-04-15"]');
      await page.click('[data-date-value="2026-04-22"]');

      const exactValues = await page.evaluate(() => ({
        departureDate: (document.getElementById("departureDate") as HTMLInputElement | null)?.value ?? "",
        returnDate: (document.getElementById("returnDate") as HTMLInputElement | null)?.value ?? "",
        summary: document.getElementById("dateTrigger")?.textContent ?? "",
      }));

      await page.click('[data-mode="flexible"]');
      await page.click("#dateTrigger");
      await page.click('[data-date-value="2026-04-18"]');
      await page.click('[data-date-value="2026-04-24"]');

      const flexibleValues = await page.evaluate(() => ({
        departureStart: (document.getElementById("departureStart") as HTMLInputElement | null)?.value ?? "",
        departureEnd: (document.getElementById("departureEnd") as HTMLInputElement | null)?.value ?? "",
        searchMode: (document.getElementById("searchMode") as HTMLSelectElement | null)?.value ?? "",
        summary: document.getElementById("dateTrigger")?.textContent ?? "",
      }));

      assert.equal(exactValues.departureDate, "2026-04-15");
      assert.equal(exactValues.returnDate, "2026-04-22");
      assert.match(exactValues.summary, /15\/04/i);
      assert.equal(flexibleValues.departureStart, "2026-04-18");
      assert.equal(flexibleValues.departureEnd, "2026-04-24");
      assert.equal(flexibleValues.searchMode, "roundtrip-grid");
      assert.match(flexibleValues.summary, /18\/04/i);
      assert.match(flexibleValues.summary, /24\/04/i);
    } finally {
      await browser.close();
    }
  });
});

test("location suggestions stay anchored to the origin field", async () => {
  await withServer(async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    await page.route(`${baseUrl}/api/agil/locations?q=LIM&limit=8`, async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          query: "LIM",
          suggestions: [
            {
              code: "LIM",
              city: "Lima",
              country: "Peru",
              label: "LIM - Lima, Peru",
            },
            {
              code: "LHR",
              city: "London",
              country: "United Kingdom",
              label: "LHR - London, United Kingdom",
            },
          ],
        }),
      });
    });

    try {
      await openDesktop(page, baseUrl);
      await page.fill("#origin", "LIM");
      await page.waitForSelector("#originSuggestions .location-item");

      const probe = await page.evaluate(() => {
        const menu = document.querySelector("#originSuggestions");
        const input = document.getElementById("origin");
        const rail = document.querySelector(".search-rail");
        const shell = document.querySelector(".search-shell");
        if (!menu || !input || !rail || !shell) return null;

        const menuRect = menu.getBoundingClientRect();
        const inputRect = input.getBoundingClientRect();
        const railRect = rail.getBoundingClientRect();
        const shellRect = shell.getBoundingClientRect();
        const pointX = Math.round(menuRect.left + 32);
        const pointY = Math.round(menuRect.top + 18);
        const hit = document.elementFromPoint(pointX, pointY);

        return {
          inputBottom: inputRect.bottom,
          menuTop: menuRect.top,
          railBottom: railRect.bottom,
          shellBottom: shellRect.bottom,
          gap: menuRect.top - inputRect.bottom,
          hitInMenu: Boolean(hit?.closest("#originSuggestions")),
        };
      });

      assert.ok(probe);
      assert.ok(probe.gap >= 0 && probe.gap <= 14, JSON.stringify(probe));
      assert.ok(probe.menuTop <= probe.shellBottom, JSON.stringify(probe));
      assert.equal(probe.hitInMenu, true, JSON.stringify(probe));
    } finally {
      await browser.close();
    }
  });
});

test("calendar stays anchored to the trigger, stays compact, and can navigate months", async () => {
  await withServer(async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
      await openDesktop(page, baseUrl);

      await page.click("#dateTrigger");
      const calendarProbe = await page.evaluate(() => {
        const popover = document.getElementById("calendarPopover");
        const trigger = document.getElementById("dateTrigger");
        const titles = [...document.querySelectorAll(".calendar-month__header h3")].map((node) => node.textContent?.trim() ?? "");
        if (!popover || !trigger) return null;
        const popRect = popover.getBoundingClientRect();
        const triggerRect = trigger.getBoundingClientRect();
        return {
          width: popRect.width,
          top: popRect.top,
          triggerBottom: triggerRect.bottom,
          gap: popRect.top - triggerRect.bottom,
          titles,
        };
      });

      await page.click("#calendarNext");
      const navigatedTitles = await page.locator(".calendar-month__header h3").allTextContents();

      assert.ok(calendarProbe);
      assert.ok(calendarProbe.width < 1100, JSON.stringify(calendarProbe));
      assert.ok(calendarProbe.gap >= 0 && calendarProbe.gap <= 20, JSON.stringify(calendarProbe));
      assert.equal(calendarProbe.titles.length, 2);
      assert.notDeepEqual(navigatedTitles, calendarProbe.titles);
    } finally {
      await browser.close();
    }
  });
});

test("clicking a flexible matrix cell still triggers a single exact search", async () => {
  await withServer(async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    let matrixPollCount = 0;
    let searchRequestCount = 0;

    const initialMatrix = buildMatrixResponse();
    const completedMatrix = buildMatrixResponse({
      matrixComplete: true,
      matrixStatus: "completed",
      confidenceSummary: {
        live: 1,
      },
      cells: [
        {
          ...buildMatrixResponse().cells[0],
          confidence: "live",
          selectable: true,
          stateCode: "live",
          tooltip: "Agil exact search.",
          price: {
            amount: 123,
            currencyCode: "USD",
          },
        },
      ],
      searchMeta: buildSearchMeta("search_live"),
    });

    await page.route(`${baseUrl}/api/matrix`, async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(initialMatrix),
      });
    });

    await page.route(`${baseUrl}/api/matrix/matrix-job-1`, async (route: Route) => {
      matrixPollCount += 1;
      const body = matrixPollCount >= 2 ? completedMatrix : initialMatrix;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    });

    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      searchRequestCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "search-job-1",
          searchComplete: true,
          searchStatus: "completed",
          sortMode: "cheapest",
          request: initialMatrix.request,
          offers: [],
          allOffers: [],
          searchMeta: buildSearchMeta("search_live"),
          providerMeta: {
            exactProvider: "agil-local",
            coverageMode: "core",
          },
          warnings: [],
        }),
      });
    });

    try {
      await openDesktop(page, baseUrl);
      await page.click('[data-mode="flexible"]');
      await page.fill("#origin", "LIM");
      await page.fill("#destination", "MIA");
      await setDateValue(page, "departureStart", "2026-04-15");
      await setDateValue(page, "departureEnd", "2026-04-15");
      await page.evaluate(() => {
        const min = document.getElementById("stayDaysMin") as HTMLInputElement | null;
        const max = document.getElementById("stayDaysMax") as HTMLInputElement | null;
        if (!min || !max) throw new Error("Missing stay duration inputs");
        min.value = "4";
        max.value = "4";
        min.dispatchEvent(new Event("change", { bubbles: true }));
        max.dispatchEvent(new Event("change", { bubbles: true }));
      });

      await page.click("#submitButton");
      await page.waitForSelector('[data-mk="2026-04-15_2026-04-19"]');
      await page.waitForTimeout(1800);
      await page.click('[data-mk="2026-04-15_2026-04-19"]');
      await page.waitForTimeout(250);

      assert.equal(searchRequestCount, 1);
    } finally {
      await browser.close();
    }
  });
});

test("submitting a search shows inline placeholders instead of a fullscreen overlay", async () => {
  await withServer(async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "search-job-inline",
          searchComplete: true,
          searchStatus: "completed",
          sortMode: "cheapest",
          request: {
            tripType: "round-trip",
            searchMode: "exact",
            legs: [
              {
                origin: "LIM",
                destination: "MIA",
                departureDate: "2026-04-15",
                returnDate: "2026-04-22",
              },
            ],
            passengers: {
              adults: 1,
              children: 0,
              infants: 0,
            },
            cabin: "ECONOMY",
            filters: {
              maxResults: 25,
            },
            coverageMode: "core",
            redirectMode: "best-effort",
            currencyCode: "USD",
            locale: "es-PE",
            market: "PE",
          },
          offers: [buildOffer()],
          allOffers: [buildOffer()],
          searchMeta: buildSearchMeta("search_live"),
          providerMeta: {
            exactProvider: "agil-local",
            coverageMode: "core",
          },
          warnings: [],
        }),
      });
    });

    try {
      await openDesktop(page, baseUrl);
      await page.evaluate(() => {
        const origin = document.getElementById("origin") as HTMLInputElement | null;
        const destination = document.getElementById("destination") as HTMLInputElement | null;
        if (!origin || !destination) throw new Error("Missing location inputs");
        origin.value = "LIM - Lima, Peru";
        origin.dataset.code = "LIM";
        origin.dataset.label = "LIM - Lima, Peru";
        destination.value = "MIA - Miami, Usa";
        destination.dataset.code = "MIA";
        destination.dataset.label = "MIA - Miami, Usa";
      });
      await setDateValue(page, "departureDate", "2026-04-15");
      await setDateValue(page, "returnDate", "2026-04-22");

      await page.click("#submitButton");
      await page.waitForSelector(".results-skeleton");

      assert.equal(await page.locator("#loadingOverlay").count(), 0);
      assert.equal(await page.locator(".results-skeleton").getAttribute("aria-busy"), "true");

      await page.waitForSelector('tr[data-oid="offer-1"]');
      assert.equal(await page.locator(".results-skeleton").count(), 0);
    } finally {
      await browser.close();
    }
  });
});

test("reprice keeps the loading feedback inside the detail panel", async () => {
  await withServer(async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "search-job-detail",
          searchComplete: true,
          searchStatus: "completed",
          sortMode: "cheapest",
          request: {
            tripType: "round-trip",
            searchMode: "exact",
            legs: [
              {
                origin: "LIM",
                destination: "MIA",
                departureDate: "2026-04-15",
                returnDate: "2026-04-22",
              },
            ],
            passengers: {
              adults: 1,
              children: 0,
              infants: 0,
            },
            cabin: "ECONOMY",
            filters: {
              maxResults: 25,
            },
            coverageMode: "core",
            redirectMode: "best-effort",
            currencyCode: "USD",
            locale: "es-PE",
            market: "PE",
          },
          offers: [buildOffer()],
          allOffers: [buildOffer()],
          searchMeta: buildSearchMeta("search_live"),
          providerMeta: {
            exactProvider: "agil-local",
            coverageMode: "core",
          },
          warnings: [],
        }),
      });
    });

    await page.route(`${baseUrl}/api/reprice`, async (route: Route) => {
      await new Promise((resolve) => setTimeout(resolve, 450));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          offer: buildOffer({
            price: {
              total: {
                amount: 499,
                currencyCode: "USD",
              },
              base: {
                amount: 415,
                currencyCode: "USD",
              },
              taxes: {
                amount: 84,
                currencyCode: "USD",
              },
            },
            priceConfidence: "validated",
          }),
        }),
      });
    });

    try {
      await openDesktop(page, baseUrl);
      await page.evaluate(() => {
        const origin = document.getElementById("origin") as HTMLInputElement | null;
        const destination = document.getElementById("destination") as HTMLInputElement | null;
        if (!origin || !destination) throw new Error("Missing location inputs");
        origin.value = "LIM - Lima, Peru";
        origin.dataset.code = "LIM";
        origin.dataset.label = "LIM - Lima, Peru";
        destination.value = "MIA - Miami, Usa";
        destination.dataset.code = "MIA";
        destination.dataset.label = "MIA - Miami, Usa";
      });
      await setDateValue(page, "departureDate", "2026-04-15");
      await setDateValue(page, "returnDate", "2026-04-22");
      await page.click("#submitButton");
      await page.waitForSelector('tr[data-oid="offer-1"]');

      await page.click("#repriceButton");
      await page.waitForSelector(".detail-busy");

      assert.equal(await page.locator("#loadingOverlay").count(), 0);
      assert.equal(await page.locator(".detail-busy").getAttribute("aria-busy"), "true");

      await page.waitForFunction(() => {
        const hero = document.querySelector(".detail-hero");
        return hero?.textContent?.includes("499.00");
      });
    } finally {
      await browser.close();
    }
  });
});
