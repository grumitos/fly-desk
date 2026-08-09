import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page, Route } from "playwright";
import { openDesktop, withDesktopPage } from "../helpers/ui.ts";
import { buildOffer } from "../helpers/ui-fixtures.ts";
import { clickSegment, segment, waitForSegmentChecked } from "./support.ts";

test("round-trip flexible search sends matrix exact-stay payload", async () => {
  await withDesktopPage(async ({ page }) => {
    let payload: Record<string, unknown> | undefined;

    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/matrix", async (route) => {
      payload = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          matrixJobId: "matrix-1",
          matrixComplete: true,
          matrixStatus: "completed",
          revision: 1,
          request: payload?.request,
          searchMeta: {
            requestedAt: "2026-03-31T00:00:00.000Z",
            completedAt: "2026-03-31T00:00:00.000Z",
            providersUsed: [],
            warnings: [],
            partial: false,
            searchState: "search_live",
          },
          providerMeta: {
            exactProvider: "costamar",
            coverageMode: "core",
          },
          warnings: [],
          cells: [
            {
              key: "2026-04-03_2026-04-10",
              departureDate: "2026-04-03",
              returnDate: "2026-04-10",
              stayNights: 7,
              price: { amount: 480, currencyCode: "USD" },
              confidence: "live",
              providerSource: "costamar",
              selectable: true,
              requiresRequery: false,
              stateCode: "live",
              tooltip: "Mejor tarifa",
              offer: {
                id: "costamar-matrix-offer",
                providerSource: "costamar",
                providerOfferRef: "costamar-ref",
                tripType: "round-trip",
                validatingCarrier: "H2",
                mainCarrier: "H2",
                origin: "LIM",
                destination: "MIA",
                itineraries: [
                  {
                    id: "outbound",
                    direction: "outbound",
                    durationMinutes: 345,
                    stops: 0,
                    layoverMinutes: [],
                    segments: [
                      {
                        id: "outbound-1",
                        marketingCarrier: "H2",
                        marketingCarrierName: "Sky Airline",
                        flightNumber: "2550",
                        origin: "LIM",
                        destination: "MIA",
                        departureAt: "2026-04-03T14:25:00",
                        arrivalAt: "2026-04-03T20:10:00",
                        durationMinutes: 345,
                      },
                    ],
                  },
                  {
                    id: "inbound",
                    direction: "inbound",
                    durationMinutes: 370,
                    stops: 0,
                    layoverMinutes: [],
                    segments: [
                      {
                        id: "inbound-1",
                        marketingCarrier: "H2",
                        marketingCarrierName: "Sky Airline",
                        flightNumber: "2551",
                        origin: "MIA",
                        destination: "LIM",
                        departureAt: "2026-04-10T08:30:00",
                        arrivalAt: "2026-04-10T14:40:00",
                        durationMinutes: 370,
                      },
                    ],
                  },
                ],
                price: {
                  total: { amount: 480, currencyCode: "USD" },
                },
                priceConfidence: "live",
                priceStatus: "unverified",
                purchasePaths: [],
                comparisonMetrics: {
                  totalDurationMinutes: 715,
                  totalStops: 0,
                  baggageScore: 0,
                  purchasePathScore: 0,
                },
                tags: [],
                warnings: [],
              },
            },
          ],
          axes: {
            departureDates: ["2026-04-03"],
            returnDates: ["2026-04-10"],
          },
          confidenceSummary: { live: 1 },
          recommendations: [],
        }),
      });
    });

    await clickSegment(segment(page, "Flexible"));
    await page.getByRole("combobox", { name: "Origen" }).fill("LIM");
    await page.getByRole("combobox", { name: "Destino" }).fill("MIA");
    await page.getByRole("button", { name: "Salida desde" }).click();
    const calendar = page.getByRole("dialog", { name: "Calendario de fechas" });
    await calendar.getByRole("button", { name: /^3 de abril de 2026/ }).click();
    await calendar.getByRole("button", { name: /^5 de abril de 2026/ }).click();
    await Promise.all([
      page.waitForResponse("**/api/matrix"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);

    const request = payload?.request as {
      tripType?: string;
      searchMode?: string;
      flexibleMode?: string;
      legs?: Array<Record<string, unknown>>;
    };
    const leg = request.legs?.[0];

    assert.equal(payload?.sortMode, "cheapest");
    assert.equal(request.tripType, "round-trip");
    assert.equal(request.searchMode, "roundtrip-grid");
    assert.equal(request.flexibleMode, "exact-stay");
    assert.equal(leg?.departureStart, "2026-04-03");
    assert.equal(leg?.departureEnd, "2026-04-05");
    assert.equal(leg?.stayNights, 7);
    await page.getByText("USD 480").waitFor();
    const flexibleCard = page.getByTestId("result-card").first();
    const offerLabel = await flexibleCard.getByRole("button").first().getAttribute("aria-label") ?? "";
    assert.match(offerLabel, /Ida: 14:25.*20:10/);
    assert.match(offerLabel, /Vuelta: 08:30.*14:40/);
    const bodyText = await page.locator("body").innerText();
    assert.doesNotMatch(bodyText, /\b00:00\b/);
    assert.match(bodyText, /14:25/);
    assert.match(bodyText, /20:10/);
    assert.match(bodyText, /08:30/);
    assert.match(bodyText, /14:40/);
    assert.match(bodyText, /5h 45m/);
    assert.match(bodyText, /6h 10m/);
    assert.doesNotMatch(bodyText, /Horario por confirmar/);
    // 04 §3: the order is one segmented of two options — a radio group, so
    // the chosen one carries `aria-checked` (01 §3, 11 §8).
    const sortControl = page.getByRole("radiogroup", { name: "Orden de resultados" });
    assert.deepEqual(
      (await sortControl.getByRole("radio").allTextContents()).map((label) => label.trim()),
      ["Precio", "Duración"],
    );
    assert.equal(await segment(page, "Ordenar por precio").getAttribute("aria-checked"), "true");
    assert.equal(await segment(page, "Ordenar por duración").getAttribute("aria-checked"), "false");
  });
});

test("migratory search sends monthly stay-range requests", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    const payloads: Record<string, unknown>[] = [];
    let quotationRequests = 0;
    const migratory = segment(page, "Migratorio");

    await page.route(`${baseUrl}/`, async (route) => {
      const response = await route.fetch();
      const body = (await response.text())
        .replace(/"minSearchDate":"[^"]+"/, '"minSearchDate":"2026-09-15"')
        .replace(/"maxSearchDate":"[^"]+"/, '"maxSearchDate":"2027-09-15"');
      await route.fulfill({ response, body });
    });

    await page.route("**/api/locations**", async (route) => {
      const query = new URL(route.request().url()).searchParams.get("q")?.trim().toUpperCase() ?? "";
      const place = query === "MIA"
        ? { city: "Miami", country: "Estados Unidos", countryCode: "US" }
        : { city: "Lima", country: "Perú", countryCode: "PE" };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          suggestions: query ? [{
            code: query,
            ...place,
            label: `${query} - ${place.city}, ${place.country}`,
          }] : [],
        }),
      });
    });
    await page.route("**/api/search", async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      payloads.push(payload);
      const offers = payloads.length === 1
        ? [
            buildOffer({
              id: "migration-offer-1",
              tripType: "one-way",
              itineraries: [
                {
                  id: "migration-offer-1-outbound",
                  direction: "outbound",
                  durationMinutes: 80,
                  stops: 0,
                  layoverMinutes: [],
                  segments: [
                    {
                      id: "migration-offer-1-outbound-1",
                      flightNumber: "LA 2011",
                      marketingCarrier: "LA",
                      origin: "LIM",
                      destination: "MIA",
                      departureAt: "2026-12-15T14:00:00Z",
                      arrivalAt: "2026-12-15T15:20:00Z",
                      durationMinutes: 80,
                    },
                  ],
                },
              ],
            }),
          ]
        : [];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: `migration-month-${payloads.length}`,
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: "cheapest",
          request: payload.request,
          offers,
          allOffers: offers,
          searchMeta: {
            requestedAt: "2026-03-31T00:00:00.000Z",
            completedAt: "2026-03-31T00:00:00.000Z",
            providersUsed: [],
            warnings: [],
            partial: false,
            searchState: "search_live",
          },
          providerMeta: {
            exactProvider: "agil-local",
            coverageMode: "core",
          },
          warnings: [],
        }),
      });
    });
    await page.route("**/api/quotation", async (route) => {
      quotationRequests += 1;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Quotation endpoint must not be used by the UI." }),
      });
    });

    await openDesktop(page, baseUrl);
    await assert.equal(await migratory.isDisabled(), false);
    await migratory.click();
    await page.getByRole("button", { name: /^Meses:/ }).click();
    const monthSelector = page.getByRole("dialog", { name: "Selector de meses" });
    await monthSelector.getByRole("button", { name: /^diciembre de 2026/i }).click();
    await monthSelector.getByRole("button", { name: /^enero de 2027/i }).click();
    await page.getByRole("combobox", { name: "Origen" }).fill("LIM");
    await page.getByRole("combobox", { name: "Destino" }).fill("MIA");
    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);
    await page.getByTestId("migration-month-card").filter({ hasText: "USD 512.00" }).waitFor();
    const topbarControls = page.getByTestId("topbar-search-controls");
    assert.equal(await segment(topbarControls, "Migratorio").count(), 1);
    assert.equal(await segment(page.locator("main"), "Migratorio").count(), 0);
    /* The filter panel now has a `<header>` of its own (04 §2), so the title
       bar has to be named — `header` alone matches two elements. */
    const topbarHeight = async () => Math.round(await page.locator("header.fd-topbar").evaluate((element) =>
      element.getBoundingClientRect().height,
    ));
    const migrationTopbarHeight = await topbarHeight();
    await clickSegment(segment(topbarControls, "Flexible"));
    const flexibleTopbarHeight = await topbarHeight();
    assert.ok(Math.abs(migrationTopbarHeight - flexibleTopbarHeight) <= 2);
    await clickSegment(segment(topbarControls, "Exacto"));
    assert.ok(Math.abs(await topbarHeight() - flexibleTopbarHeight) <= 2);
    await clickSegment(segment(topbarControls, "Migratorio"));
    assert.ok(Math.abs(await topbarHeight() - flexibleTopbarHeight) <= 2);
    assert.equal(await page.getByTestId("migration-month-card").count(), 2);
    const migrationCard = page.getByTestId("migration-month-card").filter({ hasText: "USD 512.00" });
    const migrationCardText = await migrationCard.innerText();
    assert.match(await migrationCard.getAttribute("aria-label") ?? "", /Diciembre de 2026: USD 512\.00/);
    assert.match(migrationCardText, /14:00/);
    assert.match(migrationCardText, /15:20/);
    assert.doesNotMatch(migrationCardText, /Vta|Vuelta/);
    const bodyText = await page.locator("body").innerText();
    assert.doesNotMatch(bodyText, /\b00:00\b/);
    assert.match(bodyText, /14:00/);
    assert.match(bodyText, /Diciembre de 2026/i);

    assert.equal(payloads.length, 2);
    const firstRequest = payloads[0].request as {
      tripType?: string;
      searchMode?: string;
      legs?: Array<Record<string, unknown>>;
    };
    const firstLeg = firstRequest.legs?.[0];

    assert.equal(firstRequest.tripType, "one-way");
    assert.equal(firstLeg?.originLabel, "LIM - Lima, Perú");
    assert.equal(firstLeg?.destinationLabel, "MIA - Miami, Estados Unidos");
    assert.equal(firstLeg?.originCountryCode, "PE");
    assert.equal(firstLeg?.destinationCountryCode, "US");
    assert.equal(firstRequest.searchMode, "stay-range");
    assert.equal(firstLeg?.departureStart, "2026-12-01");
    assert.equal(firstLeg?.departureEnd, "2026-12-31");
    assert.equal(firstLeg?.returnDate, undefined);
    const secondLeg = (payloads[1].request as { legs?: Array<Record<string, unknown>> }).legs?.[0];
    assert.equal(secondLeg?.departureStart, "2027-01-01");
    assert.equal(secondLeg?.departureEnd, "2027-01-31");

    /* 06 §1.3 and 11 §5: choosing a month opens that month's ordinary list —
       the same one-way range search the sweep ran for it, dates already in the
       form. It used to open the detail panel of the month's best fare instead,
       leaving `month.searchJobId` stored and read by nothing. */
    await Promise.all([
      page.waitForResponse("**/api/search"),
      migrationCard.click(),
    ]);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="migration-month-card"]').length === 0);
    assert.equal(payloads.length, 3);
    const openedMonth = (payloads[2].request as { searchMode?: string; legs?: Array<Record<string, unknown>> });
    assert.equal(openedMonth.searchMode, "stay-range");
    assert.equal(openedMonth.legs?.[0]?.departureStart, "2026-12-01");
    assert.equal(openedMonth.legs?.[0]?.departureEnd, "2026-12-31");
    // The form followed: one-way flexible over that month, not the sweep.
    await waitForSegmentChecked(segment(topbarControls, "Flexible"));

    // Opening a month is not quoting it.
    assert.equal(quotationRequests, 0);
  }, { autoOpen: false });
});

test("a month still being queried is drawn as searching, and a finished empty month says how much of it was priced", async () => {
  /*
   * The router's first response for every month is a draft — `partial: true`
   * with no offers — so a month that has only just been asked used to land on
   * the empty card with no spinner, price «—» and «sin tarifa en el mes», while
   * the header above counted it under «N buscando». And a month that finished
   * clean with zero fares had its coverage computed and correct, and dropped it.
   */
  await withDesktopPage(async ({ baseUrl, page }) => {
    let releaseSecondMonth = false;
    const migratory = segment(page, "Migratorio");

    await page.route(`${baseUrl}/`, async (route) => {
      const response = await route.fetch();
      const body = (await response.text())
        .replace(/"minSearchDate":"[^"]+"/, '"minSearchDate":"2026-09-15"')
        .replace(/"maxSearchDate":"[^"]+"/, '"maxSearchDate":"2027-09-15"');
      await route.fulfill({ response, body });
    });
    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ suggestions: [] }) });
    });

    const monthJob = (jobId: string, complete: boolean, request: unknown) => ({
      searchJobId: jobId,
      searchComplete: complete,
      searchStatus: complete ? "completed" : "running",
      revision: complete ? 2 : 1,
      sortMode: "cheapest",
      request,
      offers: [],
      allOffers: [],
      searchMeta: {
        requestedAt: "2026-10-01T00:00:00.000Z",
        completedAt: "2026-10-01T00:00:00.000Z",
        providersUsed: ["agil-local"],
        // The draft's own flag, and the one that used to decide the month state.
        warnings: complete ? [] : ["Consultando Agil y Click and Book Plus."],
        partial: !complete,
        searchState: complete ? "search_live" : "search_partial",
      },
      providerMeta: { exactProvider: "agil-local", coverageMode: "core" },
      warnings: [],
    });

    await page.route("**/api/search**", async (route) => {
      const url = new URL(route.request().url());
      const method = route.request().method();

      if (method === "POST" && url.pathname === "/api/search") {
        const payload = route.request().postDataJSON() as Record<string, unknown>;
        const leg = (payload.request as { legs?: Array<Record<string, unknown>> }).legs?.[0];
        const jobId = String(leg?.departureStart ?? "unknown");
        // December finishes at once with nothing; January stays out.
        const complete = jobId.startsWith("2026-12");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(monthJob(jobId, complete, payload.request)),
        });
        return;
      }

      if (method === "GET" && url.pathname.startsWith("/api/search/")) {
        const jobId = url.pathname.slice("/api/search/".length);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(monthJob(jobId, releaseSecondMonth, undefined)),
        });
        return;
      }

      await route.continue();
    });

    await openDesktop(page, baseUrl);
    await migratory.click();
    await page.getByRole("button", { name: /^Meses:/ }).click();
    const monthSelector = page.getByRole("dialog", { name: "Selector de meses" });
    await monthSelector.getByRole("button", { name: /^diciembre de 2026/i }).click();
    await monthSelector.getByRole("button", { name: /^enero de 2027/i }).click();
    await page.getByRole("combobox", { name: "Origen" }).fill("LIM");
    await page.getByRole("combobox", { name: "Destino" }).fill("MIA");
    await page.getByRole("button", { name: "Buscar" }).click();

    const cards = page.getByTestId("migration-month-card");
    const january = cards.filter({ hasText: "Enero de 2027" });
    // Still out: 06 §3's «buscando» — badge, «···», and no claim of no fares.
    await january.getByText("Buscando", { exact: true }).waitFor();
    const januaryText = await january.innerText();
    assert.match(januaryText, /···/);
    assert.doesNotMatch(januaryText, /sin tarifa en el mes/);
    assert.doesNotMatch(januaryText, /No se pudo completar la operación/);

    // Finished with nothing: the coverage line is the informative part.
    const december = cards.filter({ hasText: "Diciembre de 2026" });
    await december.getByText("0 de 31 días con tarifa").waitFor();
    assert.equal(await december.getByText("Buscando", { exact: true }).count(), 0);

    releaseSecondMonth = true;
    await page.getByRole("button", { name: "Buscar" }).waitFor();
    await page.waitForFunction(() =>
      !Array.from(document.querySelectorAll('[data-testid="migration-month-card"]'))
        .some((card) => card.textContent?.includes("Buscando"))
    );
  }, { autoOpen: false });
});

test("mobile workspace replaces search modes with the compact active-search summary", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/search", async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      const offer = buildOffer({ id: "mobile-layout-offer", origin: "LIM", destination: "MIA" });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "mobile-layout-search",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: payload.sortMode,
          request: payload.request,
          offers: [offer],
          allOffers: [offer],
          searchMeta: {
            requestedAt: "2026-03-31T00:00:00.000Z",
            completedAt: "2026-03-31T00:00:00.000Z",
            providersUsed: ["agil-local"],
            warnings: [],
            partial: false,
            searchState: "search_live",
          },
          providerMeta: {
            exactProvider: "agil-local",
            coverageMode: "core",
          },
          warnings: [],
        }),
      });
    });

    await page.goto(`${baseUrl}/?mode=exact&trip=one-way&origin=LIM&destination=MIA&departure=2026-06-08&adults=1&children=0&infants=0`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("button", { name: "Buscar" }).click();
    await page.getByTestId("result-card").waitFor();

    assert.equal(await segment(page.getByTestId("topbar-search-controls"), "Exacto").count(), 0);
    assert.equal(await segment(page.locator("main"), "Exacto").count(), 0);
    await page.locator(".fd-mobile-search-summary").filter({ hasText: "LIM" }).waitFor();
    await page.locator(".fd-mobile-search-summary").filter({ hasText: "MIA" }).waitFor();
  });
});

test("migratory search renders monthly progress and refilters each month locally", async () => {
  await withDesktopPage(async ({ page }) => {
    let requestCount = 0;
    let heldFirstPollRoute: Route | null = null;
    let firstPayload: Record<string, unknown> | null = null;
    let heldSecondRoute: Route | null = null;
    let heldSecondPayload: Record<string, unknown> | null = null;

    const migrationOffer = (id: string, amount: number, stops: number) => buildOffer({
      id,
      tripType: "one-way",
      mainCarrier: stops === 0 ? "LA" : "AA",
      validatingCarrier: stops === 0 ? "LA" : "AA",
      comparisonMetrics: {
        totalDurationMinutes: stops === 0 ? 480 : 660,
        totalStops: stops,
        baggageScore: 2,
        purchasePathScore: 1,
      },
      price: {
        total: { amount, currencyCode: "USD" },
        base: { amount: Math.max(0, amount - 90), currencyCode: "USD" },
        taxes: { amount: 90, currencyCode: "USD" },
      },
      itineraries: [
        {
          id: `${id}-outbound`,
          direction: "outbound",
          durationMinutes: stops === 0 ? 480 : 660,
          stops,
          layoverMinutes: stops === 0 ? [] : [180],
          segments: stops === 0
            ? [
                {
                  id: `${id}-outbound-1`,
                  flightNumber: "LA 2011",
                  marketingCarrier: "LA",
                  origin: "LIM",
                  destination: "MIA",
                  departureAt: "2026-04-15T14:00:00Z",
                  arrivalAt: "2026-04-15T22:00:00Z",
                  durationMinutes: 480,
                },
              ]
            : [
                {
                  id: `${id}-outbound-1`,
                  flightNumber: "AA 100",
                  marketingCarrier: "AA",
                  origin: "LIM",
                  destination: "BOG",
                  departureAt: "2026-04-15T08:00:00Z",
                  arrivalAt: "2026-04-15T11:00:00Z",
                  durationMinutes: 180,
                },
                {
                  id: `${id}-outbound-2`,
                  flightNumber: "AA 200",
                  marketingCarrier: "AA",
                  origin: "BOG",
                  destination: "MIA",
                  departureAt: "2026-04-15T14:00:00Z",
                  arrivalAt: "2026-04-15T19:00:00Z",
                  durationMinutes: 300,
                },
              ],
        },
      ],
    });
    const fulfillSearch = async (
      route: Route,
      payload: Record<string, unknown>,
      offers: unknown[],
      id: string,
      complete = true,
    ) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: id,
          searchComplete: complete,
          searchStatus: complete ? "completed" : "running",
          revision: 1,
          sortMode: "cheapest",
          request: payload.request,
          offers,
          allOffers: offers,
          searchMeta: {
            requestedAt: "2026-03-31T00:00:00.000Z",
            completedAt: "2026-03-31T00:00:00.000Z",
            providersUsed: ["agil-local"],
            warnings: [],
            partial: false,
            searchState: "search_live",
          },
          providerMeta: {
            exactProvider: "agil-local",
            coverageMode: "core",
          },
          warnings: [],
        }),
      });
    };

    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/search**", async (route) => {
      if (route.request().method() === "GET") {
        heldFirstPollRoute = route;
        return;
      }
      requestCount += 1;
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      if (requestCount === 1) {
        firstPayload = payload;
        await fulfillSearch(route, payload, [
          migrationOffer("migration-cheapest-stop", 90, 1),
          migrationOffer("migration-direct", 150, 0),
        ], "migration-progress-1", false);
        return;
      }

      if (requestCount === 2) {
        heldSecondRoute = route;
        heldSecondPayload = payload;
        return;
      }

      await fulfillSearch(route, payload, [], `migration-progress-${requestCount}`);
    });

    await clickSegment(segment(page, "Migratorio"));
    await page.getByRole("combobox", { name: "Origen" }).fill("LIM");
    await page.getByRole("combobox", { name: "Destino" }).fill("MIA");
    /* The sweep starts empty (11 §0.2), so the months are a gesture like any
       other: open the picker, sweep the first eight, close. */
    await page.getByRole("button", { name: /^Meses:/ }).click();
    const monthPicker = page.getByRole("dialog", { name: "Selector de meses" });
    await monthPicker.waitFor();
    const pickableMonths = monthPicker.locator("button:not([disabled])[aria-label*='de 20']");
    await pickableMonths.first().click();
    await pickableMonths.nth(7).click();
    await page.keyboard.press("Escape");
    await monthPicker.waitFor({ state: "detached" });
    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);

    const migrationCards = page.getByTestId("migration-month-card");
    const updatingCard = migrationCards.filter({ hasText: "USD 90.00" });
    await updatingCard.waitFor();
    await updatingCard.getByText("Act.", { exact: true }).waitFor();
    assert.equal(await migrationCards.count(), 8);
    assert.equal(await page.getByRole("button", { name: "Detener búsqueda" }).count(), 1);
    assert.match(await updatingCard.getAttribute("aria-label") ?? "", /USD 90\.00/);

    const stopsControl = page.getByRole("radiogroup", { name: "Escalas" });
    await clickSegment(segment(stopsControl, "Directo"));
    await migrationCards.filter({ hasText: "USD 150.00" }).waitFor();
    assert.equal(await migrationCards.filter({ hasText: "USD 90.00" }).count(), 0);

    for (let attempt = 0; attempt < 40 && !heldFirstPollRoute; attempt += 1) {
      await page.waitForTimeout(50);
    }
    assert.ok(heldFirstPollRoute, "Expected the first migration poll to be held");
    assert.ok(firstPayload, "Expected the first migration request payload");
    await fulfillSearch(heldFirstPollRoute, firstPayload, [
        migrationOffer("migration-cheapest-stop", 90, 1),
        migrationOffer("migration-direct", 150, 0),
      ], "migration-progress-1");

    assert.ok(heldSecondRoute, "Expected the second migration request to be held");
    assert.ok(heldSecondPayload, "Expected the second migration request payload");
    await fulfillSearch(heldSecondRoute, heldSecondPayload, [], "migration-progress-2");
    await page.getByRole("button", { name: "Detener búsqueda" }).waitFor({ state: "hidden" });
    const resumedSearchButton = page.locator('button[aria-label="Buscar"]:visible').first();
    await resumedSearchButton.waitFor({ state: "visible" });
    assert.equal(await resumedSearchButton.isEnabled(), true);
    assert.equal(requestCount, 8);
  });
});
