import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page, Route } from "playwright";
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
    const brandStyle = await brandLink.evaluate((link) => {
      const style = getComputedStyle(link);
      return {
        backgroundColor: style.backgroundColor,
        borderStyle: style.borderStyle,
      };
    });
    assert.equal(brandHref, instanceRoot);
    assert.equal(brandStyle.backgroundColor, "rgba(0, 0, 0, 0)");
    assert.equal(brandStyle.borderStyle, "none");
    assert.equal(await page.getByRole("button", { name: "Copiar configuración" }).isDisabled(), false);

    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);
    await page.locator(".fd-workspace-enter").waitFor({ state: "visible" });

    await brandLink.click();
    await page.waitForURL(instanceRoot);
    await page.waitForFunction(() => {
      const origin = document.querySelector<HTMLInputElement>('[aria-label="Origen"]');
      const destination = document.querySelector<HTMLInputElement>('[aria-label="Destino"]');
      return origin?.value === ""
        && destination?.value === ""
        && window.location.search === ""
        && !document.querySelector(".fd-workspace-enter");
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
              direction: "outbound",
              durationMinutes: 760 + index,
              stops: 1,
              segments: [
                {
                  flightNumber: `${carrier} ${100 + index}`,
                  marketingCarrier: carrier,
                  origin: "LIM",
                  destination: "BIO",
                  departureAt: "2026-06-08T17:30:00Z",
                  arrivalAt: "2026-06-09T14:05:00Z",
                },
              ],
            },
            {
              direction: "inbound",
              durationMinutes: 780 + index,
              stops: 1,
              segments: [
                {
                  flightNumber: `${carrier} ${200 + index}`,
                  marketingCarrier: carrier,
                  origin: "BIO",
                  destination: "LIM",
                  departureAt: "2026-06-20T09:15:00Z",
                  arrivalAt: "2026-06-20T19:30:00Z",
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
    await page.getByText("1 aviso").waitFor();
    assert.equal(await page.locator(".fd-alert.fd-alert-warning").count(), 0);
    await page.waitForFunction(() => {
      const body = document.querySelector<HTMLElement>('[data-testid="results-page-body"]');
      const cards = document.querySelectorAll('[data-testid="result-card"]').length;
      return Boolean(body && cards > 0 && cards < 18 && getComputedStyle(body).scrollbarWidth === "none");
    });

    const visibleCards = await page.locator('[data-testid="result-card"]').count();
    const paginationText = await pagination.innerText();
    assert.ok(visibleCards > 0);
    assert.ok(visibleCards < 18);
    assert.match(paginationText, new RegExp(`^1-${visibleCards} de 18`));

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

    await page.getByRole("button", { name: "Página siguiente" }).click();
    const pagedCards = page.locator('[data-testid="result-card"]');
    await pagedCards.filter({ hasText: `P${String(visibleCards + 1).padStart(2, "0")}` }).first().waitFor();
    assert.match(await pagination.innerText(), new RegExp(`^${visibleCards + 1}-\\d+ de 18`));
    assert.equal(await pagedCards.filter({ hasText: "P01" }).count(), 0);

    const firstVisibleCard = pagedCards.first();
    assert.equal(await firstVisibleCard.locator(".fd-result-card__schedule").count(), 2);
    assert.equal(await firstVisibleCard.locator(".fd-result-card__schedules").getAttribute("data-trip-type"), "round-trip");
    assert.match(await firstVisibleCard.locator(".fd-result-card__schedules").innerText(), /Ida/);
    assert.match(await firstVisibleCard.locator(".fd-result-card__schedules").innerText(), /Vuelta/);
    assert.doesNotMatch(await firstVisibleCard.locator(".fd-result-card__route").innerText(), /Vuelta/);
    const scheduleMetrics = await firstVisibleCard.locator(".fd-result-card__schedule-main").evaluateAll(
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

test("grouped result variants align changed values with the primary card columns", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 1180, height: 700 });
    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/search", async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      const groupedOffer = (id: string, returnDeparture: string, returnArrival: string, totalDurationMinutes = 480) => buildOffer({
        id,
        providerSource: "costamar",
        airline: "KLM",
        mainCarrier: "KL",
        validatingCarrier: "KL",
        rawRefs: { recommendationId: "REC-compact:0" },
        comparisonMetrics: {
          totalDurationMinutes,
          totalStops: 1,
        },
        price: {
          total: { amount: 1361.14, currencyCode: "USD" },
          base: { amount: 1120, currencyCode: "USD" },
          taxes: { amount: 241.14, currencyCode: "USD" },
        },
        itineraries: [
          {
            direction: "outbound",
            durationMinutes: 960,
            stops: 1,
            segments: [
              {
                flightNumber: "KL 744",
                marketingCarrier: "KL",
                origin: "LIM",
                destination: "AMS",
                departureAt: "2026-05-28T17:30:00-05:00",
                arrivalAt: "2026-05-30T09:30:00+02:00",
              },
              {
                flightNumber: "KL 1501",
                marketingCarrier: "KL",
                origin: "AMS",
                destination: "MAD",
                departureAt: "2026-05-30T11:00:00+02:00",
                arrivalAt: "2026-05-30T13:30:00+02:00",
              },
            ],
          },
          {
            direction: "inbound",
            durationMinutes: 780,
            stops: 1,
            segments: [
              {
                flightNumber: "KL 1502",
                marketingCarrier: "KL",
                origin: "MAD",
                destination: "AMS",
                departureAt: returnDeparture,
                arrivalAt: returnArrival,
              },
            ],
          },
        ],
      });

      const offers = [
        groupedOffer("late-return", "2026-06-04T20:30:00+02:00", "2026-06-05T15:25:00-05:00"),
        groupedOffer("early-return", "2026-06-04T06:00:00+02:00", "2026-06-04T15:25:00-05:00"),
        groupedOffer("mid-return", "2026-06-04T13:05:00+02:00", "2026-06-05T15:25:00-05:00", 1040),
      ];

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

    const group = page.getByTestId("result-offer-group");
    await group.waitFor();
    assert.equal(await group.getByTestId("result-card").count(), 1);
    assert.equal(await group.getByTestId("result-variant-card").count(), 2);
    assert.equal(await group.locator(".fd-result-group__title").innerText(), "3 horarios");
    assert.doesNotMatch(await group.locator(".fd-result-group__header").innerText(), /al mismo precio/i);

    const variants = group.getByTestId("result-variant-card");
    const variantText = await variants.allInnerTexts();
    assert.match(variantText[0] ?? "", /20:30\s*-\s*15:25\s*\+1/);
    assert.match(variantText[1] ?? "", /13:05\s*-\s*15:25\s*\+1/);
    assert.match(variantText[1] ?? "", /17h 20m/);
    assert.doesNotMatch(variantText.join(" "), /KLM|Costamar|Click and Book|USD|Equipaje|04\/06|Vuelta|Duraci[oó]n|Escalas/);

    const alignment = await group.evaluate((element) => {
      const rectOf = (selector: string) => {
        const node = element.querySelector<HTMLElement>(selector);
        if (!node) throw new Error(`Missing ${selector}`);
        const rect = node.getBoundingClientRect();
        return { left: Math.round(rect.left), width: Math.round(rect.width) };
      };
      const centerDelta = (container: HTMLElement, child: HTMLElement) => {
        const containerRect = container.getBoundingClientRect();
        const childRect = child.getBoundingClientRect();
        return Math.abs(
          (containerRect.left + containerRect.width / 2)
          - (childRect.left + childRect.width / 2),
        );
      };
      const scheduleCenterDeltas = Array.from(
        element.querySelectorAll<HTMLElement>(
          ".fd-result-card .fd-result-card__schedule, .fd-result-variant-card .fd-result-variant-card__schedule:not(.is-empty)",
        ),
      ).map((container) => {
        const child = container.querySelector<HTMLElement>(".fd-result-card__schedule-main");
        if (!child) throw new Error("Missing schedule main");
        return centerDelta(container, child);
      });
      const journeyCenterDeltas = Array.from(
        element.querySelectorAll<HTMLElement>(
          ".fd-result-card .fd-result-card__journey, .fd-result-variant-card .fd-result-variant-card__journey",
        ),
      ).flatMap((container) => {
        return Array.from(
          container.querySelectorAll<HTMLElement>(
            ".fd-result-card__journey-main, .fd-result-card__stops, .fd-result-card__layover",
          ),
        ).map((child) => centerDelta(container, child));
      });

      return {
        primarySchedules: rectOf(".fd-result-card .fd-result-card__schedules"),
        variantSchedules: rectOf(".fd-result-variant-card .fd-result-variant-card__schedules"),
        primaryJourney: rectOf(".fd-result-card .fd-result-card__journey"),
        variantJourney: rectOf(".fd-result-variant-card .fd-result-variant-card__journey"),
        scheduleCenterDeltas,
        journeyCenterDeltas,
      };
    });
    assert.ok(Math.abs(alignment.primarySchedules.left - alignment.variantSchedules.left) <= 1, JSON.stringify(alignment));
    assert.ok(Math.abs(alignment.primaryJourney.left - alignment.variantJourney.left) <= 1, JSON.stringify(alignment));
    assert.ok(alignment.scheduleCenterDeltas.every((delta: number) => delta <= 1), JSON.stringify(alignment));
    assert.ok(alignment.journeyCenterDeltas.every((delta: number) => delta <= 1), JSON.stringify(alignment));

    const baseStyles = await group.evaluate((element) => {
      const primary = element.querySelector<HTMLElement>(".fd-result-card");
      const variant = element.querySelector<HTMLElement>(".fd-result-variant-card");
      if (!primary || !variant) throw new Error("Missing grouped cards");
      return {
        primaryBackgroundImage: getComputedStyle(primary).backgroundImage,
        variantBackgroundImage: getComputedStyle(variant).backgroundImage,
      };
    });
    assert.equal(baseStyles.primaryBackgroundImage, "none");
    assert.equal(baseStyles.variantBackgroundImage, "none");

    await variants.first().click();
    assert.match(await group.getAttribute("class") ?? "", /is-selected/);
    assert.equal(await variants.first().getAttribute("aria-pressed"), "true");
  }, { autoOpen: false });
});

test("normal results wait for saved column layout before drawing cards", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 1180, height: 700 });

    let releaseLayout!: () => void;
    let markLayoutRequested!: () => void;
    const layoutReleased = new Promise<void>((resolve) => {
      releaseLayout = resolve;
    });
    const layoutRequested = new Promise<void>((resolve) => {
      markLayoutRequested = resolve;
    });

    await page.route("**/api/results-layout", async (route) => {
      markLayoutRequested();
      await layoutReleased;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          layout: {
            version: 1,
            savedAt: "2026-05-11T17:18:33.592Z",
            columns: {
              carrier: 117,
              dates: 260,
              duration: 94,
              stops: 145,
              price: 127,
              links: 40,
            },
          },
        }),
      });
    });
    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/search", async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      const offers = [buildOffer({ id: "saved-layout-offer", origin: "LIM", destination: "BIO" })];

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "saved-layout-search",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: payload.sortMode,
          request: payload.request,
          offers,
          allOffers: offers,
          searchMeta: {
            requestedAt: "2026-05-11T17:18:33.592Z",
            completedAt: "2026-05-11T17:18:33.592Z",
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
      layoutRequested,
    ]);

    await page.locator('[data-testid="result-card"]').waitFor({ state: "detached" });
    await page.locator(".fd-skeleton").first().waitFor({ state: "visible" });
    assert.equal(await page.locator('[data-testid="result-card"]').count(), 0);
    const skeletonPadding = await page.getByTestId("results-loading-skeleton").evaluate((element) => {
      const grid = element.firstElementChild as HTMLElement | null;
      if (!grid) throw new Error("Missing skeleton grid");
      const rect = element.getBoundingClientRect();
      const gridRect = grid.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        bottomGap: Math.round(rect.bottom - gridRect.bottom),
        paddingBottom: Math.round(Number.parseFloat(style.paddingBottom)),
      };
    });
    assert.ok(skeletonPadding.bottomGap >= skeletonPadding.paddingBottom - 1, JSON.stringify(skeletonPadding));

    releaseLayout();
    await page.locator('[data-testid="result-card"]').waitFor({ state: "visible" });

    const layout = await page.locator(".fd-results-list").evaluate((list) => {
      const style = getComputedStyle(list);
      return {
        fixed: list.classList.contains("fd-results-list--fixed-layout"),
        carrier: style.getPropertyValue("--fd-results-col-carrier").trim(),
        dates: style.getPropertyValue("--fd-results-col-dates").trim(),
        duration: style.getPropertyValue("--fd-results-col-duration").trim(),
        stops: style.getPropertyValue("--fd-results-col-stops").trim(),
        price: style.getPropertyValue("--fd-results-col-price").trim(),
        links: style.getPropertyValue("--fd-results-col-links").trim(),
      };
    });

    assert.deepEqual(layout, {
      fixed: true,
      carrier: "155fr",
      dates: "345fr",
      duration: "125fr",
      stops: "192fr",
      price: "169fr",
      links: "53fr",
    });
  }, { autoOpen: false });
});

test("layout editor guide renders as the first result card and resizes adjacent columns", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 1180, height: 700 });
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
      const offers = [
        buildOffer({ id: "layout-guide-offer-1", origin: "LIM", destination: "MAD" }),
        buildOffer({ id: "layout-guide-offer-2", origin: "LIM", destination: "MAD" }),
      ];

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "layout-guide-search",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: payload.sortMode,
          request: payload.request,
          offers,
          allOffers: offers,
          searchMeta: {
            requestedAt: "2026-05-11T17:18:33.592Z",
            completedAt: "2026-05-11T17:18:33.592Z",
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

    await page.goto(`${baseUrl}/?layout=editor&mode=exact&trip=round-trip&origin=LIM&destination=MAD&departure=2026-06-08&return=2026-06-20&adults=1&children=0&infants=0&sort=cheapest`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();
    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);

    const guide = page.getByTestId("results-layout-guide");
    await guide.waitFor({ state: "visible" });
    const defaultLayout = await guide.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        carrier: style.getPropertyValue("--fd-results-col-carrier").trim(),
        dates: style.getPropertyValue("--fd-results-col-dates").trim(),
        duration: style.getPropertyValue("--fd-results-col-duration").trim(),
        stops: style.getPropertyValue("--fd-results-col-stops").trim(),
        price: style.getPropertyValue("--fd-results-col-price").trim(),
        links: style.getPropertyValue("--fd-results-col-links").trim(),
      };
    });
    assert.deepEqual(defaultLayout, {
      carrier: "139fr",
      dates: "371fr",
      duration: "205fr",
      stops: "140fr",
      price: "130fr",
      links: "54fr",
    });
    const order = await page.locator(".fd-results-list").evaluate((list) => {
      const children = Array.from(list.children);
      return children.slice(0, 2).map((child) => ({
        guide: child.classList.contains("fd-result-card--layout-guide"),
        result: child.getAttribute("data-testid") === "result-card",
      }));
    });
    assert.deepEqual(order, [
      { guide: true, result: false },
      { guide: false, result: true },
    ]);

    const initialGeometry = await guide.evaluate((element) => {
      const rectOf = (selector: string) => {
        const node = element.querySelector<HTMLElement>(selector);
        if (!node) throw new Error(`Missing ${selector}`);
        const rect = node.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width };
      };
      const columns = Array.from(element.querySelectorAll<HTMLElement>(".fd-results-layout-column"))
        .slice(0, 2)
        .map((column) => {
          const rect = column.getBoundingClientRect();
          return { left: rect.left, right: rect.right, width: rect.width };
        });
      const firstHandle = rectOf(".fd-results-layout-column__handle");
      return {
        columns,
        handleCenter: (firstHandle.left + firstHandle.right) / 2,
        boundaryCenter: (columns[0].right + columns[1].left) / 2,
      };
    });
    assert.ok(Math.abs(initialGeometry.handleCenter - initialGeometry.boundaryCenter) <= 1, JSON.stringify(initialGeometry));

    await guide.locator(".fd-results-layout-column__handle").first().press("ArrowRight");

    const resizedGeometry = await guide.evaluate((element) => {
      return Array.from(element.querySelectorAll<HTMLElement>(".fd-results-layout-column"))
        .slice(0, 2)
        .map((column) => Math.round(column.getBoundingClientRect().width));
    });
    const initialWidths = initialGeometry.columns.map((column) => Math.round(column.width));
    assert.ok(resizedGeometry[0] > initialWidths[0], JSON.stringify({ initialWidths, resizedGeometry }));
    assert.ok(resizedGeometry[1] < initialWidths[1], JSON.stringify({ initialWidths, resizedGeometry }));
    assert.ok(Math.abs((resizedGeometry[0] + resizedGeometry[1]) - (initialWidths[0] + initialWidths[1])) <= 1);
  }, { autoOpen: false });
});

test("grouped provider offer renders Agilsmart and Click and Book Plus external links vertically", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 1180, height: 700 });
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
        id: "grouped-provider-offer",
        providerSource: "agil-local",
        purchasePaths: [
          {
            id: "grouped-agil-path",
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
            id: "grouped-costamar-path",
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
      });

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
          offers: [offer],
          allOffers: [offer],
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

    await page.goto(`${baseUrl}/?mode=exact&trip=round-trip&origin=LIM&destination=MIA&departure=2026-06-08&return=2026-06-20&adults=1&children=0&infants=0&sort=cheapest`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();
    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);

    const card = page.getByTestId("result-card").first();
    await card.waitFor();
    const actions = card.locator(".fd-result-card__provider-action");
    assert.equal(await actions.count(), 2);
    await card.getByRole("button", { name: "Abrir Agilsmart" }).waitFor();
    await card.getByRole("button", { name: "Buscar en Click and Book Plus" }).waitFor();

    const selectAction = card.locator("button[aria-pressed]");
    assert.equal(await selectAction.evaluate((element) => element.tagName), "BUTTON");
    const selectLabel = await selectAction.getAttribute("aria-label") ?? "";
    assert.match(selectLabel, /^Seleccionar oferta/);
    for (const detail of [
      "Ida 15/04",
      "Vuelta 22/04",
      "Directo",
      "Cabina incluida",
      "Bodega incluida",
      "Agilsmart",
      "Click and Book Plus",
    ]) {
      assert.ok(selectLabel.includes(detail), `${detail} missing from ${selectLabel}`);
    }
    assert.equal(await selectAction.getAttribute("title"), selectLabel);
    assert.equal(await selectAction.locator("button").count(), 0);
    assert.equal(await card.evaluate((element) => (
      Array.from(element.querySelectorAll(".fd-result-card__provider-action"))
        .every((action) => !element.querySelector("button[aria-pressed]")?.contains(action))
    )), true);
    assert.equal(await selectAction.getAttribute("aria-pressed"), "false");
    await page.evaluate(() => {
      const state = window as typeof window & { __providerOpen?: { url: string; target?: string; features?: string } };
      state.open = ((url, target, features) => {
        state.__providerOpen = { url: String(url), target, features };
        return null;
      }) as typeof window.open;
    });
    await card.getByRole("button", { name: "Abrir Agilsmart" }).click();
    assert.deepEqual(await page.evaluate(() => (
      window as typeof window & { __providerOpen?: { url: string; target?: string; features?: string } }
    ).__providerOpen), {
      url: "https://example.test/agil",
      target: "_blank",
      features: "noopener,noreferrer",
    });
    assert.equal(await selectAction.getAttribute("aria-pressed"), "false");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await selectAction.evaluate((element) => document.activeElement === element), true);
    const focusOutline = await selectAction.evaluate((element) => {
      const style = getComputedStyle(element);
      return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
    });
    assert.equal(focusOutline.style, "solid");
    assert.ok(focusOutline.width >= 2, JSON.stringify(focusOutline));
    await selectAction.press("Enter");
    assert.equal(await selectAction.getAttribute("aria-pressed"), "true");

    const layout = await actions.evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
      };
    }));
    assert.ok(layout[1].top >= layout[0].bottom, JSON.stringify(layout));
    assert.ok(layout.every((item) => item.width <= 38), JSON.stringify(layout));
  }, { autoOpen: false });
});

test("result cards reserve matching airline and provider logo slots", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 1180, height: 700 });
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
        airline: "LATAM Airlines",
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
            direction: "outbound",
            durationMinutes: 480,
            stops: 0,
            segments: [
              {
                flightNumber: "LA 2478",
                marketingCarrier: "LA",
                marketingCarrierName: "LATAM Airlines",
                origin: "LIM",
                destination: "MAD",
                departureAt: "2026-06-08T09:10:00-05:00",
                arrivalAt: "2026-06-08T17:25:00+02:00",
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
    const airlineLogo = card.locator(".fd-result-card__airline-logo img");
    await airlineLogo.waitFor();
    assert.ok((await airlineLogo.getAttribute("src"))?.endsWith("/assets/airline-icons/LA.png"));

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
        airline: rectOf(".fd-result-card__airline-logo"),
        provider: rectOf(".fd-result-card__provider"),
      };
    });
    assert.ok(Math.abs(geometry.airline.width - geometry.provider.width) <= 2, JSON.stringify(geometry));
    assert.ok(geometry.airline.left < geometry.provider.left, JSON.stringify(geometry));
  }, { autoOpen: false });
});

test("detail panel mirrors selected result content and omits unknown fare conditions", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
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
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          commercialText: [
            "Cotización de prueba",
            ...Array.from({ length: 24 }, (_, index) => `Detalle operativo ${index + 1}`),
          ].join("\n"),
          offer: {},
        }),
      });
    });
    await page.route("**/api/search", async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      const offers = [
        buildOffer({
          id: "detail-panel-offer",
          origin: "LIM",
          destination: "MAD",
          airline: "LATAM Airlines",
          mainCarrier: "LA",
          validatingCarrier: "LA",
          providerSource: "agil-local",
          comparisonMetrics: {
            totalDurationMinutes: 890,
            totalStops: 1,
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
          itineraries: [
            {
              direction: "outbound",
              durationMinutes: 890,
              stops: 1,
              layoverMinutes: [155],
              segments: [
                {
                  flightNumber: "LA 2478",
                  marketingCarrier: "LA",
                  marketingCarrierName: "LATAM Airlines",
                  origin: "LIM",
                  destination: "CDG",
                  destinationName: "París (Todos los aeropuertos)",
                  departureAt: "2026-05-28T09:10:00-05:00",
                  arrivalAt: "2026-05-28T17:25:00+02:00",
                },
                {
                  flightNumber: "LA 806",
                  marketingCarrier: "LA",
                  marketingCarrierName: "LATAM Airlines",
                  origin: "CDG",
                  originName: "París (Todos los aeropuertos)",
                  destination: "MAD",
                  departureAt: "2026-05-28T20:00:00+02:00",
                  arrivalAt: "2026-05-28T23:00:00+02:00",
                },
              ],
            },
          ],
        }),
      ];

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

    const quotationPrefetch = page.waitForResponse("**/api/quotation");
    await page.getByTestId("result-card").click();
    await page.getByRole("heading", { name: "Oferta seleccionada" }).waitFor();
    await quotationPrefetch;

    const selectedText = await page.evaluate(() => {
      const heading = Array.from(document.querySelectorAll("h2"))
        .find((node) => node.textContent?.trim() === "Oferta seleccionada");
      return heading?.closest("section")?.textContent ?? "";
    });
    assert.match(selectedText, /LATAM/);
    assert.match(selectedText, /Horario/);
    assert.match(selectedText, /09:10/);
    assert.match(selectedText, /23:00/);
    assert.match(selectedText, /LIM - CDG - MAD/);
    assert.equal(selectedText.match(/LIM - CDG - MAD/g)?.length, 1);
    assert.equal(selectedText.match(/\bCDG\b/g)?.length, 1);
    assert.match(selectedText, /14h 50m/);
    assert.match(selectedText, /1 escala/);
    assert.doesNotMatch(selectedText, /1 escala · CDG/);
    assert.doesNotMatch(selectedText, /París \(Todos los aeropuertos\)/i);
    assert.match(selectedText, /Cabina/);
    assert.match(selectedText, /Agilsmart/);
    assert.match(selectedText, /USD 812\.35/);
    assert.doesNotMatch(selectedText, /Cambios|Reembolso|Consultar/);

    const routeTypography = await page.getByTestId("offer-detail-info").evaluate((info) => {
      const routeTile = Array.from(info.querySelectorAll<HTMLElement>(".fd-offer-info-tile"))
        .find((tile) => tile.textContent?.includes("Ruta"));
      const value = routeTile?.querySelector<HTMLElement>(".fd-offer-detail-data");
      if (!value) throw new Error("Missing route detail value");
      const style = getComputedStyle(value);
      return {
        className: value.className,
        title: value.getAttribute("title"),
        text: value.textContent?.trim() ?? "",
        overflow: style.overflow,
        textOverflow: style.textOverflow,
        whiteSpace: style.whiteSpace,
      };
    });
    assert.match(routeTypography.className, /fd-offer-detail-data/);
    assert.equal(routeTypography.title, routeTypography.text);
    assert.equal(routeTypography.overflow, "hidden", JSON.stringify(routeTypography));
    assert.equal(routeTypography.textOverflow, "ellipsis", JSON.stringify(routeTypography));
    assert.equal(routeTypography.whiteSpace, "nowrap", JSON.stringify(routeTypography));

    assert.equal(await page.getByTestId("quotation-text").count(), 0);

    await page.getByRole("button", { name: "Cotizar" }).click();
    await page.getByTestId("quotation-text").waitFor();
    const quotedText = await page.evaluate(() => {
      const heading = Array.from(document.querySelectorAll("h2"))
        .find((node) => node.textContent?.trim() === "Oferta seleccionada");
      return heading?.closest("section")?.textContent ?? "";
    });
    assert.match(quotedText, /Cotización/);
    assert.match(quotedText, /Copiado/);
    assert.doesNotMatch(quotedText, /Listo para copiar/);

    await page.waitForFunction(() => (
      (window as unknown as { __flyDeskCopiedText?: string }).__flyDeskCopiedText?.startsWith("Cotización de prueba")
    ));
    const copiedText = await page.evaluate(() => (
      (window as unknown as { __flyDeskCopiedText?: string }).__flyDeskCopiedText
    ));
    assert.match(copiedText ?? "", /Detalle operativo 24/);
    assert.ok(await page.getByRole("button", { name: "Copiado" }).count() >= 1);

    const quotationLayout = await page.getByTestId("quotation-text").evaluate((element) => {
      const body = element.closest<HTMLElement>('[data-testid="detail-panel-body"]');
      if (!body) throw new Error("Missing detail panel body");
      const offerInfo = body.querySelector<HTMLElement>('[data-testid="offer-detail-info"]');
      if (!offerInfo) throw new Error("Missing offer detail info");
      const offerInfoStyle = getComputedStyle(offerInfo);
      return {
        bodyOverflowsHorizontally: body.scrollWidth > body.clientWidth,
        scrollsInside: element.scrollHeight > element.clientHeight,
        offerInfoOverflowY: offerInfoStyle.overflowY,
        offerInfoScrolls: offerInfo.scrollHeight > offerInfo.clientHeight,
      };
    });
    assert.equal(quotationLayout.bodyOverflowsHorizontally, false, JSON.stringify(quotationLayout));
    assert.equal(quotationLayout.scrollsInside, true, JSON.stringify(quotationLayout));
    assert.notEqual(quotationLayout.offerInfoOverflowY, "auto", JSON.stringify(quotationLayout));
    assert.notEqual(quotationLayout.offerInfoOverflowY, "scroll", JSON.stringify(quotationLayout));
    assert.equal(quotationLayout.offerInfoScrolls, false, JSON.stringify(quotationLayout));
  }, { autoOpen: false });
});
