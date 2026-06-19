import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page, Route } from "playwright";
import { withDesktopPage } from "../helpers/ui.ts";
import { buildOffer } from "../helpers/ui-fixtures.ts";
import { clickSegment } from "./support.ts";

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

    await page.getByRole("button", { name: "Flexible" }).click();
    await page.getByRole("combobox", { name: "Origen" }).fill("LIM");
    await page.getByRole("combobox", { name: "Destino" }).fill("MIA");
    await page.getByRole("button", { name: "Salida desde" }).click();
    await page.getByRole("dialog", { name: "Calendario de salida desde" }).getByRole("button", { name: "03 abr 2026" }).click();
    await page.getByRole("button", { name: "Salida hasta" }).click();
    await page.getByRole("dialog", { name: "Calendario de salida hasta" }).getByRole("button", { name: "05 abr 2026" }).click();
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
    assert.equal(await flexibleCard.locator(".fd-result-card__schedule").count(), 2);
    assert.equal(await flexibleCard.locator(".fd-result-card__schedules").getAttribute("data-trip-type"), "round-trip");
    assert.doesNotMatch(await flexibleCard.locator(".fd-result-card__route").innerText(), /Vuelta/);
    const bodyText = await page.locator("body").innerText();
    assert.doesNotMatch(bodyText, /\b00:00\b/);
    assert.match(bodyText, /14:25/);
    assert.match(bodyText, /20:10/);
    assert.match(bodyText, /08:30/);
    assert.match(bodyText, /14:40/);
    assert.match(bodyText, /11h 55m/);
    assert.doesNotMatch(bodyText, /Horario por confirmar/);
    const sortControl = page.getByLabel("Orden de resultados");
    assert.match(await sortControl.getAttribute("class") ?? "", /items-stretch/);
    assert.doesNotMatch(await sortControl.getAttribute("class") ?? "", /p-0\.5/);
    assert.equal(await sortControl.locator(".fd-segmented-indicator").count(), 1);
    assert.deepEqual(
      (await sortControl.getByRole("button").allTextContents()).map((label) => label.trim()),
      ["Precio", "Duración"],
    );
    assert.equal(await page.getByRole("button", { name: "Ordenar por precio" }).getAttribute("aria-pressed"), "true");
  });
});

test("migratory search sends monthly stay-range requests", async () => {
  await withDesktopPage(async ({ page }) => {
    const payloads: Record<string, unknown>[] = [];
    const migratory = page.getByRole("button", { name: "Migratorio" });

    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/search", async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      payloads.push(payload);
      const offers = payloads.length === 1
        ? [
            buildOffer({
              id: "migration-offer-1",
              itineraries: [
                {
                  direction: "outbound",
                  durationMinutes: 80,
                  stops: 0,
                  segments: [
                    {
                      flightNumber: "LA 2011",
                      origin: "LIM",
                      destination: "MIA",
                      departureAt: "2026-04-15T14:00:00Z",
                      arrivalAt: "2026-04-15T15:20:00Z",
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

    await assert.equal(await migratory.isDisabled(), false);
    await migratory.click();
    await page.getByRole("button", { name: "Mes desde", exact: true }).click();
    await page.getByRole("dialog", { name: "Calendario de mes desde" }).getByRole("button", { name: /Mayo de 2026/i }).click();
    await page.getByRole("button", { name: "Mes hasta", exact: true }).click();
    await page.getByRole("dialog", { name: "Calendario de mes hasta" }).getByRole("button", { name: /Junio de 2026/i }).click();
    await page.getByRole("combobox", { name: "Origen" }).fill("LIM");
    await page.getByRole("combobox", { name: "Destino" }).fill("MIA");
    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);
    await page.locator(".fd-migration-grid").getByText("USD 512.00").waitFor();
    const topbarControls = page.getByTestId("topbar-search-controls");
    assert.equal(await topbarControls.getByRole("button", { name: "Migratorio" }).count(), 1);
    assert.equal(await page.locator("main").getByRole("button", { name: "Migratorio" }).count(), 0);
    const topbarHeight = async () => Math.round(await page.locator("header").evaluate((element) =>
      element.getBoundingClientRect().height,
    ));
    const migrationTopbarHeight = await topbarHeight();
    await clickSegment(topbarControls.getByRole("button", { name: "Flexible" }));
    const flexibleTopbarHeight = await topbarHeight();
    assert.ok(Math.abs(migrationTopbarHeight - flexibleTopbarHeight) <= 2);
    assert.equal(await topbarControls.locator(".fd-segmented-indicator").count(), 2);
    assert.doesNotMatch(await topbarControls.getByRole("button", { name: "Flexible" }).getAttribute("class") ?? "", /bg-card/);
    await clickSegment(topbarControls.getByRole("button", { name: "Exacto" }));
    assert.ok(Math.abs(await topbarHeight() - flexibleTopbarHeight) <= 2);
    await clickSegment(topbarControls.getByRole("button", { name: "Migratorio" }));
    assert.ok(Math.abs(await topbarHeight() - flexibleTopbarHeight) <= 2);
    assert.equal(await page.getByTestId("migration-month-card").count(), 2);
    const migrationCard = page.getByTestId("migration-month-card").first();
    assert.equal(await migrationCard.locator(".fd-result-card__schedule").count(), 1);
    assert.equal(await migrationCard.locator(".fd-result-card__schedules").getAttribute("data-trip-type"), "one-way");
    assert.doesNotMatch(await migrationCard.locator(".fd-result-card__schedules").innerText(), /Vuelta/);
    const bodyText = await page.locator("body").innerText();
    assert.doesNotMatch(bodyText, /\b00:00\b/);
    assert.match(bodyText, /14:00/);
    assert.match(bodyText, /Mayo de 2026/i);

    assert.equal(payloads.length, 2);
    const firstRequest = payloads[0].request as {
      tripType?: string;
      searchMode?: string;
      legs?: Array<Record<string, unknown>>;
      filters?: Record<string, unknown>;
    };
    const firstLeg = firstRequest.legs?.[0];

    assert.equal(firstRequest.tripType, "one-way");
    assert.equal(firstRequest.searchMode, "stay-range");
    assert.equal(Object.hasOwn(firstRequest.filters ?? {}, "maxResults"), false);
    assert.equal(Object.hasOwn(firstRequest.filters ?? {}, "compactAllOffers"), false);
    assert.equal(firstLeg?.departureStart, "2026-05-01");
    assert.equal(firstLeg?.departureEnd, "2026-05-31");
    assert.equal(firstLeg?.returnDate, undefined);
  });
});

test("mobile workspace keeps search modes inline instead of crowding the topbar", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/results-layout", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ layout: null }),
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

    await page.goto(`${baseUrl}/?layout=editor&mode=exact&trip=one-way&origin=LIM&destination=MIA&departure=2026-06-08&adults=1&children=0&infants=0`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("button", { name: "Buscar" }).click();
    await page.getByTestId("result-card").waitFor();

    assert.equal(await page.getByTestId("topbar-search-controls").getByRole("button", { name: "Exacto" }).count(), 0);
    assert.equal(await page.locator("main").getByRole("button", { name: "Exacto" }).count(), 1);
    assert.equal(await page.locator(".fd-result-card--layout-guide").evaluate((element) => getComputedStyle(element).display), "none");
    assert.equal(await page.locator(".fd-results-layout-editor").count(), 0);
  });
});

test("migratory search renders monthly progress and refilters each month locally", async () => {
  await withDesktopPage(async ({ page }) => {
    let requestCount = 0;
    let heldSecondRoute: Route | null = null;
    let heldSecondPayload: Record<string, unknown> | null = null;

    const migrationOffer = (id: string, amount: number, stops: number) => buildOffer({
      id,
      mainCarrier: stops === 0 ? "LA" : "AA",
      validatingCarrier: stops === 0 ? "LA" : "AA",
      comparisonMetrics: {
        totalDurationMinutes: stops === 0 ? 480 : 780,
        totalStops: stops,
      },
      price: {
        total: { amount, currencyCode: "USD" },
        base: { amount: Math.max(0, amount - 90), currencyCode: "USD" },
        taxes: { amount: 90, currencyCode: "USD" },
      },
      itineraries: [
        {
          direction: "outbound",
          durationMinutes: stops === 0 ? 480 : 780,
          stops,
          layoverMinutes: stops === 0 ? [] : [180],
          segments: stops === 0
            ? [
                {
                  flightNumber: "LA 2011",
                  marketingCarrier: "LA",
                  origin: "LIM",
                  destination: "MIA",
                  departureAt: "2026-04-15T14:00:00Z",
                  arrivalAt: "2026-04-15T22:00:00Z",
                },
              ]
            : [
                {
                  flightNumber: "AA 100",
                  marketingCarrier: "AA",
                  origin: "LIM",
                  destination: "BOG",
                  departureAt: "2026-04-15T08:00:00Z",
                  arrivalAt: "2026-04-15T11:00:00Z",
                },
                {
                  flightNumber: "AA 200",
                  marketingCarrier: "AA",
                  origin: "BOG",
                  destination: "MIA",
                  departureAt: "2026-04-15T14:00:00Z",
                  arrivalAt: "2026-04-15T19:00:00Z",
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
    ) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: id,
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
    await page.route("**/api/search", async (route) => {
      requestCount += 1;
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      if (requestCount === 1) {
        await fulfillSearch(route, payload, [
          migrationOffer("migration-cheapest-stop", 90, 1),
          migrationOffer("migration-direct", 150, 0),
        ], "migration-progress-1");
        return;
      }

      if (requestCount === 2) {
        heldSecondRoute = route;
        heldSecondPayload = payload;
        return;
      }

      await fulfillSearch(route, payload, [], `migration-progress-${requestCount}`);
    });

    await page.getByRole("button", { name: "Migratorio" }).click();
    await page.getByRole("combobox", { name: "Origen" }).fill("LIM");
    await page.getByRole("combobox", { name: "Destino" }).fill("MIA");
    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);

    const migrationGrid = page.locator(".fd-migration-grid");
    await migrationGrid.getByText("USD 90.00").waitFor();
    await page.waitForFunction(() => document.querySelectorAll(".fd-migration-month-card--loading").length > 0);
    assert.equal(await page.getByTestId("migration-month-card").count(), 8);
    assert.equal(await page.getByRole("button", { name: "Detener búsqueda" }).count(), 1);

    const stopsSliderControl = page.getByRole("slider", { name: "Escalas" });
    await stopsSliderControl.focus();
    await stopsSliderControl.press("Home");
    await migrationGrid.getByText("USD 150.00").waitFor();
    assert.equal(await migrationGrid.getByText("USD 90.00").count(), 0);

    if (heldSecondRoute && heldSecondPayload) {
      await fulfillSearch(heldSecondRoute, heldSecondPayload, [], "migration-progress-2");
    }
    await page.waitForFunction(() => document.querySelector('button[aria-label="Buscar"]'));
    assert.equal(requestCount, 8);
  });
});
