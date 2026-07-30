import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page, Route } from "playwright";
import { withDesktopPage } from "../helpers/ui.ts";
import { buildOffer } from "../helpers/ui-fixtures.ts";

test("result filters refine loaded offers without restarting the search", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    let searchRequests = 0;
    const offers = ["H2", "P02", "P03", "P04"].map((carrier, index) => {
      const carrierName = carrier === "H2" ? "Sky Airline" : undefined;

      return buildOffer({
        id: `local-filter-offer-${carrier}`,
        origin: "LIM",
        destination: "BIO",
        mainCarrier: carrier,
        validatingCarrier: carrier,
        price: {
          total: { amount: 620 + index, currencyCode: "USD" },
          base: { amount: 520 + index, currencyCode: "USD" },
          taxes: { amount: 100, currencyCode: "USD" },
        },
        itineraries: [
          {
            id: `local-filter-offer-${carrier}-outbound`,
            direction: "outbound",
            durationMinutes: 480,
            stops: 0,
            layoverMinutes: [],
            segments: [
              {
                id: `local-filter-offer-${carrier}-outbound-1`,
                flightNumber: `${carrier} 123`,
                marketingCarrier: carrier,
                marketingCarrierName: carrierName,
                origin: "LIM",
                destination: "BIO",
                departureAt: "2026-06-08T14:00:00Z",
                arrivalAt: "2026-06-08T22:00:00Z",
                durationMinutes: 480,
              },
            ],
          },
          {
            id: `local-filter-offer-${carrier}-inbound`,
            direction: "inbound",
            durationMinutes: 470,
            stops: 0,
            layoverMinutes: [],
            segments: [
              {
                id: `local-filter-offer-${carrier}-inbound-1`,
                flightNumber: `${carrier} 456`,
                marketingCarrier: carrier,
                marketingCarrierName: carrierName,
                origin: "BIO",
                destination: "LIM",
                departureAt: "2026-06-20T15:00:00Z",
                arrivalAt: "2026-06-20T22:50:00Z",
                durationMinutes: 470,
              },
            ],
          },
        ],
      });
    });

    await page.setViewportSize({ width: 1440, height: 760 });
    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/search", async (route) => {
      searchRequests += 1;
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "local-filter-search",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: payload.sortMode,
          request: payload.request,
          offers,
          allOffers: offers,
          searchMeta: {
            requestedAt: "2026-05-04T15:21:48.419Z",
            completedAt: "2026-05-04T15:21:48.419Z",
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

    await page.goto(`${baseUrl}/?mode=exact&trip=round-trip&origin=LIM&destination=BIO&departure=2026-06-08&return=2026-06-20&adults=1&children=0&infants=0&sort=cheapest&maxStops=1`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();
    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);
    await page.getByTestId("result-card").first().waitFor();

    await page.getByRole("checkbox", { name: "Sky" }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="result-card"]').length === 1);

    assert.equal(searchRequests, 1);
    assert.equal(await page.getByRole("button", { name: "Buscar" }).isVisible(), true);
    assert.equal(await page.getByRole("button", { name: "Detener búsqueda" }).count(), 0);
    assert.equal(await page.getByText("Actualizando").count(), 0);
    assert.equal(await page.getByRole("checkbox", { name: "H2" }).count(), 0);
    assert.equal(await page.getByTestId("result-card").filter({ hasText: "Sky" }).count(), 1);

    const airlineListScroll = await page.locator(".fd-scrollbar-hidden").evaluateAll((nodes) =>
      nodes.some((node) => getComputedStyle(node).scrollbarWidth === "none"),
    );
    assert.equal(airlineListScroll, true);
  }, { autoOpen: false });
});

test("empty local filter results do not blame a provider that already reported no flights", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    let searchRequests = 0;
    const offers = [
      buildOffer({
        id: "costamar-carry-on-only",
        signature: "costamar:costamar-carry-on-only",
        providerOfferRef: "costamar-carry-on-only",
        providerSource: "costamar",
        priceStatus: "unverified",
        origin: "TPP",
        destination: "LIM",
        mainCarrier: "H2",
        validatingCarrier: "H2",
        comparisonMetrics: {
          totalDurationMinutes: 80,
          totalStops: 0,
          baggageScore: 1,
          purchasePathScore: 0.8,
        },
        baggage: {
          carryOnIncluded: true,
          checkedIncluded: false,
          description: "Solo equipaje de mano",
        },
        purchasePaths: [
          {
            id: "costamar-carry-on-only-path",
            provider: "costamar",
            type: "search-redirect",
            label: "Click and Book Plus",
            url: "https://example.test/costamar",
            precision: "exact-search",
            score: 0.8,
            requiresNewTab: true,
            commercialMode: "provider",
            state: "search_redirect",
          },
        ],
        tags: [],
        warnings: [],
        itineraries: [
          {
            id: "costamar-carry-on-only-outbound",
            direction: "outbound",
            durationMinutes: 80,
            stops: 0,
            layoverMinutes: [],
            segments: [
              {
                id: "costamar-carry-on-only-outbound-1",
                flightNumber: "H2 123",
                marketingCarrier: "H2",
                marketingCarrierName: "Sky Airline",
                origin: "TPP",
                destination: "LIM",
                departureAt: "2026-05-13T14:00:00Z",
                arrivalAt: "2026-05-13T15:20:00Z",
                durationMinutes: 80,
              },
            ],
          },
        ],
      }),
    ];

    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/search", async (route) => {
      searchRequests += 1;
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "filtered-empty-provider-warning",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: payload.sortMode,
          request: payload.request,
          offers,
          allOffers: offers,
          searchMeta: {
            requestedAt: "2026-05-13T18:16:23.838Z",
            completedAt: "2026-05-13T18:16:23.838Z",
            providersUsed: ["agil-local", "costamar"],
            warnings: ["Agil returned no offers for this search."],
            partial: false,
            searchState: "search_live",
          },
          providerMeta: {
            exactProvider: "agil-local",
            coverageMode: "core",
          },
          warnings: ["Agil returned no offers for this search."],
        }),
      });
    });

    await page.goto(`${baseUrl}/?mode=exact&trip=one-way&origin=TPP&destination=LIM&departure=2026-05-13&adults=1&children=0&infants=0&sort=cheapest`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();
    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);
    await page.getByTestId("result-card").first().waitFor();

    await page.getByRole("button", { name: "Bodega", exact: true }).click();
    await page.getByText("Ningún vuelo pasa los filtros").waitFor();
    await page.getByText("«Bodega incluida» dejó la lista vacía. Quítalo o amplía la búsqueda.").waitFor();

    assert.equal(await page.getByTestId("result-card").count(), 0);
    assert.equal(await page.getByText("Agilsmart no devolvió vuelos").count(), 0);
    assert.equal(await page.getByText("Agilsmart sin vuelos").count(), 0);
    assert.equal(await page.getByText("1 aviso").count(), 0);
    assert.equal(searchRequests, 1);

    await page.getByRole("button", { name: "Quitar los filtros" }).click();
    await page.getByTestId("result-card").waitFor();
    assert.equal(searchRequests, 1);
  }, { autoOpen: false });
});

test("empty exact results stay factual without inventing flight data", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/search", async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "no-flights-search",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: payload.sortMode,
          request: payload.request,
          offers: [],
          allOffers: [],
          searchMeta: {
            requestedAt: "2026-05-04T15:21:48.419Z",
            completedAt: "2026-05-04T15:21:48.419Z",
            providersUsed: ["agil-local", "costamar"],
            warnings: [
              "Agil returned no offers for this search.",
              "Click and Book Plus returned no offers for this search.",
            ],
            partial: false,
            searchState: "search_live",
          },
          providerMeta: {
            exactProvider: "agil-local",
            coverageMode: "core",
          },
          warnings: [
            "Agil returned no offers for this search.",
            "Click and Book Plus returned no offers for this search.",
          ],
        }),
      });
    });

    await page.goto(`${baseUrl}/?mode=exact&trip=round-trip&origin=LIM&destination=BIO&departure=2026-06-08&return=2026-06-20&adults=1&children=0&infants=0&sort=cheapest&maxStops=1`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();

    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);

    await page.getByText("Sin resultados para esta consulta").waitFor();
    await page.getByText("Ajusta fechas, escalas, equipaje o aerolíneas para ampliar la cobertura.").waitFor();
    assert.equal(await page.getByTestId("result-card").count(), 0);
    assert.equal(await page.getByText("Agilsmart y Click and Book Plus no devolvieron vuelos").count(), 0);
  }, { autoOpen: false });
});
