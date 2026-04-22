import test from "node:test";
import assert from "node:assert/strict";
import { type Route } from "playwright";
import {
  buildCarrierOffer,
  buildLayoverOffer,
  buildMatrixResponse,
  buildOffer,
  buildOfferWithDates,
  buildRoundTripLayoverOffer,
  buildSearchMeta,
  buildTwoStopOffer,
} from "./helpers/ui-fixtures";
import { openDesktop, setDateValue, withDesktopPage } from "./helpers/ui";

async function setRouteInputs(page: import("playwright").Page, originCode: string, destinationCode: string): Promise<void> {
  await page.evaluate(([origin, destination]) => {
    const originInput = document.getElementById("origin") as HTMLInputElement | null;
    const destinationInput = document.getElementById("destination") as HTMLInputElement | null;
    if (!originInput || !destinationInput) {
      throw new Error("Missing location inputs");
    }

    originInput.value = String(origin);
    originInput.dataset.code = String(origin);
    originInput.dataset.label = String(origin);
    destinationInput.value = String(destination);
    destinationInput.dataset.code = String(destination);
    destinationInput.dataset.label = String(destination);
  }, [originCode, destinationCode]);
}

async function submitAndWaitForRequest(
  page: import("playwright").Page,
  baseUrl: string,
  endpoint: "/api/search" | "/api/matrix",
): Promise<void> {
  const requestPromise = page.waitForRequest((request) =>
    request.method() === "POST" && request.url() === `${baseUrl}${endpoint}`);
  await page.click("#submitButton");
  await requestPromise;
  await page.waitForFunction(() => {
    const submit = document.getElementById("submitButton") as HTMLButtonElement | null;
    return submit ? submit.disabled === false : false;
  });
}

async function chooseFlexibleSubmode(
  page: import("playwright").Page,
  mode: "exact-stay" | "fixed-ranges",
): Promise<void> {
  await page.click("#dateTrigger");
  await page.waitForSelector(`#calendarFlexModeControl:not(.hidden) [data-flex-submode="${mode}"]`);
  await page.click(`[data-flex-submode="${mode}"]`);
  await page.click("#calendarDone");
}

test("desktop search rail keeps mode first and the rest of the flow in travel order", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
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
  }, { autoOpen: false });
});

test("tab from origin skips the swap button and lands on destination", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
      await openDesktop(page, baseUrl);
      await page.focus("#origin");
      await page.keyboard.press("Tab");

      const activeElement = await page.evaluate(() => ({
        activeId: document.activeElement?.id ?? "",
        swapTabIndex: document.getElementById("swapRouteBtn")?.getAttribute("tabindex") ?? "",
      }));

      assert.equal(activeElement.activeId, "destination");
      assert.equal(activeElement.swapTabIndex, "-1");
  }, { autoOpen: false });
});

test("desktop refinements no longer render removed max stops, currency, max price, or cabin controls", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
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
  }, { autoOpen: false });
});

test("query and offer panels expose homogeneous headers from first paint", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
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
          resultsCountPresent: Boolean(document.getElementById("resultsCountLabel")),
          resultsPanelDisplay: getComputedStyle(resultsPanel).display,
          detailPanelDisplay: getComputedStyle(detailPanel).display,
          paddingLeftMatches: resultsStyle.paddingLeft === detailStyle.paddingLeft,
          paddingRightMatches: resultsStyle.paddingRight === detailStyle.paddingRight,
          borderBottomMatches: resultsStyle.borderBottomWidth === detailStyle.borderBottomWidth,
        };
      });

      assert.equal(probe.resultsTitle, "Consulta");
      assert.equal(probe.detailTitle, "Oferta");
      assert.equal(probe.resultsCountPresent, false);
      assert.equal(probe.resultsMeta, "");
      assert.equal(probe.detailMeta, "");
      assert.equal(probe.resultsPanelDisplay, "flex");
      assert.equal(probe.detailPanelDisplay, "flex");
      assert.equal(probe.paddingLeftMatches, true);
      assert.equal(probe.paddingRightMatches, true);
      assert.equal(probe.borderBottomMatches, true);
  }, { autoOpen: false });
});

test("results panel boots with the shared skeleton before any search", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
      await openDesktop(page, baseUrl);
      const probe = await page.evaluate(() => ({
        skeletonCount: document.querySelectorAll("#resultsContainer .results-skeleton").length,
        emptyStateCount: document.querySelectorAll("#resultsContainer .empty-state").length,
        busy: document.querySelector("#resultsContainer .results-skeleton")?.getAttribute("aria-busy") ?? "",
        title: document.getElementById("resultsPanelTitle")?.textContent?.trim() ?? "",
        skeletonHeaderCount: document.querySelectorAll("#resultsContainer .results-skeleton__header").length,
      }));

      assert.equal(probe.skeletonCount, 1);
      assert.equal(probe.emptyStateCount, 0);
      assert.equal(probe.busy, "false");
      assert.equal(probe.title, "Consulta");
      assert.equal(probe.skeletonHeaderCount, 0);
  }, { autoOpen: false });
});

test("search payload keeps USD fixed without hidden max stops or a currency control", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    let capturedCurrencyCode = "";
    let capturedCabin = "";
    let capturedOriginLabel = "";
    let capturedDestinationLabel = "";
    let capturedMaxStops: unknown = "sent";
    let capturedMaxResults: unknown = undefined;

    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      const body = route.request().postDataJSON();
      capturedCurrencyCode = body?.request?.currencyCode ?? "";
      capturedCabin = body?.request?.cabin ?? "";
      capturedOriginLabel = body?.request?.legs?.[0]?.originLabel ?? "";
      capturedDestinationLabel = body?.request?.legs?.[0]?.destinationLabel ?? "";
      capturedMaxStops = body?.request?.filters?.maxStops;
      capturedMaxResults = body?.request?.filters?.maxResults;
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
      assert.equal(capturedMaxResults, undefined);
      assert.equal(await page.locator("#currencyCode").count(), 0);
  }, { autoOpen: false });
});

test("migration cards show exact date, provider links, and can open an exact search", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    let migrationRequestCount = 0;
    let firstRequestBody: any = null;
    let firstMigrationDate = "";
    let exactRequestBody: any = null;
    const pageErrors: string[] = [];
    const allRequestsCompleted = new Promise<void>((resolve) => {
      page.on("pageerror", (error) => {
        pageErrors.push(error.message);
      });

      page.context().route(`${baseUrl}/api/search`, async (route: Route) => {
        const body = route.request().postDataJSON();
        if (body?.request?.searchMode === "stay-range") {
          migrationRequestCount += 1;
          const departureDate = body?.request?.legs?.[0]?.departureStart ?? "2026-04-15";
          if (!firstRequestBody) {
            firstRequestBody = body;
            firstMigrationDate = departureDate;
          }
          if (migrationRequestCount === 8) {
            resolve();
          }

          const migrationOffer = buildOffer({
            id: `migration-offer-${migrationRequestCount}`,
            origin: "LIM",
            destination: "MIA",
            itineraries: [{
              direction: "outbound",
              durationMinutes: 480,
              stops: 0,
              segments: [{
                flightNumber: "LA 123",
                origin: "LIM",
                destination: "MIA",
                departureAt: `${departureDate}T14:00:00Z`,
                departureDate,
                arrivalAt: `${departureDate}T22:00:00Z`,
                airlineName: "LATAM",
              }],
            }],
            purchasePaths: [
              {
                provider: "agil-local",
                type: "search-redirect",
                label: "Buscar en Agil",
                precision: "exact-search",
                url: `https://example.test/agil/${migrationRequestCount}`,
              },
              {
                provider: "costamar",
                type: "search-redirect",
                label: "Buscar en Costamar",
                precision: "exact-search",
                url: `https://example.test/costamar/${migrationRequestCount}`,
              },
            ],
          });

          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              searchJobId: `migration-job-${migrationRequestCount}`,
              searchComplete: true,
              searchStatus: "completed",
              sortMode: "cheapest",
              request: body.request,
              offers: [migrationOffer],
              allOffers: [migrationOffer],
              searchMeta: {
                ...buildSearchMeta("search_live"),
                providersUsed: ["agil-local", "costamar"],
              },
              providerMeta: {
                exactProvider: "agil-local",
                coverageMode: "core",
              },
              warnings: [],
            }),
          });
          return;
        }

        exactRequestBody = body;
        const exactOffer = buildOffer({
          id: "exact-offer-1",
          origin: "LIM",
          destination: "MIA",
          itineraries: [{
            direction: "outbound",
            durationMinutes: 480,
            stops: 0,
            segments: [{
              flightNumber: "LA 123",
              origin: "LIM",
              destination: "MIA",
              departureAt: `${body?.request?.legs?.[0]?.departureDate ?? firstMigrationDate}T14:00:00Z`,
              arrivalAt: `${body?.request?.legs?.[0]?.departureDate ?? firstMigrationDate}T22:00:00Z`,
              airlineName: "LATAM",
            }],
          }],
          purchasePaths: [
            {
              provider: "agil-local",
              type: "search-redirect",
              label: "Buscar en Agil",
              precision: "exact-search",
              url: "https://example.test/agil/exact",
            },
            {
              provider: "costamar",
              type: "search-redirect",
              label: "Buscar en Costamar",
              precision: "exact-search",
              url: "https://example.test/costamar/exact",
            },
          ],
        });

        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            searchJobId: "exact-job-1",
            searchComplete: true,
            searchStatus: "completed",
            sortMode: "cheapest",
            request: body.request,
            offers: [exactOffer],
            allOffers: [exactOffer],
            searchMeta: {
              ...buildSearchMeta("search_live"),
              providersUsed: ["agil-local", "costamar"],
            },
            providerMeta: {
              exactProvider: "agil-local",
              coverageMode: "core",
            },
            warnings: [],
          }),
        });
      });
    });

    await openDesktop(page, baseUrl);
    await setRouteInputs(page, "LIM", "MIA");

    await page.click("#migrationBtn");
    await allRequestsCompleted;
    await page.waitForFunction(() => {
      return document.querySelectorAll("#resultsContainer .migration-card--ok").length === 8;
    });
    const firstCard = page.locator("#resultsContainer .migration-card").first();
    await firstCard.click({ position: { x: 18, y: 18 } });
    await page.waitForFunction(() => {
      const detail = document.getElementById("detailContent");
      return Boolean(
        detail
        && /Segmentos/.test(detail.textContent || "")
        && /Tarifa/.test(detail.textContent || ""),
      );
    });

    const migrationProbe = await page.evaluate(() => ({
      title: document.querySelector(".migration-panel__title")?.textContent?.trim() ?? "",
      subtitle: document.querySelector(".migration-panel__subtitle")?.textContent?.trim() ?? "",
      cardCount: document.querySelectorAll("#resultsContainer .migration-card").length,
      loadingCount: document.querySelectorAll("#resultsContainer .migration-card--loading").length,
      selectedCount: document.querySelectorAll("#resultsContainer .migration-card--selected").length,
      firstCardText: document.querySelector("#resultsContainer .migration-card")?.textContent?.trim() ?? "",
      detailText: document.querySelector("#detailContent")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      layout: (() => {
        const scroller = document.querySelector(".migration-grid-wrap");
        const grid = document.querySelector(".migration-grid");
        const action = document.querySelector("[data-migration-exact-index]");
        const card = action?.closest(".migration-card");
        if (!(scroller instanceof HTMLElement) || !(grid instanceof HTMLElement)) {
          return null;
        }

        return {
          overflowX: getComputedStyle(scroller).overflowX,
          overflowY: getComputedStyle(scroller).overflowY,
          hasHorizontalOverflow: scroller.scrollWidth > (scroller.clientWidth + 1),
          cardsPerFirstRow: (() => {
            const cards = [...document.querySelectorAll("#resultsContainer .migration-card")];
            if (cards.length === 0) return 0;
            const firstTop = Math.round(cards[0].getBoundingClientRect().top);
            return cards.filter((item) => Math.abs(Math.round(item.getBoundingClientRect().top) - firstTop) <= 1).length;
          })(),
          rowCount: (() => {
            const tops = [...document.querySelectorAll("#resultsContainer .migration-card")]
              .map((item) => Math.round(item.getBoundingClientRect().top));
            return new Set(tops).size;
          })(),
          actionWidth: action instanceof HTMLElement ? Math.round(action.getBoundingClientRect().width) : 0,
          cardWidth: card instanceof HTMLElement ? Math.round(card.getBoundingClientRect().width) : 0,
        };
      })(),
    }));

    assert.equal(await firstCard.getByRole("button", { name: "Abrir busqueda" }).count(), 1);
    assert.equal(await firstCard.getByRole("link", { name: "Agil" }).count(), 1);
    assert.equal(await firstCard.getByRole("link", { name: "Costamar" }).count(), 1);
    assert.deepEqual(pageErrors, []);
    assert.equal(migrationRequestCount, 8);
    assert.equal(firstRequestBody?.request?.tripType, "one-way");
    assert.equal(firstRequestBody?.request?.searchMode, "stay-range");
    assert.equal(firstRequestBody?.request?.filters?.maxResults, undefined);
    assert.match(firstRequestBody?.request?.legs?.[0]?.departureStart ?? "", /^\d{4}-\d{2}-\d{2}$/);
    assert.match(firstRequestBody?.request?.legs?.[0]?.departureEnd ?? "", /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(migrationProbe.title, "Vuelo migratorio — LIM → MIA");
    assert.equal(migrationProbe.subtitle, "Solo ida · Precio más bajo por mes");
    assert.equal(migrationProbe.cardCount, 8);
    assert.equal(migrationProbe.loadingCount, 0);
    assert.equal(migrationProbe.selectedCount, 1);
    assert.match(migrationProbe.firstCardText, /Fecha exacta:/);
    assert.match(migrationProbe.detailText, /Segmentos/);
    assert.match(migrationProbe.detailText, /Tarifa/);
    assert.match(migrationProbe.detailText, /Compra/);
    assert.match(migrationProbe.detailText, /LIM → MIA/);
    assert.ok(migrationProbe.layout);
    assert.equal(migrationProbe.layout?.overflowX, "hidden");
    assert.equal(migrationProbe.layout?.overflowY, "auto");
    assert.equal(migrationProbe.layout?.hasHorizontalOverflow, false);
    assert.equal(migrationProbe.layout?.cardsPerFirstRow, 4);
    assert.ok((migrationProbe.layout?.rowCount ?? 0) >= 2);
    assert.ok((migrationProbe.layout?.actionWidth ?? 0) < (migrationProbe.layout?.cardWidth ?? 0));

    const popupPromise = page.waitForEvent("popup");
    await firstCard.getByRole("button", { name: "Abrir busqueda" }).click();
    const popup = await popupPromise;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (exactRequestBody?.request?.searchMode === "exact") {
        break;
      }
      await page.waitForTimeout(100);
    }
    await popup.waitForFunction((expectedDate) => {
      const departureInput = document.getElementById("departureDate") as HTMLInputElement | null;
      return departureInput?.value === expectedDate;
    }, firstMigrationDate);

    const sourceProbe = await page.evaluate(() => ({
      toolbarHidden: document.getElementById("resultsToolbar")?.classList.contains("hidden") ?? true,
      departureDate: (document.getElementById("departureDate") as HTMLInputElement | null)?.value ?? "",
      tripType: (document.getElementById("tripType") as HTMLSelectElement | null)?.value ?? "",
      hasMigrationPanel: Boolean(document.querySelector(".migration-panel")),
      providerLinksText: document.querySelector("#resultsContainer .provider-links-cell")?.textContent?.trim() ?? "",
    }));
    const popupProbe = await popup.evaluate(() => ({
      toolbarHidden: document.getElementById("resultsToolbar")?.classList.contains("hidden") ?? true,
      departureDate: (document.getElementById("departureDate") as HTMLInputElement | null)?.value ?? "",
      tripType: (document.getElementById("tripType") as HTMLSelectElement | null)?.value ?? "",
      hasMigrationPanel: Boolean(document.querySelector(".migration-panel")),
      providerLinksText: document.querySelector("#resultsContainer .provider-links-cell")?.textContent?.trim() ?? "",
    }));

    assert.equal(exactRequestBody?.request?.searchMode, "exact");
    assert.equal(exactRequestBody?.request?.tripType, "one-way");
    assert.equal(exactRequestBody?.request?.legs?.[0]?.departureDate, firstMigrationDate);
    assert.equal(sourceProbe.toolbarHidden, true);
    assert.equal(sourceProbe.hasMigrationPanel, true);
    assert.equal(sourceProbe.departureDate, "");
    assert.equal(sourceProbe.tripType, "round-trip");
    assert.equal(popupProbe.toolbarHidden, false);
    assert.equal(popupProbe.departureDate, firstMigrationDate);
    assert.equal(popupProbe.tripType, "one-way");
    assert.equal(popupProbe.hasMigrationPanel, false);
    assert.match(popupProbe.providerLinksText, /Agil/);
    assert.match(popupProbe.providerLinksText, /Costamar/);
  }, { autoOpen: false });
});

test("migration cards surface the current cheapest fare while a month is still loading", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    let postCount = 0;
    let allPostsResolved!: () => void;
    const allPostsCompleted = new Promise<void>((resolve) => {
      allPostsResolved = resolve;
    });

    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      postCount += 1;
      const body = route.request().postDataJSON();
      const departureDate = body?.request?.legs?.[0]?.departureStart ?? "2026-03-31";

      if (postCount === 1) {
        const partialOffer = buildOffer({
          id: "migration-partial-offer-1",
          origin: "LIM",
          destination: "MIA",
          itineraries: [{
            direction: "outbound",
            durationMinutes: 480,
            stops: 0,
            segments: [{
              flightNumber: "LA 123",
              origin: "LIM",
              destination: "MIA",
              departureAt: `${departureDate}T14:00:00Z`,
              departureDate,
              arrivalAt: `${departureDate}T22:00:00Z`,
              airlineName: "LATAM",
            }],
          }],
          purchasePaths: [
            {
              provider: "agil-local",
              type: "search-redirect",
              label: "Buscar en Agil",
              precision: "exact-search",
              url: "https://example.test/agil/partial",
            },
          ],
          price: {
            total: {
              amount: 543,
              currencyCode: "USD",
            },
            base: {
              amount: 451,
              currencyCode: "USD",
            },
            taxes: {
              amount: 92,
              currencyCode: "USD",
            },
          },
        });

        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            searchJobId: "migration-partial-job-1",
            searchComplete: false,
            searchStatus: "running",
            sortMode: "cheapest",
            request: body.request,
            offers: [partialOffer],
            allOffers: [partialOffer],
            searchMeta: {
              ...buildSearchMeta("search_partial"),
              providersUsed: ["agil-local"],
            },
            providerMeta: {
              exactProvider: "agil-local",
              coverageMode: "core",
            },
            warnings: [],
          }),
        });
        return;
      }

        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            searchJobId: `migration-complete-job-${postCount}`,
          searchComplete: true,
          searchStatus: "completed",
          sortMode: "cheapest",
          request: body.request,
          offers: [],
          allOffers: [],
          searchMeta: {
            ...buildSearchMeta("search_live"),
            providersUsed: ["agil-local"],
          },
          providerMeta: {
            exactProvider: "agil-local",
            coverageMode: "core",
          },
            warnings: [],
          }),
        });
        if (postCount === 8) {
          allPostsResolved();
        }
        return;
      });

    await page.route(`${baseUrl}/api/search/*`, async (route: Route) => {
      const partialOffer = buildOffer({
        id: "migration-partial-offer-1",
        origin: "LIM",
        destination: "MIA",
        itineraries: [{
          direction: "outbound",
          durationMinutes: 480,
          stops: 0,
          segments: [{
            flightNumber: "LA 123",
            origin: "LIM",
            destination: "MIA",
            departureAt: "2026-03-31T14:00:00Z",
            departureDate: "2026-03-31",
            arrivalAt: "2026-03-31T22:00:00Z",
            airlineName: "LATAM",
          }],
        }],
        purchasePaths: [
          {
            provider: "agil-local",
            type: "search-redirect",
            label: "Buscar en Agil",
            precision: "exact-search",
            url: "https://example.test/agil/partial",
          },
        ],
        price: {
          total: {
            amount: 543,
            currencyCode: "USD",
          },
          base: {
            amount: 451,
            currencyCode: "USD",
          },
          taxes: {
            amount: 92,
            currencyCode: "USD",
          },
        },
      });

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "migration-partial-job-1",
          searchComplete: false,
          searchStatus: "running",
          sortMode: "cheapest",
          request: {
            tripType: "one-way",
            searchMode: "stay-range",
            legs: [{
              origin: "LIM",
              destination: "MIA",
              departureStart: "2026-03-31",
              departureEnd: "2026-03-31",
            }],
            passengers: {
              adults: 1,
              children: 0,
              infants: 0,
            },
            cabin: "ECONOMY",
            filters: {
              maxResults: 300,
            },
            coverageMode: "core",
            redirectMode: "best-effort",
            currencyCode: "USD",
            locale: "es-PE",
            market: "PE",
          },
          offers: [partialOffer],
          allOffers: [partialOffer],
          searchMeta: {
            ...buildSearchMeta("search_partial"),
            providersUsed: ["agil-local"],
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
    await setRouteInputs(page, "LIM", "MIA");

    await page.click("#migrationBtn");
    await allPostsCompleted;
    await page.waitForFunction(() => {
      const card = document.querySelector("#resultsContainer .migration-card");
      return Boolean(card && /LATAM/.test(card.textContent || "") && /Fecha exacta:/.test(card.textContent || ""));
    });

    const partialProbe = await page.evaluate(() => {
      const firstCard = document.querySelector("#resultsContainer .migration-card");
      return {
        className: firstCard?.className ?? "",
        text: firstCard?.textContent?.trim() ?? "",
      };
    });

    assert.equal(postCount, 8);
    assert.match(partialProbe.className, /migration-card--loading/);
    assert.match(partialProbe.text, /543\.00/);
    assert.match(partialProbe.text, /Fecha exacta:/);
    assert.match(partialProbe.text, /LATAM/);
    assert.match(partialProbe.text, /Actualizando mejor tarifa/);
    assert.match(partialProbe.text, /Agil/);
  }, { autoOpen: false });
});

test("migration keeps only a 2-month concurrent window while loading all 8 months", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    let requestCount = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseFirstWindow!: () => void;
    const releaseFirstWindowPromise = new Promise<void>((resolve) => {
      releaseFirstWindow = resolve;
    });

    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      const body = route.request().postDataJSON();
      if (body?.request?.searchMode !== "stay-range") {
        throw new Error(`Unexpected migration search mode: ${body?.request?.searchMode ?? "unknown"}`);
      }

      requestCount += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (requestCount <= 2) {
        await releaseFirstWindowPromise;
      }

      const departureDate = body?.request?.legs?.[0]?.departureStart ?? "2026-03-31";
      const offerNumber = requestCount;
      const offer = buildOffer({
        id: `migration-window-offer-${offerNumber}`,
        origin: "LIM",
        destination: "MIA",
        itineraries: [{
          direction: "outbound",
          durationMinutes: 480,
          stops: 0,
          segments: [{
            flightNumber: "LA 123",
            origin: "LIM",
            destination: "MIA",
            departureAt: `${departureDate}T14:00:00Z`,
            departureDate,
            arrivalAt: `${departureDate}T22:00:00Z`,
            airlineName: "LATAM",
          }],
        }],
      });

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: `migration-window-job-${offerNumber}`,
          searchComplete: true,
          searchStatus: "completed",
          sortMode: "cheapest",
          request: body.request,
          offers: [offer],
          allOffers: [offer],
          searchMeta: {
            ...buildSearchMeta("search_live"),
            providersUsed: ["agil-local"],
          },
          providerMeta: {
            exactProvider: "agil-local",
            coverageMode: "core",
          },
          warnings: [],
        }),
      });
      inFlight -= 1;
    });

    await openDesktop(page, baseUrl);
    await setRouteInputs(page, "LIM", "MIA");

    await page.click("#migrationBtn");

    await page.waitForTimeout(250);
    assert.equal(requestCount, 2);
    assert.equal(maxInFlight, 2);

    releaseFirstWindow();

    await page.waitForFunction(() => {
      return document.querySelectorAll("#resultsContainer .migration-card").length === 8;
    });
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 2500;
      const tick = () => {
        if (requestCount === 8) {
          resolve();
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error(`Expected 8 migration requests, got ${requestCount}`));
          return;
        }
        setTimeout(tick, 25);
      };
      tick();
    });
    assert.equal(requestCount, 8);
    assert.equal(maxInFlight, 2);
  }, { autoOpen: false });
});

test("migration replaces monthly cheapest with direct, layover, and baggage filters", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      const body = route.request().postDataJSON();
      const departureDate = body?.request?.legs?.[0]?.departureStart ?? "2026-04-01";
      const createMigrationOffer = (
        id: string,
        amount: number,
        stops: number,
        checkedIncluded: boolean,
        airlineName: string,
      ) => buildOffer({
        id,
        mainCarrier: "LA",
        validatingCarrier: "LA",
        comparisonMetrics: {
          totalDurationMinutes: 480 + (stops * 90),
          totalStops: stops,
        },
        baggage: {
          carryOnIncluded: true,
          checkedIncluded,
          checkedBags: checkedIncluded ? 1 : 0,
          description: checkedIncluded ? "23kg" : "Sin equipaje incluido",
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
            durationMinutes: 480 + (stops * 90),
            stops,
            segments: [
              {
                flightNumber: `${id.toUpperCase()} 100`,
                origin: "LIM",
                destination: "MIA",
                departureAt: `${departureDate}T10:00:00Z`,
                departureDate,
                arrivalAt: `${departureDate}T18:00:00Z`,
                airlineName,
              },
            ],
          },
        ],
      });

      const offers = [
        createMigrationOffer("migration-2stops", 90, 2, true, "DOS ESCALAS"),
        createMigrationOffer("migration-1stop-nobag", 100, 1, false, "UNA SIN BAG"),
        createMigrationOffer("migration-1stop-bag", 130, 1, true, "UNA CON BAG"),
        createMigrationOffer("migration-direct-bag", 150, 0, true, "DIRECTO BAG"),
      ];

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "migration-filtered-job",
          searchComplete: true,
          searchStatus: "completed",
          sortMode: "cheapest",
          request: body.request,
          offers,
          allOffers: offers,
          searchMeta: {
            ...buildSearchMeta("search_live"),
            providersUsed: ["agil-local"],
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
    await setRouteInputs(page, "LIM", "MIA");
    await page.click("#migrationBtn");
    await page.waitForFunction(() => {
      return document.querySelectorAll("#resultsContainer .migration-card--ok").length === 8;
    });

    const firstCardText = async () => page.evaluate(() =>
      document.querySelector("#resultsContainer .migration-card")?.textContent?.replace(/\s+/g, " ").trim() ?? "");

    const initialText = await firstCardText();
    assert.match(initialText, /DOS ESCALAS/);
    assert.match(initialText, /90\.00/);
    assert.match(initialText, /2 escalas/);

    await page.selectOption("#maxStopsFilter", "1");
    await page.waitForFunction(() =>
      (document.querySelector("#resultsContainer .migration-card")?.textContent ?? "").includes("UNA SIN BAG"));
    const stopsFilteredText = await firstCardText();
    assert.match(stopsFilteredText, /UNA SIN BAG/);
    assert.match(stopsFilteredText, /100\.00/);
    assert.match(stopsFilteredText, /1 escala/);

    await page.check("#baggageRequired");
    await page.waitForFunction(() =>
      (document.querySelector("#resultsContainer .migration-card")?.textContent ?? "").includes("UNA CON BAG"));
    const baggageFilteredText = await firstCardText();
    assert.match(baggageFilteredText, /UNA CON BAG/);
    assert.match(baggageFilteredText, /130\.00/);
    assert.match(baggageFilteredText, /1 escala/);

    await page.check("#nonStop");
    await page.waitForFunction(() =>
      (document.querySelector("#resultsContainer .migration-card")?.textContent ?? "").includes("DIRECTO BAG"));
    const nonstopFilteredText = await firstCardText();
    assert.match(nonstopFilteredText, /DIRECTO BAG/);
    assert.match(nonstopFilteredText, /150\.00/);
    assert.match(nonstopFilteredText, /Directo/);
  }, { autoOpen: false });
});

test("migration applies max layover filter when monthly options include stopovers with different durations", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      const body = route.request().postDataJSON();
      const departureDate = body?.request?.legs?.[0]?.departureStart ?? "2026-04-01";
      const longFirstArrival = `${departureDate}T14:00:00Z`;
      const longSecondDeparture = `${departureDate}T19:00:00Z`; // 5h layover
      const shortFirstArrival = `${departureDate}T13:00:00Z`;
      const shortSecondDeparture = `${departureDate}T14:30:00Z`; // 1h30 layover

      const longLayoverOffer = buildOffer({
        id: "migration-long-layover",
        mainCarrier: "LA",
        validatingCarrier: "LA",
        comparisonMetrics: {
          totalDurationMinutes: 720,
          totalStops: 1,
        },
        price: {
          total: {
            amount: 100,
            currencyCode: "USD",
          },
          base: {
            amount: 30,
            currencyCode: "USD",
          },
          taxes: {
            amount: 70,
            currencyCode: "USD",
          },
        },
        itineraries: [
          {
            direction: "outbound",
            durationMinutes: 720,
            stops: 1,
            segments: [
              {
                flightNumber: "LONG 101",
                origin: "LIM",
                destination: "BOG",
                departureAt: `${departureDate}T10:00:00Z`,
                departureDate,
                arrivalAt: longFirstArrival,
                airlineName: "LAYOVER LARGO",
              },
              {
                flightNumber: "LONG 102",
                origin: "BOG",
                destination: "MIA",
                departureAt: longSecondDeparture,
                departureDate,
                arrivalAt: `${departureDate}T23:00:00Z`,
                airlineName: "LAYOVER LARGO",
              },
            ],
          },
        ],
      });

      const shortLayoverOffer = buildOffer({
        id: "migration-short-layover",
        mainCarrier: "LA",
        validatingCarrier: "LA",
        comparisonMetrics: {
          totalDurationMinutes: 640,
          totalStops: 1,
        },
        price: {
          total: {
            amount: 150,
            currencyCode: "USD",
          },
          base: {
            amount: 80,
            currencyCode: "USD",
          },
          taxes: {
            amount: 70,
            currencyCode: "USD",
          },
        },
        itineraries: [
          {
            direction: "outbound",
            durationMinutes: 640,
            stops: 1,
            segments: [
              {
                flightNumber: "SHORT 201",
                origin: "LIM",
                destination: "BOG",
                departureAt: `${departureDate}T09:00:00Z`,
                departureDate,
                arrivalAt: shortFirstArrival,
                airlineName: "LAYOVER CORTO",
              },
              {
                flightNumber: "SHORT 202",
                origin: "BOG",
                destination: "MIA",
                departureAt: shortSecondDeparture,
                departureDate,
                arrivalAt: `${departureDate}T20:00:00Z`,
                airlineName: "LAYOVER CORTO",
              },
            ],
          },
        ],
      });

      const offers = [longLayoverOffer, shortLayoverOffer];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "migration-layover-filter-job",
          searchComplete: true,
          searchStatus: "completed",
          sortMode: "cheapest",
          request: body.request,
          offers,
          allOffers: offers,
          searchMeta: {
            ...buildSearchMeta("search_live"),
            providersUsed: ["agil-local"],
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
    await setRouteInputs(page, "LIM", "MIA");
    await page.click("#migrationBtn");
    await page.waitForFunction(() => {
      return document.querySelectorAll("#resultsContainer .migration-card--ok").length === 8;
    });

    const firstCardText = async () => page.evaluate(() =>
      document.querySelector("#resultsContainer .migration-card")?.textContent?.replace(/\s+/g, " ").trim() ?? "");

    const initialText = await firstCardText();
    assert.match(initialText, /LAYOVER LARGO/);
    assert.match(initialText, /100\.00/);

    await page.selectOption("#maxLayoverMinutes", "120");
    await page.waitForFunction(() =>
      (document.querySelector("#resultsContainer .migration-card")?.textContent ?? "").includes("LAYOVER CORTO"));
    const layoverFilteredText = await firstCardText();
    assert.match(layoverFilteredText, /LAYOVER CORTO/);
    assert.match(layoverFilteredText, /150\.00/);
  }, { autoOpen: false });
});

test("theme switch applies light and dark styles to the shell and overlays", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
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
  }, { autoOpen: false });
});

test("page boots directly into the stored theme without leaving bootstrap state behind", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
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
  }, { autoOpen: false });
});

test("paste can restore a copied search in a fresh view from system clipboard", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
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
      layoverActive: document.getElementById("layoverFilter")?.classList.contains("is-active") ?? false,
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
    assert.equal(restored.layoverLabel, "Escala");
    assert.equal(restored.layoverActive, true);
  }, {
    autoOpen: false,
    createPage: async ({ baseUrl, browser }) => {
      const context = await browser.newContext();
      await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
      return context.newPage();
    },
  });
});

test("copying a flexible exact-stay search emits a compact reusable request payload", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await openDesktop(page, baseUrl);
    await setRouteInputs(page, "CCS", "MAD");
    await page.click('[data-mode="flexible"]');
    await setDateValue(page, "departureStart", "2026-05-01");
    await setDateValue(page, "departureEnd", "2026-05-31");
    await page.evaluate(() => {
      const stayNights = document.getElementById("stayNights") as HTMLInputElement | null;
      const baggageRequired = document.getElementById("baggageRequired") as HTMLInputElement | null;
      const maxLayoverMinutes = document.getElementById("maxLayoverMinutes") as HTMLSelectElement | null;
      const sortMode = document.getElementById("sortMode") as HTMLSelectElement | null;
      if (!stayNights || !baggageRequired || !maxLayoverMinutes || !sortMode) {
        throw new Error("Missing flexible clipboard controls");
      }

      stayNights.value = "10";
      baggageRequired.checked = true;
      maxLayoverMinutes.value = "240";
      sortMode.value = "fastest";
      [stayNights, baggageRequired, maxLayoverMinutes, sortMode].forEach((input) => {
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
    });

    await page.click("#copySearchConfigBtn");

    const clipboardState = await page.evaluate(async () => ({
      clipboard: await navigator.clipboard.readText(),
      stored: window.localStorage.getItem("flydesk.searchClipboard") ?? "",
    }));
    const payload = JSON.parse(clipboardState.clipboard);
    const storedPayload = JSON.parse(clipboardState.stored);

    assert.equal(payload.version, 2);
    assert.equal(payload.mode, "flexible");
    assert.equal(payload.flexibleMode, "exact-stay");
    assert.equal(payload.tripType, "round-trip");
    assert.equal(payload.request.searchMode, "roundtrip-grid");
    assert.equal(payload.request.flexibleMode, "exact-stay");
    assert.equal(payload.request.locale, "es-PE");
    assert.equal(payload.request.market, "PE");
    assert.equal(payload.request.legs[0].departureStart, "2026-05-01");
    assert.equal(payload.request.legs[0].departureEnd, "2026-05-31");
    assert.equal(payload.request.legs[0].stayNights, 10);
    assert.equal(payload.request.filters.baggageRequired, true);
    assert.equal(payload.request.filters.maxLayoverMinutes, 240);
    assert.equal(Object.prototype.hasOwnProperty.call(payload, "origin"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(payload, "destination"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(payload, "summary"), false);
    assert.deepEqual(storedPayload.request, payload.request);
    assert.equal(Object.prototype.hasOwnProperty.call(storedPayload, "summary"), false);
  }, {
    autoOpen: false,
    createPage: async ({ baseUrl, browser }) => {
      const context = await browser.newContext();
      await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
      return context.newPage();
    },
  });
});

test("paste can import a Costamar branded URL and submit its provider session", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    const officialUrl = "https://booking.clickandbook.com/vuelos/b/CCS/MAD/2026-05-12/2026-05-22/1/0/0?terminalId=0721808110&lang=es&token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjA3MjE4MDgxMTAiLCJpYXQiOjE3NzU1OTg4NTAsImV4cCI6MTc3NTYwMjQ1MH0.Bn6HcF2E6mPBi1c5xoBqaVm1f7DPvMAAmKNBumDwhuI";
    let postedBody: Record<string, unknown> | null = null;

    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      postedBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "search-job-costamar-url",
          searchComplete: true,
          searchStatus: "completed",
          sortMode: "cheapest",
          request: postedBody?.request ?? {},
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

    await openDesktop(page, baseUrl);
    await page.evaluate(() => {
      window.localStorage.removeItem("flydesk.searchClipboard");
    });
    await page.evaluate((rawPayload) => navigator.clipboard.writeText(rawPayload), officialUrl);

    await page.click("#pasteSearchConfigBtn");
    await page.waitForFunction(() => {
      const origin = document.getElementById("origin") as HTMLInputElement | null;
      return origin?.value === "CCS";
    });

    const restored = await page.evaluate(() => ({
      origin: (document.getElementById("origin") as HTMLInputElement | null)?.value ?? "",
      destination: (document.getElementById("destination") as HTMLInputElement | null)?.value ?? "",
      departureDate: (document.getElementById("departureDate") as HTMLInputElement | null)?.value ?? "",
      returnDate: (document.getElementById("returnDate") as HTMLInputElement | null)?.value ?? "",
      adults: (document.getElementById("adults") as HTMLInputElement | null)?.value ?? "",
      children: (document.getElementById("children") as HTMLInputElement | null)?.value ?? "",
      infants: (document.getElementById("infants") as HTMLInputElement | null)?.value ?? "",
      storedClipboard: JSON.parse(window.localStorage.getItem("flydesk.searchClipboard") || "null"),
    }));

    assert.equal(restored.origin, "CCS");
    assert.equal(restored.destination, "MAD");
    assert.equal(restored.departureDate, "2026-05-12");
    assert.equal(restored.returnDate, "2026-05-22");
    assert.equal(restored.adults, "1");
    assert.equal(restored.children, "0");
    assert.equal(restored.infants, "0");
    assert.deepEqual(restored.storedClipboard?.providerConfig, {
      costamar: {
        terminalId: "0721808110",
        token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjA3MjE4MDgxMTAiLCJpYXQiOjE3NzU1OTg4NTAsImV4cCI6MTc3NTYwMjQ1MH0.Bn6HcF2E6mPBi1c5xoBqaVm1f7DPvMAAmKNBumDwhuI",
        lang: "es",
      },
    });
    assert.equal(restored.storedClipboard?.request?.searchMode, "exact");
    assert.equal(restored.storedClipboard?.request?.tripType, "round-trip");
    assert.equal(restored.storedClipboard?.request?.legs?.[0]?.departureDate, "2026-05-12");
    assert.equal(restored.storedClipboard?.request?.legs?.[0]?.returnDate, "2026-05-22");
    assert.equal(restored.storedClipboard?.version, 2);
    assert.equal(Object.prototype.hasOwnProperty.call(restored.storedClipboard ?? {}, "summary"), false);

    await submitAndWaitForRequest(page, baseUrl, "/api/search");

    assert.deepEqual(postedBody?.providerConfig, {
      costamar: {
        terminalId: "0721808110",
        token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjA3MjE4MDgxMTAiLCJpYXQiOjE3NzU1OTg4NTAsImV4cCI6MTc3NTYwMjQ1MH0.Bn6HcF2E6mPBi1c5xoBqaVm1f7DPvMAAmKNBumDwhuI",
        lang: "es",
      },
    });
    assert.equal((postedBody?.request as { legs?: Array<{ origin?: string; destination?: string }> })?.legs?.[0]?.origin, "CCS");
    assert.equal((postedBody?.request as { legs?: Array<{ origin?: string; destination?: string }> })?.legs?.[0]?.destination, "MAD");
  }, {
    autoOpen: false,
    createPage: async ({ baseUrl, browser }) => {
      const context = await browser.newContext();
      await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
      return context.newPage();
    },
  });
});

test("custom calendar writes exact and flexible dates back into the hidden form fields", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
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
      await page.click("#calendarClear");
      await page.evaluate(() => {
        const stayNights = document.getElementById("stayNights") as HTMLInputElement | null;
        if (!stayNights) throw new Error("Missing stayNights input");
        stayNights.value = "6";
        stayNights.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page.click('[data-date-value="2026-04-18"]');
      await page.click('[data-date-value="2026-04-24"]');

      const flexibleValues = await page.evaluate(() => ({
        departureStart: (document.getElementById("departureStart") as HTMLInputElement | null)?.value ?? "",
        departureEnd: (document.getElementById("departureEnd") as HTMLInputElement | null)?.value ?? "",
        returnStart: (document.getElementById("returnStart") as HTMLInputElement | null)?.value ?? "",
        returnEnd: (document.getElementById("returnEnd") as HTMLInputElement | null)?.value ?? "",
        searchMode: (document.getElementById("searchMode") as HTMLSelectElement | null)?.value ?? "",
        stayNights: (document.getElementById("stayNights") as HTMLInputElement | null)?.value ?? "",
        summary: document.getElementById("dateTrigger")?.textContent ?? "",
      }));

      assert.equal(exactValues.departureDate, "2026-04-15");
      assert.equal(exactValues.returnDate, "2026-04-22");
      assert.match(exactValues.summary, /15\/04/i);
      assert.equal(await page.locator("#stayDaysMin").count(), 0);
      assert.equal(await page.locator("#stayDaysMax").count(), 0);
      assert.equal(flexibleValues.departureStart, "2026-04-18");
      assert.equal(flexibleValues.departureEnd, "2026-04-24");
      assert.equal(flexibleValues.returnStart, "");
      assert.equal(flexibleValues.returnEnd, "");
      assert.equal(flexibleValues.searchMode, "roundtrip-grid");
      assert.equal(flexibleValues.stayNights, "6");
      assert.match(flexibleValues.summary, /18\/04/i);
      assert.match(flexibleValues.summary, /24\/04/i);
      assert.match(flexibleValues.summary, /6 noches/i);
  }, { autoOpen: false });
});

test("search form routes exact and flexible one-way or round-trip requests through the expected endpoints", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    const calls: Array<{
      endpoint: string;
      tripType: string;
      searchMode: string;
      flexibleMode?: string;
      stayNights?: number;
      hasReturnRange: boolean;
    }> = [];

    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      const body = route.request().postDataJSON();
      calls.push({
        endpoint: "/api/search",
        tripType: body?.request?.tripType ?? "",
        searchMode: body?.request?.searchMode ?? "",
        flexibleMode: body?.request?.flexibleMode,
        stayNights: body?.request?.legs?.[0]?.stayNights,
        hasReturnRange: Boolean(body?.request?.legs?.[0]?.returnStart && body?.request?.legs?.[0]?.returnEnd),
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
        flexibleMode: body?.request?.flexibleMode,
        stayNights: body?.request?.legs?.[0]?.stayNights,
        hasReturnRange: Boolean(body?.request?.legs?.[0]?.returnStart && body?.request?.legs?.[0]?.returnEnd),
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
      await openDesktop(page, baseUrl);
      await setRouteInputs(page, "LIM", "MIA");

      await setDateValue(page, "departureDate", "2026-04-15");
      await setDateValue(page, "returnDate", "2026-04-22");
      await submitAndWaitForRequest(page, baseUrl, "/api/search");

      await page.click('[data-trip="one-way"]');
      await submitAndWaitForRequest(page, baseUrl, "/api/search");

      await page.click('[data-mode="flexible"]');
      await setDateValue(page, "departureStart", "2026-04-18");
      await setDateValue(page, "departureEnd", "2026-04-24");
      await submitAndWaitForRequest(page, baseUrl, "/api/search");

      await page.click('[data-trip="round-trip"]');
      await page.evaluate(() => {
        const stayNights = document.getElementById("stayNights") as HTMLInputElement | null;
        if (!stayNights) throw new Error("Missing stayNights input");
        stayNights.value = "4";
        stayNights.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await submitAndWaitForRequest(page, baseUrl, "/api/matrix");

      await chooseFlexibleSubmode(page, "fixed-ranges");
      await setDateValue(page, "departureStart", "2026-05-01");
      await setDateValue(page, "departureEnd", "2026-05-03");
      await setDateValue(page, "returnStart", "2026-07-01");
      await setDateValue(page, "returnEnd", "2026-07-03");
      await submitAndWaitForRequest(page, baseUrl, "/api/matrix");

      assert.deepEqual(calls, [
        {
          endpoint: "/api/search",
          tripType: "round-trip",
          searchMode: "exact",
          flexibleMode: undefined,
          stayNights: undefined,
          hasReturnRange: false,
        },
        {
          endpoint: "/api/search",
          tripType: "one-way",
          searchMode: "exact",
          flexibleMode: undefined,
          stayNights: undefined,
          hasReturnRange: false,
        },
        {
          endpoint: "/api/search",
          tripType: "one-way",
          searchMode: "stay-range",
          flexibleMode: undefined,
          stayNights: undefined,
          hasReturnRange: false,
        },
        {
          endpoint: "/api/matrix",
          tripType: "round-trip",
          searchMode: "roundtrip-grid",
          flexibleMode: "exact-stay",
          stayNights: 4,
          hasReturnRange: false,
        },
        {
          endpoint: "/api/matrix",
          tripType: "round-trip",
          searchMode: "roundtrip-grid",
          flexibleMode: "fixed-ranges",
          stayNights: undefined,
          hasReturnRange: true,
        },
      ]);
  }, { autoOpen: false });
});

test("exact-stay matrix results open in the compact list and keep calendar hidden", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    const baseMatrix = buildMatrixResponse();
    const derivedRequestFor = (departureDate: string, returnDate: string) => ({
      ...baseMatrix.cells[0].derivedRequest,
      legs: [
        {
          origin: "LIM",
          destination: "MIA",
          departureDate,
          returnDate,
        },
      ],
    });
    const completedMatrix = buildMatrixResponse({
      matrixComplete: true,
      matrixStatus: "completed",
      request: {
        ...baseMatrix.request,
        flexibleMode: "exact-stay",
        legs: [
          {
            ...baseMatrix.request.legs[0],
            departureStart: "2026-04-15",
            departureEnd: "2026-04-21",
            returnStart: "2026-04-15",
            returnEnd: "2026-04-21",
            stayNights: 4,
          },
        ],
      },
      cells: [
        {
          ...baseMatrix.cells[0],
          confidence: "live",
          selectable: true,
          stateCode: "live",
          tooltip: "Agil exact search.",
          price: {
            amount: 280,
            currencyCode: "USD",
          },
          derivedRequest: derivedRequestFor("2026-04-16", "2026-04-20"),
          key: "2026-04-16_2026-04-20",
          departureDate: "2026-04-16",
          returnDate: "2026-04-20",
        },
        {
          ...baseMatrix.cells[0],
          key: "2026-04-15_2026-04-19",
          departureDate: "2026-04-15",
          returnDate: "2026-04-19",
          confidence: "loading",
          selectable: false,
          stateCode: "ind",
          tooltip: "Consultando Agil...",
          derivedRequest: derivedRequestFor("2026-04-15", "2026-04-19"),
          price: undefined,
        },
        {
          ...baseMatrix.cells[0],
          key: "2026-04-17_2026-04-21",
          departureDate: "2026-04-17",
          returnDate: "2026-04-21",
          confidence: "unavailable",
          selectable: false,
          stateCode: "unavailable",
          tooltip: "Sin resultado.",
          derivedRequest: derivedRequestFor("2026-04-17", "2026-04-21"),
          price: undefined,
        },
      ],
      axes: {
        departureDates: ["2026-04-15", "2026-04-16", "2026-04-17"],
        returnDates: ["2026-04-19", "2026-04-20", "2026-04-21"],
      },
      confidenceSummary: {
        live: 1,
        loading: 1,
        unavailable: 1,
      },
      searchMeta: buildSearchMeta("search_live"),
    });

    await page.route(`${baseUrl}/api/matrix`, async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(completedMatrix),
      });
    });

    await openDesktop(page, baseUrl);
    await setRouteInputs(page, "LIM", "MIA");
    await page.evaluate(() => {
      const stayNights = document.getElementById("stayNights") as HTMLInputElement | null;
      if (!stayNights) throw new Error("Missing stayNights input");
      stayNights.value = "4";
      stayNights.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await page.click('[data-mode="flexible"]');
    await setDateValue(page, "departureStart", "2026-04-15");
    await setDateValue(page, "departureEnd", "2026-04-21");
    await page.click("#submitButton");
    await page.waitForSelector(".results-list--flexible article");

    const probe = await page.evaluate(() => ({
      hasFlexibleTable: Boolean(document.querySelector(".results-list--flexible")),
      hasCalendarGrid: Boolean(document.querySelector(".cal-grid")),
      viewToggleHidden: document.getElementById("viewToggle")?.classList.contains("hidden") ?? false,
      rowKeys: [...document.querySelectorAll(".results-list--flexible article")]
        .map((row) => row.getAttribute("data-mk")),
      firstRowText: document.querySelector(".results-list--flexible article")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    }));

    assert.equal(probe.hasFlexibleTable, true);
    assert.equal(probe.hasCalendarGrid, false);
    assert.equal(probe.viewToggleHidden, true);
    assert.deepEqual(probe.rowKeys, [
      "2026-04-16_2026-04-20",
      "2026-04-15_2026-04-19",
      "2026-04-17_2026-04-21",
    ]);
    assert.match(probe.firstRowText, /16\/04/);
    assert.match(probe.firstRowText, /20\/04/);
    assert.match(probe.firstRowText, /4 noches/i);
  }, { autoOpen: false });
});

test("flexible exact-stay groups equivalent dates into one card and lets detail switch between grouped dates", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    const baseMatrix = buildMatrixResponse();
    const derivedRequestFor = (departureDate: string, returnDate: string) => ({
      ...baseMatrix.cells[0].derivedRequest,
      legs: [
        {
          origin: "LIM",
          destination: "MIA",
          departureDate,
          returnDate,
        },
      ],
    });
    const completedMatrix = buildMatrixResponse({
      matrixComplete: true,
      matrixStatus: "completed",
      request: {
        ...baseMatrix.request,
        flexibleMode: "exact-stay",
        legs: [
          {
            ...baseMatrix.request.legs[0],
            departureStart: "2026-04-15",
            departureEnd: "2026-04-21",
            returnStart: "2026-04-15",
            returnEnd: "2026-04-21",
            stayNights: 4,
          },
        ],
      },
      cells: [
        {
          ...baseMatrix.cells[0],
          key: "2026-04-16_2026-04-20",
          departureDate: "2026-04-16",
          returnDate: "2026-04-20",
          confidence: "live",
          selectable: true,
          stateCode: "live",
          tooltip: "Agil exact search.",
          variantKey: "variant-direct-la",
          price: {
            amount: 280,
            currencyCode: "USD",
          },
          derivedRequest: derivedRequestFor("2026-04-16", "2026-04-20"),
        },
        {
          ...baseMatrix.cells[0],
          key: "2026-04-17_2026-04-21",
          departureDate: "2026-04-17",
          returnDate: "2026-04-21",
          confidence: "live",
          selectable: true,
          stateCode: "live",
          tooltip: "Agil exact search.",
          variantKey: "variant-direct-la",
          price: {
            amount: 280,
            currencyCode: "USD",
          },
          derivedRequest: derivedRequestFor("2026-04-17", "2026-04-21"),
        },
        {
          ...baseMatrix.cells[0],
          key: "2026-04-18_2026-04-22",
          departureDate: "2026-04-18",
          returnDate: "2026-04-22",
          confidence: "live",
          selectable: true,
          stateCode: "live",
          tooltip: "Agil exact search with stop.",
          variantKey: "variant-stop-la",
          price: {
            amount: 299,
            currencyCode: "USD",
          },
          derivedRequest: derivedRequestFor("2026-04-18", "2026-04-22"),
        },
      ],
      axes: {
        departureDates: ["2026-04-16", "2026-04-17", "2026-04-18"],
        returnDates: ["2026-04-20", "2026-04-21", "2026-04-22"],
      },
      confidenceSummary: {
        live: 3,
      },
      searchMeta: buildSearchMeta("search_live"),
    });

    await page.route(`${baseUrl}/api/matrix`, async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(completedMatrix),
      });
    });

    await openDesktop(page, baseUrl);
    await setRouteInputs(page, "LIM", "MIA");
    await page.evaluate(() => {
      const stayNights = document.getElementById("stayNights") as HTMLInputElement | null;
      if (!stayNights) throw new Error("Missing stayNights input");
      stayNights.value = "4";
      stayNights.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await page.click('[data-mode="flexible"]');
    await setDateValue(page, "departureStart", "2026-04-15");
    await setDateValue(page, "departureEnd", "2026-04-21");
    await page.click("#submitButton");
    await page.waitForSelector(".results-list--flexible article");

    const groupedProbe = await page.evaluate(() => ({
      rowCount: document.querySelectorAll(".results-list--flexible article").length,
      firstCardText: document.querySelector(".results-list--flexible article")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      firstCardBadge: document.querySelector(".results-list--flexible article .badge--group-count")?.textContent?.trim() ?? "",
    }));

    assert.equal(groupedProbe.rowCount, 2);
    assert.match(groupedProbe.firstCardText, /También 17\/04/);
    assert.equal(groupedProbe.firstCardBadge, "2");

    await page.click(".results-list--flexible article");
    await page.waitForSelector("[data-matrix-group-cell-key]");

    const detailInitial = await page.evaluate(() => ({
      variantCount: document.querySelectorAll("[data-matrix-group-cell-key]").length,
      selectedVariant: document.querySelector('[data-matrix-group-cell-key][aria-pressed="true"]')?.getAttribute("data-matrix-group-cell-key") ?? "",
    }));

    assert.equal(detailInitial.variantCount, 2);
    assert.equal(detailInitial.selectedVariant, "2026-04-16_2026-04-20");

    await page.click('[data-matrix-group-cell-key="2026-04-17_2026-04-21"]');
    await page.waitForFunction(() => (
      document.querySelector('[data-matrix-group-cell-key][aria-pressed="true"]')?.getAttribute("data-matrix-group-cell-key")
      === "2026-04-17_2026-04-21"
    ));
  }, { autoOpen: false });
});

test("flexible fixed-ranges calendar marks grouped cells with a stacked style and highlights equivalent peers", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    const baseMatrix = buildMatrixResponse();
    const derivedRequestFor = (departureDate: string, returnDate: string) => ({
      ...baseMatrix.cells[0].derivedRequest,
      legs: [
        {
          origin: "LIM",
          destination: "MIA",
          departureDate,
          returnDate,
        },
      ],
    });
    const completedMatrix = buildMatrixResponse({
      matrixComplete: true,
      matrixStatus: "completed",
      request: {
        ...baseMatrix.request,
        flexibleMode: "fixed-ranges",
        legs: [
          {
            ...baseMatrix.request.legs[0],
            departureStart: "2026-04-15",
            departureEnd: "2026-04-16",
            returnStart: "2026-04-19",
            returnEnd: "2026-04-20",
            stayNights: undefined,
          },
        ],
      },
      cells: [
        {
          ...baseMatrix.cells[0],
          key: "2026-04-15_2026-04-19",
          departureDate: "2026-04-15",
          returnDate: "2026-04-19",
          confidence: "live",
          selectable: true,
          stateCode: "live",
          tooltip: "Agil exact search.",
          variantKey: "variant-direct-la",
          price: {
            amount: 280,
            currencyCode: "USD",
          },
          derivedRequest: derivedRequestFor("2026-04-15", "2026-04-19"),
        },
        {
          ...baseMatrix.cells[0],
          key: "2026-04-16_2026-04-20",
          departureDate: "2026-04-16",
          returnDate: "2026-04-20",
          confidence: "live",
          selectable: true,
          stateCode: "live",
          tooltip: "Agil exact search.",
          variantKey: "variant-direct-la",
          price: {
            amount: 280,
            currencyCode: "USD",
          },
          derivedRequest: derivedRequestFor("2026-04-16", "2026-04-20"),
        },
        {
          ...baseMatrix.cells[0],
          key: "2026-04-15_2026-04-20",
          departureDate: "2026-04-15",
          returnDate: "2026-04-20",
          confidence: "live",
          selectable: true,
          stateCode: "live",
          tooltip: "Agil stopover search.",
          variantKey: "variant-stop-la",
          price: {
            amount: 320,
            currencyCode: "USD",
          },
          derivedRequest: derivedRequestFor("2026-04-15", "2026-04-20"),
        },
        {
          ...baseMatrix.cells[0],
          key: "2026-04-16_2026-04-19",
          departureDate: "2026-04-16",
          returnDate: "2026-04-19",
          confidence: "live",
          selectable: true,
          stateCode: "live",
          tooltip: "Agil direct alt fare.",
          variantKey: "variant-direct-alt",
          price: {
            amount: 305,
            currencyCode: "USD",
          },
          derivedRequest: derivedRequestFor("2026-04-16", "2026-04-19"),
        },
      ],
      axes: {
        departureDates: ["2026-04-15", "2026-04-16"],
        returnDates: ["2026-04-19", "2026-04-20"],
      },
      confidenceSummary: {
        live: 4,
      },
      searchMeta: buildSearchMeta("search_live"),
    });

    await page.route(`${baseUrl}/api/matrix`, async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(completedMatrix),
      });
    });

    await openDesktop(page, baseUrl);
    await setRouteInputs(page, "LIM", "MIA");
    await page.click('[data-mode="flexible"]');
    await chooseFlexibleSubmode(page, "fixed-ranges");
    await setDateValue(page, "departureStart", "2026-04-15");
    await setDateValue(page, "departureEnd", "2026-04-16");
    await setDateValue(page, "returnStart", "2026-04-19");
    await setDateValue(page, "returnEnd", "2026-04-20");
    await page.click("#submitButton");
    await page.waitForSelector(".results-list--flexible article");

    await page.click('.results-list--flexible article[data-flex-cell-key="2026-04-15_2026-04-19"]');
    await page.click('[data-view="calendar"]');
    await page.waitForSelector(".matrix-wrap .matrix-cell");

    const calendarProbe = await page.evaluate(() => ({
      groupedCount: document.querySelectorAll(".matrix-wrap .matrix-cell--grouped").length,
      peerCount: document.querySelectorAll(".matrix-wrap .matrix-cell--group-peer").length,
      activeCount: document.querySelectorAll(".matrix-wrap .matrix-cell.is-active").length,
    }));

    assert.equal(calendarProbe.groupedCount, 2);
    assert.equal(calendarProbe.peerCount, 1);
    assert.equal(calendarProbe.activeCount, 1);
  }, { autoOpen: false });
});

test("location suggestions stay anchored to the origin field", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {

    await page.route("**/api/locations?*", async (route: Route) => {
      if (!route.request().url().includes(`${baseUrl}/api/locations?q=LIM&limit=8`)) {
        await route.continue();
        return;
      }
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
  }, { autoOpen: false });
});

test("location suggestions reuse the session cache on refocus", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    let requestCount = 0;

    await page.route("**/api/locations?*", async (route: Route) => {
      if (!route.request().url().includes(`${baseUrl}/api/locations?q=LIM&limit=8`)) {
        await route.continue();
        return;
      }

      requestCount += 1;
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
          ],
        }),
      });
    });

    await openDesktop(page, baseUrl);
    await page.fill("#origin", "LIM");
    await page.waitForSelector("#originSuggestions .location-item");
    await page.locator("body").click({ position: { x: 16, y: 16 } });
    await page.focus("#origin");
    await page.waitForTimeout(260);

    const probe = await page.evaluate(() => ({
      menuHidden: document.getElementById("originSuggestions")?.classList.contains("hidden") ?? true,
      itemCount: document.querySelectorAll("#originSuggestions .location-item").length,
    }));

    assert.equal(requestCount, 1);
    assert.equal(probe.menuHidden, false);
    assert.equal(probe.itemCount, 1);
  }, { autoOpen: false });
});

test("stale autocomplete failures no longer hide the latest valid suggestions", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    let liRequests = 0;

    await page.route("**/api/locations?*", async (route: Route) => {
      const requestUrl = route.request().url();
      if (requestUrl.includes(`${baseUrl}/api/locations?q=LI&limit=8`)) {
        liRequests += 1;
        await new Promise((resolve) => setTimeout(resolve, 420));
        try {
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: "Lookup failed" }),
          });
        } catch {
          // The browser can abort this stale request once the new query takes over.
        }
        return;
      }

      if (!requestUrl.includes(`${baseUrl}/api/locations?q=LIM&limit=8`)) {
        await route.continue();
        return;
      }

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
          ],
        }),
      });
    });

    await openDesktop(page, baseUrl);
    await page.fill("#origin", "LI");
    await page.waitForTimeout(220);
    await page.fill("#origin", "LIM");
    await page.waitForSelector("#originSuggestions .location-item");
    await page.waitForTimeout(450);

    const probe = await page.evaluate(() => ({
      menuHidden: document.getElementById("originSuggestions")?.classList.contains("hidden") ?? true,
      itemCount: document.querySelectorAll("#originSuggestions .location-item").length,
      toastCount: document.querySelectorAll(".toast--error").length,
    }));

    assert.equal(liRequests > 0, true);
    assert.equal(probe.menuHidden, false);
    assert.equal(probe.itemCount, 1);
    assert.equal(probe.toastCount, 0);
  }, { autoOpen: false });
});

test("calendar stays anchored to the trigger, stays compact, and can navigate months", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
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
  }, { autoOpen: false });
});

test("fixed-ranges calendar keeps the return header row and departure column sticky while scrolling", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    const baseMatrix = buildMatrixResponse();
    const departureDates = Array.from({ length: 15 }, (_, index) => `2026-05-${String(index + 1).padStart(2, "0")}`);
    const returnDates = Array.from({ length: 15 }, (_, index) => `2026-07-${String(index + 1).padStart(2, "0")}`);
    const diffDays = (fromIso: string, toIso: string) => {
      const from = Date.parse(`${fromIso}T00:00:00Z`);
      const to = Date.parse(`${toIso}T00:00:00Z`);
      return Math.round((to - from) / 86400000);
    };
    const matrixResponse = buildMatrixResponse({
      matrixComplete: true,
      matrixStatus: "completed",
      request: {
        ...baseMatrix.request,
        flexibleMode: "fixed-ranges",
        legs: [
          {
            ...baseMatrix.request.legs[0],
            departureStart: departureDates[0],
            departureEnd: departureDates.at(-1),
            returnStart: returnDates[0],
            returnEnd: returnDates.at(-1),
            stayNights: undefined,
          },
        ],
      },
      cells: departureDates.flatMap((departureDate, departureIndex) =>
        returnDates.map((returnDate, returnIndex) => ({
          ...baseMatrix.cells[0],
          key: `${departureDate}_${returnDate}`,
          departureDate,
          returnDate,
          stayNights: diffDays(departureDate, returnDate),
          confidence: "live",
          selectable: true,
          stateCode: "live",
          tooltip: "Agil exact search.",
          price: {
            amount: 280 + departureIndex + returnIndex,
            currencyCode: "USD",
          },
          derivedRequest: {
            ...baseMatrix.cells[0].derivedRequest,
            legs: [
              {
                origin: "LIM",
                destination: "MIA",
                departureDate,
                returnDate,
              },
            ],
          },
        })),
      ),
      axes: {
        departureDates,
        returnDates,
      },
      confidenceSummary: {
        live: departureDates.length * returnDates.length,
      },
      searchMeta: buildSearchMeta("search_live"),
    });

    await page.route(`${baseUrl}/api/matrix`, async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(matrixResponse),
      });
    });

    await openDesktop(page, baseUrl);
    await setRouteInputs(page, "LIM", "MIA");
    await page.click('[data-mode="flexible"]');
    await chooseFlexibleSubmode(page, "fixed-ranges");
    await setDateValue(page, "departureStart", departureDates[0]);
    await setDateValue(page, "departureEnd", departureDates.at(-1) ?? "");
    await setDateValue(page, "returnStart", returnDates[0]);
    await setDateValue(page, "returnEnd", returnDates.at(-1) ?? "");
    await page.click("#submitButton");
    await page.waitForSelector('[data-view="calendar"]');
    await page.click('[data-view="calendar"]');
    await page.waitForSelector(".matrix-wrap");

    const stickyProbe = await page.evaluate(() => {
      const wrap = document.querySelector(".matrix-wrap") as HTMLElement | null;
      const header = document.querySelector(".cal-header") as HTMLElement | null;
      const label = document.querySelector(".cal-label") as HTMLElement | null;
      const corner = document.querySelector(".cal-corner") as HTMLElement | null;
      const viewToggle = document.getElementById("viewToggle");
      if (!wrap || !header || !label || !corner || !viewToggle) return null;

      const before = {
        headerTop: header.getBoundingClientRect().top,
        labelLeft: label.getBoundingClientRect().left,
      };

      wrap.scrollTop = 280;
      wrap.scrollLeft = 280;
      wrap.dispatchEvent(new Event("scroll"));

      const after = {
        headerTop: header.getBoundingClientRect().top,
        labelLeft: label.getBoundingClientRect().left,
        wrapTop: wrap.getBoundingClientRect().top,
        wrapLeft: wrap.getBoundingClientRect().left,
        wrapPaddingTop: parseFloat(getComputedStyle(wrap).paddingTop) || 0,
        wrapPaddingLeft: parseFloat(getComputedStyle(wrap).paddingLeft) || 0,
      };

      return {
        scrolledTop: wrap.scrollTop,
        scrolledLeft: wrap.scrollLeft,
        headerPosition: getComputedStyle(header).position,
        labelPosition: getComputedStyle(label).position,
        cornerPosition: getComputedStyle(corner).position,
        viewToggleHidden: viewToggle.classList.contains("hidden"),
        headerDeltaFromWrap: Math.abs(after.headerTop - (after.wrapTop + after.wrapPaddingTop)),
        labelDeltaFromWrap: Math.abs(after.labelLeft - (after.wrapLeft + after.wrapPaddingLeft)),
      };
    });

    assert.ok(stickyProbe);
    assert.equal(stickyProbe.viewToggleHidden, false);
    assert.equal(stickyProbe.headerPosition, "sticky");
    assert.equal(stickyProbe.labelPosition, "sticky");
    assert.equal(stickyProbe.cornerPosition, "sticky");
    assert.equal(stickyProbe.scrolledTop > 0, true);
    assert.equal(stickyProbe.scrolledLeft > 0, true);
    assert.equal(stickyProbe.headerDeltaFromWrap < 2, true, JSON.stringify(stickyProbe));
    assert.equal(stickyProbe.labelDeltaFromWrap < 2, true, JSON.stringify(stickyProbe));
  }, { autoOpen: false });
});

test("clicking a flexible round-trip list row opens detail first and preserves passengers and filters for exact search", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    let lastMatrixRequest: Record<string, unknown> | null = null;
    let searchRequestCount = 0;
    let lastSearchRequest: Record<string, unknown> | null = null;

    const matrixRequest = {
      tripType: "round-trip",
      searchMode: "roundtrip-grid",
      flexibleMode: "exact-stay",
      legs: [
        {
          origin: "LIM",
          destination: "MIA",
          departureStart: "2026-04-15",
          departureEnd: "2026-04-19",
          returnStart: "",
          returnEnd: "",
          stayNights: 4,
        },
      ],
      passengers: {
        adults: 2,
        children: 1,
        infants: 1,
      },
      cabin: "ECONOMY",
      filters: {
        nonStop: true,
        baggageRequired: true,
        maxStops: 1,
        maxLayoverMinutes: 240,
      },
      coverageMode: "core",
      redirectMode: "best-effort",
      currencyCode: "USD",
      locale: "es-PE",
      market: "PE",
    };

    const exactRequest = {
      ...matrixRequest,
      searchMode: "exact",
      flexibleMode: undefined,
      legs: [
        {
          origin: "LIM",
          destination: "MIA",
          departureDate: "2026-04-15",
          returnDate: "2026-04-19",
        },
      ],
    };

    const completedMatrix = buildMatrixResponse({
      request: matrixRequest,
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
          derivedRequest: exactRequest,
          purchasePaths: [
            {
              id: "matrix-agil-path",
              provider: "agil-local",
              type: "search-redirect",
              label: "Buscar en Agil",
              url: "/r/matrix-agil-path",
              precision: "exact-search",
              score: 0.9,
              requiresNewTab: true,
              commercialMode: "provider",
              state: "search_redirect",
            },
          ],
        },
      ],
      searchMeta: buildSearchMeta("search_live"),
    });

    await page.route(`${baseUrl}/api/matrix`, async (route: Route) => {
      lastMatrixRequest = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(completedMatrix),
      });
    });

    await page.context().route(`${baseUrl}/api/search`, async (route: Route) => {
      searchRequestCount += 1;
      lastSearchRequest = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "search-job-1",
          searchComplete: true,
          searchStatus: "completed",
          sortMode: "cheapest",
          request: lastSearchRequest?.request ?? exactRequest,
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
    await openDesktop(page, baseUrl);
    await page.click('[data-mode="flexible"]');
    await setRouteInputs(page, "LIM", "MIA");
    await setDateValue(page, "departureStart", "2026-04-15");
    await setDateValue(page, "departureEnd", "2026-04-19");
    await page.evaluate(() => {
      const adults = document.getElementById("adults") as HTMLInputElement | null;
      const children = document.getElementById("children") as HTMLInputElement | null;
      const infants = document.getElementById("infants") as HTMLInputElement | null;
      const stayNights = document.getElementById("stayNights") as HTMLInputElement | null;
      const nonStop = document.getElementById("nonStop") as HTMLInputElement | null;
      const baggageRequired = document.getElementById("baggageRequired") as HTMLInputElement | null;
      const maxStops = document.getElementById("maxStopsFilter") as HTMLSelectElement | null;
      const maxLayoverMinutes = document.getElementById("maxLayoverMinutes") as HTMLSelectElement | null;
      if (!adults || !children || !infants || !stayNights || !nonStop || !baggageRequired || !maxStops || !maxLayoverMinutes) {
        throw new Error("Missing passenger, stay, or filter inputs");
      }
      adults.value = "2";
      children.value = "1";
      infants.value = "1";
      stayNights.value = "4";
      nonStop.checked = true;
      baggageRequired.checked = true;
      maxStops.value = "1";
      maxLayoverMinutes.value = "240";
      [adults, children, infants, stayNights, nonStop, baggageRequired, maxStops, maxLayoverMinutes].forEach((input) => {
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
    });

    await submitAndWaitForRequest(page, baseUrl, "/api/matrix");
    await page.waitForSelector('.results-list--flexible [data-flex-cell-key="2026-04-15_2026-04-19"]');

    assert.deepEqual((lastMatrixRequest?.request as Record<string, unknown> | undefined)?.passengers, {
      adults: 2,
      children: 1,
      infants: 1,
    });
    assert.deepEqual((lastMatrixRequest?.request as Record<string, unknown> | undefined)?.filters, {
      nonStop: true,
      baggageRequired: true,
      maxStops: 1,
      maxLayoverMinutes: 240,
      includedAirlineCodes: [],
    });

    await page.click('.results-list--flexible [data-flex-cell-key="2026-04-15_2026-04-19"]');
    await page.waitForSelector('[data-matrix-detail-search="2026-04-15_2026-04-19"]');
    await page.waitForTimeout(200);

    assert.equal(searchRequestCount, 0);

    const detailProbe = await page.evaluate(() => ({
      detailOpen: document.getElementById("detailPanel")?.classList.contains("is-open") ?? false,
      detailText: document.getElementById("detailContent")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      activeRow: document.querySelector('.results-list--flexible article.is-active')?.getAttribute("data-flex-cell-key") ?? "",
      externalLinkText: document.querySelector('#detailContent a.btn--ghost')?.textContent?.trim() ?? "",
      externalLinkHref: document.querySelector('#detailContent a.btn--ghost')?.getAttribute("href") ?? "",
    }));

    assert.equal(detailProbe.detailOpen, true);
    assert.equal(detailProbe.activeRow, "2026-04-15_2026-04-19");
    assert.match(detailProbe.detailText, /LIM → MIA/);
    assert.match(detailProbe.detailText, /2 adultos, 1 niño, 1 bebé/i);
    assert.match(detailProbe.detailText, /Directo/i);
    assert.match(detailProbe.detailText, /Con equipaje/i);
    assert.match(detailProbe.detailText, /15\/04/);
    assert.match(detailProbe.detailText, /19\/04/);
    assert.match(detailProbe.detailText, /Ruta exacta/i);
    assert.match(detailProbe.detailText, /Proveedor/i);
    assert.equal(detailProbe.externalLinkText, "Abrir en Agil");
    assert.equal(detailProbe.externalLinkHref, "/r/matrix-agil-path");

    const popupPromise = page.waitForEvent("popup");
    await page.click('[data-matrix-detail-search="2026-04-15_2026-04-19"]');
    const popup = await popupPromise;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (searchRequestCount > 0) {
        break;
      }
      await page.waitForTimeout(100);
    }
    await popup.waitForFunction(() => {
      const searchMode = document.getElementById("searchMode") as HTMLInputElement | null;
      return searchMode?.value === "exact";
    });

    assert.equal(searchRequestCount, 1);
    assert.equal((lastSearchRequest?.request as Record<string, unknown> | undefined)?.searchMode, "exact");
    assert.equal((lastSearchRequest?.request as Record<string, unknown> | undefined)?.providerId, undefined);
    assert.deepEqual((lastSearchRequest?.request as Record<string, unknown> | undefined)?.passengers, {
      adults: 2,
      children: 1,
      infants: 1,
    });
    assert.deepEqual((lastSearchRequest?.request as Record<string, unknown> | undefined)?.filters, {
      nonStop: true,
      baggageRequired: true,
      maxStops: 1,
      maxLayoverMinutes: 240,
    });

    const sourceFormState = await page.evaluate(() => ({
      searchMode: (document.getElementById("searchMode") as HTMLInputElement | null)?.value,
      departureDate: (document.getElementById("departureDate") as HTMLInputElement | null)?.value,
      returnDate: (document.getElementById("returnDate") as HTMLInputElement | null)?.value,
      departureStart: (document.getElementById("departureStart") as HTMLInputElement | null)?.value,
      departureEnd: (document.getElementById("departureEnd") as HTMLInputElement | null)?.value,
      adults: (document.getElementById("adults") as HTMLInputElement | null)?.value,
      children: (document.getElementById("children") as HTMLInputElement | null)?.value,
      infants: (document.getElementById("infants") as HTMLInputElement | null)?.value,
      dateTriggerText: document.getElementById("dateTriggerText")?.textContent?.trim(),
    }));
    const popupFormState = await popup.evaluate(() => ({
      searchMode: (document.getElementById("searchMode") as HTMLInputElement | null)?.value,
      departureDate: (document.getElementById("departureDate") as HTMLInputElement | null)?.value,
      returnDate: (document.getElementById("returnDate") as HTMLInputElement | null)?.value,
      departureStart: (document.getElementById("departureStart") as HTMLInputElement | null)?.value,
      departureEnd: (document.getElementById("departureEnd") as HTMLInputElement | null)?.value,
      adults: (document.getElementById("adults") as HTMLInputElement | null)?.value,
      children: (document.getElementById("children") as HTMLInputElement | null)?.value,
      infants: (document.getElementById("infants") as HTMLInputElement | null)?.value,
      dateTriggerText: document.getElementById("dateTriggerText")?.textContent?.trim(),
    }));

    assert.equal(sourceFormState.searchMode, "roundtrip-grid");
    assert.equal(sourceFormState.departureDate, "");
    assert.equal(sourceFormState.returnDate, "");
    assert.equal(sourceFormState.departureStart, "2026-04-15");
    assert.equal(sourceFormState.departureEnd, "2026-04-19");
    assert.equal(sourceFormState.adults, "2");
    assert.equal(sourceFormState.children, "1");
    assert.equal(sourceFormState.infants, "1");
    assert.match(sourceFormState.dateTriggerText ?? "", /15\/04/);

    assert.equal(popupFormState.searchMode, "exact");
    assert.equal(popupFormState.departureDate, "2026-04-15");
    assert.equal(popupFormState.returnDate, "2026-04-19");
    assert.equal(popupFormState.departureStart, "");
    assert.equal(popupFormState.departureEnd, "");
    assert.equal(popupFormState.adults, "2");
    assert.equal(popupFormState.children, "1");
    assert.equal(popupFormState.infants, "1");
    assert.equal(popupFormState.dateTriggerText, "15/04 → 19/04");
  }, { autoOpen: false });
});

test("flexible matrix detail hides the external provider action when no redirect is available", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    const matrixResponse = buildMatrixResponse({
      matrixComplete: true,
      matrixStatus: "completed",
      cells: [
        {
          ...buildMatrixResponse().cells[0],
          confidence: "live",
          selectable: true,
          stateCode: "live",
          tooltip: "Agil exact search.",
          price: {
            amount: 150,
            currencyCode: "USD",
          },
          purchasePaths: [],
        },
      ],
      confidenceSummary: {
        live: 1,
      },
      searchMeta: buildSearchMeta("search_live"),
    });

    await page.route(`${baseUrl}/api/matrix`, async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(matrixResponse),
      });
    });

    await openDesktop(page, baseUrl);
    await page.click('[data-mode="flexible"]');
    await setRouteInputs(page, "LIM", "MIA");
    await setDateValue(page, "departureStart", "2026-04-15");
    await setDateValue(page, "departureEnd", "2026-04-19");
    await page.evaluate(() => {
      const stayNights = document.getElementById("stayNights") as HTMLInputElement | null;
      if (!stayNights) throw new Error("Missing stayNights input");
      stayNights.value = "4";
      stayNights.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await page.click("#submitButton");
    await page.waitForSelector('.results-list--flexible [data-flex-cell-key="2026-04-15_2026-04-19"]');
    await page.click('.results-list--flexible [data-flex-cell-key="2026-04-15_2026-04-19"]');
    await page.waitForSelector('[data-matrix-detail-search="2026-04-15_2026-04-19"]');

    const detailProbe = await page.evaluate(() => ({
      detailText: document.getElementById("detailContent")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      externalActions: [...document.querySelectorAll('#detailContent a.btn--ghost')]
        .map((node) => node.textContent?.trim() ?? ""),
    }));

    assert.equal(detailProbe.externalActions.length, 0);
    assert.match(detailProbe.detailText, /no hay un enlace externo utilizable/i);
  }, { autoOpen: false });
});

test("passengers and layover popovers stay centered on their triggers", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
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
  }, { autoOpen: false });
});

test("date-equivalent offers collapse into one row and keep the date variants in detail", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {

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
      await page.waitForSelector('article[data-oid="offer-1"]');

      const probe = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('article[data-oid]')];
        const firstDateCell = rows[0]?.querySelector('[data-result-dates]');
        const segmentHeaders = [...document.querySelectorAll(".detail-segment__dir")]
          .map((node) => node.textContent?.replace(/\s+/g, " ").trim() ?? "");
        const variantTitle = segmentHeaders.find((text) => text.includes("Fechas equivalentes")) ?? "";
        const variants = [...document.querySelectorAll("[data-inbound-id]")]
          .map((node) => node.textContent?.replace(/\s+/g, " ").trim() ?? "");

        return {
          rowCount: rows.length,
          dateText: firstDateCell?.textContent?.replace(/\s+/g, " ").trim() ?? "",
          segmentHeaders,
          variantTitle,
          variants,
        };
      });

      assert.equal(probe.rowCount, 1);
      assert.match(probe.dateText, /15\/04/);
      assert.match(probe.dateText, /También 16\/04 → 23\/04 y 1 fecha más/);
      assert.match(probe.variantTitle, /Fechas equivalentes/);
      assert.equal(probe.segmentHeaders.some((text) => text.includes("Ida")), true);
      assert.equal(probe.segmentHeaders.some((text) => text.includes("Vuelta")), true);
      assert.equal(probe.segmentHeaders.some((text) => /inbound|outbound/i.test(text)), false);
      assert.equal(probe.variants.length, 3);
      assert.match(probe.variants[0] ?? "", /15\/04 → 22\/04/);
      assert.match(probe.variants[1] ?? "", /16\/04 → 23\/04/);
      assert.match(probe.variants[2] ?? "", /17\/04 → 24\/04/);
      assert.deepEqual(
        await page.locator("[data-inbound-id]").evaluateAll((nodes) =>
          nodes.map((node) => ({
            tag: node.tagName,
            type: node.getAttribute("type"),
            pressed: node.getAttribute("aria-pressed"),
          })),
        ),
        [
          { tag: "BUTTON", type: "button", pressed: "true" },
          { tag: "BUTTON", type: "button", pressed: "false" },
          { tag: "BUTTON", type: "button", pressed: "false" },
        ],
      );

      await page.locator('[data-inbound-id="offer-2"]').focus();
      await page.keyboard.press("Enter");

      const afterKeyboardSelection = await page.evaluate(() => ({
        activeVariant: document.querySelector('[data-inbound-id][aria-pressed="true"]')?.getAttribute("data-inbound-id") ?? "",
        dateText: document.querySelector('article[data-oid] [data-result-dates]')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      }));

      assert.equal(afterKeyboardSelection.activeVariant, "offer-2");
      assert.match(afterKeyboardSelection.dateText, /16\/04 → 23\/04/);
  }, { autoOpen: false });
});

test("grouped results keep the best-value variant as the visible row lead", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {

    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      const groupedOffers = [
        buildOffer({
          ...buildOfferWithDates("offer-1", "2026-04-15", "2026-04-22"),
          valueScore: 0.8,
        }),
        buildOffer({
          ...buildOfferWithDates("offer-2", "2026-04-16", "2026-04-23"),
          valueScore: 0.2,
        }),
        buildOffer({
          ...buildOfferWithDates("offer-3", "2026-04-17", "2026-04-24"),
          valueScore: 0.4,
        }),
      ];

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "search-job-grouped-best-value",
          searchComplete: true,
          searchStatus: "completed",
          sortMode: "best-value",
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
          offers: groupedOffers,
          allOffers: groupedOffers,
          searchMeta: buildSearchMeta("search_live"),
          providerMeta: {
            exactProvider: "agil-local",
            coverageMode: "core",
          },
          warnings: [],
        }),
      });
    });
      await openDesktop(page, baseUrl);
      await page.evaluate(() => {
        const origin = document.getElementById("origin") as HTMLInputElement | null;
        const destination = document.getElementById("destination") as HTMLInputElement | null;
        const sort = document.getElementById("sortMode") as HTMLSelectElement | null;
        if (!origin || !destination || !sort) throw new Error("Missing form controls");
        origin.value = "LIM - Lima, Peru";
        origin.dataset.code = "LIM";
        origin.dataset.label = "LIM - Lima, Peru";
        destination.value = "MIA - Miami, Usa";
        destination.dataset.code = "MIA";
        destination.dataset.label = "MIA - Miami, Usa";
        sort.value = "best-value";
      });
      await setDateValue(page, "departureDate", "2026-04-15");
      await setDateValue(page, "returnDate", "2026-04-22");
      await page.click("#submitButton");
      await page.waitForSelector('article[data-oid="offer-2"]');

      const groupedProbe = await page.evaluate(() => ({
        rowId: document.querySelector("article[data-oid]")?.getAttribute("data-oid") ?? "",
        dateText: document.querySelector("article[data-oid] [data-result-dates] .cell-main")?.textContent?.trim() ?? "",
      }));

      assert.equal(groupedProbe.rowId, "offer-2");
      assert.match(groupedProbe.dateText, /16\/04/i);
  }, { autoOpen: false });
});

test("results header exposes route context, rows support keyboard selection, and Escape clears the offer panel", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {

    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      const offers = [
        buildCarrierOffer("offer-aa", "AA", 505),
        buildCarrierOffer("offer-cm", "CM", 540),
      ];

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "search-job-keyboard-results",
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
    await page.waitForSelector('article[data-oid="offer-aa"]');

    const beforeKeyboard = await page.evaluate(() => ({
      resultsMeta: document.getElementById("resultsPanelMeta")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      countPresent: Boolean(document.getElementById("resultsCountLabel")),
      secondRowRole: document.querySelector('article[data-oid="offer-cm"]')?.getAttribute("role") ?? "",
      secondRowTabIndex: document.querySelector('article[data-oid="offer-cm"]')?.getAttribute("tabindex") ?? "",
      selectedId: document.querySelector("article[data-oid].is-active")?.getAttribute("data-oid") ?? "",
    }));

    assert.match(beforeKeyboard.resultsMeta, /LIM → MIA/);
    assert.match(beforeKeyboard.resultsMeta, /15\/04 → 22\/04/);
    assert.doesNotMatch(beforeKeyboard.resultsMeta, /Agil|Costamar/);
    assert.equal(beforeKeyboard.countPresent, false);
    assert.equal(beforeKeyboard.secondRowRole, "button");
    assert.equal(beforeKeyboard.secondRowTabIndex, "0");
    assert.equal(beforeKeyboard.selectedId, "offer-aa");

    await page.locator('article[data-oid="offer-cm"]').focus();
    await page.keyboard.press("Enter");

    const afterKeyboard = await page.evaluate(() => ({
      selectedId: document.querySelector("article[data-oid].is-active")?.getAttribute("data-oid") ?? "",
      detailSummary: document.querySelector(".detail-summary")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    }));

    assert.equal(afterKeyboard.selectedId, "offer-cm");
    assert.match(afterKeyboard.detailSummary, /CM/);

    await page.keyboard.press("Escape");
    await page.waitForSelector(".detail-empty .empty-panel__title");

    const afterEscape = await page.evaluate(() => ({
      selectedRowCount: document.querySelectorAll("article[data-oid].is-active").length,
      emptyTitle: document.querySelector(".detail-empty .empty-panel__title")?.textContent?.trim() ?? "",
      emptyText: document.querySelector(".detail-empty .empty-panel__text")?.textContent?.trim() ?? "",
    }));

    assert.equal(afterEscape.selectedRowCount, 0);
    assert.equal(afterEscape.emptyTitle, "Sin oferta seleccionada");
    assert.match(afterEscape.emptyText, /Selecciona una opción para ver el detalle/);
  }, { autoOpen: false });
});

test("price column header keeps the shared table header typography", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "search-job-price-header",
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
    await page.waitForSelector('article[data-oid="offer-1"]');

    const headerTypography = await page.evaluate(() => {
      const airline = document.querySelector('article[data-oid] [data-result-airline]') as HTMLElement | null;
      const route = document.querySelector('article[data-oid] [data-result-route]') as HTMLElement | null;
      if (!airline || !route) {
        throw new Error("Missing result card headings");
      }

      const airlineStyle = getComputedStyle(airline);
      const routeStyle = getComputedStyle(route);

      return {
        airlineFontFamily: airlineStyle.fontFamily,
        airlineFontSize: airlineStyle.fontSize,
        airlineFontWeight: airlineStyle.fontWeight,
        routeFontFamily: routeStyle.fontFamily,
        routeFontSize: routeStyle.fontSize,
        routeFontWeight: routeStyle.fontWeight,
      };
    });

    assert.equal(headerTypography.routeFontFamily, headerTypography.airlineFontFamily);
    assert.equal(headerTypography.routeFontSize, headerTypography.airlineFontSize);
    assert.equal(headerTypography.routeFontWeight, headerTypography.airlineFontWeight);
  }, { autoOpen: false });
});

test("exact results show total and per-person pricing from the searched passengers", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchComplete: true,
          searchStatus: "completed",
          request: {
            tripType: "round-trip",
            searchMode: "exact",
            legs: [
              {
                origin: "LIM",
                destination: "CTG",
                departureDate: "2026-09-07",
                returnDate: "2026-09-10",
              },
            ],
            passengers: {
              adults: 3,
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
            buildOffer({
              price: {
                total: {
                  amount: 1036.56,
                  currencyCode: "USD",
                },
                base: {
                  amount: 552,
                  currencyCode: "USD",
                },
                taxes: {
                  amount: 484.56,
                  currencyCode: "USD",
                },
              },
            }),
          ],
          allOffers: [
            buildOffer({
              price: {
                total: {
                  amount: 1036.56,
                  currencyCode: "USD",
                },
                base: {
                  amount: 552,
                  currencyCode: "USD",
                },
                taxes: {
                  amount: 484.56,
                  currencyCode: "USD",
                },
              },
            }),
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

    await openDesktop(page, baseUrl);
    await setRouteInputs(page, "LIM", "CTG");
    await page.evaluate(() => {
      const adults = document.getElementById("adults") as HTMLInputElement | null;
      const children = document.getElementById("children") as HTMLInputElement | null;
      const infants = document.getElementById("infants") as HTMLInputElement | null;
      if (!adults || !children || !infants) throw new Error("Missing passenger inputs");
      adults.value = "3";
      children.value = "0";
      infants.value = "0";
    });
    await setDateValue(page, "departureDate", "2026-09-07");
    await setDateValue(page, "returnDate", "2026-09-10");
    await page.click("#submitButton");
    await page.waitForSelector('article[data-oid="offer-1"]');
    await page.click('article[data-oid="offer-1"]');

    const probe = await page.evaluate(() => ({
      rowPrice: document.querySelector('article[data-oid="offer-1"] [data-result-price]')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      detailText: document.getElementById("detailContent")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      heroMeta: document.querySelector("#detailContent .detail-hero__meta")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    }));

    assert.match(probe.rowPrice, /USD 1,036\.56 total/i);
    assert.match(probe.rowPrice, /USD 345\.52 por persona/i);
    assert.match(probe.detailText, /Total\s*USD 1,036\.56/i);
    assert.match(probe.detailText, /Por persona\s*USD 345\.52/i);
    assert.match(probe.heroMeta, /USD 345\.52 por persona/i);
  }, { autoOpen: false });
});

test("flexible exact-stay results show total and per-person pricing in list and detail", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    const completedMatrix = buildMatrixResponse({
      request: {
        ...buildMatrixResponse().request,
        flexibleMode: "exact-stay",
        passengers: {
          adults: 3,
          children: 0,
          infants: 0,
        },
        legs: [
          {
            ...buildMatrixResponse().request.legs[0],
            origin: "LIM",
            destination: "CTG",
            departureStart: "2026-09-07",
            departureEnd: "2026-09-10",
            returnStart: "",
            returnEnd: "",
            stayNights: 3,
          },
        ],
      },
      matrixComplete: true,
      matrixStatus: "completed",
      cells: [
        {
          ...buildMatrixResponse().cells[0],
          key: "2026-09-07_2026-09-10",
          departureDate: "2026-09-07",
          returnDate: "2026-09-10",
          stayNights: 3,
          confidence: "live",
          selectable: true,
          stateCode: "live",
          tooltip: "Costamar exact search.",
          providerSource: "costamar",
          price: {
            amount: 1036.56,
            currencyCode: "USD",
          },
          derivedRequest: {
            ...buildMatrixResponse().cells[0].derivedRequest,
            tripType: "round-trip",
            searchMode: "exact",
            legs: [
              {
                origin: "LIM",
                destination: "CTG",
                departureDate: "2026-09-07",
                returnDate: "2026-09-10",
              },
            ],
            passengers: {
              adults: 3,
              children: 0,
              infants: 0,
            },
          },
        },
      ],
      searchMeta: buildSearchMeta("search_live"),
    });

    await page.route(`${baseUrl}/api/matrix`, async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(completedMatrix),
      });
    });

    await openDesktop(page, baseUrl);
    await setRouteInputs(page, "LIM", "CTG");
    await page.evaluate(() => {
      const adults = document.getElementById("adults") as HTMLInputElement | null;
      const children = document.getElementById("children") as HTMLInputElement | null;
      const infants = document.getElementById("infants") as HTMLInputElement | null;
      const stayNights = document.getElementById("stayNights") as HTMLInputElement | null;
      if (!adults || !children || !infants || !stayNights) throw new Error("Missing flexible inputs");
      adults.value = "3";
      children.value = "0";
      infants.value = "0";
      stayNights.value = "3";
      stayNights.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.click('[data-mode="flexible"]');
    await setDateValue(page, "departureStart", "2026-09-07");
    await setDateValue(page, "departureEnd", "2026-09-10");
    await page.click("#submitButton");
    await page.waitForSelector('.results-list--flexible article[data-flex-cell-key="2026-09-07_2026-09-10"]');
    await page.click('.results-list--flexible article[data-flex-cell-key="2026-09-07_2026-09-10"]');

    const probe = await page.evaluate(() => ({
      rowPrice: document.querySelector('.results-list--flexible .results-card__price')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      detailText: document.getElementById("detailContent")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      heroMeta: document.querySelector("#detailContent .detail-hero__meta")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    }));

    assert.match(probe.rowPrice, /USD 1,036\.56 total/i);
    assert.match(probe.rowPrice, /USD 345\.52 por persona/i);
    assert.match(probe.detailText, /Total\s*USD 1,036\.56/i);
    assert.match(probe.detailText, /Por persona\s*USD 345\.52/i);
    assert.match(probe.heroMeta, /USD 345\.52 por persona/i);
  }, { autoOpen: false });
});

test("airlines move into the search bar ordered by cheapest fare and filter horizontally", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {

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
        rowCount: document.querySelectorAll('article[data-oid]').length,
      }));

      await page.click('[data-airline-code="CM"]');

      const afterFilter = await page.evaluate(() => ({
        activeCode: document.querySelector(".airline-chip.is-active[data-airline-code]")?.getAttribute("data-airline-code") ?? "",
        rowCount: document.querySelectorAll('article[data-oid]').length,
        visibleCarrier: document.querySelector('article[data-oid] [data-result-airline]')?.textContent?.trim() ?? "",
      }));

      assert.equal(beforeFilter.sidebarCount, 0);
      assert.deepEqual(beforeFilter.chips.map((chip) => chip.code), ["AA", "CM", "LA"]);
      assert.equal(beforeFilter.rowCount, 3);
      assert.equal(afterFilter.activeCode, "CM");
      assert.equal(afterFilter.rowCount, 1);
      assert.equal(afterFilter.visibleCarrier, "CM");
  }, { autoOpen: false });
});

test("layover popover keeps a compact utility layout", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
      await openDesktop(page, baseUrl);
      await page.click("#layoverTrigger");

      const probe = await page.evaluate(() => ({
        labels: [...document.querySelectorAll("#layoverPopover .refinement-popover__section-label")]
          .map((node) => node.textContent?.trim() ?? ""),
        text: document.getElementById("layoverPopover")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
        hasHeader: Boolean(document.querySelector("#layoverPopover .refinement-popover__header")),
      }));

      assert.deepEqual(probe.labels, ["Escalas", "Tiempo"]);
      assert.equal(probe.hasHeader, false);
      assert.doesNotMatch(probe.text, /Combina número de escalas/i);
      assert.doesNotMatch(probe.text, /Directo anula este filtro/i);
      assert.doesNotMatch(probe.text, /Sin filtro/i);
  }, { autoOpen: false });
});

test("max layover filter is sent in the payload and narrows the visible results", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
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
      await page.waitForSelector('article[data-oid]');

      const probe = await page.evaluate(() => ({
        rowCount: document.querySelectorAll('article[data-oid]').length,
        ids: [...document.querySelectorAll('article[data-oid]')].map((row) => row.getAttribute("data-oid")),
      }));

      assert.equal(capturedMaxLayoverMinutes, 240);
      assert.equal(probe.rowCount, 2);
      assert.deepEqual(probe.ids, ["offer-direct", "offer-short-layover"]);
  }, { autoOpen: false });
});

test("combined max stops and max layover filters are sent and applied together", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    let capturedMaxStops: number | undefined;
    let capturedMaxLayoverMinutes: number | undefined;

    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      const body = route.request().postDataJSON();
      capturedMaxStops = body?.request?.filters?.maxStops;
      capturedMaxLayoverMinutes = body?.request?.filters?.maxLayoverMinutes;
      const offers = [
        buildOffer({ id: "offer-direct", amount: 500, comparisonMetrics: { totalDurationMinutes: 480, totalStops: 0 } }),
        buildLayoverOffer("offer-short-layover", 560, 120),
        buildTwoStopOffer("offer-two-stop", 680, 120, 300),
      ];

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "search-job-max-stops-layover",
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
              maxStops: body?.request?.filters?.maxStops,
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
        destination.value = "MIA - Miami, Usa";
        destination.dataset.code = "MIA";
        destination.dataset.label = "MIA - Miami, Usa";
      });
      await setDateValue(page, "departureDate", "2026-04-15");
      await setDateValue(page, "returnDate", "2026-04-22");

      await page.click("#layoverTrigger");
      await page.click('[data-max-stops-value="1"]');
      await page.click("#layoverTrigger");
      await page.click('[data-layover-value="240"]');
      await page.click("#submitButton");
      await page.waitForSelector('article[data-oid]');

      const probe = await page.evaluate(() => ({
        ids: [...document.querySelectorAll('article[data-oid]')].map((row) => row.getAttribute("data-oid")),
        layoverLabel: document.getElementById("layoverTriggerValue")?.textContent?.trim() ?? "",
        layoverActive: document.getElementById("layoverFilter")?.classList.contains("is-active") ?? false,
        layoverTitle: document.getElementById("layoverTrigger")?.getAttribute("title") ?? "",
      }));

      assert.equal(capturedMaxStops, 1);
      assert.equal(capturedMaxLayoverMinutes, 240);
      assert.deepEqual(probe.ids, ["offer-direct", "offer-short-layover"]);
      assert.equal(probe.layoverLabel, "Escala");
      assert.equal(probe.layoverActive, true);
      assert.equal(probe.layoverTitle, "1 escala / 4h");
  }, { autoOpen: false });
});

test("active scale filter reorders results before the selected cheapest sort", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      const body = route.request().postDataJSON();
      const offers = [
        buildTwoStopOffer("offer-two-stop-cheapest", 300, 60, 60),
        buildLayoverOffer("offer-one-stop-longer", 340, 180),
        buildLayoverOffer("offer-one-stop-shorter", 520, 60),
      ];

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "search-job-scale-priority",
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
    await page.waitForSelector('article[data-oid="offer-one-stop-shorter"]');

    const probe = await page.evaluate(() => ({
      ids: [...document.querySelectorAll('article[data-oid]')].map((row) => row.getAttribute("data-oid")),
      sortMode: (document.getElementById("sortMode") as HTMLSelectElement | null)?.value ?? "",
      activeSort: [...document.querySelectorAll("#sortButtons [data-sort]")]
        .find((button) => button.classList.contains("is-active"))
        ?.getAttribute("data-sort") ?? "",
    }));

    assert.deepEqual(probe.ids, [
      "offer-one-stop-shorter",
      "offer-one-stop-longer",
      "offer-two-stop-cheapest",
    ]);
    assert.equal(probe.sortMode, "cheapest");
    assert.equal(probe.activeSort, "cheapest");
  }, { autoOpen: false });
});

test("layover summary shows the maximum single layover instead of the combined total", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {

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
      await page.waitForSelector('article[data-oid="offer-double-4h"]');

      const probe = await page.evaluate(() => {
        const time = document.querySelector(".stops-stack__time")?.textContent?.trim() ?? "";
        const title = document.querySelector(".stops-stack")?.getAttribute("title") ?? "";
        return { time, title };
      });

      assert.match(probe.time, /^4h 0?0?m$/);
      assert.match(probe.title, /Escala máx\.: 4h 0?0?m/);
      assert.match(probe.title, /Bog: 4h 0?0?m/);
  }, { autoOpen: false });
});

test("changing layover selection does not shift the search rail layout", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
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
          layoverActive: document.getElementById("layoverFilter")?.classList.contains("is-active") ?? false,
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
          layoverActive: document.getElementById("layoverFilter")?.classList.contains("is-active") ?? false,
        };
      });

      assert.equal(before.layoverLabel, "Escala");
      assert.equal(after.layoverLabel, "Escala");
      assert.equal(before.layoverActive, false);
      assert.equal(after.layoverActive, true);
      assert.ok(Math.abs(after.railWidth - before.railWidth) < 1);
      assert.ok(Math.abs(after.originLeft - before.originLeft) < 1);
      assert.ok(Math.abs(after.submitRight - before.submitRight) < 1);
  }, { autoOpen: false });
});

test("submitting a search shows inline placeholders instead of a fullscreen overlay", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {

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
      await openDesktop(page, baseUrl);
      const initialToolbarOffset = await page.evaluate(() => {
        const toolbar = document.getElementById("resultsToolbar");
        const actions = toolbar?.querySelector(".panel-header__actions--results");
        if (!toolbar || !actions) {
          throw new Error("Missing results toolbar actions");
        }

        return Math.round(toolbar.getBoundingClientRect().right - actions.getBoundingClientRect().right);
      });

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
      assert.equal(await page.locator(".results-skeleton__header").count(), 0);
      assert.doesNotMatch(
        await page.locator("#resultsPanelMeta").textContent() ?? "",
        /Actualizando resultados/i,
      );
      assert.equal(await page.locator("#resultsPager").count(), 1);
      assert.equal(await page.locator("#resultsPager").isVisible(), true);
      assert.equal((await page.locator("#resultsPager .pager-label").textContent())?.trim(), "— / —");
      assert.equal(await page.locator('#resultsPager [data-results-page="prev"]').isDisabled(), true);
      assert.equal(await page.locator('#resultsPager [data-results-page="next"]').isDisabled(), true);

      const runningToolbarOffset = await page.evaluate(() => {
        const toolbar = document.getElementById("resultsToolbar");
        const actions = toolbar?.querySelector(".panel-header__actions--results");
        if (!toolbar || !actions) {
          throw new Error("Missing results toolbar actions");
        }

        return Math.round(toolbar.getBoundingClientRect().right - actions.getBoundingClientRect().right);
      });
      assert.ok(Math.abs(runningToolbarOffset - initialToolbarOffset) <= 1);

      await page.waitForSelector('article[data-oid="offer-1"]');
      assert.equal(await page.locator(".results-skeleton").count(), 0);
  }, { autoOpen: false });
});

test("provider link column shows both the provider link and missing-session feedback when needed", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {

    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "search-job-missing-session",
          searchComplete: true,
          searchStatus: "completed",
          sortMode: "cheapest",
          request: {
            tripType: "round-trip",
            searchMode: "exact",
            legs: [
              {
                origin: "LIM",
                destination: "MAD",
                departureDate: "2026-06-01",
                returnDate: "2026-06-08",
              },
            ],
            passengers: {
              adults: 1,
              children: 1,
              infants: 1,
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
          searchMeta: {
            ...buildSearchMeta("search_live"),
            providersUsed: ["agil-local", "costamar"],
            warnings: [
              "Costamar redirect token is missing, expired, or incompatible with this terminal.",
            ],
          },
          providerMeta: {
            exactProvider: "agil-local",
            coverageMode: "core",
          },
          warnings: [
            "Costamar redirect token is missing, expired, or incompatible with this terminal.",
          ],
        }),
      });
    });
      await openDesktop(page, baseUrl);
      await page.evaluate(() => {
        const origin = document.getElementById("origin") as HTMLInputElement | null;
        const destination = document.getElementById("destination") as HTMLInputElement | null;
        if (!origin || !destination) throw new Error("Missing location inputs");
        origin.value = "LIM - Lima, Peru";
        origin.dataset.code = "LIM";
        origin.dataset.label = "LIM - Lima, Peru";
        destination.value = "MAD - Madrid, España";
        destination.dataset.code = "MAD";
        destination.dataset.label = "MAD - Madrid, España";
      });
      await setDateValue(page, "departureDate", "2026-06-01");
      await setDateValue(page, "returnDate", "2026-06-08");

      await page.click("#submitButton");
      await page.waitForSelector('article[data-oid="offer-1"]');

      const linkCellText = await page.locator('article[data-oid="offer-1"] [data-result-links]').innerText();
      const layoutProbe = await page.locator('article[data-oid="offer-1"]').evaluate((row) => {
        const linkStack = row.querySelector("[data-result-links] .provider-links-cell") as HTMLElement | null;
        const dateCell = row.querySelector("[data-result-dates]") as HTMLElement | null;
        const dateStack = row.querySelector("[data-result-dates]") as HTMLElement | null;
        const stackChildren = linkStack ? Array.from(linkStack.children) as HTMLElement[] : [];
        const tops = stackChildren.map((item) => Math.round(item.getBoundingClientRect().top));
        const dateBounds = dateCell?.getBoundingClientRect();
        const dateStackBounds = dateStack?.getBoundingClientRect();

        return {
          linkDisplay: linkStack ? getComputedStyle(linkStack).display : "",
          stacked: tops.length > 1 ? tops[1] > tops[0] : false,
          itemCount: stackChildren.length,
          dateCenterDelta: dateBounds && dateStackBounds
            ? Math.abs(
              (dateBounds.top + (dateBounds.height / 2))
              - (dateStackBounds.top + (dateStackBounds.height / 2)),
            )
            : null,
        };
      });
      assert.match(linkCellText, /Agil/);
      assert.match(linkCellText, /Costamar:\s*Falta sesión/);
      assert.equal(layoutProbe.linkDisplay, "grid");
      assert.equal(layoutProbe.itemCount, 2);
      assert.equal(layoutProbe.stacked, true);
      assert.ok((layoutProbe.dateCenterDelta ?? 99) <= 6, JSON.stringify(layoutProbe));
      await page.click('article[data-oid="offer-1"]');
      await page.waitForSelector("#detailContent");
      assert.equal(await page.locator("#detailContent a.btn--ghost").count(), 1);
      assert.doesNotMatch(await page.locator("#detailContent").innerText(), /Buscar en Costamar/);
  }, { autoOpen: false });
});

test("empty results explain when Agil and Costamar could not be queried at all", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "search-job-provider-blocked",
          searchComplete: true,
          searchStatus: "completed",
          sortMode: "cheapest",
          request: {
            tripType: "one-way",
            searchMode: "exact",
            legs: [
              {
                origin: "IQT",
                destination: "LIM",
                departureDate: "2026-04-18",
              },
            ],
            passengers: {
              adults: 2,
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
          searchMeta: {
            ...buildSearchMeta("search_live"),
            providersUsed: ["agil-local", "costamar"],
            warnings: [
              "AGIL_APIM_SUBSCRIPTION_KEY is required for live Agil requests.",
              "Costamar terminalId is required.",
            ],
          },
          providerMeta: {
            exactProvider: "agil-local",
            coverageMode: "core",
          },
          warnings: [
            "AGIL_APIM_SUBSCRIPTION_KEY is required for live Agil requests.",
            "Costamar terminalId is required.",
          ],
        }),
      });
    });

    await openDesktop(page, baseUrl);
    await page.click('[data-trip="one-way"]');
    await page.evaluate(() => {
      const origin = document.getElementById("origin") as HTMLInputElement | null;
      const destination = document.getElementById("destination") as HTMLInputElement | null;
      const adults = document.getElementById("adults") as HTMLInputElement | null;
      if (!origin || !destination) throw new Error("Missing location inputs");
      if (!adults) throw new Error("Missing adults input");
      origin.value = "Aeropuerto C.F. Secada, Iquitos, Perú (IQT)";
      origin.dataset.code = "IQT";
      origin.dataset.label = "Aeropuerto C.F. Secada, Iquitos, Perú (IQT)";
      destination.value = "Aeropuerto Internacional Jorge Chavez, Lima, Perú (LIM)";
      destination.dataset.code = "LIM";
      destination.dataset.label = "Aeropuerto Internacional Jorge Chavez, Lima, Perú (LIM)";
      adults.value = "2";
    });
    await setDateValue(page, "departureDate", "2026-04-18");

    await page.click("#submitButton");
    await page.waitForSelector(".results-panel .empty-panel");

    const emptyTitle = await page.locator(".results-panel .empty-panel__title").innerText();
    const emptyText = await page.locator(".results-panel .empty-panel__text").innerText();
    const emptyHint = await page.locator(".results-panel .empty-panel__hint").innerText();

    assert.match(emptyTitle, /No se pudo consultar Agil y Costamar/);
    assert.match(emptyText, /no logró entrar a los proveedores necesarios/i);
    assert.match(emptyHint, /Agil no tiene AGIL_APIM_SUBSCRIPTION_KEY cargada/i);
    assert.match(emptyHint, /Costamar no tiene un terminal activo o recuperable/i);
    assert.doesNotMatch(emptyHint, /Prueba quitando Directo/i);
  }, { autoOpen: false });
});

test("provider link column keeps external redirects available when nonstop is only enforced in Fly Desk", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {

    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      const body = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "search-job-local-filter-links",
          searchComplete: true,
          searchStatus: "completed",
          sortMode: "cheapest",
          request: {
            tripType: "round-trip",
            searchMode: "exact",
            legs: [
              {
                origin: "LIM",
                destination: "MAD",
                departureDate: "2026-06-01",
                returnDate: "2026-06-08",
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
              nonStop: body?.request?.filters?.nonStop,
            },
            coverageMode: "core",
            redirectMode: "best-effort",
            currencyCode: "USD",
            locale: "es-PE",
            market: "PE",
          },
          offers: [buildOffer()],
          allOffers: [buildOffer()],
          searchMeta: {
            ...buildSearchMeta("search_live"),
            providersUsed: ["agil-local", "costamar"],
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
      await page.evaluate(() => {
        const origin = document.getElementById("origin") as HTMLInputElement | null;
        const destination = document.getElementById("destination") as HTMLInputElement | null;
        if (!origin || !destination) throw new Error("Missing location inputs");
        origin.value = "LIM - Lima, Peru";
        origin.dataset.code = "LIM";
        origin.dataset.label = "LIM - Lima, Peru";
        destination.value = "MAD - Madrid, España";
        destination.dataset.code = "MAD";
        destination.dataset.label = "MAD - Madrid, España";
      });
      await setDateValue(page, "departureDate", "2026-06-01");
      await setDateValue(page, "returnDate", "2026-06-08");
      await page.check("#nonStop");

      await page.click("#submitButton");
      await page.waitForSelector('article[data-oid="offer-1"]');

      const linkCell = page.locator('article[data-oid="offer-1"] [data-result-links]');
      const linkCellText = await linkCell.innerText();
      assert.match(linkCellText, /Agil/);
      assert.doesNotMatch(linkCellText, /Filtro local/);
      assert.equal(await linkCell.locator("a.row-link").count(), 1);
      assert.equal(await linkCell.locator('a.row-link').first().getAttribute("href"), "https://example.test/agil");
      assert.equal(await page.locator("#detailContent a.btn--ghost").count(), 1);
  }, { autoOpen: false });
});

test("provider link column reuses the matched Costamar link for the same flight when the total matches", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {

    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      const agilOffer = buildOffer({
        id: "offer-agil",
        providerSource: "agil-local",
        mainCarrier: "IB",
        validatingCarrier: "IB",
        price: {
          total: {
            amount: 512,
            currencyCode: "USD",
          },
        },
        purchasePaths: [
          {
            provider: "agil-local",
            type: "deep-link",
            label: "Agil",
            url: "https://example.test/agil",
            precision: "exact-search",
            score: 0.9,
          },
        ],
        itineraries: [
          {
            direction: "outbound",
            durationMinutes: 480,
            stops: 0,
            segments: [
              {
                marketingCarrier: "IB",
                flightNumber: "IB124",
                origin: "LIM",
                destination: "MAD",
                departureAt: "2026-06-01T11:00:00",
                arrivalAt: "2026-06-02T05:40:00",
              },
            ],
          },
          {
            direction: "inbound",
            durationMinutes: 470,
            stops: 0,
            segments: [
              {
                marketingCarrier: "IB",
                flightNumber: "IB121",
                origin: "MAD",
                destination: "LIM",
                departureAt: "2026-06-08T00:05:00",
                arrivalAt: "2026-06-08T05:30:00",
              },
            ],
          },
        ],
      });

      const costamarOffer = buildOffer({
        id: "offer-costamar",
        providerSource: "costamar",
        mainCarrier: "IB",
        validatingCarrier: "IB",
        price: {
          total: {
            amount: 512,
            currencyCode: "USD",
          },
        },
        purchasePaths: [
          {
            provider: "costamar",
            type: "deep-link",
            label: "Costamar",
            url: "https://example.test/costamar",
            precision: "exact-search",
            score: 0.9,
          },
        ],
        itineraries: [
          {
            direction: "outbound",
            durationMinutes: 480,
            stops: 0,
            segments: [
              {
                marketingCarrier: "ib",
                flightNumber: "IB124",
                origin: "lim",
                destination: "mad",
                departureAt: "2026-06-01T11:00:00.000-0500",
                arrivalAt: "2026-06-02T05:40:00.000-0500",
              },
            ],
          },
          {
            direction: "inbound",
            durationMinutes: 470,
            stops: 0,
            segments: [
              {
                marketingCarrier: "ib",
                flightNumber: "IB121",
                origin: "mad",
                destination: "lim",
                departureAt: "2026-06-08T00:05:00.000-0500",
                arrivalAt: "2026-06-08T05:30:00.000-0500",
              },
            ],
          },
        ],
      });

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "search-job-match-links",
          searchComplete: true,
          searchStatus: "completed",
          sortMode: "cheapest",
          request: {
            tripType: "round-trip",
            searchMode: "exact",
            legs: [
              {
                origin: "LIM",
                destination: "MAD",
                departureDate: "2026-06-01",
                returnDate: "2026-06-08",
              },
            ],
            passengers: {
              adults: 1,
              children: 1,
              infants: 1,
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
          offers: [agilOffer, costamarOffer],
          allOffers: [agilOffer, costamarOffer],
          searchMeta: {
            ...buildSearchMeta("search_live"),
            providersUsed: ["agil-local", "costamar"],
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
      await page.evaluate(() => {
        const origin = document.getElementById("origin") as HTMLInputElement | null;
        const destination = document.getElementById("destination") as HTMLInputElement | null;
        if (!origin || !destination) throw new Error("Missing location inputs");
        origin.value = "LIM - Lima, Peru";
        origin.dataset.code = "LIM";
        origin.dataset.label = "LIM - Lima, Peru";
        destination.value = "MAD - Madrid, España";
        destination.dataset.code = "MAD";
        destination.dataset.label = "MAD - Madrid, España";
      });
      await setDateValue(page, "departureDate", "2026-06-01");
      await setDateValue(page, "returnDate", "2026-06-08");

      await page.click("#submitButton");
      await page.waitForSelector('article[data-oid="offer-agil"]');

      const linkCellText = await page.locator('article[data-oid="offer-agil"] [data-result-links]').innerText();
      assert.match(linkCellText, /Agil/);
      assert.match(linkCellText, /Costamar/);
  }, { autoOpen: false });
});

test("provider link column keeps each provider on its own fare when matched flights have different totals", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {

    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      const agilOffer = buildOffer({
        id: "offer-agil",
        providerSource: "agil-local",
        mainCarrier: "LA",
        validatingCarrier: "LA",
        price: {
          total: {
            amount: 391.74,
            currencyCode: "USD",
          },
        },
        purchasePaths: [
          {
            provider: "agil-local",
            type: "deep-link",
            label: "Agil",
            url: "https://example.test/agil",
            precision: "exact-search",
            score: 0.9,
          },
        ],
        itineraries: [
          {
            direction: "outbound",
            durationMinutes: 95,
            stops: 0,
            segments: [
              {
                marketingCarrier: "LA",
                flightNumber: "LA2041",
                origin: "PIU",
                destination: "LIM",
                departureAt: "2026-10-06T08:10:00",
                arrivalAt: "2026-10-06T09:45:00",
              },
            ],
          },
          {
            direction: "inbound",
            durationMinutes: 95,
            stops: 0,
            segments: [
              {
                marketingCarrier: "LA",
                flightNumber: "LA2040",
                origin: "LIM",
                destination: "PIU",
                departureAt: "2026-10-08T18:00:00",
                arrivalAt: "2026-10-08T19:35:00",
              },
            ],
          },
        ],
      });

      const costamarOffer = buildOffer({
        id: "offer-costamar",
        providerSource: "costamar",
        mainCarrier: "LA",
        validatingCarrier: "LA",
        price: {
          total: {
            amount: 427.2,
            currencyCode: "USD",
          },
        },
        purchasePaths: [
          {
            provider: "costamar",
            type: "deep-link",
            label: "Costamar",
            url: "https://example.test/costamar",
            precision: "exact-search",
            score: 0.9,
          },
        ],
        itineraries: [
          {
            direction: "outbound",
            durationMinutes: 95,
            stops: 0,
            segments: [
              {
                marketingCarrier: "LA",
                flightNumber: "LA2041",
                origin: "PIU",
                destination: "LIM",
                departureAt: "2026-10-06T08:10:00.000-0500",
                arrivalAt: "2026-10-06T09:45:00.000-0500",
              },
            ],
          },
          {
            direction: "inbound",
            durationMinutes: 95,
            stops: 0,
            segments: [
              {
                marketingCarrier: "LA",
                flightNumber: "LA2040",
                origin: "LIM",
                destination: "PIU",
                departureAt: "2026-10-08T18:00:00.000-0500",
                arrivalAt: "2026-10-08T19:35:00.000-0500",
              },
            ],
          },
        ],
      });

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "search-job-link-price-guard",
          searchComplete: true,
          searchStatus: "completed",
          sortMode: "cheapest",
          request: {
            tripType: "round-trip",
            searchMode: "exact",
            legs: [
              {
                origin: "PIU",
                destination: "LIM",
                departureDate: "2026-10-06",
                returnDate: "2026-10-08",
              },
            ],
            passengers: {
              adults: 3,
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
          offers: [agilOffer, costamarOffer],
          allOffers: [agilOffer, costamarOffer],
          searchMeta: {
            ...buildSearchMeta("search_live"),
            providersUsed: ["agil-local", "costamar"],
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
      await page.evaluate(() => {
        const origin = document.getElementById("origin") as HTMLInputElement | null;
        const destination = document.getElementById("destination") as HTMLInputElement | null;
        if (!origin || !destination) throw new Error("Missing location inputs");
        origin.value = "PIU - Piura, Peru";
        origin.dataset.code = "PIU";
        origin.dataset.label = "PIU - Piura, Peru";
        destination.value = "LIM - Lima, Peru";
        destination.dataset.code = "LIM";
        destination.dataset.label = "LIM - Lima, Peru";
      });
      await setDateValue(page, "departureDate", "2026-10-06");
      await setDateValue(page, "returnDate", "2026-10-08");
      await page.click("#submitButton");
      await page.waitForSelector('article[data-oid="offer-agil"]');
      await page.click('article[data-oid="offer-agil"]');

      const linkCellText = await page.locator('article[data-oid="offer-agil"] [data-result-links]').innerText();
      assert.match(linkCellText, /Agil/);
      assert.doesNotMatch(linkCellText, /Costamar/);
      assert.doesNotMatch(await page.locator("#detailContent").innerText(), /Costamar/);
  }, { autoOpen: false });
});

test("provider link column keeps baggage-unknown fares from borrowing a different provider link", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      const agilOffer = buildOffer({
        id: "offer-agil",
        providerSource: "agil-local",
        origin: "LIM",
        destination: "MAD",
        mainCarrier: "LA",
        validatingCarrier: "LA",
        baggage: {
          carryOnIncluded: false,
          checkedIncluded: false,
        },
        price: {
          total: {
            amount: 512,
            currencyCode: "USD",
          },
        },
        purchasePaths: [
          {
            provider: "agil-local",
            type: "deep-link",
            label: "Agil",
            url: "https://example.test/agil",
            precision: "exact-search",
            score: 0.9,
          },
        ],
        itineraries: [
          {
            direction: "outbound",
            durationMinutes: 95,
            stops: 0,
            segments: [
              {
                marketingCarrier: "LA",
                flightNumber: "LA2041",
                origin: "LIM",
                destination: "MAD",
                departureAt: "2026-10-06T08:10:00",
                arrivalAt: "2026-10-06T09:45:00",
              },
            ],
          },
          {
            direction: "inbound",
            durationMinutes: 95,
            stops: 0,
            segments: [
              {
                marketingCarrier: "LA",
                flightNumber: "LA2040",
                origin: "MAD",
                destination: "LIM",
                departureAt: "2026-10-08T18:00:00",
                arrivalAt: "2026-10-08T19:35:00",
              },
            ],
          },
        ],
      });

      const costamarOffer = buildOffer({
        id: "offer-costamar",
        providerSource: "costamar",
        origin: "lim",
        destination: "mad",
        mainCarrier: "LA",
        validatingCarrier: "LA",
        baggage: {},
        price: {
          total: {
            amount: 512,
            currencyCode: "USD",
          },
        },
        purchasePaths: [
          {
            provider: "costamar",
            type: "deep-link",
            label: "Costamar",
            url: "https://example.test/costamar",
            precision: "exact-search",
            score: 0.9,
          },
        ],
        itineraries: [
          {
            direction: "outbound",
            durationMinutes: 95,
            stops: 0,
            segments: [
              {
                marketingCarrier: "la",
                flightNumber: "LA2041",
                origin: "lim",
                destination: "mad",
                departureAt: "2026-10-06T08:10:00.000-0500",
                arrivalAt: "2026-10-06T09:45:00.000-0500",
              },
            ],
          },
          {
            direction: "inbound",
            durationMinutes: 95,
            stops: 0,
            segments: [
              {
                marketingCarrier: "la",
                flightNumber: "LA2040",
                origin: "mad",
                destination: "lim",
                departureAt: "2026-10-08T18:00:00.000-0500",
                arrivalAt: "2026-10-08T19:35:00.000-0500",
              },
            ],
          },
        ],
      });

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "search-job-baggage-guard",
          searchComplete: true,
          searchStatus: "completed",
          sortMode: "cheapest",
          request: {
            tripType: "round-trip",
            searchMode: "exact",
            legs: [
              {
                origin: "LIM",
                destination: "MAD",
                departureDate: "2026-10-06",
                returnDate: "2026-10-08",
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
          offers: [agilOffer, costamarOffer],
          allOffers: [agilOffer, costamarOffer],
          searchMeta: {
            ...buildSearchMeta("search_live"),
            providersUsed: ["agil-local", "costamar"],
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
    await page.evaluate(() => {
      const origin = document.getElementById("origin") as HTMLInputElement | null;
      const destination = document.getElementById("destination") as HTMLInputElement | null;
      if (!origin || !destination) throw new Error("Missing location inputs");
      origin.value = "LIM - Lima, Peru";
      origin.dataset.code = "LIM";
      origin.dataset.label = "LIM - Lima, Peru";
      destination.value = "MAD - Madrid, España";
      destination.dataset.code = "MAD";
      destination.dataset.label = "MAD - Madrid, España";
    });
    await setDateValue(page, "departureDate", "2026-10-06");
    await setDateValue(page, "returnDate", "2026-10-08");

    await page.click("#submitButton");
    await page.waitForSelector('article[data-oid="offer-agil"]');

    const linkCellText = await page.locator('article[data-oid="offer-agil"] [data-result-links]').innerText();
    assert.match(linkCellText, /Agil/);
    assert.doesNotMatch(linkCellText, /Costamar/);
  }, { autoOpen: false });
});

test("progressive list searches keep the visible list compact while results are still streaming", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    let pollCount = 0;

    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "search-job-streaming",
          searchComplete: false,
          searchStatus: "running",
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
          searchMeta: buildSearchMeta(),
          providerMeta: {
            exactProvider: "agil-local",
            coverageMode: "core",
          },
          warnings: [],
        }),
      });
    });

    await page.route(`${baseUrl}/api/search/search-job-streaming`, async (route: Route) => {
      pollCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "search-job-streaming",
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
      await page.waitForSelector('article[data-oid="offer-1"]');

      const placeholderCountWhileRunning = await page.locator(".results-card--placeholder").count();
      assert.equal(await page.locator('#resultsContainer [data-results-scroll]').getAttribute("aria-busy"), "true");
      assert.equal(placeholderCountWhileRunning, 0);

      await page.waitForFunction(() => (
        document.querySelector('#resultsContainer [data-results-scroll]')?.getAttribute("aria-busy") === "false"
      ));

      assert.equal(pollCount > 0, true);
  }, { autoOpen: false });
});

test("progressive nonstop searches keep visible results stable after polling finishes", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    let pollCount = 0;

    const directOne = buildOffer({
      id: "offer-direct-1",
      price: {
        total: {
          amount: 710,
          currencyCode: "USD",
        },
        base: {
          amount: 620,
          currencyCode: "USD",
        },
        taxes: {
          amount: 90,
          currencyCode: "USD",
        },
      },
    });
    const directTwo = buildOffer({
      id: "offer-direct-2",
      price: {
        total: {
          amount: 740,
          currencyCode: "USD",
        },
        base: {
          amount: 650,
          currencyCode: "USD",
        },
        taxes: {
          amount: 90,
          currencyCode: "USD",
        },
      },
    });
    const layoverOne = buildLayoverOffer("offer-layover-1", 320, 120);
    const layoverTwo = buildLayoverOffer("offer-layover-2", 340, 180);

    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "search-job-nonstop-streaming",
          searchComplete: false,
          searchStatus: "running",
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
              maxResults: 2,
              nonStop: true,
            },
            coverageMode: "core",
            redirectMode: "best-effort",
            currencyCode: "USD",
            locale: "es-PE",
            market: "PE",
          },
          offers: [directOne, directTwo],
          allOffers: [directOne, directTwo],
          searchMeta: buildSearchMeta(),
          providerMeta: {
            exactProvider: "agil-local",
            coverageMode: "core",
          },
          warnings: [],
        }),
      });
    });

    await page.route(`${baseUrl}/api/search/search-job-nonstop-streaming`, async (route: Route) => {
      pollCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "search-job-nonstop-streaming",
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
              maxResults: 2,
              nonStop: true,
            },
            coverageMode: "core",
            redirectMode: "best-effort",
            currencyCode: "USD",
            locale: "es-PE",
            market: "PE",
          },
          offers: [directOne, directTwo],
          allOffers: [layoverOne, layoverTwo],
          searchMeta: buildSearchMeta("search_live"),
          providerMeta: {
            exactProvider: "agil-local",
            coverageMode: "core",
          },
          warnings: [],
        }),
      });
    });

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
    await page.check("#nonStop");

    await page.click("#submitButton");
    await page.waitForSelector('article[data-oid="offer-direct-1"]');

    const initialIds = await page.locator("#resultsContainer article[data-oid]").evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-oid")),
    );
    assert.deepEqual(initialIds, ["offer-direct-1", "offer-direct-2"]);

    await page.waitForFunction(() => (
      document.querySelector('#resultsContainer [data-results-scroll]')?.getAttribute("aria-busy") === "false"
    ));

    const finalProbe = await page.evaluate(() => ({
      ids: [...document.querySelectorAll("#resultsContainer article[data-oid]")]
        .map((row) => row.getAttribute("data-oid")),
      resultPill: document.getElementById("resultPill")?.textContent?.trim() ?? "",
      hasEmptyPanel: Boolean(document.querySelector(".results-panel .empty-panel")),
    }));

    assert.equal(pollCount > 0, true);
    assert.deepEqual(finalProbe.ids, ["offer-direct-1", "offer-direct-2"]);
    assert.equal(finalProbe.resultPill, "2 ofertas");
    assert.equal(finalProbe.hasEmptyPanel, false);
  }, { autoOpen: false });
});

test("changing sort reorders mixed-height result rows without breaking the visible list", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    const groupedPrimary = buildOfferWithDates("offer-primary", "2026-04-15", "2026-04-22");
    const groupedAlt = buildOfferWithDates("offer-alt", "2026-04-16", "2026-04-23");
    const groupedOffers = [groupedPrimary, groupedAlt].map((offer) => ({
      ...offer,
      comparisonMetrics: {
        ...offer.comparisonMetrics,
        totalDurationMinutes: 900,
      },
      price: {
        ...offer.price,
        total: {
          amount: 350,
          currencyCode: "USD",
        },
        base: {
          amount: 270,
          currencyCode: "USD",
        },
        taxes: {
          amount: 80,
          currencyCode: "USD",
        },
      },
      itineraries: (offer.itineraries ?? []).map((itinerary) => ({
        ...itinerary,
        durationMinutes: itinerary.direction === "outbound" ? 470 : 430,
      })),
    }));

    const fastSingles = Array.from({ length: 24 }, (_, index) => buildOffer({
      id: `offer-single-${index + 1}`,
      comparisonMetrics: {
        totalDurationMinutes: 540 + index,
        totalStops: 0,
      },
      price: {
        total: {
          amount: 500 + index,
          currencyCode: "USD",
        },
        base: {
          amount: 420 + index,
          currencyCode: "USD",
        },
        taxes: {
          amount: 80,
          currencyCode: "USD",
        },
      },
      itineraries: [
        {
          direction: "outbound",
          durationMinutes: 270 + index,
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
          durationMinutes: 270,
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
    }));

    const offers = [...groupedOffers, ...fastSingles];

    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "search-job-row-heights",
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
    await page.waitForSelector('article[data-oid="offer-primary"]');

    const cheapestView = await page.evaluate(() => ({
      rowCount: document.querySelectorAll("#resultsContainer article[data-oid]").length,
      firstId: document.querySelector("#resultsContainer article[data-oid]")?.getAttribute("data-oid") ?? "",
      pagerLabel: document.querySelector("#resultsPager .pager-label")?.textContent?.trim() ?? "",
    }));

    await page.click('[data-sort="fastest"]');
    await page.waitForFunction(() => (
      document.querySelector("#resultsContainer article[data-oid]")?.getAttribute("data-oid") === "offer-single-1"
    ));

    const fastestView = await page.evaluate(() => ({
      rowCount: document.querySelectorAll("#resultsContainer article[data-oid]").length,
      firstId: document.querySelector("#resultsContainer article[data-oid]")?.getAttribute("data-oid") ?? "",
      pagerLabel: document.querySelector("#resultsPager .pager-label")?.textContent?.trim() ?? "",
    }));

    assert.equal(cheapestView.firstId, "offer-primary");
    assert.equal(cheapestView.rowCount > 0, true);
    assert.equal(cheapestView.pagerLabel.startsWith("1 /"), true);
    assert.equal(fastestView.firstId, "offer-single-1");
    assert.equal(fastestView.rowCount > 0, true);
    assert.equal(fastestView.pagerLabel.startsWith("1 /"), true);
  }, { autoOpen: false });
});

test("results pager updates the page label and arrow states when navigating", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    const pagedOffers = Array.from({ length: 40 }, (_, index) => buildOffer({
      id: `offer-${index + 1}`,
      price: {
        total: {
          amount: 400 + index,
          currencyCode: "USD",
        },
        base: {
          amount: 320 + index,
          currencyCode: "USD",
        },
        taxes: {
          amount: 80,
          currencyCode: "USD",
        },
      },
    }));

    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "search-job-pager",
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
              maxResults: 40,
            },
            coverageMode: "core",
            redirectMode: "best-effort",
            currencyCode: "USD",
            locale: "es-PE",
            market: "PE",
          },
          offers: pagedOffers,
          allOffers: pagedOffers,
          searchMeta: buildSearchMeta("search_live"),
          providerMeta: {
            exactProvider: "agil-local",
            coverageMode: "core",
          },
          warnings: [],
        }),
      });
    });

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
    await page.waitForSelector("#resultsPager .pager-label");

    const initialPager = await page.evaluate(() => ({
      label: document.querySelector("#resultsPager .pager-label")?.textContent?.trim() ?? "",
      prevDisabled: (document.querySelector('#resultsPager [data-results-page=\"prev\"]') as HTMLButtonElement | null)?.disabled ?? null,
      nextDisabled: (document.querySelector('#resultsPager [data-results-page=\"next\"]') as HTMLButtonElement | null)?.disabled ?? null,
      width: document.getElementById("resultsPager")?.getBoundingClientRect().width ?? 0,
      left: document.getElementById("resultsPager")?.getBoundingClientRect().left ?? 0,
      toolbarCenter: (() => {
        const bounds = document.getElementById("resultsToolbar")?.getBoundingClientRect();
        return bounds ? bounds.left + (bounds.width / 2) : 0;
      })(),
    }));

    await page.click('#resultsPager [data-results-page="next"]');

    const nextPager = await page.evaluate(() => ({
      label: document.querySelector("#resultsPager .pager-label")?.textContent?.trim() ?? "",
      prevDisabled: (document.querySelector('#resultsPager [data-results-page=\"prev\"]') as HTMLButtonElement | null)?.disabled ?? null,
      nextDisabled: (document.querySelector('#resultsPager [data-results-page=\"next\"]') as HTMLButtonElement | null)?.disabled ?? null,
      width: document.getElementById("resultsPager")?.getBoundingClientRect().width ?? 0,
      left: document.getElementById("resultsPager")?.getBoundingClientRect().left ?? 0,
      toolbarCenter: (() => {
        const bounds = document.getElementById("resultsToolbar")?.getBoundingClientRect();
        return bounds ? bounds.left + (bounds.width / 2) : 0;
      })(),
    }));

    assert.equal(initialPager.label.startsWith("1 /"), true);
    assert.equal(initialPager.prevDisabled, true);
    assert.equal(initialPager.nextDisabled, false);
    assert.equal(Math.abs((initialPager.left + (initialPager.width / 2)) - initialPager.toolbarCenter) < 1, true);
    assert.equal(nextPager.label.startsWith("2 /"), true);
    assert.equal(nextPager.prevDisabled, false);
    assert.equal(Math.abs((nextPager.left + (nextPager.width / 2)) - nextPager.toolbarCenter) < 1, true);
    assert.equal(Math.abs(nextPager.width - initialPager.width) < 1.5, true);
  }, { autoOpen: false });
});

test("quotation renders a single commercial text area and auto-copies it", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    const normalizeClipboardText = (value: string) => value.replace(/\r\n/g, "\n");
    const commercialText = [
      "COTIZACION BOLETO AEREO",
      "",
      "Ruta comercial para cliente",
    ].join("\n");

    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "search-job-quotation",
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

    await page.route(`${baseUrl}/api/quotation`, async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchSessionId: "search-job-quotation",
          offer: buildOffer({
            priceConfidence: "validated",
          }),
          commercialText,
        }),
      });
    });

    await openDesktop(page, baseUrl);
    await page.evaluate(() => navigator.clipboard.writeText("clipboard inicial"));
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
    await page.waitForSelector('article[data-oid="offer-1"]');

    await page.click("#quotationButton");
    await page.waitForFunction(() => {
      const textareas = [...document.querySelectorAll(".quote-textarea")] as HTMLTextAreaElement[];
      return textareas.length === 1;
    });

    const quotationState = await page.evaluate(async () => {
      const textareas = [...document.querySelectorAll(".quote-textarea")] as HTMLTextAreaElement[];
      const sectionTitles = [...document.querySelectorAll(".detail-section__title")]
        .map((node) => node.textContent?.trim() ?? "");
      return {
        textareaValues: textareas.map((node) => node.value),
        sectionTitles,
        clipboard: await navigator.clipboard.readText(),
      };
    });

    assert.ok(quotationState.sectionTitles.includes("Cotización comercial"));
    assert.ok(!quotationState.sectionTitles.includes("Detalle técnico"));
    assert.deepEqual(quotationState.textareaValues, [commercialText]);
    assert.equal(normalizeClipboardText(quotationState.clipboard), commercialText);
  }, {
    autoOpen: false,
    createPage: async ({ baseUrl, browser }) => {
      const context = await browser.newContext();
      await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
      return context.newPage();
    },
  });
});

test("quotation state clears when selecting another offer and ignores late responses for a stale selection", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    const offerOne = buildOffer({
      id: "offer-1",
      mainCarrier: "LA",
      validatingCarrier: "LA",
      price: {
        total: {
          amount: 512,
          currencyCode: "USD",
        },
      },
    });
    const offerTwo = buildOffer({
      id: "offer-2",
      mainCarrier: "AA",
      validatingCarrier: "AA",
      price: {
        total: {
          amount: 640,
          currencyCode: "USD",
        },
      },
      purchasePaths: [
        {
          provider: "agil-local",
          type: "deep-link",
          label: "Agil",
          url: "https://example.test/agil-2",
        },
      ],
    });

    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "search-job-quotation-stale",
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
          offers: [offerOne, offerTwo],
          allOffers: [offerOne, offerTwo],
          searchMeta: buildSearchMeta("search_live"),
          providerMeta: {
            exactProvider: "agil-local",
            coverageMode: "core",
          },
          warnings: [],
        }),
      });
    });

    await page.route(`${baseUrl}/api/quotation`, async (route: Route) => {
      const payload = route.request().postDataJSON() as { offerId?: string };
      if (payload.offerId === "offer-2") {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      const label = payload.offerId === "offer-2" ? "Oferta 2" : "Oferta 1";
      const offer = payload.offerId === "offer-2" ? offerTwo : offerOne;

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchSessionId: "search-job-quotation-stale",
          offer,
          commercialText: `COTIZACION BOLETO AEREO\n\n${label}`,
        }),
      });
    });

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
    await page.waitForSelector('article[data-oid="offer-1"]');
    await page.waitForSelector('article[data-oid="offer-2"]');

    await page.click("#quotationButton");
    await page.waitForFunction(() => {
      return [...document.querySelectorAll(".quote-textarea")].some((node) => (
        (node as HTMLTextAreaElement).value.includes("Oferta 1")
      ));
    });

    await page.click('article[data-oid="offer-2"]');
    await page.waitForFunction(() => document.querySelectorAll(".quote-textarea").length === 0);

    await page.click("#quotationButton");
    await page.click('article[data-oid="offer-1"]');
    await page.waitForTimeout(400);

    const quotationProbe = await page.evaluate(() => ({
      selectedOfferId: document.querySelector('article.is-active[data-oid]')?.getAttribute("data-oid") ?? "",
      textareaValues: [...document.querySelectorAll(".quote-textarea")]
        .map((node) => (node as HTMLTextAreaElement).value),
    }));

    assert.equal(quotationProbe.selectedOfferId, "offer-1");
    assert.equal(quotationProbe.textareaValues.length, 0);
  }, { autoOpen: false });
});

test("detail panel wraps long segment and baggage content without horizontal scroll", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    const offer = buildOffer({
      id: "offer-long-detail",
      mainCarrier: "UA",
      validatingCarrier: "UA",
      comparisonMetrics: {
        totalDurationMinutes: 2890,
        totalStops: 2,
      },
      price: {
        total: {
          amount: 1764.34,
          currencyCode: "USD",
        },
      },
      baggage: {
        carryOnIncluded: true,
        checkedIncluded: true,
        checkedBags: 1,
        description: "1 pieza de 23 kg con condiciones operativas del proveedor",
      },
      itineraries: [
        {
          direction: "outbound",
          durationMinutes: 2890,
          stops: 2,
          segments: [
            {
              id: "seg-ua-1",
              marketingCarrier: "UA",
              marketingCarrierName: "United Airlines",
              flightNumber: "855",
              origin: "LIM",
              originName: "LIMA",
              destination: "IAH",
              destinationName: "HOUSTON - GEORGE BUSH INTERCONTINENTAL",
              departureAt: "2026-04-25T00:55:00Z",
              arrivalAt: "2026-04-25T07:05:00Z",
              durationMinutes: 370,
            },
            {
              id: "seg-ua-2",
              marketingCarrier: "UA",
              marketingCarrierName: "United Airlines",
              flightNumber: "512",
              origin: "IAH",
              originName: "HOUSTON - GEORGE BUSH INTERCONTINENTAL",
              destination: "DCA",
              destinationName: "WASHINGTON - RONALD REAGAN WASHINGTON NATIONAL",
              departureAt: "2026-04-26T07:55:00Z",
              arrivalAt: "2026-04-26T11:05:00Z",
              durationMinutes: 190,
            },
            {
              id: "seg-ua-3",
              marketingCarrier: "UA",
              marketingCarrierName: "United Airlines",
              flightNumber: "260",
              origin: "IAD",
              originName: "WASHINGTON - WASHINGTON DULLES",
              destination: "MAD",
              destinationName: "MADRID",
              departureAt: "2026-04-26T18:55:00Z",
              arrivalAt: "2026-04-27T08:05:00Z",
              durationMinutes: 430,
            },
          ],
        },
      ],
    });

    await page.route(`${baseUrl}/api/search`, async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "search-job-long-detail",
          searchComplete: true,
          searchStatus: "completed",
          sortMode: "cheapest",
          request: {
            tripType: "one-way",
            searchMode: "exact",
            legs: [
              {
                origin: "LIM",
                destination: "MAD",
                departureDate: "2026-04-25",
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
          offers: [offer],
          allOffers: [offer],
          searchMeta: buildSearchMeta("search_live"),
          providerMeta: {
            exactProvider: "agil-local",
            coverageMode: "core",
          },
          warnings: [],
        }),
      });
    });

    await openDesktop(page, baseUrl);
    await page.click('[data-trip="one-way"]');
    await setRouteInputs(page, "LIM", "MAD");
    await setDateValue(page, "departureDate", "2026-04-25");

    await submitAndWaitForRequest(page, baseUrl, "/api/search");
    await page.waitForSelector('article[data-oid="offer-long-detail"]');
    await page.click('article[data-oid="offer-long-detail"]');
    await page.waitForSelector("#detailContent .detail-layover__label");

    const overflowProbe = await page.evaluate(() => {
      const body = document.querySelector(".detail-panel__body") as HTMLElement | null;
      const content = document.getElementById("detailContent") as HTMLElement | null;
      const layoverLabels = Array.from(document.querySelectorAll(".detail-layover__label")) as HTMLElement[];

      return {
        bodyClientWidth: body?.clientWidth ?? 0,
        bodyScrollWidth: body?.scrollWidth ?? 0,
        contentClientWidth: content?.clientWidth ?? 0,
        contentScrollWidth: content?.scrollWidth ?? 0,
        layoverWraps: layoverLabels.every((label) => label.scrollWidth <= label.clientWidth + 1),
      };
    });

    assert.equal(overflowProbe.bodyScrollWidth <= overflowProbe.bodyClientWidth + 1, true, JSON.stringify(overflowProbe));
    assert.equal(overflowProbe.contentScrollWidth <= overflowProbe.contentClientWidth + 1, true, JSON.stringify(overflowProbe));
    assert.equal(overflowProbe.layoverWraps, true, JSON.stringify(overflowProbe));
  }, { autoOpen: false });
});





