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
        skeletonHeaderCount: document.querySelectorAll("#resultsContainer .results-skeleton__header").length,
      }));

      assert.equal(probe.skeletonCount, 1);
      assert.equal(probe.emptyStateCount, 0);
      assert.equal(probe.busy, "false");
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
      const expectedMaxResults = await page.evaluate(() => {
        const viewport = document.querySelector("#resultsContainer .table-wrap") ?? document.getElementById("resultsContainer");
        const header = viewport?.querySelector("thead");
        const row = viewport?.querySelector("tbody tr.results-row--placeholder");
        if (!(viewport instanceof HTMLElement) || !(header instanceof HTMLElement) || !(row instanceof HTMLElement)) {
          throw new Error("Missing results viewport measurements");
        }

        const availableHeight = Math.max(
          row.getBoundingClientRect().height,
          viewport.clientHeight - header.getBoundingClientRect().height,
        );
        const visibleRows = Math.max(1, Math.floor((availableHeight + 1) / row.getBoundingClientRect().height));
        return visibleRows * 25;
      });
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
      assert.equal(capturedMaxResults, expectedMaxResults);
      assert.equal(await page.locator("#currencyCode").count(), 0);
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
    await page.waitForSelector(".results-table--flexible tbody tr");

    const probe = await page.evaluate(() => ({
      hasFlexibleTable: Boolean(document.querySelector(".results-table--flexible")),
      hasCalendarGrid: Boolean(document.querySelector(".cal-grid")),
      viewToggleHidden: document.getElementById("viewToggle")?.classList.contains("hidden") ?? false,
      rowKeys: [...document.querySelectorAll(".results-table--flexible tbody tr")]
        .map((row) => row.getAttribute("data-mk")),
      firstRowText: document.querySelector(".results-table--flexible tbody tr")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
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

test("location suggestions stay anchored to the origin field", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {

    await page.route(`${baseUrl}/api/locations?q=LIM&limit=8`, async (route: Route) => {
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

test("clicking a flexible matrix cell relaunches a single exact search without pinning a provider", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    let matrixPollCount = 0;
    let searchRequestCount = 0;
    let lastSearchRequest: Record<string, unknown> | null = null;

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
      lastSearchRequest = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "search-job-1",
          searchComplete: true,
          searchStatus: "completed",
          sortMode: "cheapest",
          request: lastSearchRequest?.request ?? initialMatrix.request,
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
        const stayNights = document.getElementById("stayNights") as HTMLInputElement | null;
        if (!stayNights) throw new Error("Missing stay duration input");
        stayNights.value = "4";
        stayNights.dispatchEvent(new Event("change", { bubbles: true }));
      });

      await submitAndWaitForRequest(page, baseUrl, "/api/matrix");
      await page.waitForSelector('.results-table--flexible [data-mk="2026-04-15_2026-04-19"]');
      await page.waitForSelector('.results-table--flexible [data-mk="2026-04-15_2026-04-19"][aria-disabled="false"]');

      const listProbe = await page.evaluate(() => ({
        hasFlexibleTable: Boolean(document.querySelector(".results-table--flexible")),
        hasCalendarGrid: Boolean(document.querySelector(".cal-grid")),
        viewToggleHidden: document.getElementById("viewToggle")?.classList.contains("hidden") ?? false,
      }));

      assert.equal(listProbe.hasFlexibleTable, true);
      assert.equal(listProbe.hasCalendarGrid, false);
      assert.equal(listProbe.viewToggleHidden, true);

      const searchRequestPromise = page.waitForRequest((request) =>
        request.method() === "POST" && request.url() === `${baseUrl}/api/search`);
      await page.click('.results-table--flexible [data-mk="2026-04-15_2026-04-19"]');
      await searchRequestPromise;
      await page.waitForFunction(() => {
        const searchMode = document.getElementById("searchMode") as HTMLInputElement | null;
        return searchMode?.value === "exact";
      });

      assert.equal(searchRequestCount, 1);
      assert.equal((lastSearchRequest?.request as Record<string, unknown> | undefined)?.searchMode, "exact");
      assert.equal((lastSearchRequest?.request as Record<string, unknown> | undefined)?.providerId, undefined);

      const formState = await page.evaluate(() => ({
        searchMode: (document.getElementById("searchMode") as HTMLInputElement | null)?.value,
        departureDate: (document.getElementById("departureDate") as HTMLInputElement | null)?.value,
        returnDate: (document.getElementById("returnDate") as HTMLInputElement | null)?.value,
        departureStart: (document.getElementById("departureStart") as HTMLInputElement | null)?.value,
        departureEnd: (document.getElementById("departureEnd") as HTMLInputElement | null)?.value,
        dateTriggerText: document.getElementById("dateTriggerText")?.textContent?.trim(),
      }));

      assert.equal(formState.searchMode, "exact");
      assert.equal(formState.departureDate, "2026-04-15");
      assert.equal(formState.returnDate, "2026-04-19");
      assert.equal(formState.departureStart, "");
      assert.equal(formState.departureEnd, "");
      assert.equal(formState.dateTriggerText, "15/04 → 19/04");
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
      await page.waitForSelector('tr[data-oid="offer-1"]');

      const probe = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('tr[data-oid]')];
        const firstDateCell = rows[0]?.children[1];
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
        dateText: document.querySelector('tr[data-oid] td:nth-child(2)')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      }));

      assert.equal(afterKeyboardSelection.activeVariant, "offer-2");
      assert.match(afterKeyboardSelection.dateText, /16\/04 → 23\/04/);
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
    await page.waitForSelector('tr[data-oid="offer-aa"]');

    const beforeKeyboard = await page.evaluate(() => ({
      resultsMeta: document.getElementById("resultsPanelMeta")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      countPresent: Boolean(document.getElementById("resultsCountLabel")),
      secondRowRole: document.querySelector('tr[data-oid="offer-cm"]')?.getAttribute("role") ?? "",
      secondRowTabIndex: document.querySelector('tr[data-oid="offer-cm"]')?.getAttribute("tabindex") ?? "",
      selectedId: document.querySelector("tr[data-oid].is-active")?.getAttribute("data-oid") ?? "",
    }));

    assert.match(beforeKeyboard.resultsMeta, /LIM → MIA/);
    assert.match(beforeKeyboard.resultsMeta, /15\/04 → 22\/04/);
    assert.doesNotMatch(beforeKeyboard.resultsMeta, /Agil|Costamar/);
    assert.equal(beforeKeyboard.countPresent, false);
    assert.equal(beforeKeyboard.secondRowRole, "button");
    assert.equal(beforeKeyboard.secondRowTabIndex, "0");
    assert.equal(beforeKeyboard.selectedId, "offer-aa");

    await page.locator('tr[data-oid="offer-cm"]').focus();
    await page.keyboard.press("Enter");

    const afterKeyboard = await page.evaluate(() => ({
      selectedId: document.querySelector("tr[data-oid].is-active")?.getAttribute("data-oid") ?? "",
      detailSummary: document.querySelector(".detail-summary")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    }));

    assert.equal(afterKeyboard.selectedId, "offer-cm");
    assert.match(afterKeyboard.detailSummary, /CM/);

    await page.keyboard.press("Escape");
    await page.waitForSelector(".detail-empty .empty-panel__title");

    const afterEscape = await page.evaluate(() => ({
      selectedRowCount: document.querySelectorAll("tr[data-oid].is-active").length,
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
    await page.waitForSelector(".results-table thead th");

    const headerTypography = await page.evaluate(() => {
      const headers = [...document.querySelectorAll(".results-table thead th")] as HTMLElement[];
      const airline = headers[0];
      const price = headers[5];
      if (!airline || !price) {
        throw new Error("Missing results table headers");
      }

      const airlineStyle = getComputedStyle(airline);
      const priceStyle = getComputedStyle(price);

      return {
        airlineFontFamily: airlineStyle.fontFamily,
        airlineFontSize: airlineStyle.fontSize,
        airlineFontWeight: airlineStyle.fontWeight,
        priceFontFamily: priceStyle.fontFamily,
        priceFontSize: priceStyle.fontSize,
        priceFontWeight: priceStyle.fontWeight,
      };
    });

    assert.equal(headerTypography.priceFontFamily, headerTypography.airlineFontFamily);
    assert.equal(headerTypography.priceFontSize, headerTypography.airlineFontSize);
    assert.equal(headerTypography.priceFontWeight, headerTypography.airlineFontWeight);
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
      await page.waitForSelector('tr[data-oid]');

      const probe = await page.evaluate(() => ({
        rowCount: document.querySelectorAll('tr[data-oid]').length,
        ids: [...document.querySelectorAll('tr[data-oid]')].map((row) => row.getAttribute("data-oid")),
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
      await page.waitForSelector('tr[data-oid]');

      const probe = await page.evaluate(() => ({
        ids: [...document.querySelectorAll('tr[data-oid]')].map((row) => row.getAttribute("data-oid")),
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
    await page.waitForSelector('tr[data-oid="offer-one-stop-shorter"]');

    const probe = await page.evaluate(() => ({
      ids: [...document.querySelectorAll('tr[data-oid]')].map((row) => row.getAttribute("data-oid")),
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
      await page.waitForSelector('tr[data-oid="offer-double-4h"]');

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

      await page.waitForSelector('tr[data-oid="offer-1"]');
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
      await page.waitForSelector('tr[data-oid="offer-1"]');

      const linkCellText = await page.locator('tr[data-oid="offer-1"] td:nth-child(7)').innerText();
      assert.match(linkCellText, /Agil/);
      assert.match(linkCellText, /Costamar:\s*Falta sesión/);
      await page.click('tr[data-oid="offer-1"]');
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
      await page.waitForSelector('tr[data-oid="offer-1"]');

      const linkCell = page.locator('tr[data-oid="offer-1"] td:nth-child(7)');
      const linkCellText = await linkCell.innerText();
      assert.match(linkCellText, /Agil/);
      assert.doesNotMatch(linkCellText, /Filtro local/);
      assert.equal(await linkCell.locator("a.row-link").count(), 1);
      assert.equal(await linkCell.locator('a.row-link').first().getAttribute("href"), "https://example.test/agil");
      assert.equal(await page.locator("#detailContent a.btn--ghost").count(), 1);
  }, { autoOpen: false });
});

test("provider link column reuses the matched Costamar link for the same flight", async () => {
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
            amount: 498,
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
                marketingCarrier: "IB",
                flightNumber: "IB124",
                origin: "LIM",
                destination: "MAD",
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
                marketingCarrier: "IB",
                flightNumber: "IB121",
                origin: "MAD",
                destination: "LIM",
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
      await page.waitForSelector('tr[data-oid="offer-agil"]');

      const linkCellText = await page.locator('tr[data-oid="offer-agil"] td:nth-child(7)').innerText();
      assert.match(linkCellText, /Agil/);
      assert.match(linkCellText, /Costamar/);
  }, { autoOpen: false });
});

test("progressive list searches keep placeholder rows while results are still streaming", async () => {
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
      await page.waitForSelector('tr[data-oid="offer-1"]');

      const placeholderCountWhileRunning = await page.locator(".results-row--placeholder").count();
      assert.equal(await page.locator("#resultsContainer .table-wrap").getAttribute("aria-busy"), "true");
      assert.equal(placeholderCountWhileRunning > 0, true);

      await page.waitForFunction(() => (
        document.querySelectorAll("#resultsContainer .results-row--placeholder").length === 0
        && document.querySelector("#resultsContainer .table-wrap")?.getAttribute("aria-busy") === "false"
      ));

      assert.equal(pollCount > 0, true);
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
      sortRight: document.getElementById("sortButtons")?.getBoundingClientRect().right ?? 0,
    }));

    await page.click('#resultsPager [data-results-page="next"]');

    const nextPager = await page.evaluate(() => ({
      label: document.querySelector("#resultsPager .pager-label")?.textContent?.trim() ?? "",
      prevDisabled: (document.querySelector('#resultsPager [data-results-page=\"prev\"]') as HTMLButtonElement | null)?.disabled ?? null,
      nextDisabled: (document.querySelector('#resultsPager [data-results-page=\"next\"]') as HTMLButtonElement | null)?.disabled ?? null,
      width: document.getElementById("resultsPager")?.getBoundingClientRect().width ?? 0,
      left: document.getElementById("resultsPager")?.getBoundingClientRect().left ?? 0,
    }));

    assert.equal(initialPager.label.startsWith("1 /"), true);
    assert.equal(initialPager.prevDisabled, true);
    assert.equal(initialPager.nextDisabled, false);
    assert.equal(initialPager.left > initialPager.sortRight, true);
    assert.equal(nextPager.label.startsWith("2 /"), true);
    assert.equal(nextPager.prevDisabled, false);
    assert.equal(Math.abs(nextPager.width - initialPager.width) < 0.5, true);
  }, { autoOpen: false });
});

test("quotation separates commercial and technical text and only auto-copies the commercial version", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    const normalizeClipboardText = (value: string) => value.replace(/\r\n/g, "\n");
    const commercialText = [
      "COTIZACION BOLETO AEREO",
      "",
      "Ruta comercial para cliente",
    ].join("\n");
    const technicalText = [
      "COTIZACION DE VUELO",
      "",
      "Detalle tecnico interno",
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
          plainText: `${commercialText}\n\nDETALLE TECNICO\n\n${technicalText}`,
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
    await page.waitForSelector('tr[data-oid="offer-1"]');

    await page.click("#quotationButton");
    await page.waitForFunction(() => {
      const textareas = [...document.querySelectorAll(".quote-textarea")] as HTMLTextAreaElement[];
      return textareas.length === 2;
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
    assert.ok(quotationState.sectionTitles.includes("Detalle técnico"));
    assert.deepEqual(quotationState.textareaValues, [commercialText, technicalText]);
    assert.equal(normalizeClipboardText(quotationState.clipboard), commercialText);

    await page.click("[data-copy-technical-quotation]");
    await page.waitForFunction(async () => (await navigator.clipboard.readText()) === "COTIZACION DE VUELO\n\nDetalle tecnico interno");

    const technicalClipboard = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(normalizeClipboardText(technicalClipboard), technicalText);
  }, {
    autoOpen: false,
    createPage: async ({ baseUrl, browser }) => {
      const context = await browser.newContext();
      await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
      return context.newPage();
    },
  });
});



