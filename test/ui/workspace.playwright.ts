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

test("workspace panel tabs expose one selected panel and keyboard semantics", async () => {
  await withDesktopPage(async ({ page }) => {
    await page.setViewportSize({ width: 1080, height: 720 });
    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/search", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "tabs-style-search",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: "cheapest",
          request: route.request().postDataJSON().request,
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

    const workspaceTabs = page.getByRole("tablist");
    await workspaceTabs.waitFor({ state: "visible" });
    assert.equal(await workspaceTabs.locator(".fd-segmented-indicator").count(), 1);
    const resultsTab = page.getByRole("tab", { name: "Resultados" });
    const filtersTab = page.getByRole("tab", { name: "Filtros" });
    assert.equal(await resultsTab.getAttribute("aria-selected"), "true");
    assert.equal(await filtersTab.getAttribute("aria-selected"), "false");

    await filtersTab.click();
    assert.equal(await filtersTab.getAttribute("aria-selected"), "true");
    assert.equal(await resultsTab.getAttribute("aria-selected"), "false");
    assert.equal(await page.getByRole("heading", { name: "Filtros" }).isVisible(), true);
    assert.equal(await page.getByRole("heading", { name: "Resultados" }).isVisible(), false);
  });
});

test("baggage filter uses one compact slider and maps checked baggage to carry-on too", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    let submittedFilters: Record<string, unknown> | null = null;

    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/search", async (route) => {
      const payload = route.request().postDataJSON() as {
        request?: { filters?: Record<string, unknown> };
        sortMode?: string;
      };
      submittedFilters = payload.request?.filters ?? null;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "baggage-slider-search",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: payload.sortMode,
          request: payload.request,
          offers: [],
          allOffers: [],
          searchMeta: {
            requestedAt: "2026-05-21T00:00:00.000Z",
            completedAt: "2026-05-21T00:00:00.000Z",
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

    await page.goto(`${baseUrl}/?layout=editor&mode=exact&trip=one-way&origin=LIM&destination=MAD&departure=2026-05-28&adults=1&children=0&infants=0&sort=cheapest`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();

    const baggageSliderControl = page.getByRole("slider", { name: "Equipaje incluido" });
    assert.equal(await baggageSliderControl.getAttribute("aria-valuemin"), "0");
    assert.equal(await baggageSliderControl.getAttribute("aria-valuemax"), "2");
    assert.equal(await baggageSliderControl.getAttribute("aria-valuenow"), "0");
    assert.equal(await page.getByRole("switch", { name: "Equipaje de mano" }).count(), 0);
    assert.equal(await page.getByRole("switch", { name: "Maleta de bodega" }).count(), 0);

    const baggageSlider = page.locator(".fd-filter-slider").filter({ has: baggageSliderControl });
    assert.equal(await baggageSlider.locator(".fd-filter-slider__value").innerText(), "Cualquiera");
    const visibleSliderLabels = await page.locator(".fd-filter-slider__label").evaluateAll((labels) => (
      labels.map((label) => label.textContent?.trim()).filter(Boolean)
    ));
    assert.deepEqual(visibleSliderLabels, ["Tipo", "Tiempo máximo", "Incluido"]);

    await baggageSliderControl.focus();
    await baggageSliderControl.press("End");
    assert.equal(await baggageSlider.locator(".fd-filter-slider__value").innerText(), "Bodega");

    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);
    assert.equal(submittedFilters?.carryOnRequired, true);
    assert.equal(submittedFilters?.checkedBaggageRequired, true);

    const sliderStyle = await baggageSlider.evaluate((element) => {
      const value = element.querySelector<HTMLElement>(".fd-filter-slider__value");
      const visibleLabel = element.querySelector<HTMLElement>(".fd-filter-slider__label");
      const head = element.querySelector<HTMLElement>(".fd-filter-slider__head");
      if (!visibleLabel || !value || !head) throw new Error("Missing slider text");
      return {
        background: getComputedStyle(element).backgroundColor,
        visibleLabel: visibleLabel.textContent?.trim(),
        headJustify: getComputedStyle(head).justifyContent,
        valueWeight: Number(getComputedStyle(value).fontWeight),
      };
    });
    assert.equal(sliderStyle.background, "rgba(0, 0, 0, 0)");
    assert.equal(sliderStyle.visibleLabel, "Incluido");
    assert.equal(sliderStyle.headJustify, "space-between");
    assert.ok(sliderStyle.valueWeight <= 500, JSON.stringify(sliderStyle));

    const filterSectionTitleGaps = await page.locator("aside.fd-panel section").evaluateAll((sections) => {
      return sections.flatMap((section) => {
        const title = section.querySelector<HTMLElement>(".fd-label");
        const content = section.children.item(1) as HTMLElement | null;
        if (!title || !content) return [];
        const titleRect = title.getBoundingClientRect();
        const contentRect = content.getBoundingClientRect();
        return [Math.round(contentRect.top - titleRect.bottom)];
      });
    });
    assert.ok(filterSectionTitleGaps.length >= 2, JSON.stringify(filterSectionTitleGaps));
    assert.ok(
      Math.max(...filterSectionTitleGaps) - Math.min(...filterSectionTitleGaps) <= 2,
      JSON.stringify(filterSectionTitleGaps),
    );

    const markPositions = await page.locator(".fd-filter-slider").evaluateAll((sliders) => {
      return sliders.map((slider) => (
        Array.from(slider.querySelectorAll<HTMLElement>(".fd-filter-slider__mark"))
          .map((mark) => mark.style.getPropertyValue("--fd-filter-slider-mark-position"))
      ));
    });
    for (const positions of markPositions) {
      assert.equal(positions[0], "0%");
      assert.equal(positions.at(-1), "100%");
    }
  }, { autoOpen: false });
});

test("location suggestions stay above workspace tabs after a search", async () => {
  await withDesktopPage(async ({ page }) => {
    await page.setViewportSize({ width: 1080, height: 720 });
    let suggestionsEnabled = false;

    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          suggestions: suggestionsEnabled
            ? [
                { code: "ZZZ", city: "Zed City", country: "Pruebas", countryCode: "ZZ", label: "Zed City, Pruebas (ZZZ)" },
                { code: "ZZY", city: "Zeta Field", country: "Pruebas", countryCode: "ZZ", label: "Zeta Field, Pruebas (ZZY)" },
              ]
            : [],
        }),
      });
    });
    await page.route("**/api/search", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "suggestions-layer-search",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: "cheapest",
          request: route.request().postDataJSON().request,
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

    await page.getByRole("tablist").waitFor({ state: "visible" });
    suggestionsEnabled = true;
    const destination = page.getByRole("combobox", { name: "Destino" });
    await destination.click();
    const suggestionsResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/locations"
        && url.searchParams.get("q") === "ZZ"
        && response.status() === 200;
    });
    await destination.fill("ZZ");
    await suggestionsResponse;

    const listbox = page.getByRole("listbox");
    await listbox.waitFor({ state: "visible" });
    const layerState = await listbox.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const topElement = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 12);
      return {
        ownsTopPoint: topElement === element || element.contains(topElement),
        position: getComputedStyle(element).position,
        zIndex: Number(getComputedStyle(element).zIndex),
      };
    });

    assert.equal(layerState.position, "fixed");
    assert.ok(layerState.zIndex >= 90);
    assert.equal(layerState.ownsTopPoint, true);
  });
});

test("technical Agil session errors stay out of the alert and are available in plain logs", async () => {
  await withDesktopPage(async ({ page }) => {
    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/search", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Unable to extract Agil session from Chrome profiles. connected browser: browserType.connectOverCDP: connect ECONNREFUSED 127.0.0.1:9222 Call log: \u001b[2m - <ws preparing> retrieving websocket url from http://127.0.0.1:9222\u001b[22m | Profile 40: Agil local session data is incomplete in Chrome localStorage.",
        }),
      });
    });

    await page.getByRole("combobox", { name: "Origen" }).fill("LIM");
    await page.getByRole("combobox", { name: "Destino" }).fill("CUZ");
    await page.getByRole("button", { name: "Salida" }).click();
    await page.getByRole("dialog", { name: "Calendario de salida" }).getByRole("button", { name: "31 mar 2026" }).click();
    await page.getByRole("button", { name: "Regreso" }).click();
    await page.getByRole("dialog", { name: "Calendario de regreso" }).getByRole("button", { name: "01 abr 2026" }).click();
    await page.getByRole("button", { name: "Buscar" }).click();

    const alert = page.getByRole("alert");
    await alert.waitFor();
    const text = await alert.innerText();

    assert.match(text, /No se pudo leer la sesión local de Agil/);
    assert.doesNotMatch(text, /Chrome remoto|127\.0\.0\.1:9222/);
    assert.doesNotMatch(text, /Profile 40|localStorage|connectOverCDP/);
    assert.doesNotMatch(text, /\u001b|\[2m|\[22m|Call log/);

    await page.keyboard.press("Control+Shift+L");
    const logText = await page.getByRole("textbox", { name: "Registro de búsqueda" }).inputValue();
    assert.match(logText, /HTTP 500/);
    assert.match(logText, /Profile 40: Agil local session data is incomplete in Chrome localStorage/);
    assert.match(logText, /connectOverCDP/);
  });
});
