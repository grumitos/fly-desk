import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page, Route } from "playwright";
import { openDesktop, registerDesktopHarness, withDesktopPage } from "../helpers/ui.ts";
import { buildOffer } from "../helpers/ui-fixtures.ts";
import { clickSegment, segment, waitForSegmentChecked } from "./support.ts";

registerDesktopHarness();

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
    // The sweep starts empty now, so the picker is a real step: close it before
    // reaching for the fields behind it.
    await page.keyboard.press("Escape");
    await monthSelector.waitFor({ state: "detached" });
    /* Take the suggestion instead of dismissing it. `Esc` on a location field
       restores the previous value (11 §2.1), so pressing it after typing empties
       the field and leaves the CTA disabled — `Enter` is the gesture that
       commits «IATA + ciudad» and closes the panel. */
    await page.getByRole("combobox", { name: "Origen" }).fill("LIM");
    await page.getByRole("combobox", { name: "Origen" }).press("Enter");
    await page.getByRole("combobox", { name: "Destino" }).fill("MIA");
    await page.getByRole("combobox", { name: "Destino" }).press("Enter");
    await page.waitForFunction(() => document.querySelectorAll('[role="listbox"]').length === 0);
    /* Wait on the sweep landing rather than on a single response: migratorio is
       one request per month, so «the search happened» is two of them and the
       grid is the only place that says both arrived. */
    await page.getByRole("button", { name: "Buscar" }).click();
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
    // The label lives on the card's hit button now that «Abrir mes» is its own control.
    assert.match(await migrationCard.locator(".fd-month-card__hit").getAttribute("aria-label") ?? "", /Diciembre de 2026: USD 512.00/);
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

    /* A month card selects, like a result card: the detail panel says the rest
       and the sweep stays on screen. This used to assert the opposite — that
       the click ran a third search — which meant reading one month cost a
       search and a way back. Opening the month is «Abrir mes», its own control,
       and it reads the job the sweep already ran; that path has its own case. */
    await migrationCard.locator(".fd-month-card__hit").click();
    await page.getByTestId("detail-panel-body").waitFor();
    assert.equal(await page.getByTestId("migration-month-card").count(), 2);
    assert.equal(payloads.length, 2);
    assert.match(await migrationCard.getAttribute("class") ?? "", /is-selected/);
    /* The form does not follow either: selecting a month reads it, so the sweep
       and its mode stay exactly where the agent left them. The old flow
       switched to Flexible here because the click ran a range search. */
    await waitForSegmentChecked(segment(topbarControls, "Migratorio"));

    // Reading a month is not quoting it.
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
    // The sweep starts empty now, so the picker is a real step: close it before
    // reaching for the fields behind it.
    await page.keyboard.press("Escape");
    await monthSelector.waitFor({ state: "detached" });
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
    assert.match(await updatingCard.locator(".fd-month-card__hit").getAttribute("aria-label") ?? "", /USD 90.00/);

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

test("11 §3 · a month card selects like a result card, and «Abrir mes» opens the job the sweep already ran", async () => {
  await withDesktopPage(async ({ baseUrl, context, page }) => {
    /*
     * A month used to be one button that launched the day search, so reading a
     * month cost a search and a way back. The click now selects and the detail
     * panel says the rest; opening the month is its own control, and the tab it
     * opens reads the job that month already has on the server instead of
     * paying for the same work twice.
     */
    /* Three months of sweep, taken from the picker rather than written down:
       the window it offers starts at the server's pinned `SEARCH_TODAY_OVERRIDE`
       and the months are whatever that start implies. */
    const sweepMonthCount = 3;
    const offerFor = (monthKey: string, amount: number) => buildOffer({
      id: `sweep-${monthKey}`,
      destination: "MAD",
      price: {
        total: { amount, currencyCode: "USD" },
        base: { amount: amount - 100, currencyCode: "USD" },
        taxes: { amount: 100, currencyCode: "USD" },
      },
    });

    /*
     * The two lookups the sweep is gated on.
     *
     * `handleSubmit` resolves «LIM» and «MAD» against `/api/locations` *before*
     * it starts the search, so with the endpoint left live there is an
     * unbounded round trip against the shared test server sitting between the
     * click on «Buscar» and the first month card — and nothing in this case was
     * gating on it. A loaded CI runner is simply more likely to lose that race,
     * and when it does the only symptom is `migration-month-card` never
     * appearing, which reads as a grid bug and is not one. The sibling cases in
     * this file stub the endpoint for the same reason. Routed on the context so
     * the tab «Abrir mes» opens is covered too.
     */
    const knownLocations: Record<string, Record<string, string>> = {
      LIM: { code: "LIM", city: "Lima", country: "Perú", countryCode: "PE", cityCode: "LIM", searchType: "CI", label: "LIM - Lima, Perú" },
      MAD: { code: "MAD", city: "Madrid", country: "España", countryCode: "ES", cityCode: "MAD", searchType: "CI", label: "MAD - Madrid, España" },
    };
    await context.route("**/api/locations**", async (route) => {
      const query = (new URL(route.request().url()).searchParams.get("q") ?? "").trim().toUpperCase();
      const suggestion = knownLocations[query];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ query, suggestions: suggestion ? [suggestion] : [] }),
      });
    });

    // One job per month, named after the month it swept.
    await page.route("**/api/search", async (route) => {
      const payload = route.request().postDataJSON() as {
        request: { legs: { departureStart?: string }[] };
        sortMode: string;
      };
      /* No date fallback: a payload that stopped carrying `departureStart` used
         to collapse every month onto one job id and pass, which is how the
         request shape could drift without this case noticing. */
      const monthKey = (payload.request.legs[0]?.departureStart ?? "sin-fecha").slice(0, 7);
      const offers = [offerFor(monthKey, 1500)];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: `month-job-${monthKey}`,
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: payload.sortMode,
          request: payload.request,
          offers,
          allOffers: offers,
          searchMeta: {
            requestedAt: "2026-03-31T12:00:00.000Z",
            completedAt: "2026-03-31T12:00:01.000Z",
            providersUsed: ["agil-local"],
            warnings: [],
            partial: false,
            searchState: "search_live",
          },
          providerMeta: { exactProvider: "agil-local", coverageMode: "core" },
          warnings: [],
        }),
      });
    });

    // What the restored tab reads. Routed on the context so the new tab gets it.
    let restoreRequests = 0;
    await context.route("**/api/search/month-job-*", async (route) => {
      restoreRequests += 1;
      const monthKey = new URL(route.request().url()).pathname.split("month-job-")[1] ?? "";
      const offers = [offerFor(monthKey, 1500), offerFor(`${monthKey}-b`, 1620)];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: `month-job-${monthKey}`,
          searchComplete: true,
          searchStatus: "completed",
          revision: 7,
          sortMode: "cheapest",
          request: {
            origin: "LIM",
            destination: "MAD",
            searchMode: "range",
            tripType: "one-way",
            departureStart: `${monthKey}-01`,
            departureEnd: `${monthKey}-28`,
            adults: 1,
            children: 0,
            infants: 0,
            cabin: "ECONOMY",
          },
          offers,
          allOffers: offers,
          searchMeta: {
            requestedAt: "2026-03-31T12:00:00.000Z",
            completedAt: "2026-03-31T12:00:01.000Z",
            providersUsed: ["agil-local"],
            warnings: [],
            partial: false,
            searchState: "search_live",
          },
          providerMeta: { exactProvider: "agil-local", coverageMode: "core" },
          warnings: [],
        }),
      });
    });

    await page.goto(`${baseUrl}/?mode=migration&trip=one-way&origin=LIM&destination=MAD&adults=1&children=0&infants=0`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();
    await page.getByRole("button", { name: /^Meses:/ }).click();
    const monthPicker = page.getByRole("dialog", { name: "Selector de meses" });
    await monthPicker.waitFor();
    const pickable = monthPicker.locator("button:not([disabled])[aria-label*='de 20']");
    await pickable.first().click();
    await pickable.nth(sweepMonthCount - 1).click();
    await page.keyboard.press("Escape");
    await monthPicker.waitFor({ state: "detached" });
    /* Wait for the sweep to leave, not just for the click to land: the form
       submits asynchronously, so a case that only watches for a card cannot
       tell «the grid did not render» from «the search never started» — and it
       was always the second one. */
    await Promise.all([
      page.waitForRequest("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);

    const cards = page.getByTestId("migration-month-card");
    await cards.first().waitFor();
    const sweepUrl = page.url();

    // Selecting stays on the sweep and hands the offer to the detail panel.
    await cards.first().locator(".fd-month-card__hit").click();
    await page.getByTestId("detail-panel-body").waitFor();
    assert.equal(page.url(), sweepUrl);
    assert.ok(await cards.count() >= 2);
    assert.match(await cards.first().getAttribute("class") ?? "", /is-selected/);

    // Opening is the other gesture, and it goes to that month's own job.
    const [openedTab] = await Promise.all([
      context.waitForEvent("page"),
      page.getByRole("button", { name: "Abrir mes" }).first().click(),
    ]);
    /* Wait for the navigation, not for a load state: a tab that has only just
       been created is still `about:blank`, `domcontentloaded` resolves against
       that immediately, and `url()` then returns "" — which is what made
       `new URL()` throw `TypeError: Invalid URL` on a loaded CI runner while
       passing on a quiet laptop. `waitForURL` waits for the real navigation and
       asserts its shape in the same step. */
    await openedTab.waitForURL(/\?job=month-job-\d{4}-\d{2}$/);

    // And it paints from the job rather than starting a search of its own.
    await openedTab.getByTestId("result-card").first().waitFor();
    assert.equal(await openedTab.getByTestId("result-card").count(), 2);
    assert.ok(restoreRequests >= 1);
  }, { autoOpen: false });
});
