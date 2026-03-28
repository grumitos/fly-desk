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

function buildOfferWithDates(id: string, departureDate: string, returnDate: string) {
  return buildOffer({
    id,
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
            departureAt: `${departureDate}T14:00:00Z`,
            arrivalAt: `${departureDate}T22:00:00Z`,
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
            departureAt: `${returnDate}T15:00:00Z`,
            arrivalAt: `${returnDate}T22:50:00Z`,
          },
        ],
      },
    ],
  });
}

function buildCarrierOffer(id: string, carrierCode: string, amount: number) {
  return buildOffer({
    id,
    mainCarrier: carrierCode,
    validatingCarrier: carrierCode,
    price: {
      total: {
        amount,
        currencyCode: "USD",
      },
      base: {
        amount: Math.max(0, amount - 90),
        currencyCode: "USD",
      },
      taxes: {
        amount: 90,
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
            flightNumber: `${carrierCode} 123`,
            marketingCarrier: carrierCode,
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
            flightNumber: `${carrierCode} 456`,
            marketingCarrier: carrierCode,
            origin: "MIA",
            destination: "LIM",
            departureAt: "2026-04-22T15:00:00Z",
            arrivalAt: "2026-04-22T22:50:00Z",
          },
        ],
      },
    ],
  });
}

function buildLayoverOffer(id: string, amount: number, layoverMinutes: number) {
  const departureAt = "2026-04-15T08:00:00Z";
  const firstArrival = "2026-04-15T12:00:00Z";
  const secondDepartureDate = new Date(Date.parse(firstArrival) + layoverMinutes * 60000).toISOString();
  const secondArrivalDate = new Date(Date.parse(secondDepartureDate) + 240 * 60000).toISOString();

  return buildOffer({
    id,
    mainCarrier: "LA",
    validatingCarrier: "LA",
    comparisonMetrics: {
      totalDurationMinutes: 710 + layoverMinutes,
      totalStops: 1,
    },
    price: {
      total: {
        amount,
        currencyCode: "USD",
      },
      base: {
        amount: Math.max(0, amount - 90),
        currencyCode: "USD",
      },
      taxes: {
        amount: 90,
        currencyCode: "USD",
      },
    },
    itineraries: [
      {
        direction: "outbound",
        durationMinutes: 470 + layoverMinutes,
        stops: 1,
        layoverMinutes: [layoverMinutes],
        segments: [
          {
            flightNumber: "LA 201",
            marketingCarrier: "LA",
            origin: "LIM",
            destination: "BOG",
            departureAt,
            arrivalAt: firstArrival,
          },
          {
            flightNumber: "LA 305",
            marketingCarrier: "LA",
            origin: "BOG",
            destination: "MIA",
            departureAt: secondDepartureDate,
            arrivalAt: secondArrivalDate,
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
            marketingCarrier: "LA",
            origin: "MIA",
            destination: "LIM",
            departureAt: "2026-04-22T15:00:00Z",
            arrivalAt: "2026-04-22T22:50:00Z",
          },
        ],
      },
    ],
  });
}

function buildRoundTripLayoverOffer(id: string, outboundLayoverMinutes: number, inboundLayoverMinutes: number) {
  const outboundDepartureAt = "2026-04-15T08:00:00Z";
  const outboundFirstArrival = "2026-04-15T12:00:00Z";
  const outboundSecondDeparture = new Date(Date.parse(outboundFirstArrival) + outboundLayoverMinutes * 60000).toISOString();
  const outboundSecondArrival = new Date(Date.parse(outboundSecondDeparture) + 240 * 60000).toISOString();
  const inboundDepartureAt = "2026-04-22T10:00:00Z";
  const inboundFirstArrival = "2026-04-22T14:00:00Z";
  const inboundSecondDeparture = new Date(Date.parse(inboundFirstArrival) + inboundLayoverMinutes * 60000).toISOString();
  const inboundSecondArrival = new Date(Date.parse(inboundSecondDeparture) + 240 * 60000).toISOString();

  return buildOffer({
    id,
    comparisonMetrics: {
      totalDurationMinutes: 960 + outboundLayoverMinutes + inboundLayoverMinutes,
      totalStops: 2,
    },
    itineraries: [
      {
        direction: "outbound",
        durationMinutes: 480 + outboundLayoverMinutes,
        stops: 1,
        layoverMinutes: [outboundLayoverMinutes],
        segments: [
          {
            flightNumber: "LA 201",
            marketingCarrier: "LA",
            origin: "LIM",
            destination: "BOG",
            departureAt: outboundDepartureAt,
            arrivalAt: outboundFirstArrival,
          },
          {
            flightNumber: "LA 305",
            marketingCarrier: "LA",
            origin: "BOG",
            destination: "MIA",
            departureAt: outboundSecondDeparture,
            arrivalAt: outboundSecondArrival,
          },
        ],
      },
      {
        direction: "inbound",
        durationMinutes: 480 + inboundLayoverMinutes,
        stops: 1,
        layoverMinutes: [inboundLayoverMinutes],
        segments: [
          {
            flightNumber: "LA 456",
            marketingCarrier: "LA",
            origin: "MIA",
            destination: "BOG",
            departureAt: inboundDepartureAt,
            arrivalAt: inboundFirstArrival,
          },
          {
            flightNumber: "LA 457",
            marketingCarrier: "LA",
            origin: "BOG",
            destination: "LIM",
            departureAt: inboundSecondDeparture,
            arrivalAt: inboundSecondArrival,
          },
        ],
      },
    ],
  });
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

test("query and offer panels expose homogeneous headers from first paint", async () => {
  await withServer(async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
      await openDesktop(page, baseUrl);
      const probe = await page.evaluate(() => {
        const resultsHeader = document.getElementById("resultsToolbar");
        const detailHeader = document.querySelector("#detailPanel .panel-header");
        const resultsPanel = document.querySelector(".results-panel");
        const detailPanel = document.getElementById("detailPanel");
        if (!resultsHeader || !detailHeader || !resultsPanel || !detailPanel) {
          throw new Error("Missing panel headers");
        }

        const resultsStyle = getComputedStyle(resultsHeader);
        const detailStyle = getComputedStyle(detailHeader);

        return {
          resultsTitle: document.getElementById("resultsPanelTitle")?.textContent?.trim() ?? "",
          resultsMeta: document.getElementById("resultsPanelMeta")?.textContent?.trim() ?? "",
          detailTitle: detailHeader.querySelector(".panel-header__title")?.textContent?.trim() ?? "",
          detailMeta: detailHeader.querySelector(".panel-header__meta")?.textContent?.trim() ?? "",
          countHidden: document.getElementById("resultsCountLabel")?.classList.contains("hidden") ?? false,
          resultsPanelDisplay: getComputedStyle(resultsPanel).display,
          detailPanelDisplay: getComputedStyle(detailPanel).display,
          paddingLeftMatches: resultsStyle.paddingLeft === detailStyle.paddingLeft,
          paddingRightMatches: resultsStyle.paddingRight === detailStyle.paddingRight,
          borderBottomMatches: resultsStyle.borderBottomWidth === detailStyle.borderBottomWidth,
        };
      });

      assert.equal(probe.resultsTitle, "Esperando una búsqueda");
      assert.equal(probe.detailTitle, "Detalle");
      assert.equal(probe.countHidden, true);
      assert.match(probe.resultsMeta, /Completa origen, destino y fechas/i);
      assert.match(probe.detailMeta, /Tarifa, tramos y accesos de compra/i);
      assert.equal(probe.resultsPanelDisplay, "flex");
      assert.equal(probe.detailPanelDisplay, "flex");
      assert.equal(probe.paddingLeftMatches, true);
      assert.equal(probe.paddingRightMatches, true);
      assert.equal(probe.borderBottomMatches, true);
    } finally {
      await browser.close();
    }
  });
});

test("search payload keeps USD fixed without hidden max stops or a currency control", async () => {
  await withServer(async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    let capturedCurrencyCode = "";
    let capturedCabin = "";
    let capturedOriginLabel = "";
    let capturedDestinationLabel = "";
    let capturedMaxStops: unknown = "sent";

    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      const body = route.request().postDataJSON();
      capturedCurrencyCode = body?.request?.currencyCode ?? "";
      capturedCabin = body?.request?.cabin ?? "";
      capturedOriginLabel = body?.request?.legs?.[0]?.originLabel ?? "";
      capturedDestinationLabel = body?.request?.legs?.[0]?.destinationLabel ?? "";
      capturedMaxStops = body?.request?.filters?.maxStops;
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
      assert.equal(capturedMaxStops, undefined);
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

test("page boots directly into the stored theme without leaving bootstrap state behind", async () => {
  await withServer(async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
      await page.addInitScript(() => {
        window.localStorage.setItem("flydesk-theme", "dark");
      });

      await page.goto(baseUrl, { waitUntil: "networkidle" });
      await page.setViewportSize({ width: 1440, height: 960 });

      const themeState = await page.evaluate(() => {
        const shell = document.querySelector(".search-shell");
        const darkButton = document.querySelector('[data-theme-value="dark"]');
        const lightButton = document.querySelector('[data-theme-value="light"]');
        const dateTriggerText = document.getElementById("dateTriggerText");
        const paxLabel = document.getElementById("paxLabel");
        return {
          theme: document.documentElement.dataset.theme,
          booting: document.documentElement.hasAttribute("data-theme-booting"),
          shellBg: shell ? getComputedStyle(shell).backgroundColor : "",
          shellVisibility: shell ? getComputedStyle(shell).visibility : "",
          darkActiveClass: darkButton?.classList.contains("is-active") ?? false,
          darkPressed: darkButton?.getAttribute("aria-pressed"),
          lightActiveClass: lightButton?.classList.contains("is-active") ?? false,
          dateTriggerText: dateTriggerText?.textContent ?? "",
          paxLabel: paxLabel?.textContent ?? "",
        };
      });

      assert.equal(themeState.theme, "dark");
      assert.equal(themeState.booting, false);
      assert.notEqual(themeState.shellBg, "rgba(0, 0, 0, 0)");
      assert.equal(themeState.shellVisibility, "visible");
      assert.equal(themeState.darkActiveClass, true);
      assert.equal(themeState.darkPressed, "true");
      assert.equal(themeState.lightActiveClass, false);
      assert.equal(themeState.dateTriggerText, "Salida y regreso");
      assert.equal(themeState.paxLabel, "1 adulto");
    } finally {
      await browser.close();
    }
  });
});

test("paste can restore a copied search in a fresh view from system clipboard", async () => {
  await withServer(async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const clipboardPayload = JSON.stringify({
      type: "fly-desk-search-config",
      version: 1,
      copiedAt: "2026-03-28T12:00:00.000Z",
      mode: "exact",
      tripType: "round-trip",
      origin: {
        value: "Lima",
        code: "LIM",
        label: "Lima",
      },
      destination: {
        value: "Miami",
        code: "MIA",
        label: "Miami",
      },
      dates: {
        departureDate: "2026-04-15",
        returnDate: "2026-04-22",
        departureStart: "",
        departureEnd: "",
        returnStart: "",
        returnEnd: "",
      },
      stay: {
        min: "7",
        max: "14",
      },
      passengers: {
        adults: "2",
        children: "1",
        infants: "0",
      },
      filters: {
        nonStop: true,
        baggageRequired: true,
        maxLayoverMinutes: "240",
      },
      sortMode: "fastest",
    });

    const context = await browser.newContext();
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
    const page = await context.newPage();

    try {
      await openDesktop(page, baseUrl);
      await page.evaluate(() => {
        window.localStorage.removeItem("flydesk.searchClipboard");
      });
      await page.evaluate((rawPayload) => navigator.clipboard.writeText(rawPayload), clipboardPayload);

      const initiallyEnabled = await page.evaluate(() => {
        const button = document.getElementById("pasteSearchConfigBtn") as HTMLButtonElement | null;
        return button ? !button.disabled : false;
      });

      assert.equal(initiallyEnabled, true);

      await page.click("#pasteSearchConfigBtn");
      await page.waitForFunction(() => {
        const origin = document.getElementById("origin") as HTMLInputElement | null;
        return origin?.value === "Lima";
      });

      const restored = await page.evaluate(() => ({
        origin: (document.getElementById("origin") as HTMLInputElement | null)?.value ?? "",
        destination: (document.getElementById("destination") as HTMLInputElement | null)?.value ?? "",
        departureDate: (document.getElementById("departureDate") as HTMLInputElement | null)?.value ?? "",
        returnDate: (document.getElementById("returnDate") as HTMLInputElement | null)?.value ?? "",
        adults: (document.getElementById("adults") as HTMLInputElement | null)?.value ?? "",
        children: (document.getElementById("children") as HTMLInputElement | null)?.value ?? "",
        nonStop: (document.getElementById("nonStop") as HTMLInputElement | null)?.checked ?? false,
        baggageRequired: (document.getElementById("baggageRequired") as HTMLInputElement | null)?.checked ?? false,
        maxLayoverMinutes: (document.getElementById("maxLayoverMinutes") as HTMLSelectElement | null)?.value ?? "",
        sortMode: (document.getElementById("sortMode") as HTMLSelectElement | null)?.value ?? "",
        paxLabel: document.getElementById("paxLabel")?.textContent?.trim() ?? "",
        dateTriggerText: document.getElementById("dateTriggerText")?.textContent?.trim() ?? "",
        layoverLabel: document.getElementById("layoverTriggerValue")?.textContent?.trim() ?? "",
      }));

      assert.equal(restored.origin, "Lima");
      assert.equal(restored.destination, "Miami");
      assert.equal(restored.departureDate, "2026-04-15");
      assert.equal(restored.returnDate, "2026-04-22");
      assert.equal(restored.adults, "2");
      assert.equal(restored.children, "1");
      assert.equal(restored.nonStop, true);
      assert.equal(restored.baggageRequired, true);
      assert.equal(restored.maxLayoverMinutes, "240");
      assert.equal(restored.sortMode, "fastest");
      assert.equal(restored.paxLabel, "2 adultos, 1 niño");
      assert.equal(restored.dateTriggerText, "15/04 → 22/04");
      assert.equal(restored.layoverLabel, "Escala: 4h");
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

test("search form routes exact and flexible one-way or round-trip requests through the expected endpoints", async () => {
  await withServer(async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const calls: Array<{ endpoint: string; tripType: string; searchMode: string }> = [];

    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      const body = route.request().postDataJSON();
      calls.push({
        endpoint: "/api/search",
        tripType: body?.request?.tripType ?? "",
        searchMode: body?.request?.searchMode ?? "",
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: `search-job-${calls.length}`,
          searchComplete: true,
          searchStatus: "completed",
          sortMode: "cheapest",
          request: body?.request,
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

    await page.route(`${baseUrl}/api/matrix`, async (route: Route) => {
      const body = route.request().postDataJSON();
      calls.push({
        endpoint: "/api/matrix",
        tripType: body?.request?.tripType ?? "",
        searchMode: body?.request?.searchMode ?? "",
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(buildMatrixResponse({
          matrixComplete: true,
          matrixStatus: "completed",
          request: body?.request,
          cells: [],
          axes: {
            departureDates: ["2026-04-18"],
            returnDates: ["2026-04-25"],
          },
          confidenceSummary: {},
          searchMeta: buildSearchMeta("search_live"),
        })),
      });
    });

    try {
      await openDesktop(page, baseUrl);
      await page.evaluate(() => {
        const origin = document.getElementById("origin") as HTMLInputElement | null;
        const destination = document.getElementById("destination") as HTMLInputElement | null;
        if (!origin || !destination) throw new Error("Missing location inputs");
        origin.value = "LIM";
        origin.dataset.code = "LIM";
        origin.dataset.label = "LIM";
        destination.value = "MIA";
        destination.dataset.code = "MIA";
        destination.dataset.label = "MIA";
      });

      await setDateValue(page, "departureDate", "2026-04-15");
      await setDateValue(page, "returnDate", "2026-04-22");
      await page.click("#submitButton");
      await page.waitForTimeout(150);

      await page.click('[data-trip="one-way"]');
      await page.click("#submitButton");
      await page.waitForTimeout(150);

      await page.click('[data-mode="flexible"]');
      await setDateValue(page, "departureStart", "2026-04-18");
      await setDateValue(page, "departureEnd", "2026-04-24");
      await page.click("#submitButton");
      await page.waitForTimeout(150);

      await page.click('[data-trip="round-trip"]');
      await page.click("#submitButton");
      await page.waitForTimeout(150);

      assert.deepEqual(calls, [
        { endpoint: "/api/search", tripType: "round-trip", searchMode: "exact" },
        { endpoint: "/api/search", tripType: "one-way", searchMode: "exact" },
        { endpoint: "/api/search", tripType: "one-way", searchMode: "stay-range" },
        { endpoint: "/api/matrix", tripType: "round-trip", searchMode: "roundtrip-grid" },
      ]);
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
        const shell = input?.closest(".field-shell");
        const rail = document.querySelector(".search-rail");
        const searchShell = document.querySelector(".search-shell");
        if (!menu || !input || !shell || !rail || !searchShell) return null;

        const menuRect = menu.getBoundingClientRect();
        const inputRect = shell.getBoundingClientRect();
        const railRect = rail.getBoundingClientRect();
        const shellRect = searchShell.getBoundingClientRect();
        const pointX = Math.round(menuRect.left + 32);
        const pointY = Math.round(menuRect.top + 18);
        const hit = document.elementFromPoint(pointX, pointY);

        return {
          inputBottom: inputRect.bottom,
          menuTop: menuRect.top,
          railBottom: railRect.bottom,
          shellBottom: shellRect.bottom,
          gap: menuRect.top - inputRect.bottom,
          centerDelta: Math.abs((menuRect.left + menuRect.width / 2) - (inputRect.left + inputRect.width / 2)),
          hitInMenu: Boolean(hit?.closest("#originSuggestions")),
        };
      });

      assert.ok(probe);
      assert.ok(probe.gap >= 0 && probe.gap <= 14, JSON.stringify(probe));
      assert.ok(probe.centerDelta <= 4, JSON.stringify(probe));
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

test("passengers and layover popovers stay centered on their triggers", async () => {
  await withServer(async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
      await openDesktop(page, baseUrl);

      await page.click("#paxTrigger");
      const paxProbe = await page.evaluate(() => {
        const trigger = document.getElementById("paxTrigger");
        const popover = document.getElementById("paxPopover");
        if (!trigger || !popover) return null;
        const triggerRect = trigger.getBoundingClientRect();
        const popRect = popover.getBoundingClientRect();
        return {
          position: getComputedStyle(popover).position,
          gap: popRect.top - triggerRect.bottom,
          centerDelta: Math.abs((popRect.left + popRect.width / 2) - (triggerRect.left + triggerRect.width / 2)),
        };
      });

      await page.click("#origin");
      await page.click("#layoverTrigger");
      await page.waitForFunction(() => !document.getElementById("layoverPopover")?.classList.contains("hidden"));
      const layoverProbe = await page.evaluate(() => {
        const trigger = document.getElementById("layoverTrigger");
        const popover = document.getElementById("layoverPopover");
        if (!trigger || !popover) return null;
        const triggerRect = trigger.getBoundingClientRect();
        const popRect = popover.getBoundingClientRect();
        return {
          position: getComputedStyle(popover).position,
          gap: popRect.top - triggerRect.bottom,
          centerDelta: Math.abs((popRect.left + popRect.width / 2) - (triggerRect.left + triggerRect.width / 2)),
        };
      });

      assert.ok(paxProbe);
      assert.equal(paxProbe.position, "fixed");
      assert.ok(paxProbe.gap >= 0 && paxProbe.gap <= 14, JSON.stringify(paxProbe));
      assert.ok(paxProbe.centerDelta <= 4, JSON.stringify(paxProbe));

      assert.ok(layoverProbe);
      assert.equal(layoverProbe.position, "fixed");
      assert.ok(layoverProbe.gap >= 0 && layoverProbe.gap <= 14, JSON.stringify(layoverProbe));
      assert.ok(layoverProbe.centerDelta <= 4, JSON.stringify(layoverProbe));
    } finally {
      await browser.close();
    }
  });
});

test("date-equivalent offers collapse into one row and keep the date variants in detail", async () => {
  await withServer(async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "search-job-grouped-dates",
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
          offers: [
            buildOfferWithDates("offer-1", "2026-04-15", "2026-04-22"),
            buildOfferWithDates("offer-2", "2026-04-16", "2026-04-23"),
            buildOfferWithDates("offer-3", "2026-04-17", "2026-04-24"),
          ],
          allOffers: [
            buildOfferWithDates("offer-1", "2026-04-15", "2026-04-22"),
            buildOfferWithDates("offer-2", "2026-04-16", "2026-04-23"),
            buildOfferWithDates("offer-3", "2026-04-17", "2026-04-24"),
          ],
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
      await page.waitForSelector('tr[data-oid="offer-1"]');

      const probe = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('tr[data-oid]')];
        const firstDateCell = rows[0]?.children[1];
        const variantTitle = [...document.querySelectorAll(".detail-segment__dir")]
          .map((node) => node.textContent?.trim() ?? "")
          .find((text) => text.includes("Fechas equivalentes")) ?? "";
        const variants = [...document.querySelectorAll("[data-inbound-id]")]
          .map((node) => node.textContent?.replace(/\s+/g, " ").trim() ?? "");

        return {
          rowCount: rows.length,
          dateText: firstDateCell?.textContent?.replace(/\s+/g, " ").trim() ?? "",
          variantTitle,
          variants,
        };
      });

      assert.equal(probe.rowCount, 1);
      assert.match(probe.dateText, /15\/04/);
      assert.match(probe.dateText, /También 16\/04 → 23\/04 y 1 fecha más/);
      assert.match(probe.variantTitle, /Fechas equivalentes — 3 variantes/);
      assert.equal(probe.variants.length, 3);
      assert.match(probe.variants[0] ?? "", /15\/04 → 22\/04/);
      assert.match(probe.variants[1] ?? "", /16\/04 → 23\/04/);
      assert.match(probe.variants[2] ?? "", /17\/04 → 24\/04/);
    } finally {
      await browser.close();
    }
  });
});

test("airlines move into the search bar ordered by cheapest fare and filter horizontally", async () => {
  await withServer(async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      const offers = [
        buildCarrierOffer("offer-aa", "AA", 505),
        buildCarrierOffer("offer-cm", "CM", 540),
        buildCarrierOffer("offer-la", "LA", 580),
      ];

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "search-job-airlines-bar",
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
          offers,
          allOffers: offers,
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
      await page.waitForSelector('[data-airline-code="AA"]');

      const beforeFilter = await page.evaluate(() => ({
        sidebarCount: document.querySelectorAll("#sidebar").length,
        chips: [...document.querySelectorAll("[data-airline-code]")].map((node) => ({
          code: node.getAttribute("data-airline-code"),
          text: node.textContent?.replace(/\s+/g, " ").trim() ?? "",
        })),
        rowCount: document.querySelectorAll('tr[data-oid]').length,
      }));

      await page.click('[data-airline-code="CM"]');

      const afterFilter = await page.evaluate(() => ({
        activeCode: document.querySelector(".airline-chip.is-active[data-airline-code]")?.getAttribute("data-airline-code") ?? "",
        rowCount: document.querySelectorAll('tr[data-oid]').length,
        visibleCarrier: document.querySelector('tr[data-oid] td .carrier-label')?.textContent?.trim() ?? "",
      }));

      assert.equal(beforeFilter.sidebarCount, 0);
      assert.deepEqual(beforeFilter.chips.map((chip) => chip.code), ["AA", "CM", "LA"]);
      assert.equal(beforeFilter.rowCount, 3);
      assert.equal(afterFilter.activeCode, "CM");
      assert.equal(afterFilter.rowCount, 1);
      assert.equal(afterFilter.visibleCarrier, "CM");
    } finally {
      await browser.close();
    }
  });
});

test("max layover filter is sent in the payload and narrows the visible results", async () => {
  await withServer(async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    let capturedMaxLayoverMinutes: number | undefined;

    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      const body = route.request().postDataJSON();
      capturedMaxLayoverMinutes = body?.request?.filters?.maxLayoverMinutes;
      const offers = [
        buildOffer({ id: "offer-direct", comparisonMetrics: { totalDurationMinutes: 480, totalStops: 0 } }),
        buildLayoverOffer("offer-short-layover", 560, 120),
        buildLayoverOffer("offer-long-layover", 590, 300),
      ];

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "search-job-max-layover",
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
              maxLayoverMinutes: body?.request?.filters?.maxLayoverMinutes,
            },
            coverageMode: "core",
            redirectMode: "best-effort",
            currencyCode: "USD",
            locale: "es-PE",
            market: "PE",
          },
          offers,
          allOffers: offers,
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
      await page.selectOption("#maxLayoverMinutes", "240");
      await page.click("#submitButton");
      await page.waitForSelector('tr[data-oid]');

      const probe = await page.evaluate(() => ({
        rowCount: document.querySelectorAll('tr[data-oid]').length,
        ids: [...document.querySelectorAll('tr[data-oid]')].map((row) => row.getAttribute("data-oid")),
      }));

      assert.equal(capturedMaxLayoverMinutes, 240);
      assert.equal(probe.rowCount, 2);
      assert.deepEqual(probe.ids, ["offer-direct", "offer-short-layover"]);
    } finally {
      await browser.close();
    }
  });
});

test("layover summary shows the maximum single layover instead of the combined total", async () => {
  await withServer(async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      const body = route.request().postDataJSON();
      const offers = [
        buildRoundTripLayoverOffer("offer-double-4h", 240, 240),
      ];

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "search-job-layover-summary",
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
              maxLayoverMinutes: body?.request?.filters?.maxLayoverMinutes,
            },
            coverageMode: "core",
            redirectMode: "best-effort",
            currencyCode: "USD",
            locale: "es-PE",
            market: "PE",
          },
          offers,
          allOffers: offers,
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
      await page.selectOption("#maxLayoverMinutes", "240");
      await page.click("#submitButton");
      await page.waitForSelector('tr[data-oid="offer-double-4h"]');

      const probe = await page.evaluate(() => {
        const time = document.querySelector(".stops-stack__time")?.textContent?.trim() ?? "";
        const title = document.querySelector(".stops-stack")?.getAttribute("title") ?? "";
        return { time, title };
      });

      assert.match(probe.time, /^4h 0?0?m$/);
      assert.match(probe.title, /Escala máx\.: 4h 0?0?m/);
      assert.match(probe.title, /Bog: 4h 0?0?m/);
    } finally {
      await browser.close();
    }
  });
});

test("changing layover selection does not shift the search rail layout", async () => {
  await withServer(async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
      await openDesktop(page, baseUrl);

      const before = await page.evaluate(() => {
        const rail = document.querySelector(".search-rail");
        const origin = document.querySelector('[data-search-order="origin"]');
        const submit = document.querySelector('[data-search-order="submit"]');
        return {
          railWidth: rail ? Math.round(rail.getBoundingClientRect().width) : 0,
          originLeft: origin ? origin.getBoundingClientRect().left : 0,
          submitRight: submit ? submit.getBoundingClientRect().right : 0,
          layoverLabel: document.getElementById("layoverTriggerValue")?.textContent?.trim() ?? "",
        };
      });

      await page.click("#layoverTrigger");
      await page.click('[data-layover-value="120"]');

      const after = await page.evaluate(() => {
        const rail = document.querySelector(".search-rail");
        const origin = document.querySelector('[data-search-order="origin"]');
        const submit = document.querySelector('[data-search-order="submit"]');
        return {
          railWidth: rail ? Math.round(rail.getBoundingClientRect().width) : 0,
          originLeft: origin ? origin.getBoundingClientRect().left : 0,
          submitRight: submit ? submit.getBoundingClientRect().right : 0,
          layoverLabel: document.getElementById("layoverTriggerValue")?.textContent?.trim() ?? "",
        };
      });

      assert.equal(after.layoverLabel, "Escala: 2h");
      assert.ok(Math.abs(after.railWidth - before.railWidth) < 1);
      assert.ok(Math.abs(after.originLeft - before.originLeft) < 1);
      assert.ok(Math.abs(after.submitRight - before.submitRight) < 1);
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
