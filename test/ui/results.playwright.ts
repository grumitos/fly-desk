import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page, Route } from "playwright";
import type { CanonicalOffer, Itinerary } from "../../src/core/types";
import { registerDesktopHarness, withDesktopPage } from "../helpers/ui.ts";
import { buildOffer } from "../helpers/ui-fixtures.ts";
import { clickSegment, openSearchUrlWithoutLaunching, openSharedSearchLink, segment, waitForFontsReady } from "./support.ts";

registerDesktopHarness();

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

    await openSharedSearchLink(page, `${baseUrl}/?mode=exact&trip=round-trip&origin=LIM&destination=BIO&departure=2026-06-08&return=2026-06-20&adults=1&children=0&infants=0&sort=cheapest&maxStops=1`);
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

test("the list opens on a column of offers and scrolls to the rest inside it", async () => {
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

    await openSharedSearchLink(page, `${baseUrl}/?mode=exact&trip=round-trip&origin=LIM&destination=BIO&departure=2026-06-08&return=2026-06-20&adults=1&children=0&infants=0&sort=cheapest&maxStops=1`);

    const resultsBody = page.getByTestId("results-list-body");
    /* Only that cards exist. How many are on screen at this instant is the
       window's business and it moves within a frame of arriving — waiting for
       an intermediate count is waiting for a paint the browser is free to
       coalesce away. */
    await page.waitForFunction(() => {
      const body = document.querySelector<HTMLElement>('[data-testid="results-list-body"]');
      const cards = document.querySelectorAll('[data-testid="result-card"]').length;
      return Boolean(body && cards > 0 && getComputedStyle(body).scrollbarWidth === "none");
    });

    /* There is no control anywhere that hands out the rest of the list:
       reaching it is scrolling, and nothing else. (Eighteen offers all fit
       within the first window and its slack — what a set too long for that
       does is the case below.) */
    const openingCards = await page.locator('[data-testid="result-card"]').count();
    assert.ok(openingCards > 0, `opened on ${openingCards}`);
    assert.equal(await page.getByTestId("results-pagination").count(), 0);
    assert.equal(await page.getByRole("button", { name: /^Página / }).count(), 0);

    const metrics = await resultsBody.evaluate((element) => ({
      clientHeight: element.clientHeight,
      listHeight: element.querySelector<HTMLElement>(".fd-results-list")?.getBoundingClientRect().height ?? 0,
      overflowY: getComputedStyle(element).overflowY,
      scrollbarWidth: getComputedStyle(element).scrollbarWidth,
      scrollHeight: element.scrollHeight,
    }));
    assert.equal(metrics.overflowY, "auto");
    assert.equal(metrics.scrollbarWidth, "none");
    assert.ok(metrics.scrollHeight >= metrics.clientHeight, JSON.stringify(metrics));

    /*
     * On a desk the list grows inside its own column and nowhere else: the
     * window it scrolls in is the one the plates draw beside the filters and
     * the detail, so the page behind it must never gain a scroll of its own.
     */
    const pageScroll = await page.evaluate(() => ({
      documentScrollable: document.scrollingElement
        ? document.scrollingElement.scrollHeight > document.scrollingElement.clientHeight + 1
        : false,
      shellOverflow: getComputedStyle(document.querySelector(".fd-shell") as HTMLElement).overflow,
    }));
    assert.deepEqual(pageScroll, { documentScrollable: false, shellOverflow: "hidden" });

    /* Scrolling the column reaches the whole set, and never by starting over:
       the cards already read stay where they were read. */
    const pagedCards = page.locator('[data-testid="result-card"]');
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (await pagedCards.count() >= 18) break;
      await resultsBody.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await page.waitForTimeout(120);
    }
    assert.equal(await pagedCards.count(), 18);
    assert.equal(await pagedCards.filter({ hasText: "P01" }).count(), 1);
    await pagedCards.filter({ hasText: "P18" }).first().waitFor();
    /* The whole set is in the column, so there is nothing left to reach for —
       the mark the list watches is gone with the reason for it. */
    assert.equal(await page.getByTestId("results-more-sentinel").count(), 0);

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
    /* One schedule per leg, and the count is asserted before the `every`:
       `[].every()` is true, so a renamed lane would have retired this check
       without failing it. */
    assert.equal(scheduleMetrics.length, 2, JSON.stringify(scheduleMetrics));
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

    await openSharedSearchLink(page, `${baseUrl}/?mode=exact&trip=round-trip&origin=LIM&destination=MAD&departure=2026-05-28&return=2026-06-04&adults=1&children=0&infants=0&sort=cheapest`);

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
    /* «VUELTA» alone over «4 jun · …»: both detail plates keep the eyebrow to
       the word and hand the date to the summary on the right, which is where
       the rest of the leg's facts already are. It read «Vuelta · 4 jun» while
       the date was glued to the eyebrow. */
    assert.match(detailText, /VUELTA\n4 jun · /);
    assert.match(detailText, /20:30/);
    assert.match(detailText, /15:25/);
  }, { autoOpen: false });
});

test("a list with more results to give covers the column it was measured against", async () => {
  /*
   * Reported from the desk at 1920: five cards and a third of the column blank
   * below them. Capacity is counted in plain-card slots, so it has to be
   * measured on a plain card — taking the tallest instead made a single group
   * card (101px against 58) the unit for the whole page and cut it almost in
   * half. With results still queued, what is left over must be less than one
   * more row, or a card that fits was withheld.
   */
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 1920, height: 940 });
    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/search", async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      /* Twenty, not fourteen. The claim is that a list with more to give covers
         the column, so the fixture has to hold more than the column does — and
         a 940-tall desk holds thirteen 52px rows where it held eleven 58px
         cards with 6px of air between them. */
      const offers = Array.from({ length: 20 }, (_, index) => {
        const base = buildOffer({ id: `fill-${index}`, destination: "MAD" });
        // The first three share an outbound and differ on the return, which is
        // what makes them one group with a strip instead of three plain cards.
        const inbound = base.itineraries[1];
        return buildOffer({
          id: `fill-${index}`,
          destination: "MAD",
          itineraries: [
            base.itineraries[0],
            {
              ...inbound,
              id: `fill-${index}-inbound`,
              segments: inbound.segments.map((segment) => ({
                ...segment,
                /* Wrapped, so twenty offers still name twenty valid hours: the
                   two schedules only have to differ, and `12 + index` walked
                   past 23 as soon as the fixture grew. */
                departureAt: `2026-06-04T${String((4 + index) % 24).padStart(2, "0")}:30:00Z`,
                arrivalAt: `2026-06-04T${String((10 + index) % 24).padStart(2, "0")}:30:00Z`,
              })),
            },
          ] as never,
        });
      });
      const grouped = offers.slice(0, 3);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "fill-search",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: payload.sortMode,
          request: payload.request,
          offers,
          allOffers: offers,
          scheduleGroups: [{
            id: "agil-local:FILL",
            providerSource: "agil-local",
            outboundOptions: [{ id: "fill-out", itinerary: grouped[0].itineraries[0] }],
            inboundOptions: grouped.map((offer, index) => ({ id: `fill-in-${index}`, itinerary: offer.itineraries[1] })),
            combinations: grouped.map((offer, index) => ({
              outboundOptionId: "fill-out",
              inboundOptionId: `fill-in-${index}`,
              offerId: offer.id,
            })),
            truncated: false,
          }],
          searchMeta: {
            requestedAt: "2026-05-04T15:21:48.419Z",
            completedAt: "2026-05-04T15:21:48.419Z",
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

    await openSharedSearchLink(page, `${baseUrl}/?mode=exact&trip=round-trip&origin=LIM&destination=MAD&departure=2026-05-28&return=2026-06-04&adults=1&children=0&infants=0&sort=cheapest`);
    await page.getByTestId("result-card").first().waitFor();
    // There is more of the list below, so what is on screen has no excuse to
    // stop short of the bottom of the column.
    await page.waitForTimeout(400);

    const fill = await page.evaluate(() => {
      const body = document.querySelector<HTMLElement>("[data-testid='results-list-body']");
      const list = document.querySelector<HTMLElement>(".fd-results-list");
      const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='result-card']"));
      const plain = cards.find((card) => !card.querySelector(".fd-card__alts"));
      const grouped = cards.find((card) => card.querySelector(".fd-card__alts"));
      const last = cards[cards.length - 1];
      if (!body || !list || !plain || !grouped || !last) return null;

      /* `rowGap` computes to `normal` where nothing declares one, and the list
         declares none any more — rows are separated by their own hairline. A
         bare `parseFloat` returns NaN there and every comparison against `row`
         below silently becomes false. */
      const declaredGap = Number.parseFloat(getComputedStyle(list).rowGap);
      const gap = Number.isFinite(declaredGap) ? declaredGap : 0;
      return {
        available: body.clientHeight,
        used: last.getBoundingClientRect().bottom - list.getBoundingClientRect().top,
        row: plain.getBoundingClientRect().height + gap,
        groupHeight: grouped.getBoundingClientRect().height,
        cards: cards.length,
      };
    });

    assert.ok(fill, "missing list metrics");
    // The mix is what makes the measurement meaningful.
    assert.ok(fill.groupHeight > fill.row, JSON.stringify(fill));
    /* Covered, not fitted: the list runs past the bottom of the column now, and
       what the column must never show is a gap where a card would fit. */
    assert.ok(fill.used >= fill.available, JSON.stringify(fill));
  }, { autoOpen: false });
});

test("a list sized to its items still fits a group card, which is taller than one", async () => {
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

    await openSharedSearchLink(page, `${baseUrl}/?mode=exact&trip=round-trip&origin=LIM&destination=MIA&departure=2026-09-14&return=2026-09-24&adults=1&children=0&infants=0&sort=cheapest`);
    await page.getByTestId("result-card").first().waitFor();

    // Both items are the whole list, and a list that fits needs nothing below it.
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="result-card"]').length === 2);
    assert.equal(await page.getByTestId("results-more-sentinel").count(), 0);
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

    await openSharedSearchLink(page, `${baseUrl}/?mode=exact&trip=round-trip&origin=LIM&destination=MIA&departure=2026-04-15&return=2026-04-22&adults=1&children=0&infants=0&sort=cheapest`);

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

    await openSharedSearchLink(page, `${baseUrl}/?mode=exact&trip=one-way&origin=LIM&destination=MAD&departure=2026-06-08&adults=1&children=0&infants=0&sort=cheapest`);

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
    /* 28, not 32: the four pixels the logo gave up are the four the baggage
       lane took to carry «Eq.» in the column header above it. The provider mark
       is unchanged at 26. */
    assert.equal(geometry.airline.width, 28, JSON.stringify(geometry));
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

    await openSharedSearchLink(page, `${baseUrl}/?mode=exact&trip=one-way&origin=LIM&destination=MAD&departure=2026-05-28&adults=1&children=0&infants=0&sort=cheapest`);

    await page.getByTestId("result-card").getByRole("button", { name: /^Seleccionar oferta/ }).click();
    const detailBody = page.getByTestId("detail-panel-body");
    await detailBody.waitFor();
    const detailPanel = detailBody.locator("..");
    /* The panel's heading is «Oferta» now — the 28px line it shares with
       «Filtros» and «Resultados», so one rule crosses the screen — and the
       carrier is the first line of the hero under it. The claim is the same:
       the panel has landed and it is showing this fare. */
    await detailPanel.getByRole("heading", { name: "Oferta" }).waitFor();
    await detailPanel.locator(".fd-detail-carrier", { hasText: "LATAM" }).waitFor();
    assert.equal(quotationRequests, 0);

    const selectedText = await detailPanel.innerText();
    assert.match(selectedText, /LATAM/);
    assert.match(selectedText, /USD 812\.35/);
    assert.match(selectedText, /Agilsmart/);
    /* Same as above: the eyebrow is the word and the date opens the summary. */
    assert.match(selectedText, /IDA\n28 may · 21h 50m · 1 escala/);
    assert.match(selectedText, /09:10/);
    assert.match(selectedText, /LIM/);
    /* «16h 15m · LATAM 2478»: how long the passenger is aboard comes first,
       because that is what the line is for, and the flight is named rather
       than coded — both plates write the rail this way round. */
    assert.match(selectedText, /16h 15m · LATAM 2478/);
    assert.match(selectedText, /08:25/);
    /*
     * The provider labels this station «París (Todos los aeropuertos)», which
     * is a fact about the *search* — the query covered a whole city — and not
     * about the runway this leg lands on. It used to be printed verbatim in the
     * itinerary. One parser now serves the card's stop label and the detail's
     * station line, and it drops the search concept along with a code that
     * would otherwise be printed twice.
     */
    assert.match(selectedText, /CDG · París\b/);
    assert.doesNotMatch(selectedText, /Todos los aeropuertos/i);
    /* «Escala 2h 35m», with no station: `Main.dc.html` and
       `MovilDetalle.dc.html` both leave it out, and the two rail rows this
       line sits between already say CDG — the aeroplane lands at «CDG · París»
       and the next one leaves from «CDG · París». Naming it a third time in
       between made the longest line on the rail the one saying the least. */
    assert.match(selectedText, /CDG · París \+1\nEscala 2h 35m\n/);
    assert.match(selectedText, /11:00/);
    assert.match(selectedText, /3h 0m · LATAM 806/);
    assert.match(selectedText, /14:00/);
    assert.match(selectedText, /MAD/);
    assert.match(selectedText, /Equipaje/);
    /* Only what the fare includes is named; the absence is the dimmed icon.
       «Mano», the word the filter that switches this fact on already uses, and
       the word both detail plates write — «Cabina» named the same thing twice
       in the product. */
    assert.match(selectedText, /Equipaje\nMano\n/);
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

    await openSharedSearchLink(page, `${baseUrl}/?mode=exact&trip=one-way&origin=LIM&destination=CUZ&departure=2026-06-08&adults=1&children=0&infants=0&sort=cheapest`);
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

    await openSharedSearchLink(page, `${baseUrl}/?mode=exact&trip=one-way&origin=LIM&destination=CUZ&departure=2026-06-08&adults=1&children=0&infants=0&sort=cheapest`);
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

    await openSharedSearchLink(page, `${baseUrl}/?mode=exact&trip=one-way&origin=LIM&destination=MIA&departure=2026-06-08&adults=1&children=0&infants=0&sort=cheapest`);
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

    await openSharedSearchLink(page, `${baseUrl}/?mode=exact&trip=one-way&origin=LIM&destination=MAD&departure=2026-05-28&adults=1&children=0&infants=0&sort=cheapest`);
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

    await openSharedSearchLink(page, `${baseUrl}/?mode=exact&trip=one-way&origin=LIM&destination=MAD&departure=2026-05-28&adults=1&children=0&infants=0&sort=cheapest`);
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

test("the open list of schedules takes the click over every card it covers", async () => {
  /*
   * Reported from the desk: «+7» opened the full list and the cards below it
   * showed *through* it — only the 6px gaps between them were the panel.
   *
   * Two things put it there, and the test pins both. The cascade of 04 §9 runs
   * with `both`, so every row kept the final keyframe — an identity transform,
   * which is still a transform and therefore still a stacking context. The
   * panel's `z-30` was trapped inside its own row's context, and the rows after
   * it, painted later in DOM order, went over it. Being visible is not the
   * claim worth testing: what an agent does with this panel is *click* it, so
   * the assertion is `elementFromPoint` down the whole surface.
   */
  await withDesktopPage(async ({ baseUrl, page }) => {
    const leg = (id: string, direction: "outbound" | "inbound", departureAt: string, arrivalAt: string) => ({
      id: `${id}-${direction}`,
      direction,
      durationMinutes: 430,
      stops: 0,
      layoverMinutes: [],
      segments: [{
        id: `${id}-${direction}-1`,
        flightNumber: direction === "outbound" ? "CM 210" : "CM 211",
        marketingCarrier: "CM",
        origin: direction === "outbound" ? "LIM" : "MIA",
        destination: direction === "outbound" ? "MIA" : "LIM",
        departureAt,
        arrivalAt,
        durationMinutes: 430,
      }],
    });
    // Ten schedules over one outbound: three fit on the strip, the rest are the
    // «+7» — which is the only way to open the panel.
    const groupOffers = Array.from({ length: 10 }, (_, index) => {
      const id = `stack-grouped-${index}`;
      const hour = String(6 + index).padStart(2, "0");
      return buildOffer({
        id,
        providerSource: "costamar",
        origin: "LIM",
        destination: "MIA",
        price: {
          total: { amount: 610 + index * 7, currencyCode: "USD" },
          base: { amount: 580 + index * 7, currencyCode: "USD" },
          taxes: { amount: 30, currencyCode: "USD" },
        },
        itineraries: [
          leg(id, "outbound", "2026-09-14T09:50:00-05:00", "2026-09-14T17:00:00-04:00"),
          leg(id, "inbound", `2026-09-24T${hour}:20:00-04:00`, `2026-09-24T${hour}:30:00-05:00`),
        ],
      });
    });
    // Plain cards *after* the group, so there is something below the panel that
    // can paint over it. Without them the test would pass on a broken build.
    const plainOffers = Array.from({ length: 6 }, (_, index) => {
      const id = `stack-plain-${index}`;
      const hour = String(17 + index).padStart(2, "0");
      return buildOffer({
        id,
        providerSource: "costamar",
        origin: "LIM",
        destination: "MIA",
        price: {
          total: { amount: 900 + index * 11, currencyCode: "USD" },
          base: { amount: 870 + index * 11, currencyCode: "USD" },
          taxes: { amount: 30, currencyCode: "USD" },
        },
        itineraries: [
          leg(id, "outbound", `2026-09-14T${hour}:05:00-05:00`, `2026-09-15T${hour}:15:00-04:00`),
          leg(id, "inbound", `2026-09-24T${hour}:40:00-04:00`, `2026-09-25T${hour}:50:00-05:00`),
        ],
      });
    });
    const offers = [...groupOffers, ...plainOffers];
    const outboundOptionId = "costamar:STACK:outbound";

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ suggestions: [] }) });
    });
    await page.route("**/api/search", async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "stacking-search",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: payload.sortMode,
          request: payload.request,
          offers,
          allOffers: offers,
          scheduleGroups: [{
            id: "costamar:STACK",
            providerSource: "costamar",
            outboundOptions: [{ id: outboundOptionId, itinerary: groupOffers[0].itineraries[0] }],
            inboundOptions: groupOffers.map((offer, index) => ({
              id: `costamar:STACK:inbound:${index}`,
              itinerary: offer.itineraries[1],
            })),
            combinations: groupOffers.map((offer, index) => ({
              outboundOptionId,
              inboundOptionId: `costamar:STACK:inbound:${index}`,
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

    await openSharedSearchLink(page, `${baseUrl}/?mode=exact&trip=round-trip&origin=LIM&destination=MIA&departure=2026-09-14&return=2026-09-24&adults=1&children=0&infants=0&sort=cheapest`);
    await page.getByTestId("result-card").first().waitFor();

    /*
     * «Es el button ese que colapsa contra el borde del otro»: the inset-0 hit
     * of a group card ran under the alternates strip to the card's bottom
     * border, so a press on the strip's ground selected the offer and the
     * invisible button stood flush against the next card. The select surface is
     * the fare row, which is 52 now that the row is a table row rather than a
     * 58px card with 13px of padding and a border.
     */
    const hitMetrics = await page.locator(".fd-card", { has: page.locator(".fd-card__alts") }).first().evaluate((card) => {
      const hit = card.querySelector<HTMLElement>(".fd-card__hit");
      const strip = card.querySelector<HTMLElement>(".fd-card__alts");
      if (!hit || !strip) return null;
      const cardBox = card.getBoundingClientRect();
      const hitBox = hit.getBoundingClientRect();
      const stripBox = strip.getBoundingClientRect();
      const probe = document.elementFromPoint(stripBox.right - 6, stripBox.top + stripBox.height / 2);
      return {
        hitHeight: Math.round(hitBox.height),
        hitReachesCardBottom: Math.round(cardBox.bottom - hitBox.bottom) === 0,
        stripGroundSelects: Boolean(probe && probe.closest(".fd-card__hit")),
      };
    });
    assert.ok(hitMetrics, "missing group card anatomy");
    assert.equal(hitMetrics.hitHeight, 52, JSON.stringify(hitMetrics));
    assert.equal(hitMetrics.hitReachesCardBottom, false, JSON.stringify(hitMetrics));
    assert.equal(hitMetrics.stripGroundSelects, false, JSON.stringify(hitMetrics));

    /* Nine alternates to the schedule on the card, and as many chips on the
       strip as its measured width holds — three was a constant, and on a desk
       this wide it drew half of what fitted while «+n» counted the rest as if
       there were no room. Every chip that is drawn is inside the strip; the
       ones past the fit are out of flow, which is how the fit stays measurable
       through a resize. */
    const strip = await page.locator(".fd-card__alts-strip").first().evaluate((node) => {
      const chips = Array.from(node.children) as HTMLElement[];
      const box = node.getBoundingClientRect();
      const shown = chips.filter((chip) => getComputedStyle(chip).position !== "absolute");
      return {
        total: chips.length,
        shown: shown.length,
        spills: shown.filter((chip) => chip.getBoundingClientRect().right > box.right + 0.5).length,
      };
    });
    assert.equal(strip.total, 9, JSON.stringify(strip));
    assert.ok(strip.shown > 3, JSON.stringify(strip));
    assert.equal(strip.spills, 0, JSON.stringify(strip));

    await page.getByRole("button", { name: "Ver los 9 horarios" }).click();
    const panel = page.getByRole("dialog", { name: /^Todos los horarios/ });
    await panel.waitFor();

    /* Straight after the click, with the entrance cascade only just settled:
       the panel has to be the topmost thing at every height it covers, not only
       where a gap between cards lets it through. */
    const surface = await page.evaluate(() => {
      const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label^="Todos los horarios"]');
      if (!dialog) return null;

      const rect = dialog.getBoundingClientRect();
      const row = dialog.parentElement as HTMLElement;
      const cardsBelow = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='result-card']"))
        .filter((card) => !row.contains(card) && card.getBoundingClientRect().top < rect.bottom)
        .length;
      const x = rect.x + rect.width / 2;
      const probes = [0.06, 0.2, 0.35, 0.5, 0.65, 0.8, 0.94].map((fraction) => {
        const y = rect.y + rect.height * fraction;
        const top = document.elementFromPoint(x, y);
        return {
          fraction,
          inside: Boolean(top?.closest('[role="dialog"][aria-label^="Todos los horarios"]')),
          topmost: top?.className || top?.tagName || "?",
        };
      });

      return {
        cardsBelow,
        probes,
        rowZIndex: getComputedStyle(row).zIndex,
        rowTransform: getComputedStyle(row).transform,
      };
    });

    assert.ok(surface, "the panel did not open");
    // The rig is only a rig if cards really do overlap the open panel.
    assert.ok(surface.cardsBelow >= 4, JSON.stringify(surface));
    assert.deepEqual(
      surface.probes.filter((probe) => !probe.inside),
      [],
      JSON.stringify(surface, null, 2),
    );
    // The row wins on z-index while it is open …
    assert.equal(surface.rowZIndex, "30", JSON.stringify(surface));
    // … and the finished cascade left no transform behind to trap the panel in.
    assert.equal(surface.rowTransform, "none", JSON.stringify(surface));

    /* The list tiles: a schedule is 240px of lanes plus its stops label, and
       the panel is as wide as the card, so on this desk the rows sit in more
       than one column instead of one per line. */
    const columns = await panel.evaluate((node) => {
      const rows = Array.from(node.querySelectorAll<HTMLElement>(".fd-schedule-row"));
      const tops = new Set(rows.map((row) => Math.round(row.getBoundingClientRect().top)));
      return { rows: rows.length, lines: tops.size };
    });
    /* Ten, not the nine on the strip: «+n» counts the schedules the card is
       not showing, and this list draws every schedule in the group including
       the one it is. */
    assert.equal(columns.rows, 10, JSON.stringify(columns));
    assert.ok(columns.lines < columns.rows, JSON.stringify(columns));
    // And no lane repeats the price the card already states.
    assert.equal(await panel.getByText(/mismo precio/).count(), 0);

    // And the click lands: choosing a schedule repaints the card underneath it.
    const chosen = panel.locator(".fd-schedule-row").nth(4);
    const chosenTime = (await chosen.innerText()).match(/\d{2}:\d{2}/)?.[0];
    await chosen.click();
    await panel.waitFor({ state: "detached" });

    const groupedCard = page.getByTestId("result-card").first();
    assert.match(await groupedCard.getAttribute("class") ?? "", /is-schedule-changed/);
    assert.match(await groupedCard.locator(".fd-card__legs").innerText(), new RegExp(chosenTime ?? "never"));
  }, { autoOpen: false });
});

/*
 * A leg that stops once in Bogotá, so the stops lane has an airport code to
 * lose. Measured against the loaded face: «1 escala · BOG» is 75px at the
 * desk's 11px, «1 esc · BOG» is 60 there and 54 at the stacked card's 10px.
 */
function oneStopOffer(index: number, overrides: Partial<CanonicalOffer> = {}) {
  return buildOffer({
    id: `stops-${index}`,
    destination: "MAD",
    comparisonMetrics: { totalDurationMinutes: 1390, totalStops: 2, baggageScore: 2, purchasePathScore: 1 },
    itineraries: [
      {
        id: `stops-${index}-outbound`,
        direction: "outbound",
        durationMinutes: 700,
        stops: 1,
        layoverMinutes: [120],
        segments: [
          { id: `stops-${index}-o1`, flightNumber: "LA 123", marketingCarrier: "LA", origin: "LIM", destination: "BOG", departureAt: "2026-05-28T08:00:00Z", arrivalAt: "2026-05-28T11:00:00Z", durationMinutes: 180 },
          { id: `stops-${index}-o2`, flightNumber: "LA 900", marketingCarrier: "LA", origin: "BOG", destination: "MAD", departureAt: "2026-05-28T13:00:00Z", arrivalAt: "2026-05-28T22:40:00Z", durationMinutes: 400 },
        ],
      },
      {
        id: `stops-${index}-inbound`,
        direction: "inbound",
        durationMinutes: 690,
        stops: 1,
        layoverMinutes: [110],
        segments: [
          { id: `stops-${index}-i1`, flightNumber: "LA 901", marketingCarrier: "LA", origin: "MAD", destination: "BOG", departureAt: `2026-06-04T${String(6 + (index % 12)).padStart(2, "0")}:10:00Z`, arrivalAt: `2026-06-04T${String(12 + (index % 8)).padStart(2, "0")}:20:00Z`, durationMinutes: 400 },
          { id: `stops-${index}-i2`, flightNumber: "LA 124", marketingCarrier: "LA", origin: "BOG", destination: "LIM", departureAt: "2026-06-04T20:00:00Z", arrivalAt: "2026-06-04T23:05:00Z", durationMinutes: 185 },
        ],
      },
    ],
    ...overrides,
  });
}

const RESULTS_SEARCH_URL = "/?mode=exact&trip=round-trip&origin=LIM&destination=MAD&departure=2026-05-28&return=2026-06-04&adults=1&children=0&infants=0&sort=cheapest";

/* One link per mode, because a tab that recognises its own address bar fills
   the form and waits instead of running the search again — so a case that
   sweeps four modes has to arrive somewhere new each time. Only the return date
   moves; nothing in the row is drawn from it. */
function searchUrlForMode(searchMode: string): string {
  const day = { exact: "04", "stay-range": "05", "roundtrip-grid": "06", "month-view": "07" }[searchMode] ?? "04";
  return RESULTS_SEARCH_URL.replace("return=2026-06-04", `return=2026-06-${day}`);
}

async function routeCompletedSearch(
  page: Page,
  /* `searchMode` overrides the one the request carries. What reads it is the
     list — it stamps `data-mode` for the stylesheet — so a case about the row's
     geometry under each mode drives it here rather than through the six fields
     of the form that produce it. `flexible.playwright.ts` covers the request
     path itself. */
  body: { offers: CanonicalOffer[]; scheduleGroups?: unknown[]; searchMode?: string },
): Promise<void> {
  await page.route("**/api/locations**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ suggestions: [] }) });
  });
  await page.route("**/api/search", async (route) => {
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    const request = body.searchMode
      ? { ...(payload.request as Record<string, unknown>), searchMode: body.searchMode }
      : payload.request;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        searchJobId: "geometry-search",
        searchComplete: true,
        searchStatus: "completed",
        revision: 1,
        sortMode: payload.sortMode,
        request,
        offers: body.offers,
        allOffers: body.offers,
        scheduleGroups: body.scheduleGroups ?? [],
        searchMeta: {
          requestedAt: "2026-05-04T15:21:48.419Z",
          completedAt: "2026-05-04T15:21:48.419Z",
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
}

/** A search whose POST never answers: the column belongs to the skeleton. */
async function routeUnansweredSearch(page: Page): Promise<void> {
  await page.route("**/api/locations**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ suggestions: [] }) });
  });
  await page.route("**/api/search", () => {});
}

/**
 * A search that answers, but not instantly.
 *
 * An instantly-fulfilled route is a test that never sees the skeleton phase or
 * the handover into results, which is where both halves of the column's
 * measurement actually live — and is why the first version of these cases
 * passed against a build that painted four bones in a column of eleven.
 */
async function routeDelayedSearch(
  page: Page,
  body: { offers: CanonicalOffer[]; scheduleGroups?: unknown[] },
  delayMs = 2_500,
): Promise<void> {
  await page.route("**/api/locations**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ suggestions: [] }) });
  });
  await page.route("**/api/search", async (route) => {
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        searchJobId: "delayed-search",
        searchComplete: true,
        searchStatus: "completed",
        revision: 1,
        sortMode: payload.sortMode,
        request: payload.request,
        offers: body.offers,
        allOffers: body.offers,
        scheduleGroups: body.scheduleGroups ?? [],
        searchMeta: {
          requestedAt: "2026-05-04T15:21:48.419Z",
          completedAt: "2026-05-04T15:21:48.419Z",
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
}

/**
 * Every distinct `bones/cards` pair the list actually paints, in order.
 *
 * Sampling settled state is what let a fallback of four survive review: it is
 * gone a frame later, so a test that waits cannot see it, and a person watching
 * a real search sees it every time. This records the frames themselves, and the
 * assertions read the sequence rather than its last entry.
 */
async function recordListFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const trace: string[] = [];
    (window as unknown as { __listFrames: string[] }).__listFrames = trace;
    const tick = () => {
      const bones = document.querySelectorAll(".fd-card--skeleton").length;
      const cards = document.querySelectorAll("[data-testid='result-card']").length;
      const entry = `${bones}/${cards}`;
      if (trace[trace.length - 1] !== entry) trace.push(entry);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function readListFrames(page: Page): Promise<Array<{ bones: number; cards: number }>> {
  const trace = await page.evaluate(() => (window as unknown as { __listFrames: string[] }).__listFrames ?? []);
  return trace.map((entry) => {
    const [bones, cards] = entry.split("/").map(Number);
    return { bones: bones ?? 0, cards: cards ?? 0 };
  });
}

/** What the column holds, in plain rows, from the box the list is drawn in. */
async function measureColumn(page: Page): Promise<{
  viewportHeight: number;
  cards: number;
  hasMore: boolean;
  row: number;
  fits: number;
  blank: number;
}> {
  const measured = await page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>(".fd-list-viewport");
    const list = document.querySelector<HTMLElement>(".fd-results-list");
    /* Scoped to the list, not to the document. The column header wears
       `.fd-card` too — that is how it takes the row's lanes without restating
       them — and it stands outside the scroller, so a document-wide query made
       a 26px header the unit the whole column was counted in. */
    const rows = list ? Array.from(list.querySelectorAll<HTMLElement>(".fd-card")) : [];
    const plain = rows.filter((row) => !row.querySelector(".fd-card__alts"));
    const last = rows[rows.length - 1];
    if (!viewport || !list || !last || plain.length === 0) return null;
    /* The list has no gap any more: rows are separated by their own hairline.
       `rowGap` computes to `normal` when nothing declares one, and
       `parseFloat("normal")` is NaN — which propagated into `row` and `fits`
       and turned every column assertion into a comparison against NaN. */
    const declaredGap = Number.parseFloat(getComputedStyle(list).rowGap);
    const gap = Number.isFinite(declaredGap) ? declaredGap : 0;
    const row = plain[0].getBoundingClientRect().height + gap;
    /* The same 4px top inset the capacity hook budgets — blank has to be
       measured against the space a row could actually take, or a column whose
       leftover lands between `available` and `clientHeight` reads as a missing
       row that never had room. */
    const available = viewport.clientHeight - 4;
    return {
      viewportHeight: viewport.clientHeight,
      /* In the payload because every assertion below is about the relationship
         between them, and «blank: 117» on its own says nothing about whether
         the column was short or the fixture was. */
      cards: rows.length,
      hasMore: Boolean(document.querySelector("[data-testid='results-more-sentinel']")),
      row,
      fits: Math.floor((available + gap) / row),
      blank: Math.round(available - (last.getBoundingClientRect().bottom - list.getBoundingClientRect().top)),
    };
  });
  assert.ok(measured, "missing column metrics");
  return measured;
}

test("a fare the provider said nothing about keeps the card's lanes", async () => {
  /*
   * «A veces pierde su distribución», reported with a screenshot of one row
   * whose price and provider sat a lane to the left of every other row's.
   *
   * The baggage lane was `auto` and the pair was hung on the *label*, which
   * names only what a fare includes. So a fare that includes neither — or that
   * the provider says nothing about — rendered no pair at all, the lane
   * collapsed, and auto-placement walked the price into the baggage lane and
   * the provider into the price's. It also broke `list - legs === 428` for
   * exactly those fares, silently, because every fixture until this one had
   * baggage.
   *
   * Three fares, three answers from the provider, one geometry.
   */
  await withDesktopPage(async ({ baseUrl, page }) => {
    await routeCompletedSearch(page, {
      offers: [
        oneStopOffer(0, { id: "bags-both" }),
        oneStopOffer(1, {
          id: "bags-neither",
          baggage: { carryOnIncluded: false, checkedIncluded: false },
        }),
        oneStopOffer(2, { id: "bags-unknown", baggage: undefined }),
      ],
    });
    await page.setViewportSize({ width: 1920, height: 1000 });
    await openSharedSearchLink(page, `${baseUrl}${RESULTS_SEARCH_URL}`);
    await page.getByTestId("result-card").first().waitFor();

    const rows = await page.evaluate(() => {
      const list = document.querySelector<HTMLElement>(".fd-list");
      const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='result-card']"));
      return {
        listWidth: list?.clientWidth ?? 0,
        cards: cards.map((card) => {
          const at = (selector: string) => {
            const node = card.querySelector<HTMLElement>(selector);
            return node ? Math.round(node.getBoundingClientRect().left) : null;
          };
          const legs = card.querySelector<HTMLElement>(".fd-card__legs");
          return {
            columns: getComputedStyle(card).gridTemplateColumns,
            legsWidth: Math.round(legs?.getBoundingClientRect().width ?? 0),
            priceLeft: at(".fd-card__price"),
            providerLeft: at(".fd-card__provider"),
            baggage: Boolean(card.querySelector(".fd-card__baggage")),
          };
        }),
      };
    });

    const at = JSON.stringify(rows);
    assert.equal(rows.cards.length, 3, at);
    // The pair is drawn on evidence, not on inclusion: only the fare nobody
    // described goes without it.
    assert.deepEqual(rows.cards.map((card) => card.baggage), [true, true, false], at);

    /* And whatever the answer, the row is the same row: same tracks, same
       result cell, and the price and the provider in the same lanes.

       28 where the card drew 32, and the fixed measure 428 where the card's was
       436: the lanes still sum to 348 — the logo gave four pixels to the
       baggage, which has a column name to carry now — and the eight that came
       off are the card's own 13px padding and 1px border, which a row with one
       hairline under it and 10px of padding no longer spends. */
    for (const card of rows.cards) {
      assert.match(card.columns, /^28px 142px /, at);
      assert.equal(rows.listWidth - card.legsWidth, 428, at);
      assert.equal(card.priceLeft, rows.cards[0].priceLeft, at);
      assert.equal(card.providerLeft, rows.cards[0].providerLeft, at);
    }
  }, { autoOpen: false });
});

test("the card keeps a lane for the airport codes at every width a desk can be", async () => {
  /*
   * «Cada resultado colapsa el ancho», reported from a laptop. Measured, three
   * thresholds were wrong about the same thing — how much room a leg row needs
   * before its stops lane stops existing:
   *
   *   · the detail column took 326px out of a list that had 748 at 1366, so
   *     every result on the commonest laptop width wore the phone anatomy
   *     inside a three-column desk. The list was in fact *wider* one pixel
   *     below 1100 (807) than one pixel above it (482): widening the window
   *     collapsed the cards;
   *   · the stacking threshold still read 750, an arithmetic that predates the
   *     baggage taking a track of its own — 44px off the legs track — and that
   *     used the duration lane's 50 as a stand-in for the 75 the one-stop label
   *     actually measures;
   *   · the side-by-side leg row engaged at 980, where its own fixed lanes do
   *     not fit: the two stops lanes resolved to zero and the row overflowed
   *     the legs track by up to 47px, painting over the price.
   *
   * One rule settles all three, and this case is that rule: whatever
   * disposition a width lands in, the stops lane holds the label that
   * disposition draws.
   *
   * The third of those dispositions is gone — the side-by-side pair went with
   * the card frame, because a table row with an elastic lane has no empty half
   * to fill — so there are two left and the rule is unchanged. The threshold
   * moved to 787, which is the same sum with the row's numbers: 428 of fixed
   * measure, 284 of fixed leg lanes (56 + 126 + 66 and three 12px gaps) and the
   * 75 of «1 escala · BOG». And the width the detail column leaves at moved
   * with it, from 1437 to 1440, so this sweep walks 1441/1440/1439 instead.
   */
  await withDesktopPage(async ({ baseUrl, page }) => {
    await routeCompletedSearch(page, { offers: Array.from({ length: 14 }, (_, index) => oneStopOffer(index)) });
    await page.setViewportSize({ width: 1920, height: 1000 });
    await openSharedSearchLink(page, `${baseUrl}${RESULTS_SEARCH_URL}`);
    await page.getByTestId("result-card").first().waitFor();

    const measure = () => page.evaluate(() => {
      const card = document.querySelector<HTMLElement>("[data-testid='result-card']");
      const list = document.querySelector<HTMLElement>(".fd-list");
      const legs = card?.querySelector<HTMLElement>(".fd-card__legs");
      const stops = card?.querySelector<HTMLElement>(".fd-card__leg-stops");
      /* The chevron used to be the tell, and it no longer exists: it was
         decorative, `aria-hidden`, and its 14px lane was 24 of the 310 a 360px
         phone has to spend. The provider mark answers the same question from
         the other side — the desk draws it, the stacked row does not. */
      const provider = card?.querySelector<HTMLElement>(".fd-card__provider");
      if (!card || !list || !legs || !stops || !provider) return null;
      const shown = Array.from(stops.children)
        .find((child) => getComputedStyle(child as HTMLElement).display !== "none") as HTMLElement | undefined;
      return {
        listWidth: list.clientWidth,
        stacked: getComputedStyle(provider).display === "none",
        legsOverflow: legs.scrollWidth - legs.clientWidth,
        laneWidth: stops.getBoundingClientRect().width,
        labelWidth: shown?.getBoundingClientRect().width ?? 0,
        label: (shown?.textContent ?? "").trim(),
      };
    });

    for (const width of [1920, 1745, 1700, 1600, 1500, 1441, 1440, 1439, 1366, 1280, 1111, 1024, 900]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForTimeout(320);
      const layout = await measure();
      assert.ok(layout, `missing card metrics at ${width}`);
      const at = `${width}: ${JSON.stringify(layout)}`;

      // The airport code has a box, at every width and in every disposition.
      assert.match(layout.label, /BOG/, at);
      assert.ok(layout.laneWidth + 0.5 >= layout.labelWidth, at);
      // And the row it lives in never spills over the columns beside it.
      assert.ok(layout.legsOverflow <= 0, at);
      // The disposition answers the list, and the list alone (02 §2).
      assert.equal(layout.stacked, layout.listWidth < 787, at);
    }

    // The headline: a 1366 laptop is a desk, and its list is not 748 any more.
    await page.setViewportSize({ width: 1366, height: 1000 });
    await page.waitForTimeout(320);
    const laptop = await measure();
    assert.ok(laptop && !laptop.stacked && laptop.listWidth >= 787, JSON.stringify(laptop));
  }, { autoOpen: false });
});

test("the stops label keeps its airport code in every mode, on the narrowest phone", async () => {
  /*
   * The defect this closes was not a width, it was that a width could move
   * without anything saying so.
   *
   * §5's rule — the disposition in force must fit its own one-stop stops label
   * — is pinned by «the card keeps a lane for the airport codes», and that case
   * sweeps thirteen desk widths in the one mode the app opens on. The stacked
   * row's rótulo, though, is *narrower in Exacto than anywhere else*: there the
   * search bar above the list already states both dates, so the leg drops its
   * own copy and the lane falls from 56 to 22. Flexible and Migratorio vary the
   * dates per offer — the date is what those modes are for — so there the lane
   * is 56, and the 34px difference comes straight out of the elastic lane the
   * airport code lives in.
   *
   * So the geometry was a function of the mode, no case ran in the wide one,
   * and a change that fitted the code at 360 in Exacto shipped it broken from
   * 388 down in Flexible — iPhone SE, 6, 7 and 8. What buys it back is the
   * baggage pair staying on the carrier line instead of taking a fifth lane of
   * the legs block; the rule is that **no mode may ask for more phone than
   * another**, and 360 is the number, because that is the common Android.
   *
   * Three modes and four `searchMode`s: Flexible sends two of them, and
   * Migratorio sends a fourth that draws the month grid instead of rows — so no
   * row can ever carry it, which the last block here asserts rather than
   * assumes. Migratorio reaches a row only through the month it opens, and that
   * is an ordinary search covered by the sweep above it.
   */
  await withDesktopPage(async ({ baseUrl, page }) => {
    for (const [searchMode, datedRotulo] of [
      ["exact", false],
      ["stay-range", true],
      ["roundtrip-grid", true],
    ] as const) {
      await routeCompletedSearch(page, {
        offers: Array.from({ length: 6 }, (_, index) => oneStopOffer(index)),
        searchMode,
      });
      /* A link the tab has already written is a link the tab does not run
         again, so each mode arrives on a return date of its own. Once is
         enough: the widths below are a resize, which is what a rotation is. */
      await page.setViewportSize({ width: 360, height: 800 });
      await openSharedSearchLink(page, `${baseUrl}${searchUrlForMode(searchMode)}`);
      await page.getByTestId("result-card").first().waitFor();

      /* 360 is the floor and 375 is the phone the previous arithmetic broke
         first; 390 is the QA viewport, so a regression that only shows up on
         the narrow two is still visible beside a width that passes. */
      for (const width of [360, 375, 390]) {
        await page.setViewportSize({ width, height: 800 });
        await page.waitForTimeout(320);

        const row = await page.evaluate(() => {
          const card = document.querySelector<HTMLElement>("[data-testid='result-card']");
          const list = document.querySelector<HTMLElement>(".fd-results-list");
          const legs = card?.querySelector<HTMLElement>(".fd-card__legs");
          const stops = card?.querySelector<HTMLElement>(".fd-card__leg-stops");
          const label = card?.querySelector<HTMLElement>(".fd-card__leg-label");
          const date = card?.querySelector<HTMLElement>(".fd-card__leg-date");
          const provider = card?.querySelector<HTMLElement>(".fd-card__provider");
          if (!card || !list || !legs || !stops || !label || !provider) return null;
          const shown = Array.from(stops.children)
            .find((child) => getComputedStyle(child as HTMLElement).display !== "none") as HTMLElement | undefined;
          return {
            mode: list.dataset.mode ?? "",
            stacked: getComputedStyle(provider).display === "none",
            legsOverflow: legs.scrollWidth - legs.clientWidth,
            laneWidth: stops.getBoundingClientRect().width,
            labelWidth: shown?.getBoundingClientRect().width ?? 0,
            laneClips: stops.scrollWidth > stops.clientWidth,
            label: (shown?.textContent ?? "").trim(),
            rotuloClips: label.scrollWidth > label.clientWidth,
            dateShown: Boolean(date) && getComputedStyle(date as HTMLElement).display !== "none",
            dateText: (date?.textContent ?? "").trim(),
          };
        });

        assert.ok(row, `missing row metrics at ${width} in ${searchMode}`);
        const at = `${searchMode} @ ${width}: ${JSON.stringify(row)}`;

        assert.equal(row.mode, searchMode, at);
        assert.equal(row.stacked, true, at);
        // The whole of it: the airport code has a box, in every mode, at 360.
        assert.match(row.label, /BOG/, at);
        /* And in Exacto it is not abbreviated either: the rótulo gives up its
           date there, so the lane holds 96 against the 74 the widest one-stop
           label measures — which is the wording `Movil.dc.html` draws. The
           abbreviation is what Flexible's 62 buys, not a phone-wide rule. */
        assert.match(row.label, searchMode === "exact" ? /^1 escala · BOG$/ : /^1 esc · BOG$/, at);
        assert.ok(row.laneWidth + 0.5 >= row.labelWidth, at);
        assert.equal(row.laneClips, false, at);
        // And the row it lives in never spills over the lanes beside it.
        assert.ok(row.legsOverflow <= 0, at);
        assert.equal(row.rotuloClips, false, at);
        /* The other half of the rule, or the next fix buys its width by taking
           the date out of Flexible — where the date is the offer. */
        assert.equal(row.dateShown, datedRotulo, at);
        if (datedRotulo) assert.match(row.dateText, /^\d{2}\/\d{2}$/, at);
      }
    }

    /* And the fourth `searchMode` reaches no row at all: it is the sweep, and
       the sweep is a grid of months. Asserted so «every mode» above stays a
       complete statement — if `month-view` ever starts drawing rows, this is
       the line that says the sweep is one short. */
    await routeCompletedSearch(page, {
      offers: Array.from({ length: 6 }, (_, index) => oneStopOffer(index)),
      searchMode: "month-view",
    });
    await page.setViewportSize({ width: 360, height: 800 });
    await openSharedSearchLink(page, `${baseUrl}${searchUrlForMode("month-view")}`);
    /* By the grid and not by the heading: on a phone the list title is not
       drawn at all (02 §5 spends that strip on results). Attached rather than
       visible, because this fixture carries no months — what is being read is
       which branch the mode took, and the branch is the grid's. */
    await page.locator(".fd-month-grid").waitFor({ state: "attached" });
    assert.equal(await page.getByTestId("result-card").count(), 0);
    assert.equal(await page.locator(".fd-results-list").count(), 0);
  }, { autoOpen: false });
});

test("the result cell keeps the whole list minus the row's own 428", async () => {
  /*
   * «No solucionaste el cambio erróneo de ancho de celda de resultado, compara
   * con commits viejos y arréglalo — el correcto es el que tenía en el commit
   * de rediseño.»
   *
   * Only one track of this row is elastic — the legs — so every fixed lane the
   * row gains is taken out of the result cell and out of nothing else. The
   * redesign's card was 32/186/1fr/116/26 with four 12px gaps, a fixed measure
   * of `list - 436`. Giving the baggage its own lane added 32px of track and a
   * fifth gap and charged the whole 44 to the cell: measured against the same
   * builds, the legs track fell from 708 to 662 on a 1920 desk and from 484 to
   * 438 on a 1536 one, and every threshold derived from it rose by the same 44.
   *
   * The lane is now paid for out of «who flies», which had the slack: the
   * widest carrier name this application can draw is «Aerolíneas Argentinas»,
   * measured at 141 against a 142px lane, and it still fits unbroken.
   *
   * 428, not 436, since the recipient stopped being a card. The five fixed
   * lanes are unchanged in sum — 28 + 142 + 36 + 116 + 26 = 348, the logo's
   * four pixels having moved to the baggage lane so it can carry «Eq.» in the
   * column header — and so are the five 12px gaps. What came off is the frame:
   * 13px of padding and a 1px border on each side became 10px of padding and
   * no border, which is 428. The cell is *wider* than it was, by eight pixels,
   * at every width; the two halves are still pinned together here.
   */
  await withDesktopPage(async ({ baseUrl, page }) => {
    await routeCompletedSearch(page, {
      offers: Array.from({ length: 6 }, (_, index) =>
        oneStopOffer(index, { mainCarrier: "AR", validatingCarrier: "AR" })),
    });
    await page.setViewportSize({ width: 1920, height: 1000 });
    await openSharedSearchLink(page, `${baseUrl}${RESULTS_SEARCH_URL}`);
    await page.getByTestId("result-card").first().waitFor();

    for (const [width, height] of [[1920, 1080], [1920, 911], [1536, 864], [1366, 768]]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(320);
      const cell = await page.evaluate(() => {
        const card = document.querySelector<HTMLElement>("[data-testid='result-card']");
        const list = document.querySelector<HTMLElement>(".fd-list");
        const legs = card?.querySelector<HTMLElement>(".fd-card__legs");
        const name = card?.querySelector<HTMLElement>(".fd-card__carrier-name");
        if (!card || !list || !legs || !name) return null;
        return {
          listWidth: list.clientWidth,
          legsWidth: Math.round(legs.getBoundingClientRect().width),
          nameLane: Math.round(name.getBoundingClientRect().width),
          nameNeeds: name.scrollWidth,
          name: (name.textContent ?? "").trim(),
        };
      });
      assert.ok(cell, `missing card metrics at ${width}`);
      const at = `${width}x${height}: ${JSON.stringify(cell)}`;

      /* The row's fixed measure, and the whole point of the change: 428, and
         not the 480 the standalone baggage lane once made of it. */
      assert.equal(cell.listWidth - cell.legsWidth, 428, at);
      /* And the lane that paid for it still says the whole name. */
      assert.equal(cell.name, "Aerolíneas Argentinas", at);
      assert.ok(cell.nameNeeds <= cell.nameLane, at);
    }
  }, { autoOpen: false });
});

test("the skeleton draws as many rows as the column it is standing in will hold", async () => {
  /*
   * «La cantidad de resultados solo llena la mitad del espacio disponible, lo
   * mismo con el skeleton.» The page had been measured against its column for
   * some time; the skeleton had not — it drew a constant seven, capped to six
   * when stacked by a CSS `nth-child`, into a column that holds eleven or more.
   * Both now come from one measurement, so the bones stand where the results
   * will.
   */
  await withDesktopPage(async ({ baseUrl, page }) => {
    /* Answered, but not instantly: the skeleton phase has to be something the
       browser actually paints, and the frames are what this case reads. */
    await routeDelayedSearch(page, { offers: Array.from({ length: 31 }, (_, index) => oneStopOffer(index)) }, 2_500);
    await page.setViewportSize({ width: 1920, height: 911 });
    await openSearchUrlWithoutLaunching(page, `${baseUrl}${RESULTS_SEARCH_URL}`);
    await page.getByRole("combobox", { name: "Origen" }).waitFor();
    await recordListFrames(page);
    await page.getByRole("button", { name: "Buscar" }).click();
    await page.getByTestId("results-loading-skeleton").waitFor();
    await page.waitForFunction(() => document.querySelectorAll(".fd-card--skeleton").length > 1);

    // Read while the search is still out, so this is the skeleton's own column
    // and no results have ever been rendered into it.
    const column = await measureColumn(page);
    const bones = await page.locator(".fd-card--skeleton").count();
    const at = JSON.stringify({ ...column, bones });

    // Seven was the constant. A 911-tall window holds more than that.
    assert.ok(bones > 7, at);
    // And the bones fill the column they are standing in, to the row.
    assert.equal(bones, column.fits, at);
    assert.ok(column.blank >= 0 && column.blank < column.row, at);

    /*
     * The frames, not the settled state. Before the measurement was taken
     * synchronously, the first painted frame was `RESULTS_PAGE_SIZE_FALLBACK`
     * — four bones in a column of eleven — and the correction landed one frame
     * later, so every assertion above passed against it.
     */
    const frames = await readListFrames(page);
    const skeletonFrames = frames.filter((frame) => frame.bones > 0);
    assert.ok(skeletonFrames.length > 0, JSON.stringify(frames));
    for (const frame of skeletonFrames) {
      assert.equal(frame.bones, column.fits, `painted ${frame.bones} bones: ${JSON.stringify(frames)}`);
    }

    /*
     * And the column survives the handover. Both are drawn in the same box now
     * that neither reserves a strip below itself, so the row a bone stands in
     * is the row a card lands in — which is what 04 §7 is about: no value
     * jumping the moment the data arrives.
     *
     * The count is a floor rather than an equality, because the list does not
     * stop where the skeleton did: what the reader sees is the same column of
     * cards, and the batch waiting under the fold is the list already being
     * ready for the scroll that asks for it.
     */
    await page.getByTestId("result-card").first().waitFor({ timeout: 20_000 });
    await page.waitForTimeout(1_200);
    const arrived = await page.getByTestId("result-card").count();
    assert.ok(arrived >= bones, `${bones} bones handed over to ${arrived} cards`);
    const arrivedColumn = await measureColumn(page);
    assert.equal(arrivedColumn.fits, column.fits, JSON.stringify({ column, arrivedColumn }));
    assert.ok(arrivedColumn.blank <= 0, JSON.stringify(arrivedColumn));
  }, { autoOpen: false });
});

test("a tall column is filled by the results, not by the old ceiling of twelve", async () => {
  /*
   * The window the list opens on was capped at 12 when a 1440-tall desk was the
   * tallest thing it had been measured on. A 1920×1080 column fits 13 plain
   * rows, so the cap left a row empty on the reporter's own screen and seven on
   * a 1440-tall one — the same half-filled column, arriving from the other
   * side.
   */
  await withDesktopPage(async ({ baseUrl, page }) => {
    await routeDelayedSearch(page, { offers: Array.from({ length: 40 }, (_, index) => oneStopOffer(index)) }, 2_000);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await openSearchUrlWithoutLaunching(page, `${baseUrl}${RESULTS_SEARCH_URL}`);
    await page.getByRole("combobox", { name: "Origen" }).waitFor();
    await recordListFrames(page);
    await page.getByRole("button", { name: "Buscar" }).click();
    await page.getByTestId("result-card").first().waitFor({ timeout: 20_000 });
    // Let the entry cascade and the first batches finish, so "settled" means
    // settled.
    await page.waitForTimeout(1_200);

    const column = await measureColumn(page);
    const cards = await page.getByTestId("result-card").count();
    const at = JSON.stringify({ ...column, cards });

    assert.ok(cards > 12, at);
    // The column is covered from its first row to its last pixel.
    assert.ok(column.blank <= 0, at);

    /*
     * And it was never smaller on the way in. Re-keying this panel on the
     * arriving `searchJobId` remounts it, which used to reset the column to the
     * fallback for one painted frame: four cards in a column that had already
     * been measured for twelve.
     *
     * A window that grows is the point of this list, so what is asserted is
     * that it only ever grew — and that the first frame carrying cards already
     * carried a column's worth of them.
     */
    const frames = await readListFrames(page);
    const resultFrames = frames.filter((frame) => frame.cards > 0);
    assert.ok(resultFrames.length > 0, JSON.stringify(frames));
    assert.ok(resultFrames[0].cards >= column.fits, `opened on ${resultFrames[0].cards}: ${at}`);
    for (const [index, frame] of resultFrames.entries()) {
      if (index === 0) continue;
      assert.ok(
        frame.cards >= resultFrames[index - 1].cards,
        `list shrank: ${JSON.stringify(frames)}`,
      );
    }
  }, { autoOpen: false });
});

test("a list of hundreds is built a column at a time, and only downwards", async () => {
  /*
   * The reason this list is a window and not a `map` over the offers.
   *
   * A plain LIM–MIA search comes back with 520 offers and a week-long range
   * with 2,500; rendering every card up front is the one thing an infinite list
   * must not do, and it is invisible in a fixture of eighteen — they all fit
   * inside the first window and its slack. 240 is past that by an order of
   * magnitude, so what the column holds and what the DOM holds are two
   * different numbers and this case can read both.
   */
  await withDesktopPage(async ({ baseUrl, page }) => {
    await routeDelayedSearch(page, { offers: Array.from({ length: 240 }, (_, index) => oneStopOffer(index)) }, 800);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSharedSearchLink(page, `${baseUrl}${RESULTS_SEARCH_URL}`);
    await page.getByTestId("result-card").first().waitFor({ timeout: 20_000 });
    await page.waitForTimeout(900);

    const column = await measureColumn(page);
    const opened = await page.getByTestId("result-card").count();
    const at = JSON.stringify({ ...column, opened });

    // A column's worth on screen, a batch of slack under it, and 240 nowhere.
    assert.ok(opened >= column.fits, at);
    assert.ok(opened < 120, at);
    // The count in the header is the whole set, not the part that was built.
    assert.match(await page.locator(".fd-panel-count").innerText(), /^240$/);

    /* Every flick adds to what is there rather than replacing it: the first
       card of the list is still the first card of the list at the bottom of
       three screens of scrolling. */
    const body = page.getByTestId("results-list-body");
    const firstCardBefore = await page.getByTestId("result-card").first().innerText();
    let previous = opened;
    for (let flick = 0; flick < 3; flick += 1) {
      await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await page.waitForTimeout(200);
      const grown = await page.getByTestId("result-card").count();
      assert.ok(grown > previous, `flick ${flick} added nothing: ${grown} of 240`);
      previous = grown;
    }
    assert.ok(previous < 240, `built the whole list in three flicks: ${previous}`);
    assert.equal(await page.getByTestId("result-card").first().innerText(), firstCardBefore);
    assert.equal(await page.getByTestId("results-more-sentinel").count(), 1);
  }, { autoOpen: false });
});

test("a list carrying a group still closes the column it was measured against", async () => {
  /*
   * The rounding that the weight system hides until a group is in the window.
   * Capacity used to be floored to whole plain rows before the weights were
   * applied, so a column of 687 became a budget of 10 — and a group at 1.67
   * plus eight flights is 9.67 of it, with a ninth flight refused at 10.67
   * while 80px of column, more than the 64 it needed, sat empty beneath it.
   * Two roundings each losing under a row, together losing more than one.
   *
   * The fixture is the reported one, less the part of it that was never in the
   * list: a truncated group of ten, a duplicate of one of its members, and
   * fourteen flights. Twenty was the reported number, but `oneStopOffer` draws
   * twenty-four distinct schedules and the group holds ten of them, so twelve
   * of those twenty were the group's own schedules again and the list absorbed
   * them. At 58px rows the eleven items that survived happened to cover the
   * column anyway; at 52 they do not, which is the fixture being short and not
   * the column being unfilled. Fourteen is every schedule the group leaves.
   */
  await withDesktopPage(async ({ baseUrl, page }) => {
    const grouped = Array.from({ length: 10 }, (_, index) => oneStopOffer(index, { id: `grp-${index}` }));
    const plain = Array.from({ length: 14 }, (_, index) => oneStopOffer(index + 10, { id: `plain-${index}` }));
    const duplicate = oneStopOffer(0, { id: "dup-0" });

    await routeDelayedSearch(page, {
      offers: [...grouped, duplicate, ...plain],
      scheduleGroups: [{
        id: "agil-local:FILL",
        providerSource: "agil-local",
        outboundOptions: [{ id: "fill-out", itinerary: grouped[0].itineraries[0] }],
        inboundOptions: grouped.map((offer, index) => ({ id: `fill-in-${index}`, itinerary: offer.itineraries[1] })),
        combinations: grouped.map((offer, index) => ({
          outboundOptionId: "fill-out",
          inboundOptionId: `fill-in-${index}`,
          offerId: offer.id,
        })),
        truncated: true,
      }],
    }, 1_500);

    await page.setViewportSize({ width: 1920, height: 911 });
    await openSharedSearchLink(page, `${baseUrl}${RESULTS_SEARCH_URL}`);
    await page.getByTestId("result-card").first().waitFor({ timeout: 20_000 });
    await page.waitForTimeout(1_200);

    const column = await measureColumn(page);
    const groupCards = await page.locator(".fd-card__alts").count();
    const at = JSON.stringify({ ...column, groupCards });

    // The mix is what makes the measurement meaningful.
    assert.equal(groupCards, 1, at);
    // A card that fits was not withheld.
    assert.ok(column.blank <= 0, at);
  }, { autoOpen: false });
});

test("a search that is merely slow says nothing beyond the skeleton", async () => {
  /*
   * «Esos avisos de demora no deben existir, solo el absoluto de no
   * funcionar.» The skeleton used to grow a line of words at eight seconds and,
   * for a reader who had asked for no movement, hand them the whole column. A
   * real search here takes fifteen to forty seconds and more, so «tarda más de
   * lo habitual» announced the ordinary case as if it were news, and it said it
   * while the search was working normally.
   *
   * The bones stay for as long as the search is alive, in both motion
   * preferences, and the only thing that still takes words is failure — which
   * has its own states and its own cases.
   */
  await withDesktopPage(async ({ baseUrl, page }) => {
    // The eight seconds are the app's own timer, so the clock is faked and the
    // suite does not spend nine real seconds waiting for words to not appear.
    await page.clock.install();
    await routeUnansweredSearch(page);
    await page.setViewportSize({ width: 1440, height: 960 });
    await openSearchUrlWithoutLaunching(page, `${baseUrl}${RESULTS_SEARCH_URL}`);
    await page.getByRole("combobox", { name: "Origen" }).waitFor();
    await page.getByRole("button", { name: "Buscar" }).click();
    await page.getByTestId("results-loading-skeleton").waitFor();

    // Past the eight seconds that used to end the skeleton's silence.
    await page.clock.runFor(9_000);

    assert.equal(await page.getByTestId("results-loading-skeleton").isVisible(), true);
    assert.ok((await page.locator(".fd-card--skeleton").count()) > 1);
    assert.equal(await page.getByTestId("results-still-searching").count(), 0);
    assert.equal(await page.getByText("La búsqueda sigue en curso").count(), 0);
    assert.equal(await page.getByText(/tardando más de lo habitual/).count(), 0);
    assert.equal(await page.locator(".fd-list-empty").count(), 0);
  }, { autoOpen: false });
});

test("the same search under reduced motion still shows bones and no notice", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.clock.install();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await routeUnansweredSearch(page);
    await page.setViewportSize({ width: 1440, height: 960 });
    await openSearchUrlWithoutLaunching(page, `${baseUrl}${RESULTS_SEARCH_URL}`);
    await page.getByRole("combobox", { name: "Origen" }).waitFor();
    await page.getByRole("button", { name: "Buscar" }).click();
    await page.getByTestId("results-loading-skeleton").waitFor();
    await page.clock.runFor(9_000);

    assert.equal(await page.getByTestId("results-loading-skeleton").isVisible(), true);
    assert.equal(await page.getByText(/tardando más de lo habitual/).count(), 0);
    await page.emulateMedia({ reducedMotion: null });
  }, { autoOpen: false });
});

test("an offer whose schedule is already inside a group is not drawn a second time", async () => {
  /*
   * «Uno que ya está en otro grupo se muestra como independiente repitiendo los
   * horarios ya antes mostrados.» Membership was `combinations[].offerId` and
   * nothing else, which leaks two ways — both of them here. The group is
   * `truncated`, so the provider stopped enumerating combinations while its
   * family kept the offers; and one of those offers arrives again under a
   * second id. Neither may appear as a card of its own: the legs it would show
   * are the legs the strip above it already shows.
   *
   * The third offer is the fare edge and must survive: same metal, same times,
   * a different price. That is a second thing to sell, not a repeated schedule,
   * and the list keeps it — on exactly the bar the provider grouped on, since
   * `offer-schedule-groups.ts::groupKeyForOffer` puts two offers in one group
   * only when the currency, the amount and the baggage all match.
   */
  await withDesktopPage(async ({ baseUrl, page }) => {
    const inGroupA = oneStopOffer(0, { id: "grouped-a" });
    const inGroupB = oneStopOffer(1, { id: "grouped-b" });
    // Leak (a): part of the truncated family, absent from `combinations`.
    const familyLeak = oneStopOffer(1, { id: "family-leak" });
    // Leak (b): the same physical flight under a second offer id.
    const idLeak = oneStopOffer(0, { id: "id-leak" });
    // Not a leak: the same flight at a different fare.
    const otherFare = oneStopOffer(0, {
      id: "other-fare",
      price: {
        total: { amount: 421, currencyCode: "USD" },
        base: { amount: 350, currencyCode: "USD" },
        taxes: { amount: 71, currencyCode: "USD" },
      },
    });

    await routeCompletedSearch(page, {
      offers: [inGroupA, inGroupB, familyLeak, idLeak, otherFare],
      scheduleGroups: [{
        id: "agil-local:LEAK",
        providerSource: "agil-local",
        outboundOptions: [{ id: "leak-out", itinerary: inGroupA.itineraries[0] }],
        inboundOptions: [inGroupA, inGroupB].map((offer, index) => ({ id: `leak-in-${index}`, itinerary: offer.itineraries[1] })),
        combinations: [inGroupA, inGroupB].map((offer, index) => ({
          outboundOptionId: "leak-out",
          inboundOptionId: `leak-in-${index}`,
          offerId: offer.id,
        })),
        truncated: true,
      }],
    });

    await page.setViewportSize({ width: 1440, height: 960 });
    await openSharedSearchLink(page, `${baseUrl}${RESULTS_SEARCH_URL}`);
    await page.getByTestId("result-card").first().waitFor();

    const cards = page.getByTestId("result-card");
    // The group, and the differently-priced fare. Nothing else.
    assert.equal(await cards.count(), 2);
    assert.equal(await page.locator(".fd-card__alts").count(), 1);

    const shown = await cards.evaluateAll((nodes) => nodes.map((node) => ({
      price: node.querySelector<HTMLElement>(".fd-card__price-figure")?.innerText.trim() ?? "",
      grouped: Boolean(node.querySelector(".fd-card__alts")),
    })));
    const independent = shown.find((card) => !card.grouped);
    assert.ok(independent, JSON.stringify(shown));
    // The card that survives on its own is the one that differs on price.
    assert.match(independent.price, /421/, JSON.stringify(shown));
  }, { autoOpen: false });
});

/*
 * The order, which is a contract and not a screen preference.
 *
 * The criterion travels in the body of `POST /api/search` and the backend is
 * what sorts (`src/core/ranking.ts::sortOffers`) — but the client sorts the
 * same list again for display (`App.tsx::compareOffersForDisplay`), because
 * what is on screen is a filtered, revalidated, batched version of what
 * arrived. Both surfaces order by the same keys and break ties the same way,
 * so these cases can read the screen and be talking about the contract.
 *
 * The control offers exactly the four criteria the server knows how to serve,
 * a link asking for one of the new ones reaches the list in that order, and
 * pressing one of the four really moves the rows.
 */
test("the order offers the four criteria the backend can serve", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await routeCompletedSearch(page, { offers: [oneStopOffer(1), oneStopOffer(2)] });
    await openSharedSearchLink(page, `${baseUrl}${RESULTS_SEARCH_URL}`);
    await page.getByTestId("result-card").first().waitFor();

    const order = page.getByRole("radiogroup", { name: "Orden de resultados" });
    assert.deepEqual(
      await order.getByRole("radio").evaluateAll((nodes) => nodes.map((node) => ({
        value: node.getAttribute("data-segment"),
        label: node.textContent?.trim() ?? "",
      }))),
      [
        { value: "departure", label: "Horario" },
        { value: "fastest", label: "Duración" },
        { value: "stops", label: "Escalas" },
        { value: "cheapest", label: "Precio" },
      ],
    );

    /* The control is a radiogroup: choosing one of the new options leaves it
       chosen and rewrites the workspace link, which is what lets the same list
       be reopened in the same order. */
    await clickSegment(segment(page, "Ordenar por número de escalas"));
    await page.waitForFunction(() => new URL(location.href).searchParams.get("sort") === "stops");
  }, { autoOpen: false });
});

test("a link that asks for departure order gets the list the backend ordered", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    /* The test server really sorts: it answers with the offers by departure
       time, which is not their order by price. If the client reordered what
       arrives already ordered, this case would see it. */
    const byDeparture = [
      { id: "dep-0600", amount: 900, departureAt: "2026-05-28T06:00:00Z" },
      { id: "dep-0900", amount: 700, departureAt: "2026-05-28T09:00:00Z" },
      { id: "dep-1400", amount: 600, departureAt: "2026-05-28T14:00:00Z" },
      { id: "dep-2000", amount: 500, departureAt: "2026-05-28T20:00:00Z" },
    ];
    let requestedSortMode: unknown;
    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ suggestions: [] }) });
    });
    await page.route("**/api/search", async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      requestedSortMode = payload.sortMode;
      const offers = byDeparture.map((entry) => buildOffer({
        id: entry.id,
        destination: "MAD",
        price: {
          total: { amount: entry.amount, currencyCode: "USD" },
          base: { amount: entry.amount - 90, currencyCode: "USD" },
          taxes: { amount: 90, currencyCode: "USD" },
        },
        comparisonMetrics: { totalDurationMinutes: 1390, totalStops: 0, baggageScore: 2, purchasePathScore: 1 },
        itineraries: [
          {
            id: `${entry.id}-outbound`,
            direction: "outbound",
            durationMinutes: 700,
            stops: 0,
            layoverMinutes: [],
            segments: [{
              id: `${entry.id}-o1`,
              flightNumber: "LA 123",
              marketingCarrier: "LA",
              origin: "LIM",
              destination: "MAD",
              departureAt: entry.departureAt,
              arrivalAt: "2026-05-28T23:40:00Z",
              durationMinutes: 700,
            }],
          },
          /* The return is the same for all four, on purpose: what orders them
             is the first leg, not this one. */
          {
            id: `${entry.id}-inbound`,
            direction: "inbound",
            durationMinutes: 690,
            stops: 0,
            layoverMinutes: [],
            segments: [{
              id: `${entry.id}-i1`,
              flightNumber: "LA 124",
              marketingCarrier: "LA",
              origin: "MAD",
              destination: "LIM",
              departureAt: "2026-06-04T10:00:00Z",
              arrivalAt: "2026-06-04T21:30:00Z",
              durationMinutes: 690,
            }],
          },
        ],
      }));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "departure-order-search",
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
          providerMeta: { exactProvider: "agil-local", coverageMode: "core" },
          warnings: [],
        }),
      });
    });

    await openSharedSearchLink(page, `${baseUrl}${RESULTS_SEARCH_URL.replace("sort=cheapest", "sort=departure")}`);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="result-card"]').length === 4);

    assert.equal(requestedSortMode, "departure");
    assert.equal(await segment(page, "Ordenar por hora de salida").getAttribute("aria-checked"), "true");
    /* By departure time, which here is the exact reverse of price. */
    assert.deepEqual(
      await page.getByTestId("result-card").evaluateAll((nodes) => nodes.map(
        (node) => node.querySelector<HTMLElement>(".fd-card__price-figure")?.innerText.trim() ?? "",
      )),
      ["USD 900.00", "USD 700.00", "USD 600.00", "USD 500.00"],
    );
  }, { autoOpen: false });
});

/*
 * One offer per order, built so the four criteria give four different
 * sequences — which is the only way a case can tell «the list was re-laid» from
 * «the list happened to already be in that order».
 *
 *   price   duration   stops   departure
 *   900     600        1       20:00
 *   700     900        0       06:00
 *   500     750        2       14:00
 *
 * price → 500 700 900 · duration → 900 500 700
 * departure → 700 500 900 · stops → 700 900 500
 */
const SORTABLE_OFFERS = [
  { amount: 900, durationMinutes: 600, stops: 1, departureAt: "2026-05-28T20:00:00Z" },
  { amount: 700, durationMinutes: 900, stops: 0, departureAt: "2026-05-28T06:00:00Z" },
  { amount: 500, durationMinutes: 750, stops: 2, departureAt: "2026-05-28T14:00:00Z" },
];

function sortableOffer(entry: typeof SORTABLE_OFFERS[number]): CanonicalOffer {
  const id = `sortable-${entry.amount}`;
  return buildOffer({
    id,
    destination: "MAD",
    price: {
      total: { amount: entry.amount, currencyCode: "USD" },
      base: { amount: entry.amount - 90, currencyCode: "USD" },
      taxes: { amount: 90, currencyCode: "USD" },
    },
    comparisonMetrics: {
      totalDurationMinutes: entry.durationMinutes,
      totalStops: entry.stops,
      baggageScore: 2,
      purchasePathScore: 1,
    },
    itineraries: [
      {
        id: `${id}-outbound`,
        direction: "outbound",
        durationMinutes: entry.durationMinutes,
        stops: entry.stops,
        layoverMinutes: Array.from({ length: entry.stops }, () => 90),
        segments: [{
          id: `${id}-o1`,
          flightNumber: "LA 123",
          marketingCarrier: "LA",
          origin: "LIM",
          destination: "MAD",
          departureAt: entry.departureAt,
          arrivalAt: "2026-05-29T05:40:00Z",
          durationMinutes: entry.durationMinutes,
        }],
      },
      /* One return for all three, on purpose: the leg that orders them is the
         first one, and a return that moved with it would leave the case unable
         to say which of the two the order read. */
      {
        id: `${id}-inbound`,
        direction: "inbound",
        durationMinutes: 690,
        stops: 0,
        layoverMinutes: [],
        segments: [{
          id: `${id}-i1`,
          flightNumber: "LA 124",
          marketingCarrier: "LA",
          origin: "MAD",
          destination: "LIM",
          departureAt: "2026-06-04T10:00:00Z",
          arrivalAt: "2026-06-04T21:30:00Z",
          durationMinutes: 690,
        }],
      },
    ],
  });
}

/*
 * The server answers in one fixed sequence whatever `sortMode` it is asked for,
 * so anything the list does with the order is the client doing it. That is the
 * half these cases are about: `sortOffers` has unit coverage of its own, and
 * what was broken was `App.tsx::compareOffersForDisplay`, which knew two
 * criteria and returned 0 — no movement at all — for the other two.
 */
async function routeUnsortedSearch(page: Page, seen: { sortModes: unknown[] }): Promise<void> {
  const offers = SORTABLE_OFFERS.map(sortableOffer);
  await page.route("**/api/locations**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ suggestions: [] }) });
  });
  await page.route("**/api/search", async (route) => {
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    seen.sortModes.push(payload.sortMode);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        searchJobId: `unsorted-${seen.sortModes.length}`,
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
        providerMeta: { exactProvider: "agil-local", coverageMode: "core" },
        warnings: [],
      }),
    });
  });
}

function shownPrices(page: Page): Promise<number[]> {
  return page.getByTestId("result-card").evaluateAll((nodes) => nodes.map((node) => Number.parseFloat(
    (node.querySelector<HTMLElement>(".fd-card__price-figure")?.innerText ?? "").replace(/[^\d.]/g, ""),
  )));
}

test("pressing each of the four columns re-lays the list, and not just the radio", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const seen = { sortModes: [] as unknown[] };
    await routeUnsortedSearch(page, seen);
    await openSharedSearchLink(page, `${baseUrl}${RESULTS_SEARCH_URL}`);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="result-card"]').length === 3);

    /* The link asks for price, and price is what the list is in. */
    assert.deepEqual(await shownPrices(page), [500, 700, 900]);

    const expected: Array<[string, number[]]> = [
      ["Ordenar por duración", [900, 500, 700]],
      ["Ordenar por hora de salida", [700, 500, 900]],
      ["Ordenar por número de escalas", [700, 900, 500]],
      ["Ordenar por precio", [500, 700, 900]],
    ];

    for (const [name, order] of expected) {
      await clickSegment(segment(page, name));
      await page.waitForFunction((prices) => {
        const shown = Array.from(document.querySelectorAll('[data-testid="result-card"]')).map((node) => Number.parseFloat(
          (node.querySelector<HTMLElement>(".fd-card__price-figure")?.innerText ?? "").replace(/[^\d.]/g, ""),
        ));
        return shown.length === prices.length && shown.every((value, index) => value === prices[index]);
      }, order).catch(() => undefined);
      assert.deepEqual(await shownPrices(page), order, `«${name}» left the list in the wrong sequence`);
    }

    /* And no order asked the server for a second list: the criterion travels on
       the request of the *next* search, but re-reading the list that is already
       here is the client's job. */
    assert.equal(seen.sortModes.length, 1);
  }, { autoOpen: false });
});

test("the order the agent chose survives the next «Buscar»", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const seen = { sortModes: [] as unknown[] };
    await routeUnsortedSearch(page, seen);
    await openSharedSearchLink(page, `${baseUrl}${RESULTS_SEARCH_URL}`);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="result-card"]').length === 3);

    await clickSegment(segment(page, "Ordenar por número de escalas"));
    assert.deepEqual(await shownPrices(page), [700, 900, 500]);

    /* «Buscar» runs the same search again. It used to reset the order to price
       on the way out — `defaultSortForRequest()` answered `cheapest` and
       nothing else — so the agent got the list back by price, and the header
       said so only once they looked. */
    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="result-card"]').length === 3);

    assert.deepEqual(seen.sortModes, ["cheapest", "stops"]);
    assert.equal(await segment(page, "Ordenar por número de escalas").getAttribute("aria-checked"), "true");
    assert.deepEqual(await shownPrices(page), [700, 900, 500]);
    assert.equal(await page.evaluate(() => new URL(location.href).searchParams.get("sort")), "stops");
  }, { autoOpen: false });
});

/*
 * The header's labels against the lanes they name.
 *
 * Four of the cells are radios now, and the active one draws a 12px arrow
 * beside its label — which changes that cell's width at the moment it is
 * pressed. The lanes are fixed, so «it fits» is arithmetic a case can do: every
 * cell is measured against the track under it and against the cell beside it,
 * in each of the four states.
 *
 * Measured, at the 1440 desk where the list is 824: «Horario» 49.09 in a lane
 * of 126, «Escalas» 49.53 in 112, «Precio» 39.44 in 116 — and «Duración» 56.89
 * in 66, which with the arrow is 71.89 and hangs 5.89 into the 12px gap on its
 * left. That is allowed and the rest of the row is why: the lane cannot grow
 * without moving `RESULT_LEG_FIXED_PX`, and a 1440 desk sits exactly on the 824
 * the detail column asks for.
 */
test("every column header fits the lane it names, arrow included", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await routeCompletedSearch(page, { offers: [oneStopOffer(1), oneStopOffer(2)] });
    await openSharedSearchLink(page, `${baseUrl}${RESULTS_SEARCH_URL}`);
    await page.getByTestId("result-card").first().waitFor();
    await waitForFontsReady(page);

    for (const criterion of ["precio", "duración", "hora de salida", "número de escalas"]) {
      await clickSegment(segment(page, `Ordenar por ${criterion}`));

      const cells = await page.evaluate(() => {
        const head = document.querySelector<HTMLElement>('[data-testid="results-column-head"]')!;
        const legs = head.querySelector<HTMLElement>(".fd-card__legs")!;
        const leg = head.querySelector<HTMLElement>(".fd-card__leg")!;
        const tracksOf = (node: HTMLElement) =>
          getComputedStyle(node).gridTemplateColumns.split(" ").map(Number.parseFloat);
        const headTracks = tracksOf(head);
        const legTracks = tracksOf(legs);

        const read = (node: HTMLElement, tracks: number[], index: number) => ({
          text: (node.textContent ?? "").trim(),
          lane: tracks[index] ?? Number.NaN,
          box: Math.round(node.getBoundingClientRect().width * 100) / 100,
          left: Math.round(node.getBoundingClientRect().left * 100) / 100,
          right: Math.round(node.getBoundingClientRect().right * 100) / 100,
        });

        return [
          ...Array.from(head.children).map((node, index) =>
            node === legs ? null : read(node as HTMLElement, headTracks, index)),
          ...Array.from(leg.children).map((node, index) => read(node as HTMLElement, legTracks, index)),
        ]
          .filter((cell): cell is NonNullable<typeof cell> => Boolean(cell?.text))
          .sort((left, right) => left.left - right.left);
      });

      /* Every gap in this row is 12, so a cell that runs past its track has at
         most that much room before it reaches its neighbour's. */
      for (const cell of cells) {
        assert.ok(
          cell.box <= cell.lane + 12,
          `«${cell.text}» is ${cell.box} wide in a lane of ${cell.lane}, ordering by ${criterion}`,
        );
      }

      for (let index = 1; index < cells.length; index += 1) {
        assert.ok(
          cells[index]!.left >= cells[index - 1]!.right,
          `«${cells[index]!.text}» starts at ${cells[index]!.left} and «${cells[index - 1]!.text}» `
            + `ends at ${cells[index - 1]!.right}, ordering by ${criterion}`,
        );
      }
    }
  }, { autoOpen: false });
});

/*
 * What nothing in this suite asserted, and what let a header that does not
 * head its columns reach production green: that the header's geometry *is* the
 * row's geometry, and that each name starts where the values it names start.
 *
 * The case above only checks a cell against its own declared track, so a header
 * drawn on tracks of its own — or one whose labels float in the middle of the
 * lane — passes it without ever being compared to a row.
 */
test("the column header wears the row's own lanes and starts at the row's own edge", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await routeCompletedSearch(page, { offers: [oneStopOffer(1), oneStopOffer(2)] });
    await openSharedSearchLink(page, `${baseUrl}${RESULTS_SEARCH_URL}`);
    await page.getByTestId("result-card").first().waitFor();
    await waitForFontsReady(page);

    const geometry = await page.evaluate(() => {
      const head = document.querySelector<HTMLElement>('[data-testid="results-column-head"]')!;
      const row = document.querySelector<HTMLElement>('[data-testid="result-card"]')!;
      const read = (node: HTMLElement) => {
        const style = getComputedStyle(node);
        const legs = node.querySelector<HTMLElement>(".fd-card__legs")!;
        return {
          tracks: style.gridTemplateColumns,
          gap: style.columnGap,
          left: Math.round(node.getBoundingClientRect().left * 100) / 100,
          right: Math.round(node.getBoundingClientRect().right * 100) / 100,
          legTracks: getComputedStyle(legs).gridTemplateColumns,
          legGap: getComputedStyle(legs).columnGap,
          legLeft: Math.round(legs.getBoundingClientRect().left * 100) / 100,
        };
      };
      return { head: read(head), row: read(row) };
    });

    assert.equal(geometry.head.tracks, geometry.row.tracks);
    assert.equal(geometry.head.gap, geometry.row.gap);
    assert.equal(geometry.head.legTracks, geometry.row.legTracks);
    assert.equal(geometry.head.legGap, geometry.row.legGap);
    /* Same box, so the same tracks resolve to the same pixels: a header padded
       differently from the rows names lanes that are 8px away from the ones
       drawn. */
    assert.equal(geometry.head.left, geometry.row.left);
    assert.equal(geometry.head.right, geometry.row.right);
    assert.equal(geometry.head.legLeft, geometry.row.legLeft);
  }, { autoOpen: false });
});

test("every column heading begins where the values it names begin", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await routeCompletedSearch(page, { offers: [oneStopOffer(1), oneStopOffer(2)] });
    await openSharedSearchLink(page, `${baseUrl}${RESULTS_SEARCH_URL}`);
    await page.getByTestId("result-card").first().waitFor();
    await waitForFontsReady(page);

    const columns = await page.evaluate(() => {
      const head = document.querySelector<HTMLElement>('[data-testid="results-column-head"]')!;
      const row = document.querySelector<HTMLElement>('[data-testid="result-card"]')!;
      const headLeg = head.querySelector<HTMLElement>(".fd-card__leg")!;
      const rowLeg = row.querySelector<HTMLElement>(".fd-card__leg")!;

      /* The ink, not the box. Every one of these labels is a grid item as wide
         as its lane, so its box tells us nothing about where the word is
         painted — which is the whole of the defect this case exists for. */
      const ink = (node: Element) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        const box = range.getBoundingClientRect();
        return { left: Math.round(box.left * 100) / 100, right: Math.round(box.right * 100) / 100 };
      };

      const pair = (name: string, label: Element, value: Element, edge: "left" | "right") => ({
        name,
        edge,
        label: ink(label)[edge],
        value: ink(value)[edge],
      });

      return [
        pair("Aerolínea", head.children[1]!, row.querySelector(".fd-card__carrier-name")!, "left"),
        pair("Tramo", headLeg.children[0]!, rowLeg.querySelector(".fd-card__leg-label")!, "left"),
        pair("Horario", headLeg.children[1]!, rowLeg.querySelector(".fd-card__leg-schedule")!, "left"),
        pair("Duración", headLeg.children[2]!, rowLeg.querySelector(".fd-card__leg-duration")!, "right"),
        pair("Escalas", headLeg.children[3]!, rowLeg.querySelector(".fd-card__leg-stops")!, "left"),
        pair("Precio", head.querySelector('[data-segment="cheapest"]')!, row.querySelector(".fd-card__price-figure")!, "right"),
      ];
    });

    for (const column of columns) {
      /* A pixel of tolerance and no more: these are the same track, so the only
         thing that may differ between the two edges is the sub-pixel the glyph
         itself starts at. */
      assert.ok(
        Math.abs(column.label - column.value) <= 1,
        `«${column.name}» is painted with its ${column.edge} edge at ${column.label} `
          + `over values whose ${column.edge} edge is ${column.value}`,
      );
    }
  }, { autoOpen: false });
});

test("the row draws the airline and its operator at the rungs the plate gives them", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await routeCompletedSearch(page, {
      offers: [oneStopOffer(1, {
        id: "codeshare-1",
        itineraries: oneStopOffer(1).itineraries.map((leg) => ({
          ...leg,
          segments: leg.segments.map((segment) => ({
            ...segment,
            marketingCarrierName: "Iberia",
            operatingCarrier: "4O",
            operatingCarrierName: "Level",
          })),
        })),
      })],
    });
    await openSharedSearchLink(page, `${baseUrl}${RESULTS_SEARCH_URL}`);
    await page.getByTestId("result-card").first().waitFor();
    await waitForFontsReady(page);

    const type = await page.evaluate(() => {
      const read = (selector: string) => {
        const node = document.querySelector<HTMLElement>(selector);
        if (!node) return null;
        const style = getComputedStyle(node);
        return `${style.fontSize}/${style.fontWeight}`;
      };
      return {
        name: read(".fd-card:not(.fd-card--head) .fd-card__carrier-name"),
        operator: read(".fd-card:not(.fd-card--head) .fd-card__carrier-operator"),
      };
    });

    /* `Main.dc.html` and `Actual.dc.html` both draw 13/600 over 10/600 here.
       The row carried 13/700 over 12/400, which made the airline louder than
       the price it is compared by and the codeshare larger than the row's own
       metadata. */
    assert.equal(type.name, "13px/600");
    assert.equal(type.operator, "10px/600");
  }, { autoOpen: false });
});

test("the second price line states the amount and leaves the currency to the figure above it", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await routeCompletedSearch(page, { offers: [oneStopOffer(1)] });
    await openSharedSearchLink(
      page,
      `${baseUrl}${RESULTS_SEARCH_URL.replace("adults=1", "adults=2")}`,
    );
    await page.getByTestId("result-card").first().waitFor();

    const price = await page.evaluate(() => ({
      figure: document.querySelector<HTMLElement>(".fd-card__price-figure")?.textContent ?? "",
      meta: document.querySelector<HTMLElement>(".fd-card__price-meta")?.textContent ?? "",
      /* And the reader, who has no line above to carry the code, still hears
         it. */
      spoken: document.querySelector<HTMLElement>(".fd-card__hit")?.getAttribute("aria-label") ?? "",
    }));

    assert.match(price.figure, /^USD [\d,]+\.\d\d$/);
    assert.match(price.meta, /^[\d,]+\.\d\d p\/p$/);
    assert.doesNotMatch(price.meta, /USD/);
    assert.match(price.spoken, /USD [\d,]+\.\d\d por persona/);
  }, { autoOpen: false });
});

test("the two baggage marks are the plate's, and the same two on every surface", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await routeCompletedSearch(page, { offers: [oneStopOffer(1)] });
    await openSharedSearchLink(page, `${baseUrl}${RESULTS_SEARCH_URL}`);
    await page.getByTestId("result-card").first().waitFor();
    await page.getByTestId("result-card").first().click();
    await page.locator(".fd-condition-bags").waitFor();

    const marks = await page.evaluate(() => {
      /* The geometry, in the order the glyph declares it: what a mark *is*.
         Two icons of the same size in the same lane say nothing about whether
         they are the right two. */
      const shapeOf = (svg: Element | null | undefined) =>
        svg
          ? Array.from(svg.children)
            .map((node) => node.tagName.toLowerCase() === "rect"
              ? `rect ${node.getAttribute("x")},${node.getAttribute("y")} ${node.getAttribute("width")}x${node.getAttribute("height")} r${node.getAttribute("rx")}`
              : node.getAttribute("d") ?? "")
            .join(" | ")
          : "";
      const rowBags = Array.from(document.querySelectorAll(".fd-card__bag svg"));
      const detailBags = Array.from(document.querySelectorAll(".fd-condition-bags svg"));
      const filterBags = Array.from(document.querySelectorAll('[data-segment="carry"] svg, [data-segment="checked"] svg'));
      return {
        row: rowBags.map(shapeOf),
        detail: detailBags.map(shapeOf),
        filter: filterBags.map(shapeOf),
      };
    });

    /* A soft cabin bag with a hoop handle, and a hold case with a flat one.
       Lucide's `Backpack` and `Luggage` — a rucksack and a wheeled trolley —
       are what these were, and no plate in the set has ever drawn either. */
    const cabin = "M7 8h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z | M9 8V6a3 3 0 0 1 6 0v2";
    const hold = "rect 5,7 14x14 r2 | M9 7V4h6v3";

    assert.deepEqual(marks.row, [cabin, hold]);
    assert.deepEqual(marks.detail, [cabin, hold]);
    assert.deepEqual(marks.filter, [cabin, hold]);
  }, { autoOpen: false });
});

test("the detail states every condition the provider confirmed, on the plate's line", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await routeCompletedSearch(page, {
      offers: [oneStopOffer(1, {
        id: "conditions-1",
        fareMeta: { changeable: true, refundable: false, lastTicketingDate: "2026-05-26" },
      })],
    });
    await openSharedSearchLink(page, `${baseUrl}${RESULTS_SEARCH_URL}`);
    await page.getByTestId("result-card").first().waitFor();
    await page.getByTestId("result-card").first().click();
    await page.locator(".fd-condition-row").first().waitFor();

    const conditions = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('[data-testid="detail-panel-body"]')!;
      const rows = Array.from(panel.querySelectorAll<HTMLElement>(".fd-condition-row"));
      return {
        rows: rows.map((row) => ({
          label: row.querySelector<HTMLElement>(".fd-condition-label")?.textContent ?? "",
          value: row.querySelector<HTMLElement>(".fd-condition-value")?.textContent ?? "",
          height: Math.round(row.getBoundingClientRect().height),
          /* The value block ends where the row ends: both plates set these as a
             label at the left and an answer at the right, and they were a
             ragged left-aligned second column. */
          flushRight: Math.abs(
            row.getBoundingClientRect().right
              - row.querySelector<HTMLElement>(".fd-condition-value")!.getBoundingClientRect().right,
          ) < 1,
        })),
      };
    });

    /* All four, in the plate's order. The panel omits a row the provider said
       nothing about — that stays — but a fare that states its conditions has
       to show them, and nothing here was checking that it did. */
    assert.deepEqual(
      conditions.rows.map((row) => row.label),
      ["Equipaje", "Cambios", "Reembolso", "Emisión"],
    );
    assert.deepEqual(
      conditions.rows.map((row) => row.value),
      ["Mano y bodega", "Permitido", "No permitido", "26 may 2026"],
    );
    for (const row of conditions.rows) {
      assert.equal(row.height, 26, `«${row.label}» is ${row.height} tall`);
      assert.ok(row.flushRight, `«${row.label}» does not end at the row's edge`);
    }
  }, { autoOpen: false });
});

test("the three headings across the desk are one line with one rule", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await routeCompletedSearch(page, { offers: [oneStopOffer(1), oneStopOffer(2)] });
    await openSharedSearchLink(page, `${baseUrl}${RESULTS_SEARCH_URL}`);
    await page.getByTestId("result-card").first().waitFor();
    await page.getByTestId("result-card").first().click();
    await page.locator(".fd-detail-header").waitFor();
    await waitForFontsReady(page);

    const headings = await page.evaluate(() => {
      const read = (selector: string) => {
        const node = document.querySelector<HTMLElement>(selector)!;
        const style = getComputedStyle(node);
        const box = node.getBoundingClientRect();
        return {
          selector,
          top: Math.round(box.top * 100) / 100,
          height: Math.round(box.height * 100) / 100,
          rule: `${style.borderBottomWidth} ${style.borderBottomColor}`,
        };
      };
      const title = document.querySelector<HTMLElement>(".fd-list-title")!;
      const row = document.querySelector<HTMLElement>('[data-testid="result-card"]')!;
      return {
        filters: read(".fd-filter-panel-header"),
        list: read(".fd-list-header"),
        detail: read(".fd-detail-header"),
        titleLeft: Math.round(title.getBoundingClientRect().left * 100) / 100,
        rowContentLeft: Math.round(
          row.querySelector<HTMLElement>(".fd-card__logo")!.getBoundingClientRect().left * 100,
        ) / 100,
      };
    });

    for (const heading of [headings.filters, headings.list, headings.detail]) {
      assert.equal(heading.height, 28, `${heading.selector} is ${heading.height} tall`);
      assert.equal(heading.top, headings.filters.top, `${heading.selector} sits at ${heading.top}`);
      assert.equal(heading.rule, headings.filters.rule, `${heading.selector} draws ${heading.rule}`);
    }
    /* And the middle one names a table, so its title starts over the table's
       first lane rather than at the column's own edge. */
    assert.equal(headings.titleLeft, headings.rowContentLeft);
  }, { autoOpen: false });
});

/*
 * The drawn scrollbar (`ResultsScrollbar`).
 *
 * Three things only a browser can say: that the new sheet really wins — it is
 * unlayered, and in this project a rule in `@layer utilities` can sit inert
 * without warning because the tail of `index.css` is in no layer —, that the
 * thumb measures the real viewport and not a row count, and that dragging it
 * scrolls the list.
 */
async function routeLongCompletedSearch(page: Page, count: number): Promise<void> {
  await routeCompletedSearch(page, {
    offers: Array.from({ length: count }, (_, index) => oneStopOffer(index)),
  });
}

test("the list draws its own scrollbar, and the sheet that draws it wins", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 1440, height: 820 });
    await routeLongCompletedSearch(page, 40);
    await openSharedSearchLink(page, `${baseUrl}${RESULTS_SEARCH_URL}`);
    await page.getByTestId("results-scrollbar-thumb").waitFor();

    const drawn = await page.evaluate(() => {
      const bar = document.querySelector<HTMLElement>('[data-testid="results-scrollbar"]')!;
      const thumb = document.querySelector<HTMLElement>('[data-testid="results-scrollbar-thumb"]')!;
      const viewport = document.querySelector<HTMLElement>('[data-testid="results-list-body"]')!;
      const barStyle = getComputedStyle(bar);
      const thumbStyle = getComputedStyle(thumb);

      return {
        display: barStyle.display,
        /* If these three are not the new sheet's, the sheet is in a layer that
           loses and the bar is being drawn with whatever it inherits. */
        barWidth: barStyle.width,
        thumbWidth: thumbStyle.width,
        thumbRadius: thumbStyle.borderRadius,
        thumbOpaque: thumbStyle.backgroundColor !== "rgba(0, 0, 0, 0)",
        /* The thumb is not animated: it goes where the reader is, not after. */
        transitionProperty: thumbStyle.transitionProperty,
        ariaHidden: bar.getAttribute("aria-hidden"),
        focusable: bar.hasAttribute("tabindex") || thumb.hasAttribute("tabindex"),
        trackHeight: Math.round(bar.getBoundingClientRect().height),
        thumbHeight: Math.round(thumb.getBoundingClientRect().height),
        clientHeight: viewport.clientHeight,
        scrollHeight: viewport.scrollHeight,
        /* Inside the clipped body, never hanging off the edge. */
        withinListBody: bar.getBoundingClientRect().right
          <= (viewport.parentElement as HTMLElement).getBoundingClientRect().right,
        documentOverflows: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        /* The channel. Its `padding-right` is declared in the same unlayered
           sheet and nowhere else, so reading it back at 10 is a second proof
           that the sheet wins — and the bar sitting clear of the row is what
           the channel is *for*: 18px of every row used to be the track's. */
        channel: getComputedStyle(viewport.parentElement as HTMLElement).paddingRight,
        rowRight: document.querySelector<HTMLElement>(".fd-results-list .fd-card")!
          .getBoundingClientRect().right,
        headRight: document.querySelector<HTMLElement>(".fd-card--head")!
          .getBoundingClientRect().right,
        barLeft: bar.getBoundingClientRect().left,
      };
    });

    assert.equal(drawn.display, "block");
    assert.equal(drawn.barWidth, "10px");
    assert.equal(drawn.channel, "10px");
    /* Not one pixel of the row under the bar — and the header still ends where
       the rows do, because the channel is reserved on the body they are both
       in, so the columns stay under the names that title them. */
    assert.ok(
      drawn.barLeft >= drawn.rowRight,
      `the bar starts at ${drawn.barLeft} and the row ends at ${drawn.rowRight}`,
    );
    assert.equal(Math.round(drawn.headRight), Math.round(drawn.rowRight));
    assert.equal(drawn.thumbWidth, "6px");
    assert.equal(drawn.thumbRadius, "4px");
    assert.equal(drawn.thumbOpaque, true);
    assert.equal(drawn.transitionProperty, "background-color");
    assert.equal(drawn.ariaHidden, "true");
    assert.equal(drawn.focusable, false);
    assert.equal(drawn.withinListBody, true);
    assert.equal(drawn.documentOverflows, false);

    /* The proportion comes from the viewport, not from how many cards there
       are: visible height over total height. One point of slack for the
       rounding to whole pixels. */
    assert.equal(drawn.trackHeight, drawn.clientHeight);
    const expected = Math.round(drawn.trackHeight * (drawn.clientHeight / drawn.scrollHeight));
    assert.ok(
      Math.abs(drawn.thumbHeight - expected) <= 1,
      `thumb ${drawn.thumbHeight} against ${expected}: ${JSON.stringify(drawn)}`,
    );
  }, { autoOpen: false });
});

test("dragging the drawn thumb scrolls the list it belongs to", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 1440, height: 820 });
    await routeLongCompletedSearch(page, 40);
    await openSharedSearchLink(page, `${baseUrl}${RESULTS_SEARCH_URL}`);
    const thumb = page.getByTestId("results-scrollbar-thumb");
    await thumb.waitFor();

    const before = await page.getByTestId("results-list-body").evaluate((node) => node.scrollTop);
    assert.equal(before, 0);

    const box = (await thumb.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 120, { steps: 6 });
    await page.mouse.up();

    const after = await page.getByTestId("results-list-body").evaluate((node) => ({
      scrollTop: node.scrollTop,
      maxScroll: node.scrollHeight - node.clientHeight,
      thumbTop: document.querySelector<HTMLElement>('[data-testid="results-scrollbar-thumb"]')
        ?.getBoundingClientRect().top ?? 0,
      trackTop: document.querySelector<HTMLElement>('[data-testid="results-scrollbar"]')
        ?.getBoundingClientRect().top ?? 0,
    }));

    /* It went down, and the thumb went down with it: the bar did not stay put
       while the list moved underneath it. */
    assert.ok(after.scrollTop > 0, JSON.stringify(after));
    assert.ok(after.scrollTop <= after.maxScroll + 1, JSON.stringify(after));
    assert.ok(after.thumbTop > after.trackTop, JSON.stringify(after));
  }, { autoOpen: false });
});

test("a list that fits its column draws no bar at all", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await routeLongCompletedSearch(page, 2);
    await openSharedSearchLink(page, `${baseUrl}${RESULTS_SEARCH_URL}`);
    await page.getByTestId("result-card").first().waitFor();
    await page.waitForFunction(() => {
      const viewport = document.querySelector<HTMLElement>('[data-testid="results-list-body"]');
      return Boolean(viewport) && viewport!.scrollHeight <= viewport!.clientHeight + 1;
    });

    assert.equal(await page.getByTestId("results-scrollbar").count(), 0);
  }, { autoOpen: false });
});

test("on a phone the gesture is the convention and the drawn bar stands down", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await routeLongCompletedSearch(page, 40);
    await openSharedSearchLink(page, `${baseUrl}${RESULTS_SEARCH_URL}`);
    await page.getByTestId("result-card").first().waitFor();
    /* Mounted but off, which is the claim: what hides it is the sheet, not a
       JavaScript branch deciding what a phone is. The measurement lands a frame
       after the content — it is `rAF` — so this waits for the node instead of
       reading one that does not exist yet. */
    await page.getByTestId("results-scrollbar").waitFor({ state: "attached" });

    const phone = await page.evaluate(() => {
      const bar = document.querySelector<HTMLElement>('[data-testid="results-scrollbar"]');
      const viewport = document.querySelector<HTMLElement>('[data-testid="results-list-body"]')!;
      return {
        display: bar ? getComputedStyle(bar).display : "absent",
        scrolls: viewport.scrollHeight > viewport.clientHeight + 1,
        documentOverflows: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      };
    });

    /* The list does scroll; what there is not is a drawn bar competing with
       the edge of the screen. */
    assert.equal(phone.scrolls, true);
    assert.equal(phone.display, "none");
    assert.equal(phone.documentOverflows, false);
  }, { autoOpen: false });
});
