import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page, Route } from "playwright";
import { openDesktop, withDesktopPage } from "../helpers/ui.ts";
import { buildOffer } from "../helpers/ui-fixtures.ts";
import {
  clickSegment,
  routeLocationUsageSuggestions,
  waitForFontsReady,
  waitForLocationFieldsClosed,
  waitForPressed,
  waitForStableIndicator,
} from "./support.ts";

test("invalid shared dates do not roll over in the search form", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.goto(`${baseUrl}/?mode=exact&trip=round-trip&origin=LIM&destination=MIA&departure=2026-06-31&return=2026-07-10&adults=1&children=0&infants=0`, {
      waitUntil: "domcontentloaded",
    });

    const departureButton = page.getByRole("button", { name: "Salida" });
    await page.waitForFunction(() => {
      const button = document.querySelector('[aria-labelledby="date-salida-label"]');
      return button?.textContent?.includes("Fecha inválida");
    });
    await assert.equal(await departureButton.innerText(), "Fecha inválida");
    await assert.equal(await departureButton.getAttribute("aria-invalid"), "true");
    await assert.equal(await page.getByRole("button", { name: "Buscar" }).isDisabled(), true);
    await assert.equal(await page.getByText("Fecha inválida.").count(), 1);
  });
});

test("date calendars use the runtime minimum date for both trip dates", async () => {
  await withDesktopPage(async ({ page }) => {
    await page.getByRole("button", { name: "Salida" }).click();

    const departureCalendar = page.getByRole("dialog", { name: "Calendario de salida" });
    await departureCalendar.waitFor();
    await assert.equal(await departureCalendar.getByRole("button", { name: "30 mar 2026" }).isDisabled(), true);
    await assert.equal(await departureCalendar.getByRole("button", { name: "31 mar 2026" }).isDisabled(), false);
    await departureCalendar.getByRole("button", { name: "31 mar 2026" }).click();

    await page.getByRole("button", { name: "Regreso" }).click();

    const returnCalendar = page.getByRole("dialog", { name: "Calendario de regreso" });
    await returnCalendar.waitFor();
    await assert.equal(await returnCalendar.getByRole("button", { name: "30 mar 2026" }).isDisabled(), true);
    await assert.equal(await returnCalendar.getByRole("button", { name: "31 mar 2026" }).isDisabled(), false);
  });
});

test("one-way flexible search sends the selected stay-range payload without hidden expansion", async () => {
  await withDesktopPage(async ({ page }) => {
    let payload: Record<string, unknown> | undefined;

    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/search", async (route) => {
      payload = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "job-1",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: "cheapest",
          request: payload?.request,
          offers: [],
          allOffers: [],
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

    await page.getByRole("button", { name: "Solo ida" }).click();
    await page.getByRole("button", { name: "Flexible" }).click();
    await page.getByRole("combobox", { name: "Origen" }).fill("LIM");
    await page.getByRole("combobox", { name: "Destino" }).fill("MIA");
    await page.getByRole("button", { name: "Salida desde" }).click();
    await page.getByRole("dialog", { name: "Calendario de salida desde" }).getByRole("button", { name: "02 abr 2026" }).click();
    await page.getByRole("button", { name: "Salida hasta" }).click();
    await page.getByRole("dialog", { name: "Calendario de salida hasta" }).getByRole("button", { name: "04 abr 2026" }).click();
    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);

    const request = payload?.request as {
      tripType?: string;
      searchMode?: string;
      legs?: Array<Record<string, unknown>>;
    };
    const leg = request.legs?.[0];

    assert.equal(request.tripType, "one-way");
    assert.equal(request.searchMode, "stay-range");
    assert.equal(leg?.departureStart, "2026-04-02");
    assert.equal(leg?.departureEnd, "2026-04-04");
    assert.equal(leg?.departureDate, undefined);
    assert.equal(leg?.returnDate, undefined);
  });
});

test("search URL stores the payload and reopens it without auto-searching", async () => {
  await withDesktopPage(async ({ baseUrl, context, page }) => {
    const payloads: Record<string, unknown>[] = [];
    const routeLocations = async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          suggestions: [
            { code: "LIM", label: "LIM - Lima, Perú" },
            { code: "MIA", label: "MIA - FL, Estados Unidos" },
          ],
        }),
      });
    };

    const routeSearch = async (route: Route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      payloads.push(payload);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: `url-search-${payloads.length}`,
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: payload.sortMode,
          request: payload.request,
          offers: [],
          allOffers: [],
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
    };

    await page.route("**/api/locations**", routeLocations);
    await page.route("**/api/search", routeSearch);

    await openDesktop(page, baseUrl);
    await page.getByRole("combobox", { name: "Origen" }).fill("LIM");
    await page.getByRole("combobox", { name: "Destino" }).fill("MIA");
    await page.getByRole("button", { name: "Salida" }).click();
    await page.getByRole("dialog", { name: "Calendario de salida" }).getByRole("button", { name: "31 mar 2026" }).click();
    await page.getByRole("button", { name: "Regreso" }).click();
    await page.getByRole("dialog", { name: "Calendario de regreso" }).getByRole("button", { name: "01 abr 2026" }).click();
    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);
    await page.waitForFunction(() => new URL(window.location.href).searchParams.get("origin") === "LIM");
    await waitForLocationFieldsClosed(page, {
      origin: "LIM - Lima, Perú",
      destination: "MIA - FL, Estados Unidos",
    });

    const reusableUrl = page.url();
    const sharedUrl = new URL(reusableUrl);
    assert.equal(sharedUrl.searchParams.has("launchPayload"), false);
    assert.equal(sharedUrl.searchParams.get("mode"), "exact");
    assert.equal(sharedUrl.searchParams.get("trip"), "round-trip");
    assert.equal(sharedUrl.searchParams.get("origin"), "LIM");
    assert.equal(sharedUrl.searchParams.get("destination"), "MIA");
    assert.equal(sharedUrl.searchParams.get("departure"), "2026-03-31");
    assert.equal(sharedUrl.searchParams.get("return"), "2026-04-01");
    assert.equal(sharedUrl.searchParams.get("sort"), "cheapest");
    assert.equal(sharedUrl.searchParams.get("adults"), "1");
    assert.equal(sharedUrl.searchParams.get("children"), "0");
    assert.equal(sharedUrl.searchParams.get("infants"), "0");

    const replayPage = await context.newPage();
    await replayPage.route("**/api/locations**", routeLocations);
    await replayPage.route("**/api/search", routeSearch);

    await replayPage.goto(reusableUrl, { waitUntil: "domcontentloaded" });
    await replayPage.getByRole("combobox", { name: "Origen" }).waitFor();

    assert.equal(new URL(replayPage.url()).searchParams.has("launchPayload"), false);
    assert.equal(payloads.length, 1);
    await waitForLocationFieldsClosed(replayPage, {
      origin: "LIM - Lima, Perú",
      destination: "MIA - FL, Estados Unidos",
    });
    assert.equal(await replayPage.getByRole("combobox", { name: "Origen" }).inputValue(), "LIM - Lima, Perú");
    assert.equal(await replayPage.getByRole("combobox", { name: "Destino" }).inputValue(), "MIA - FL, Estados Unidos");

    await Promise.all([
      replayPage.waitForResponse("**/api/search"),
      replayPage.getByRole("button", { name: "Buscar" }).click(),
    ]);

    const replayRequest = payloads[1].request as {
      tripType?: string;
      searchMode?: string;
      legs?: Array<Record<string, unknown>>;
      passengers?: Record<string, unknown>;
    };
    const replayLeg = replayRequest.legs?.[0];

    assert.equal(payloads.length, 2);
    assert.equal(replayRequest.tripType, "round-trip");
    assert.equal(replayRequest.searchMode, "exact");
    assert.equal(replayLeg?.origin, "LIM");
    assert.equal(replayLeg?.destination, "MIA");
    assert.equal(replayLeg?.departureDate, "2026-03-31");
    assert.equal(replayLeg?.returnDate, "2026-04-01");
    assert.equal(replayRequest.passengers?.adults, 1);
  }, { autoOpen: false });
});

test("paste accepts desktop search config JSON and sends the same exact backend request", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
    let payload: Record<string, unknown> | undefined;

    await page.route("**/api/locations**", async (route) => {
      const url = new URL(route.request().url());
      const query = url.searchParams.get("q")?.toLowerCase() ?? "";
      const suggestions = query.includes("bio")
        ? [{ code: "BIO", city: "Bilbao", country: "España", countryCode: "ES", label: "BIO - Bilbao, España" }]
        : [{ code: "LIM", city: "Lima", country: "Perú", countryCode: "PE", label: "LIM - Lima, Perú" }];

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions }),
      });
    });
    await page.route("**/api/search", async (route) => {
      payload = route.request().postDataJSON() as Record<string, unknown>;
      const cachedOffer = buildOffer({
        id: "clipboard-cache-offer",
        origin: "LIM",
        destination: "BIO",
        mainCarrier: "IB",
        validatingCarrier: "IB",
        comparisonMetrics: {
          totalDurationMinutes: 920,
          totalStops: 2,
        },
        stops: 2,
        itineraries: [
          {
            direction: "outbound",
            durationMinutes: 760,
            stops: 1,
            segments: [
              {
                flightNumber: "IB 610",
                origin: "LIM",
                destination: "MAD",
                departureAt: "2026-06-08T17:30:00Z",
                arrivalAt: "2026-06-09T11:10:00Z",
              },
              {
                flightNumber: "IB 426",
                origin: "MAD",
                destination: "BIO",
                departureAt: "2026-06-09T13:00:00Z",
                arrivalAt: "2026-06-09T14:05:00Z",
              },
            ],
          },
          {
            direction: "inbound",
            durationMinutes: 780,
            stops: 1,
            segments: [
              {
                flightNumber: "IB 447",
                origin: "BIO",
                destination: "MAD",
                departureAt: "2026-06-20T09:15:00Z",
                arrivalAt: "2026-06-20T10:20:00Z",
              },
              {
                flightNumber: "IB 6659",
                origin: "MAD",
                destination: "LIM",
                departureAt: "2026-06-20T12:05:00Z",
                arrivalAt: "2026-06-20T19:30:00Z",
              },
            ],
          },
        ],
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "clipboard-search",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: payload.sortMode,
          request: payload.request,
          offers: [cachedOffer],
          allOffers: [cachedOffer],
          searchMeta: {
            requestedAt: "2026-05-04T15:21:48.419Z",
            completedAt: "2026-05-04T15:21:48.419Z",
            providersUsed: ["agil-local", "costamar"],
            warnings: ["Mostrando resultados cacheados mientras actualizamos en segundo plano."],
            partial: true,
            searchState: "search_cached",
          },
          providerMeta: {
            exactProvider: "agil-local",
            coverageMode: "core",
          },
          warnings: [],
        }),
      });
    });

    await openDesktop(page, baseUrl);
    const copyConfig = page.getByRole("button", { name: "Copiar configuración" });
    const pasteConfig = page.getByRole("button", { name: "Pegar configuración" });
    assert.equal(await copyConfig.isDisabled(), true);
    assert.equal(await pasteConfig.isDisabled(), false);

    await page.evaluate((rawPayload) => navigator.clipboard.writeText(rawPayload), JSON.stringify({
      type: "fly-desk-search-config",
      version: 2,
      copiedAt: "2026-05-04T15:21:48.419Z",
      mode: "exact",
      tripType: "round-trip",
      sortMode: "cheapest",
      providerConfig: null,
      request: {
        tripType: "round-trip",
        searchMode: "exact",
        cabin: "ECONOMY",
        currencyCode: "USD",
        coverageMode: "core",
        redirectMode: "best-effort",
        passengers: { adults: 1, children: 0, infants: 0 },
        filters: {
          nonStop: false,
          baggageRequired: false,
          maxStops: 1,
          includedAirlineCodes: [],
        },
        legs: [{
          origin: "LIM",
          destination: "BIO",
          originLabel: "Lima, Perú (LIM)",
          destinationLabel: "Bilbao, España (BIO)",
          departureDate: "2026-06-08",
          returnDate: "2026-06-20",
        }],
        locale: "es-PE",
        market: "PE",
      },
    }));

    await pasteConfig.click();
    await page.waitForFunction(() => {
      const origin = document.querySelector<HTMLInputElement>('[aria-label="Origen"]');
      const destination = document.querySelector<HTMLInputElement>('[aria-label="Destino"]');
      return origin?.value.includes("LIM") && destination?.value.includes("BIO");
    });
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('button[aria-label="Copiar configuración"]')?.disabled);
    assert.equal(await copyConfig.isDisabled(), false);

    await copyConfig.click();
    const copiedPayload = await page.evaluate(async () => JSON.parse(String(await navigator.clipboard.readText())) as {
      type?: string;
      sortMode?: string;
      request?: { legs?: Array<Record<string, unknown>>; filters?: Record<string, unknown> };
    });
    assert.equal(copiedPayload.type, "fly-desk-search-config");
    assert.equal(copiedPayload.sortMode, "cheapest");
    assert.equal(copiedPayload.request?.legs?.[0]?.origin, "LIM");
    assert.equal(copiedPayload.request?.legs?.[0]?.destination, "BIO");
    assert.equal(copiedPayload.request?.filters?.maxStops, 1);

    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);

    const request = payload?.request as {
      tripType?: string;
      searchMode?: string;
      legs?: Array<Record<string, unknown>>;
      passengers?: Record<string, unknown>;
      filters?: Record<string, unknown>;
    };
    const leg = request.legs?.[0];

    assert.equal(payload?.sortMode, "cheapest");
    assert.equal(request.tripType, "round-trip");
    assert.equal(request.searchMode, "exact");
    assert.equal(leg?.origin, "LIM");
    assert.equal(leg?.destination, "BIO");
    assert.equal(leg?.departureDate, "2026-06-08");
    assert.equal(leg?.returnDate, "2026-06-20");
    assert.equal(request.passengers?.adults, 1);
    assert.equal(request.filters?.maxStops, 1);
    await page.getByText("Cache revalidando").waitFor();
    await page.getByText("1 vuelo").waitFor();
    await page.getByText("LIM - MAD - BIO").waitFor();
  }, { autoOpen: false });
});
