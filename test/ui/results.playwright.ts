import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page, Route } from "playwright";
import type { Itinerary } from "../../src/core/types";
import { withDesktopPage } from "../helpers/ui.ts";
import { buildOffer } from "../helpers/ui-fixtures.ts";

test("topbar brand opens the current instance root without hardcoding the port", async () => {
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
          searchJobId: "brand-reset-search",
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

    await page.goto(`${baseUrl}/?mode=exact&trip=round-trip&origin=LIM&destination=BIO&departure=2026-06-08&return=2026-06-20&adults=1&children=0&infants=0&sort=cheapest&maxStops=1`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();
    await page.waitForFunction(() => {
      const origin = document.querySelector<HTMLInputElement>('[aria-label="Origen"]');
      const destination = document.querySelector<HTMLInputElement>('[aria-label="Destino"]');
      return origin?.value.includes("LIM") && destination?.value.includes("BIO");
    });

    const instanceRoot = `${new URL(baseUrl).origin}/`;
    const brandLink = page.getByRole("link", { name: "Abrir Fly Desk" });
    const brandHref = await brandLink.getAttribute("href");
    /* 1a draws the brand as mark + name, not as a boxed control: no fill and
       no border. The Tailwind reset leaves every element at `border-style:
       solid; border-width: 0`, so what says "no box" is the width. */
    const brandStyle = await brandLink.evaluate((link) => {
      const style = getComputedStyle(link);
      return {
        backgroundColor: style.backgroundColor,
        borderWidth: style.borderWidth,
      };
    });
    assert.equal(brandHref, instanceRoot);
    assert.equal(brandStyle.backgroundColor, "rgba(0, 0, 0, 0)");
    assert.equal(brandStyle.borderWidth, "0px");
    assert.equal(await page.getByRole("button", { name: "Copiar configuración" }).isDisabled(), false);

    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);
    await page.locator(".fd-results").waitFor({ state: "visible" });

    await brandLink.click();
    await page.waitForURL(instanceRoot);
    await page.waitForFunction(() => {
      const origin = document.querySelector<HTMLInputElement>('[aria-label="Origen"]');
      const destination = document.querySelector<HTMLInputElement>('[aria-label="Destino"]');
      return origin?.value === ""
        && destination?.value === ""
        && window.location.search === ""
        && !document.querySelector(".fd-results");
    });
    assert.equal(await page.getByRole("button", { name: "Copiar configuración" }).isDisabled(), true);
  }, { autoOpen: false });
});

test("exact results paginate visible offers with hidden minimal result scroll", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/search", async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      const offers = Array.from({ length: 18 }, (_, index) => {
        const carrier = `P${String(index + 1).padStart(2, "0")}`;
        return buildOffer({
          id: `paged-offer-${index + 1}`,
          origin: "LIM",
          destination: "BIO",
          mainCarrier: carrier,
          validatingCarrier: carrier,
          price: {
            total: { amount: 520 + index, currencyCode: "USD" },
            base: { amount: 430 + index, currencyCode: "USD" },
            taxes: { amount: 90, currencyCode: "USD" },
          },
          itineraries: [
            {
              id: `paged-offer-${index + 1}-outbound`,
              direction: "outbound",
              durationMinutes: 760 + index,
              stops: 0,
              layoverMinutes: [],
              segments: [
                {
                  id: `paged-offer-${index + 1}-outbound-1`,
                  flightNumber: `${carrier} ${100 + index}`,
                  marketingCarrier: carrier,
                  origin: "LIM",
                  destination: "BIO",
                  departureAt: "2026-06-08T17:30:00Z",
                  arrivalAt: "2026-06-09T14:05:00Z",
                  durationMinutes: 760 + index,
                },
              ],
            },
            {
              id: `paged-offer-${index + 1}-inbound`,
              direction: "inbound",
              durationMinutes: 780 + index,
              stops: 0,
              layoverMinutes: [],
              segments: [
                {
                  id: `paged-offer-${index + 1}-inbound-1`,
                  flightNumber: `${carrier} ${200 + index}`,
                  marketingCarrier: carrier,
                  origin: "BIO",
                  destination: "LIM",
                  departureAt: "2026-06-20T09:15:00Z",
                  arrivalAt: "2026-06-20T19:30:00Z",
                  durationMinutes: 780 + index,
                },
              ],
            },
          ],
        });
      });

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "paged-search",
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
            warnings: ["Tarifas sujetas a disponibilidad."],
            partial: false,
            searchState: "search_live",
          },
          providerMeta: {
            exactProvider: "agil-local",
            coverageMode: "core",
          },
          warnings: ["Tarifas sujetas a disponibilidad."],
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

    const pagination = page.getByTestId("results-pagination");
    await pagination.waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const body = document.querySelector<HTMLElement>('[data-testid="results-page-body"]');
      const cards = document.querySelectorAll('[data-testid="result-card"]').length;
      return Boolean(body && cards > 0 && cards < 18 && getComputedStyle(body).scrollbarWidth === "none");
    });

    const visibleCards = await page.locator('[data-testid="result-card"]').count();
    const paginationText = await pagination.innerText();
    assert.ok(visibleCards > 0);
    assert.ok(visibleCards < 18);
    assert.match(paginationText, new RegExp(`^1–${visibleCards} de 18`));

    const metrics = await page.getByTestId("results-page-body").evaluate((element) => ({
      clientHeight: element.clientHeight,
      listHeight: element.querySelector<HTMLElement>(".fd-results-list")?.getBoundingClientRect().height ?? 0,
      overflowY: getComputedStyle(element).overflowY,
      scrollbarWidth: getComputedStyle(element).scrollbarWidth,
      scrollHeight: element.scrollHeight,
    }));
    assert.equal(metrics.overflowY, "auto");
    assert.equal(metrics.scrollbarWidth, "none");
    assert.ok(metrics.scrollHeight >= metrics.clientHeight || metrics.clientHeight - metrics.listHeight < 72, JSON.stringify(metrics));

    const resultsBody = page.getByTestId("results-page-body");
    await resultsBody.evaluate((element) => {
      element.style.paddingBottom = "320px";
      element.scrollTop = 123;
      element.dispatchEvent(new Event("scroll"));
    });
    assert.equal(await resultsBody.evaluate((element) => element.scrollTop), 123);

    await page.getByRole("button", { name: "Página siguiente" }).click();
    const pagedCards = page.locator('[data-testid="result-card"]');
    await pagedCards.filter({ hasText: `P${String(visibleCards + 1).padStart(2, "0")}` }).first().waitFor();
    assert.match(await pagination.innerText(), new RegExp(`^${visibleCards + 1}–\\d+ de 18`));
    assert.equal(await pagedCards.filter({ hasText: "P01" }).count(), 0);
    assert.equal(await resultsBody.evaluate((element) => element.scrollTop), 0);

    await page.getByRole("button", { name: "Página anterior" }).click();
    await pagedCards.filter({ hasText: "P01" }).first().waitFor();
    assert.equal(await resultsBody.evaluate((element) => element.scrollTop), 0);

    await page.getByRole("button", { name: "Página siguiente" }).click();
    await pagedCards.filter({ hasText: `P${String(visibleCards + 1).padStart(2, "0")}` }).first().waitFor();

    const firstVisibleCard = pagedCards.first();
    assert.equal(await firstVisibleCard.locator(".fd-card__leg").count(), 2);
    assert.match(await firstVisibleCard.locator(".fd-card__legs").innerText(), /IDA/);
    assert.match(await firstVisibleCard.locator(".fd-card__legs").innerText(), /VTA/);
    assert.equal(await firstVisibleCard.locator(".fd-card__route").count(), 0);
    const scheduleMetrics = await firstVisibleCard.locator(".fd-card__leg-schedule").evaluateAll(
      (schedules) => schedules.map((schedule) => ({
        clientWidth: schedule.clientWidth,
        scrollWidth: schedule.scrollWidth,
        text: schedule.textContent?.trim(),
      })),
    );
    assert.ok(
      scheduleMetrics.every((schedule) => schedule.scrollWidth <= schedule.clientWidth),
      JSON.stringify(scheduleMetrics),
    );
  }, { autoOpen: false });
});

test("native schedule groups expose complete return-flight alternatives", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 1440, height: 760 });
    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/search", async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      const groupedOffer = (
        id: string,
        returnDeparture: string,
        returnArrival: string,
        inboundDurationMinutes: number,
      ) => buildOffer({
        id,
        signature: `costamar:${id}`,
        providerOfferRef: id,
        providerSource: "costamar",
        priceStatus: "unverified",
        mainCarrier: "KL",
        validatingCarrier: "KL",
        comparisonMetrics: {
          totalDurationMinutes: 960 + inboundDurationMinutes,
          totalStops: 1,
          baggageScore: 2,
          purchasePathScore: 0.8,
        },
        price: {
          total: { amount: 1361.14, currencyCode: "USD" },
          base: { amount: 1120, currencyCode: "USD" },
          taxes: { amount: 241.14, currencyCode: "USD" },
        },
        itineraries: [
          {
            id: `${id}-outbound`,
            direction: "outbound",
            durationMinutes: 960,
            stops: 1,
            layoverMinutes: [90],
            segments: [
              {
                id: `${id}-outbound-1`,
                flightNumber: "KL 744",
                marketingCarrier: "KL",
                origin: "LIM",
                destination: "AMS",
                departureAt: "2026-05-28T17:30:00-05:00",
                arrivalAt: "2026-05-29T12:30:00+02:00",
                durationMinutes: 720,
              },
              {
                id: `${id}-outbound-2`,
                flightNumber: "KL 1501",
                marketingCarrier: "KL",
                origin: "AMS",
                destination: "MAD",
                departureAt: "2026-05-29T14:00:00+02:00",
                arrivalAt: "2026-05-29T16:30:00+02:00",
                durationMinutes: 150,
              },
            ],
          },
          {
            id: `${id}-inbound`,
            direction: "inbound",
            durationMinutes: inboundDurationMinutes,
            stops: 0,
            layoverMinutes: [],
            segments: [
              {
                id: `${id}-inbound-1`,
                flightNumber: "KL 1502",
                marketingCarrier: "KL",
                origin: "MAD",
                destination: "LIM",
                departureAt: returnDeparture,
                arrivalAt: returnArrival,
                durationMinutes: inboundDurationMinutes,
              },
            ],
          },
        ],
        purchasePaths: [
          {
            id: `${id}-costamar-path`,
            provider: "costamar",
            type: "search-redirect",
            label: "Click and Book Plus",
            url: `https://example.test/costamar/${id}`,
            precision: "exact-search",
            score: 0.8,
            requiresNewTab: true,
            commercialMode: "provider",
            state: "search_redirect",
          },
        ],
        tags: [],
        warnings: [],
      });

      const offers = [
        groupedOffer("late-return", "2026-06-04T20:30:00+02:00", "2026-06-05T15:25:00-05:00", 1555),
        groupedOffer("early-return", "2026-06-04T06:00:00+02:00", "2026-06-04T15:25:00-05:00", 985),
        groupedOffer("mid-return", "2026-06-04T13:05:00+02:00", "2026-06-05T15:25:00-05:00", 2000),
      ];
      const outboundOptionId = "costamar:REC-compact:outbound";
      const inboundOptions = offers.map((offer, index) => ({
        id: `costamar:REC-compact:inbound:${index}`,
        itinerary: offer.itineraries[1],
      }));

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "grouped-compact-search",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: payload.sortMode,
          request: payload.request,
          offers,
          allOffers: offers,
          scheduleGroups: [
            {
              id: "costamar:REC-compact",
              providerSource: "costamar",
              outboundOptions: [
                { id: outboundOptionId, itinerary: offers[0].itineraries[0] },
              ],
              inboundOptions,
              combinations: offers.map((offer, index) => ({
                outboundOptionId,
                inboundOptionId: inboundOptions[index].id,
                offerId: offer.id,
              })),
              truncated: false,
            },
          ],
          searchMeta: {
            requestedAt: "2026-05-04T15:21:48.419Z",
            completedAt: "2026-05-04T15:21:48.419Z",
            providersUsed: ["costamar"],
            warnings: [],
            partial: false,
            searchState: "search_live",
          },
          providerMeta: {
            exactProvider: "costamar",
            coverageMode: "core",
          },
          warnings: [],
        }),
      });
    });

    await page.goto(`${baseUrl}/?mode=exact&trip=round-trip&origin=LIM&destination=MAD&departure=2026-05-28&return=2026-06-04&adults=1&children=0&infants=0&sort=cheapest`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();
    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);

    const card = page.getByTestId("result-card");
    await card.waitFor();
    assert.equal(await card.count(), 1);
    assert.equal(await card.locator(".fd-card__alts-label").innerText(), "2 HORARIOS MÁS");

    const alternatives = card.locator(".fd-card__alt-chip");
    assert.equal(await alternatives.count(), 2);
    assert.match(await alternatives.nth(0).getAttribute("aria-label") ?? "", /^Cambiar la vuelta a las 20:30, 1d 1h 55m$/);
    assert.match(await alternatives.nth(1).getAttribute("aria-label") ?? "", /^Cambiar la vuelta a las 13:05, 1d 9h 20m$/);
    assert.doesNotMatch(await alternatives.allInnerTexts().then((items) => items.join(" ")), /KLM|Click and Book|USD|Equipaje/);

    await alternatives.nth(0).click();
    const selectedCard = page.getByTestId("result-card");
    await selectedCard.getByRole("button", { name: /^Oferta seleccionada/ }).waitFor();
    assert.match(await selectedCard.getAttribute("class") ?? "", /is-schedule-changed/);
    assert.match(await selectedCard.locator(".fd-card__legs").innerText(), /VTA 04\/06[\s\S]*20:30[\s\S]*15:25[\s\S]*\+1/);

    const detailText = await page.getByTestId("detail-panel-body").innerText();
    assert.match(detailText, /Vuelta · 4 jun/i);
    assert.match(detailText, /20:30/);
    assert.match(detailText, /15:25/);
  }, { autoOpen: false });
});

test("a page sized to its items still fits a group card, which is taller than one", async () => {
  /*
   * Found by running the app against the live providers: a real LIM–MIA search
   * came back as one standalone flight plus a group of thirteen — two list
   * items — and drew **one card with eleven empty rows below it**, pushing the
   * group to page 2. The capacity was clamped to the item count (2) while the
   * page weighed 1 + 1.34; it is now clamped to the weight.
   */
  await withDesktopPage(async ({ baseUrl, page }) => {
    const leg = (id: string, direction: "outbound" | "inbound", departureAt: string, arrivalAt: string) => ({
      id: `${id}-${direction}`,
      direction,
      durationMinutes: 320,
      stops: 0,
      layoverMinutes: [],
      segments: [{
        id: `${id}-${direction}-1`,
        flightNumber: "CM 400",
        marketingCarrier: "CM",
        origin: direction === "outbound" ? "LIM" : "MIA",
        destination: direction === "outbound" ? "MIA" : "LIM",
        departureAt,
        arrivalAt,
        durationMinutes: 320,
      }],
    });
    const grouped = (id: string, returnDeparture: string, amount: number) => buildOffer({
      id,
      providerSource: "costamar",
      origin: "LIM",
      destination: "MIA",
      price: {
        total: { amount, currencyCode: "USD" },
        base: { amount: amount - 30, currencyCode: "USD" },
        taxes: { amount: 30, currencyCode: "USD" },
      },
      itineraries: [
        leg(id, "outbound", "2026-09-14T09:50:00-05:00", "2026-09-14T17:00:00-04:00"),
        leg(id, "inbound", returnDeparture, "2026-09-24T23:10:00-05:00"),
      ],
    });
    const standalone = buildOffer({
      id: "standalone-sky",
      providerSource: "costamar",
      origin: "LIM",
      destination: "MIA",
      price: {
        total: { amount: 488, currencyCode: "USD" },
        base: { amount: 458, currencyCode: "USD" },
        taxes: { amount: 30, currencyCode: "USD" },
      },
      itineraries: [
        leg("standalone-sky", "outbound", "2026-09-14T08:00:00-05:00", "2026-09-14T15:10:00-04:00"),
        leg("standalone-sky", "inbound", "2026-09-24T18:20:00-04:00", "2026-09-24T23:10:00-05:00"),
      ],
    });
    const groupOffers = [
      grouped("grouped-a", "2026-09-24T18:31:00-04:00", 532),
      grouped("grouped-b", "2026-09-24T17:14:00-04:00", 540),
      grouped("grouped-c", "2026-09-24T11:00:00-04:00", 560),
    ];
    const offers = [standalone, ...groupOffers];
    const outboundOptionId = "costamar:PAGE-WEIGHT:outbound";

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ suggestions: [] }) });
    });
    await page.route("**/api/search", async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "page-weight-search",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: payload.sortMode,
          request: payload.request,
          offers,
          allOffers: offers,
          scheduleGroups: [{
            id: "costamar:PAGE-WEIGHT",
            providerSource: "costamar",
            outboundOptions: [{ id: outboundOptionId, itinerary: groupOffers[0].itineraries[0] }],
            inboundOptions: groupOffers.map((offer, index) => ({
              id: `costamar:PAGE-WEIGHT:inbound:${index}`,
              itinerary: offer.itineraries[1],
            })),
            combinations: groupOffers.map((offer, index) => ({
              outboundOptionId,
              inboundOptionId: `costamar:PAGE-WEIGHT:inbound:${index}`,
              offerId: offer.id,
            })),
            truncated: false,
          }],
          searchMeta: {
            requestedAt: "2026-08-01T21:06:13.178Z",
            completedAt: "2026-08-01T21:06:13.178Z",
            providersUsed: ["costamar"],
            warnings: [],
            partial: false,
            searchState: "search_live",
          },
          providerMeta: { exactProvider: "costamar", coverageMode: "core" },
          warnings: [],
        }),
      });
    });

    await page.goto(`${baseUrl}/?mode=exact&trip=round-trip&origin=LIM&destination=MIA&departure=2026-09-14&return=2026-09-24&adults=1&children=0&infants=0&sort=cheapest`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();
    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);
    await page.getByTestId("result-card").first().waitFor();

    // Both items belong on the one page there is room for.
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="result-card"]').length === 2);
    assert.equal(await page.getByTestId("results-pagination").count(), 0);
    assert.equal(await page.locator(".fd-card__alts-label").innerText(), "2 HORARIOS MÁS");
  }, { autoOpen: false });
});

test("provider offers open the highest-ranked Agilsmart and Click and Book Plus links from detail", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 1440, height: 760 });
    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/search", async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      const providerItineraries = (offerId: string): Itinerary[] => [
        {
          id: `${offerId}-outbound`,
          direction: "outbound",
          durationMinutes: 480,
          stops: 0,
          layoverMinutes: [],
          segments: [
            {
              id: `${offerId}-outbound-1`,
              flightNumber: "LA 123",
              marketingCarrier: "LA",
              origin: "LIM",
              destination: "MIA",
              departureAt: "2026-04-15T14:00:00Z",
              arrivalAt: "2026-04-15T22:00:00Z",
              durationMinutes: 480,
            },
          ],
        },
        {
          id: `${offerId}-inbound`,
          direction: "inbound",
          durationMinutes: 470,
          stops: 0,
          layoverMinutes: [],
          segments: [
            {
              id: `${offerId}-inbound-1`,
              flightNumber: "LA 456",
              marketingCarrier: "LA",
              origin: "MIA",
              destination: "LIM",
              departureAt: "2026-04-22T15:00:00Z",
              arrivalAt: "2026-04-22T22:50:00Z",
              durationMinutes: 470,
            },
          ],
        },
      ];
      const agilOffer = buildOffer({
        id: "merged-provider-offer",
        signature: "merged-provider-offer",
        providerOfferRef: "merged-provider-offer",
        providerSource: "agil-local",
        priceStatus: "unverified",
        comparisonMetrics: {
          totalDurationMinutes: 950,
          totalStops: 0,
          baggageScore: 2,
          purchasePathScore: 1,
        },
        itineraries: providerItineraries("merged-provider-offer"),
        purchasePaths: [
          {
            id: "merged-agil-path",
            provider: "agil-local",
            type: "deeplink",
            label: "Agilsmart",
            url: "https://example.test/agil",
            precision: "exact-offer",
            score: 1,
            requiresNewTab: true,
            commercialMode: "provider",
            state: "deeplink_exact",
          },
          {
            id: "merged-costamar-path",
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
      });
      const costamarOffer = buildOffer({
        id: "costamar-provider-offer",
        signature: "costamar-provider-offer",
        providerOfferRef: "costamar-provider-offer",
        providerSource: "costamar",
        priceStatus: "unverified",
        comparisonMetrics: {
          totalDurationMinutes: 950,
          totalStops: 0,
          baggageScore: 2,
          purchasePathScore: 0.8,
        },
        itineraries: providerItineraries("costamar-provider-offer"),
        price: {
          total: { amount: 620, currencyCode: "USD" },
          base: { amount: 520, currencyCode: "USD" },
          taxes: { amount: 100, currencyCode: "USD" },
        },
        purchasePaths: [
          {
            id: "costamar-provider-path",
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
      });
      const offers = [agilOffer, costamarOffer];

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "grouped-provider-search",
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
            providersUsed: ["agil-local", "costamar"],
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

    await page.goto(`${baseUrl}/?mode=exact&trip=round-trip&origin=LIM&destination=MIA&departure=2026-04-15&return=2026-04-22&adults=1&children=0&infants=0&sort=cheapest`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();
    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);

    const cards = page.getByTestId("result-card");
    await cards.nth(1).waitFor();
    assert.equal(await cards.count(), 2);
    assert.equal(await cards.nth(0).locator(".fd-card__provider").getAttribute("title"), "Agilsmart");
    assert.equal(await cards.nth(1).locator(".fd-card__provider").getAttribute("title"), "Click and Book Plus");

    const selectAction = cards.nth(0).getByRole("button", { name: /^Seleccionar oferta/ });
    assert.equal(await selectAction.evaluate((element) => element.tagName), "BUTTON");
    const selectLabel = await selectAction.getAttribute("aria-label") ?? "";
    assert.match(selectLabel, /^Seleccionar oferta/);
    for (const detail of [
      "LATAM",
      "Ida: 14:00 a 22:00, 8h 0m, Directo",
      "Vuelta: 15:00 a 22:50, 7h 50m, Directo",
      "USD 512.00 total",
      "Agilsmart",
    ]) {
      assert.ok(selectLabel.includes(detail), `${detail} missing from ${selectLabel}`);
    }
    assert.equal(await selectAction.locator("button").count(), 0);
    assert.equal(await selectAction.getAttribute("aria-pressed"), "false");
    await page.evaluate(() => {
      const state = window as typeof window & { __providerOpens?: Array<{ url: string; target?: string; features?: string }> };
      state.__providerOpens = [];
      state.open = ((url, target, features) => {
        state.__providerOpens?.push({ url: String(url), target, features });
        return null;
      }) as typeof window.open;
    });
    await selectAction.focus();
    assert.equal(await selectAction.evaluate((element) => document.activeElement === element), true);
    assert.match(await selectAction.getAttribute("class") ?? "", /fd-focus-ring/);
    await selectAction.press("Enter");
    const selectedAction = cards.nth(0).getByRole("button", { name: /^Oferta seleccionada/ });
    await selectedAction.waitFor();
    assert.equal(await selectedAction.getAttribute("aria-pressed"), "true");

    const detailPanel = page.getByTestId("detail-panel-body").locator("..");
    const agilLink = detailPanel.getByRole("button", { name: "Abrir", exact: true });
    await agilLink.waitFor();
    assert.equal(await agilLink.getAttribute("title"), "Abrir proveedor");
    await agilLink.click();

    await cards.nth(1).getByRole("button", { name: /^Seleccionar oferta/ }).click();
    const costamarLink = detailPanel.getByRole("button", { name: "Buscar", exact: true });
    await costamarLink.waitFor();
    assert.match(await costamarLink.getAttribute("title") ?? "", /búsqueda equivalente/i);
    await costamarLink.click();

    assert.deepEqual(await page.evaluate(() => (
      window as typeof window & { __providerOpens?: Array<{ url: string; target?: string; features?: string }> }
    ).__providerOpens), [
      {
        url: "https://example.test/agil",
        target: "_blank",
        features: "noopener,noreferrer",
      },
      {
        url: "https://example.test/costamar",
        target: "_blank",
        features: "noopener,noreferrer",
      },
    ]);
  }, { autoOpen: false });
});

test("result cards reserve matching airline and provider logo slots", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 1600, height: 800 });
    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/search", async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      const offer = buildOffer({
        id: "airline-logo-slot-offer",
        tripType: "one-way",
        mainCarrier: "LA",
        validatingCarrier: "LA",
        providerSource: "costamar",
        purchasePaths: [
          {
            id: "logo-slot-costamar-path",
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
        itineraries: [
          {
            id: "airline-logo-slot-offer-outbound",
            direction: "outbound",
            durationMinutes: 480,
            stops: 0,
            layoverMinutes: [],
            segments: [
              {
                id: "airline-logo-slot-offer-outbound-1",
                flightNumber: "LA 2478",
                marketingCarrier: "LA",
                marketingCarrierName: "LATAM Airlines",
                origin: "LIM",
                destination: "MAD",
                departureAt: "2026-06-08T09:10:00-05:00",
                arrivalAt: "2026-06-08T17:25:00+02:00",
                durationMinutes: 480,
              },
            ],
          },
        ],
      });

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "airline-logo-slot-search",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: payload.sortMode,
          request: payload.request,
          offers: [offer],
          allOffers: [offer],
          searchMeta: {
            requestedAt: "2026-05-04T15:21:48.419Z",
            completedAt: "2026-05-04T15:21:48.419Z",
            providersUsed: ["costamar"],
            warnings: [],
            partial: false,
            searchState: "search_live",
          },
          providerMeta: {
            exactProvider: "costamar",
            coverageMode: "core",
          },
          warnings: [],
        }),
      });
    });

    await page.goto(`${baseUrl}/?mode=exact&trip=one-way&origin=LIM&destination=MAD&departure=2026-06-08&adults=1&children=0&infants=0&sort=cheapest`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();
    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);

    const card = page.getByTestId("result-card").first();
    await card.waitFor();
    const airlineLogo = card.locator(".fd-card__logo img");
    await airlineLogo.waitFor();
    assert.ok((await airlineLogo.getAttribute("src"))?.endsWith("/assets/airline-icons/LA.png"));
    const providerLogo = card.locator(".fd-card__provider img");
    await providerLogo.waitFor();
    assert.ok((await providerLogo.getAttribute("src"))?.endsWith("/assets/provider-icons/click-and-book-plus-128.png"));

    const geometry = await card.evaluate((element) => {
      const rectOf = (selector: string) => {
        const node = element.querySelector<HTMLElement>(selector);
        if (!node) throw new Error(`Missing ${selector}`);
        const rect = node.getBoundingClientRect();
        return {
          left: Math.round(rect.left),
          width: Math.round(rect.width),
        };
      };

      return {
        airline: rectOf(".fd-card__logo"),
        provider: rectOf(".fd-card__provider"),
      };
    });
    assert.equal(geometry.airline.width, 32, JSON.stringify(geometry));
    assert.equal(geometry.provider.width, 26, JSON.stringify(geometry));
    assert.ok(geometry.airline.left < geometry.provider.left, JSON.stringify(geometry));
  }, { autoOpen: false });
});

test("detail panel mirrors selected result content and omits unknown fare conditions", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    let quotationRequests = 0;
    let quotedOffer: ReturnType<typeof buildOffer> | undefined;
    await page.setViewportSize({ width: 1280, height: 760 });
    await page.addInitScript(() => {
      const originalExecCommand = document.execCommand.bind(document);
      document.execCommand = ((command: string, showUI?: boolean, value?: string) => {
        if (command === "copy") {
          const activeElement = document.activeElement as HTMLTextAreaElement | null;
          (window as unknown as { __flyDeskCopiedText?: string }).__flyDeskCopiedText = activeElement?.value ?? "";
          return Boolean(activeElement?.value);
        }
        return originalExecCommand(command, showUI, value);
      }) as typeof document.execCommand;

      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async () => {
            throw new DOMException("Clipboard blocked", "NotAllowedError");
          },
        },
      });
    });
    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/quotation", async (route) => {
      quotationRequests += 1;
      assert.deepEqual(route.request().postDataJSON(), {
        searchSessionId: "detail-panel-search",
        offerId: "detail-panel-offer",
        migrationPlan: false,
      });
      assert.ok(quotedOffer);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchSessionId: "detail-panel-search",
          commercialText: "COTIZACIÓN BOLETO AÉREO ✈️\nTarifa validada por el proveedor",
          offer: {
            ...quotedOffer,
            priceConfidence: "validated",
            priceStatus: "verified",
            priceVerifiedAt: "2026-05-21T10:13:58.582Z",
          },
        }),
      });
    });
    await page.route("**/api/search", async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      const offers = [
        buildOffer({
          id: "detail-panel-offer",
          tripType: "one-way",
          signature: "agil:detail-panel-offer",
          providerOfferRef: "detail-panel-offer",
          quotationPreparedAt: "2026-05-21T10:12:58.582Z",
          priceStatus: "unverified",
          origin: "LIM",
          destination: "MAD",
          mainCarrier: "LA",
          validatingCarrier: "LA",
          providerSource: "agil-local",
          comparisonMetrics: {
            totalDurationMinutes: 1310,
            totalStops: 1,
            baggageScore: 1,
            purchasePathScore: 1,
          },
          baggage: {
            carryOnIncluded: true,
            checkedIncluded: false,
            description: "Equipaje de mano incluido",
          },
          price: {
            total: { amount: 812.35, currencyCode: "USD" },
            base: { amount: 710, currencyCode: "USD" },
            taxes: { amount: 102.35, currencyCode: "USD" },
          },
          usdToPenRate: 3.75,
          itineraries: [
            {
              id: "detail-panel-outbound",
              direction: "outbound",
              durationMinutes: 1310,
              stops: 1,
              layoverMinutes: [155],
              segments: [
                {
                  id: "detail-panel-outbound-1",
                  flightNumber: "LA 2478",
                  marketingCarrier: "LA",
                  marketingCarrierName: "LATAM Airlines",
                  origin: "LIM",
                  destination: "CDG",
                  destinationName: "París (Todos los aeropuertos)",
                  departureAt: "2026-05-28T09:10:00-05:00",
                  arrivalAt: "2026-05-29T08:25:00+02:00",
                  durationMinutes: 975,
                },
                {
                  id: "detail-panel-outbound-2",
                  flightNumber: "LA 806",
                  marketingCarrier: "LA",
                  marketingCarrierName: "LATAM Airlines",
                  origin: "CDG",
                  originName: "París (Todos los aeropuertos)",
                  destination: "MAD",
                  departureAt: "2026-05-29T11:00:00+02:00",
                  arrivalAt: "2026-05-29T14:00:00+02:00",
                  durationMinutes: 180,
                },
              ],
            },
          ],
          purchasePaths: [
            {
              id: "detail-panel-agil-path",
              provider: "agil-local",
              type: "deeplink",
              label: "Agilsmart",
              url: "https://example.test/agil/detail-panel-offer",
              precision: "exact-offer",
              score: 1,
              requiresNewTab: true,
              commercialMode: "provider",
              state: "deeplink_exact",
            },
          ],
          tags: [],
          warnings: [],
        }),
      ];
      quotedOffer = offers[0];

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "detail-panel-search",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: payload.sortMode,
          request: payload.request,
          offers,
          allOffers: offers,
          searchMeta: {
            requestedAt: "2026-05-21T10:12:58.582Z",
            completedAt: "2026-05-21T10:12:58.582Z",
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

    await page.goto(`${baseUrl}/?mode=exact&trip=one-way&origin=LIM&destination=MAD&departure=2026-05-28&adults=1&children=0&infants=0&sort=cheapest`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();
    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);

    await page.getByTestId("result-card").getByRole("button", { name: /^Seleccionar oferta/ }).click();
    const detailBody = page.getByTestId("detail-panel-body");
    await detailBody.waitFor();
    const detailPanel = detailBody.locator("..");
    await detailPanel.getByRole("heading", { name: "LATAM" }).waitFor();
    assert.equal(quotationRequests, 0);

    const selectedText = await detailPanel.innerText();
    assert.match(selectedText, /LATAM/);
    assert.match(selectedText, /USD 812\.35/);
    assert.match(selectedText, /Agilsmart/);
    assert.match(selectedText, /Ida · 28 may/i);
    assert.match(selectedText, /21h 50m · 1 escala/);
    assert.match(selectedText, /09:10/);
    assert.match(selectedText, /LIM/);
    assert.match(selectedText, /LA2478 · 16h 15m/);
    assert.match(selectedText, /08:25/);
    assert.match(selectedText, /CDG · París \(Todos los aeropuertos\)/i);
    // Plate 8a writes the waiting leg station first, wait second.
    assert.match(selectedText, /Escala en CDG · 2h 35m/);
    assert.match(selectedText, /11:00/);
    assert.match(selectedText, /LA806 · 3h/);
    assert.match(selectedText, /14:00/);
    assert.match(selectedText, /MAD/);
    assert.match(selectedText, /Equipaje/);
    // Only what the fare includes is named; the absence is the dimmed icon.
    assert.match(selectedText, /Cabina/);
    assert.doesNotMatch(selectedText, /no incluido/);
    assert.doesNotMatch(selectedText, /Cambios|Reembolso|Asientos|Emisión/);

    const footerMigrationSwitch = detailPanel.getByRole("switch", { name: "Paquete migratorio" });
    await footerMigrationSwitch.waitFor();
    assert.equal(await footerMigrationSwitch.getAttribute("aria-checked"), "false");
    assert.equal(await page.getByTestId("quotation-text").count(), 0);
    await detailPanel.getByRole("button", { name: "Cotizar" }).click();

    const dialog = page.getByRole("dialog", { name: "Cotización lista para pegar" });
    await dialog.waitFor();
    const quotationText = dialog.getByTestId("quotation-text");
    await quotationText.waitFor();
    await page.waitForFunction(() => (
      (window as unknown as { __flyDeskCopiedText?: string }).__flyDeskCopiedText?.startsWith("COTIZACIÓN BOLETO AÉREO ✈️")
    ));
    assert.equal(quotationRequests, 1);

    const overlayMigrationSwitch = dialog.getByRole("switch", { name: "Paquete migratorio" });
    await overlayMigrationSwitch.click();
    assert.equal(await overlayMigrationSwitch.getAttribute("aria-checked"), "true");
    assert.equal(await quotationText.count(), 1);
    await quotationText.getByText("PAQUETE MIGRATORIO MADRID 🇪🇸", { exact: false }).waitFor();
    assert.match(await quotationText.innerText(), /Seguro de viaje Transitorio/);
    assert.match(await quotationText.innerText(), /Selección de asiento no permitida; la asignación es aleatoria/);
    assert.equal(quotationRequests, 1);

    await dialog.getByRole("button", { name: "Copiar" }).click();
    const quotedText = await dialog.innerText();
    assert.match(quotedText, /Cotización/);
    assert.match(quotedText, /Copiado/);
    assert.doesNotMatch(quotedText, /Listo para copiar/);

    await page.waitForFunction(() => (
      (window as unknown as { __flyDeskCopiedText?: string }).__flyDeskCopiedText?.startsWith("PAQUETE MIGRATORIO MADRID 🇪🇸")
    ));
    const copiedText = await page.evaluate(() => (
      (window as unknown as { __flyDeskCopiedText?: string }).__flyDeskCopiedText
    ));
    assert.match(copiedText ?? "", /Seguro de viaje Transitorio/);
    assert.equal(await dialog.getByRole("button", { name: "Copiado" }).count(), 1);

    const quotationLayout = await quotationText.evaluate((element) => {
      const dialogElement = element.closest<HTMLElement>('[role="dialog"]');
      const scrollBody = element.parentElement;
      if (!dialogElement || !scrollBody) throw new Error("Missing quotation dialog layout");
      const rect = dialogElement.getBoundingClientRect();
      return {
        bodyOverflowsHorizontally: scrollBody.scrollWidth > scrollBody.clientWidth,
        overflowY: getComputedStyle(scrollBody).overflowY,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    });
    assert.equal(quotationLayout.bodyOverflowsHorizontally, false, JSON.stringify(quotationLayout));
    assert.equal(quotationLayout.overflowY, "auto", JSON.stringify(quotationLayout));
    assert.ok(quotationLayout.width <= 620, JSON.stringify(quotationLayout));
    assert.ok(quotationLayout.height <= 768, JSON.stringify(quotationLayout));
  }, { autoOpen: false });
});

test("domestic Costamar quotation uses the verified endpoint response", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    let quotationRequests = 0;
    const offer = buildOffer({
      id: "domestic-costamar-quote",
      tripType: "one-way",
      providerSource: "costamar",
      quotationPreparedAt: "2026-06-01T12:00:00.000Z",
      usdToPenRate: 3.61,
      origin: "LIM",
      destination: "CUZ",
      price: {
        total: { amount: 100, currencyCode: "USD" },
        base: { amount: 80, currencyCode: "USD" },
        taxes: { amount: 20, currencyCode: "USD" },
      },
      itineraries: [{
        id: "domestic-costamar-quote-outbound",
        direction: "outbound",
        durationMinutes: 85,
        stops: 0,
        layoverMinutes: [],
        segments: [{
          id: "domestic-costamar-quote-outbound-1",
          marketingCarrier: "LA",
          flightNumber: "LA 2025",
          origin: "LIM",
          destination: "CUZ",
          departureAt: "2026-06-08T09:00:00-05:00",
          arrivalAt: "2026-06-08T10:25:00-05:00",
          durationMinutes: 85,
        }],
      }],
    });

    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ suggestions: [] }) });
    });
    await page.route("**/api/quotation", async (route) => {
      quotationRequests += 1;
      assert.deepEqual(route.request().postDataJSON(), {
        searchSessionId: "domestic-costamar-search",
        offerId: "domestic-costamar-quote",
        migrationPlan: false,
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchSessionId: "domestic-costamar-search",
          commercialText: "COTIZACIÓN BOLETO AÉREO ✈️\nS/ 361 por adulto",
          offer: {
            ...offer,
            priceConfidence: "validated",
            priceStatus: "verified",
            priceVerifiedAt: "2026-06-01T12:01:00.000Z",
          },
        }),
      });
    });
    await page.route("**/api/search", async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "domestic-costamar-search",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: payload.sortMode,
          request: payload.request,
          offers: [offer],
          allOffers: [offer],
          searchMeta: {
            requestedAt: "2026-06-01T12:00:00.000Z",
            completedAt: "2026-06-01T12:00:00.000Z",
            providersUsed: ["costamar"],
            warnings: [],
            partial: false,
            searchState: "search_live",
          },
          providerMeta: { exactProvider: "costamar", coverageMode: "core" },
          warnings: [],
        }),
      });
    });

    await page.goto(`${baseUrl}/?mode=exact&trip=one-way&origin=LIM&destination=CUZ&departure=2026-06-08&adults=1&children=0&infants=0&sort=cheapest`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();
    await page.getByRole("button", { name: "Buscar" }).click();
    await page.getByTestId("result-card").click();
    await page.getByRole("button", { name: "Cotizar" }).click();

    const quotation = await page.getByTestId("quotation-text").innerText();
    assert.match(quotation, /S\/ 361 por adulto/);
    assert.doesNotMatch(quotation, /US\$|USD/);
    assert.equal(quotationRequests, 1);
  }, { autoOpen: false });
});

test("a confirmed fare replaces the one on screen and the toggle never borrows another offer's rate", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    const leg = (id: string, flightNumber: string) => ([{
      id: `${id}-outbound`,
      direction: "outbound" as const,
      durationMinutes: 85,
      stops: 0,
      layoverMinutes: [],
      segments: [{
        id: `${id}-outbound-1`,
        marketingCarrier: "LA",
        flightNumber,
        origin: "LIM",
        destination: "CUZ",
        departureAt: "2026-06-08T09:00:00-05:00",
        arrivalAt: "2026-06-08T10:25:00-05:00",
        durationMinutes: 85,
      }],
    }]);

    /* The offer the agent quotes carries no rate of its own — that is the real
       shape, the provider does not supply one. The second offer does, and it is
       the one the panel used to borrow from. */
    const quoted = buildOffer({
      id: "reconcile-quoted",
      tripType: "one-way",
      providerSource: "costamar",
      quotationPreparedAt: "2026-06-01T12:00:00.000Z",
      usdToPenRate: undefined,
      origin: "LIM",
      destination: "CUZ",
      price: {
        total: { amount: 100, currencyCode: "USD" },
        base: { amount: 80, currencyCode: "USD" },
        taxes: { amount: 20, currencyCode: "USD" },
      },
      itineraries: leg("reconcile-quoted", "LA 2025"),
    });
    const lender = buildOffer({
      id: "reconcile-lender",
      tripType: "one-way",
      providerSource: "agil-local",
      quotationPreparedAt: "2026-06-01T12:00:00.000Z",
      usdToPenRate: 3.61,
      origin: "LIM",
      destination: "CUZ",
      price: {
        total: { amount: 900, currencyCode: "USD" },
        base: { amount: 850, currencyCode: "USD" },
        taxes: { amount: 50, currencyCode: "USD" },
      },
      itineraries: leg("reconcile-lender", "LA 2099"),
    });

    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ suggestions: [] }) });
    });
    await page.route("**/api/quotation", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchSessionId: "reconcile-search",
          commercialText: "COTIZACIÓN BOLETO AÉREO ✈️\nUS$ 150 por adulto",
          offer: {
            ...quoted,
            // Revalidation came back dearer. That is allowed; hiding it is not.
            price: {
              total: { amount: 150, currencyCode: "USD" },
              base: { amount: 120, currencyCode: "USD" },
              taxes: { amount: 30, currencyCode: "USD" },
            },
            priceConfidence: "validated",
            priceStatus: "verified",
            priceVerifiedAt: "2026-06-01T12:01:00.000Z",
          },
        }),
      });
    });
    await page.route("**/api/search", async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "reconcile-search",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: payload.sortMode,
          request: payload.request,
          offers: [quoted, lender],
          allOffers: [quoted, lender],
          searchMeta: {
            requestedAt: "2026-06-01T12:00:00.000Z",
            completedAt: "2026-06-01T12:00:00.000Z",
            providersUsed: ["costamar", "agil-local"],
            warnings: [],
            partial: false,
            searchState: "search_live",
          },
          providerMeta: { exactProvider: "costamar", coverageMode: "core" },
          warnings: [],
        }),
      });
    });

    await page.goto(`${baseUrl}/?mode=exact&trip=one-way&origin=LIM&destination=CUZ&departure=2026-06-08&adults=1&children=0&infants=0&sort=cheapest`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();
    await page.getByRole("button", { name: "Buscar" }).click();
    await page.getByTestId("result-card").first().click();

    const detailPrice = page.locator(".fd-detail-price");
    assert.match(await detailPrice.innerText(), /100/);

    await page.getByRole("button", { name: "Cotizar" }).click();
    await page.getByTestId("quotation-text").waitFor();

    // The header and the card now say what the provider confirmed.
    await page.waitForFunction(() =>
      document.querySelector(".fd-detail-price")?.textContent?.includes("150") === true
    );
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll(".fd-card__price-figure"))
        .some((node) => node.textContent?.includes("150"))
    );

    /* 05 §5: the toggle rewrites the text live. With no rate on the confirmed
       offer the only figure it may produce is the one the provider confirmed —
       reaching for the 3.61 of the other offer is how «US$ 150» used to turn
       into a sol figure nobody had confirmed. */
    await page
      .getByRole("dialog", { name: "Cotización lista para pegar" })
      .getByRole("switch", { name: /Paquete migratorio/i })
      .click();
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="quotation-text"]')?.textContent?.includes("PAQUETE MIGRATORIO") === true
    );
    const migrationText = await page.getByTestId("quotation-text").innerText();
    assert.doesNotMatch(migrationText, /S\//);
    assert.match(migrationText, /(US\$|USD) 150/);
  }, { autoOpen: false });
});

test("quotation failure never exposes or copies an unvalidated local quote", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    const offer = buildOffer({
      id: "quotation-validation-failure",
      tripType: "one-way",
      providerSource: "agil-local",
      quotationPreparedAt: "2026-06-01T12:00:00.000Z",
      origin: "LIM",
      destination: "MIA",
      price: { total: { amount: 500, currencyCode: "USD" } },
      itineraries: [{
        id: "quotation-validation-failure-outbound",
        direction: "outbound",
        durationMinutes: 360,
        stops: 0,
        layoverMinutes: [],
        segments: [{
          id: "quotation-validation-failure-outbound-1",
          marketingCarrier: "LA",
          flightNumber: "2478",
          origin: "LIM",
          destination: "MIA",
          departureAt: "2026-06-08T09:00:00-05:00",
          arrivalAt: "2026-06-08T15:00:00-04:00",
          durationMinutes: 360,
        }],
      }],
    });

    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ suggestions: [] }) });
    });
    await page.route("**/api/quotation", async (route) => {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ errors: ["Selected offer could not be validated for quotation."] }),
      });
    });
    await page.route("**/api/search", async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "quotation-validation-search",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: payload.sortMode,
          request: payload.request,
          offers: [offer],
          allOffers: [offer],
          searchMeta: {
            requestedAt: "2026-06-01T12:00:00.000Z",
            completedAt: "2026-06-01T12:00:00.000Z",
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

    await page.goto(`${baseUrl}/?mode=exact&trip=one-way&origin=LIM&destination=MIA&departure=2026-06-08&adults=1&children=0&infants=0&sort=cheapest`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();
    await page.getByRole("button", { name: "Buscar" }).click();
    await page.getByTestId("result-card").click();
    await page.getByRole("button", { name: "Cotizar" }).click();

    /*
     * Plate 3c and 05 §7: the failure is resolved in the panel, where the button
     * that asked for it lives — the 620 panel of 1h only ever opens over a fare
     * the provider confirmed, so it must not open at all here.
     */
    const failure = page.getByRole("alert");
    await failure.waitFor();
    const failureText = await failure.innerText();
    assert.match(failureText, /No se pudo confirmar la tarifa/);
    assert.match(failureText, /El texto no se copió/);
    assert.equal(await failure.getByRole("button", { name: "Reintentar" }).count(), 1);

    // The unvalidated local quote is neither shown nor copied, on any surface.
    assert.equal(await page.getByRole("dialog", { name: "Cotización lista para pegar" }).count(), 0);
    assert.equal(await page.getByTestId("quotation-text").count(), 0);
    // The offer's own price stays on screen — it is the quotation body, the
    // thing composed locally and never confirmed, that must not appear.
    assert.doesNotMatch(await page.locator("body").innerText(), /COTIZACIÓN BOLETO/);
    assert.equal(
      await page.evaluate(() => (window as unknown as { __flyDeskCopiedText?: string }).__flyDeskCopiedText),
      undefined,
    );

    // It does not leave on its own; discarding is the second way out (05 §7).
    await failure.getByRole("button", { name: "Descartar el aviso de cotización" }).click();
    assert.equal(await page.getByRole("alert").count(), 0);
  }, { autoOpen: false });
});

test("progressive results preserve existing cards when the remaining offers arrive", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    let releasePoll = () => {};
    const pollGate = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    const firstOffer = buildOffer({ id: "progressive-first", quotationPreparedAt: "2026-05-21T10:12:58.582Z" });
    const secondOffer = buildOffer({ id: "progressive-second", price: { total: { amount: 950, currencyCode: "USD" } } });

    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ suggestions: [] }) });
    });
    await page.route("**/api/search**", async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() === "POST" && url.pathname === "/api/search") {
        const payload = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            searchJobId: "progressive-results",
            searchComplete: false,
            searchStatus: "running",
            revision: 1,
            sortMode: payload.sortMode,
            request: payload.request,
            offers: [firstOffer],
            allOffers: [firstOffer],
            searchMeta: {
              requestedAt: "2026-05-21T10:12:58.582Z",
              completedAt: "2026-05-21T10:12:58.582Z",
              providersUsed: ["agil-local"],
              warnings: [],
              partial: true,
              searchState: "search_partial",
            },
            providerMeta: { exactProvider: "agil-local", coverageMode: "core" },
            warnings: [],
          }),
        });
        return;
      }

      if (route.request().method() === "GET" && url.pathname === "/api/search/progressive-results") {
        await pollGate;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            searchJobId: "progressive-results",
            searchComplete: true,
            searchStatus: "completed",
            revision: 2,
            sortMode: "cheapest",
            request: undefined,
            offers: [firstOffer, secondOffer],
            allOffers: [firstOffer, secondOffer],
            searchMeta: {
              requestedAt: "2026-05-21T10:12:58.582Z",
              completedAt: "2026-05-21T10:12:59.582Z",
              providersUsed: ["agil-local", "costamar"],
              warnings: [],
              partial: false,
              searchState: "search_live",
            },
            providerMeta: { exactProvider: "agil-local", coverageMode: "core" },
            warnings: [],
          }),
        });
        return;
      }

      await route.continue();
    });

    await page.goto(`${baseUrl}/?mode=exact&trip=one-way&origin=LIM&destination=MAD&departure=2026-05-28&adults=1&children=0&infants=0&sort=cheapest`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();
    await page.getByRole("button", { name: "Buscar" }).click();
    await page.getByTestId("result-card").first().waitFor();
    await page.evaluate(() => {
      (window as unknown as { __firstResultCard?: Element }).__firstResultCard = document.querySelector('[data-testid="result-card"]') ?? undefined;
    });

    releasePoll();
    await page.getByTestId("result-card").nth(1).waitFor();
    assert.equal(await page.evaluate(() => (
      (window as unknown as { __firstResultCard?: Element }).__firstResultCard
        === document.querySelector('[data-testid="result-card"]')
    )), true);
  }, { autoOpen: false });
});

test("cached offers stay non-quotable until a fresh provider result replaces them", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    let releasePoll = () => {};
    const pollGate = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    const cachedOffer = buildOffer({ id: "cache-refresh-offer" });
    const freshOffer = { ...cachedOffer, quotationPreparedAt: "2026-05-21T10:13:58.582Z" };

    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ suggestions: [] }) });
    });
    await page.route("**/api/search**", async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() === "POST" && url.pathname === "/api/search") {
        const payload = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            searchJobId: "cache-refresh-job",
            searchComplete: false,
            searchStatus: "running",
            revision: 1,
            sortMode: payload.sortMode,
            request: payload.request,
            offers: [cachedOffer],
            allOffers: [cachedOffer],
            searchMeta: {
              requestedAt: "2026-05-21T10:12:58.582Z",
              completedAt: "2026-05-21T10:12:58.582Z",
              providersUsed: ["agil-local"],
              warnings: ["Mostrando resultados cacheados mientras actualizamos en segundo plano."],
              partial: true,
              searchState: "search_cached",
            },
            providerMeta: { exactProvider: "agil-local", coverageMode: "core" },
            warnings: [],
          }),
        });
        return;
      }

      if (route.request().method() === "GET" && url.pathname === "/api/search/cache-refresh-job") {
        await pollGate;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            searchJobId: "cache-refresh-job",
            searchComplete: true,
            searchStatus: "completed",
            revision: 2,
            sortMode: "cheapest",
            request: undefined,
            offers: [freshOffer],
            allOffers: [freshOffer],
            searchMeta: {
              requestedAt: "2026-05-21T10:12:58.582Z",
              completedAt: "2026-05-21T10:13:58.582Z",
              providersUsed: ["agil-local"],
              warnings: [],
              partial: false,
              searchState: "search_live",
            },
            providerMeta: { exactProvider: "agil-local", coverageMode: "core" },
            warnings: [],
          }),
        });
        return;
      }

      await route.continue();
    });

    await page.goto(`${baseUrl}/?mode=exact&trip=one-way&origin=LIM&destination=MAD&departure=2026-05-28&adults=1&children=0&infants=0&sort=cheapest`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();
    await page.getByRole("button", { name: "Buscar" }).click();
    await page.getByTestId("result-card").click();
    const quoteButton = page.getByRole("button", { name: "Cotizar" });
    assert.equal(await quoteButton.isDisabled(), true);

    releasePoll();
    await page.waitForFunction(() => {
      const button = Array.from(document.querySelectorAll("button")).find((candidate) => candidate.textContent?.includes("Cotizar"));
      return button instanceof HTMLButtonElement && !button.disabled;
    });
    assert.equal(await quoteButton.isEnabled(), true);
  }, { autoOpen: false });
});
