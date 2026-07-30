import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page, Route } from "playwright";
import { openDesktop, withDesktopPage } from "../helpers/ui.ts";

test("provider rail clears a stale availability claim after a later status request fails", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.addInitScript(() => {
      const nativeSetInterval = window.setInterval.bind(window);
      window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
        nativeSetInterval(handler, timeout === 30_000 ? 500 : timeout, ...args)) as typeof window.setInterval;
    });

    let statusRequests = 0;
    let resolveFailedRefresh: (() => void) | undefined;
    const failedRefresh = new Promise<void>((resolve) => {
      resolveFailedRefresh = resolve;
    });
    await page.route("**/api/provider-status", async (route) => {
      statusRequests += 1;
      // React StrictMode mounts the effect twice in the test build; the first
      // request is aborted by its development-only cleanup.
      if (statusRequests > 2) {
        resolveFailedRefresh?.();
        await route.abort("failed");
        return;
      }

      const observedAt = new Date().toISOString();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          generatedAt: observedAt,
          staleAfterMs: 60_000,
          providers: [
            {
              id: "agil-local",
              configured: true,
              state: "ready",
              evidence: "prewarm",
              reasonCode: null,
              observedAt,
              stale: false,
            },
            {
              id: "costamar",
              configured: true,
              state: "ready",
              evidence: "prewarm",
              reasonCode: null,
              observedAt,
              stale: false,
            },
          ],
        }),
      });
    });

    await openDesktop(page, baseUrl);
    await page.getByText("disponible").first().waitFor();
    await failedRefresh;
    await page.waitForFunction(() => document.querySelectorAll(".fd-provider-rail-status").length === 0);

    assert.equal(await page.getByText("Agilsmart", { exact: true }).isVisible(), true);
    assert.equal(await page.getByText("Click and Book Plus", { exact: true }).isVisible(), true);
  }, { autoOpen: false });
});

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
    const calendar = page.getByRole("dialog", { name: "Calendario de fechas" });
    await calendar.getByRole("button", { name: /^31 de marzo de 2026/ }).click();
    await calendar.getByRole("button", { name: /^1 de abril de 2026/ }).click();
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

test("baggage filter uses one compact segmented control and maps checked baggage to carry-on too", async () => {
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

    await page.goto(`${baseUrl}/?mode=exact&trip=one-way&origin=LIM&destination=MAD&departure=2026-05-28&adults=1&children=0&infants=0&sort=cheapest`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();

    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);
    const baggageControl = page.getByLabel("Equipaje incluido", { exact: true });
    await baggageControl.waitFor({ state: "visible" });
    const baggageOptions = baggageControl.getByRole("button");
    assert.equal(await baggageOptions.count(), 3);
    assert.deepEqual(await baggageOptions.allTextContents(), ["Todos", "Mano", "Bodega"]);
    assert.equal(await baggageControl.getByRole("button", { name: "Todos" }).getAttribute("aria-pressed"), "true");
    assert.equal(await baggageControl.getByRole("button", { name: "Mano" }).getAttribute("aria-pressed"), "false");
    assert.equal(await baggageControl.getByRole("button", { name: "Bodega" }).getAttribute("aria-pressed"), "false");
    assert.equal(await page.getByRole("switch", { name: "Equipaje de mano" }).count(), 0);
    assert.equal(await page.getByRole("switch", { name: "Maleta de bodega" }).count(), 0);

    await baggageControl.getByRole("button", { name: "Bodega" }).click();
    assert.equal(await baggageControl.getByRole("button", { name: "Bodega" }).getAttribute("aria-pressed"), "true");
    assert.equal(await baggageControl.getByRole("button", { name: "Todos" }).getAttribute("aria-pressed"), "false");

    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);
    assert.equal(submittedFilters?.carryOnRequired, true);
    assert.equal(submittedFilters?.checkedBaggageRequired, true);
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
    const calendar = page.getByRole("dialog", { name: "Calendario de fechas" });
    await calendar.getByRole("button", { name: /^31 de marzo de 2026/ }).click();
    await calendar.getByRole("button", { name: /^1 de abril de 2026/ }).click();
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
      const layer = element.parentElement;
      if (!layer) throw new Error("Missing suggestions layer");
      const rect = layer.getBoundingClientRect();
      const topElement = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 12);
      return {
        ownsTopPoint: topElement === layer || layer.contains(topElement),
        position: getComputedStyle(layer).position,
        zIndex: Number(getComputedStyle(layer).zIndex),
      };
    });

    assert.equal(layerState.position, "fixed");
    assert.ok(layerState.zIndex >= 90);
    assert.equal(layerState.ownsTopPoint, true);
  });
});

test("technical Agil session errors stay out of the notice and are available in plain logs", async () => {
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
    const calendar = page.getByRole("dialog", { name: "Calendario de fechas" });
    await calendar.getByRole("button", { name: /^31 de marzo de 2026/ }).click();
    await calendar.getByRole("button", { name: /^1 de abril de 2026/ }).click();
    await page.getByRole("button", { name: "Buscar" }).click();

    const notice = page.getByRole("status").filter({ hasText: "No se pudo leer la sesión local de Agil" });
    await notice.waitFor();
    const text = await notice.innerText();

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
