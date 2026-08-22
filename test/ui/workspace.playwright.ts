import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page, Route } from "playwright";
import { openDesktop, registerDesktopHarness, withDesktopPage } from "../helpers/ui.ts";
import { clickSegment, segment } from "./support.ts";

registerDesktopHarness();

test("the provider rail says who the desk searches, whatever their health", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    /*
     * The rail used to poll `/api/provider-status` and keep only providers with
     * a live `ready` observation. Click and Book Plus cannot reach `ready`
     * until a real search has answered, so on the idle screen — the only screen
     * this rail lives on — it was never listed and the desk looked like it
     * searched one provider. Coverage is a fact of the deployment, not of the
     * minute; a provider that fails a search is said in one line above the
     * results (04 §8), where the agent can act on it.
     */
    let statusRequests = 0;
    await page.route("**/api/provider-status", async (route) => {
      statusRequests += 1;
      await route.abort("failed");
    });

    await openDesktop(page, baseUrl);
    const rail = page.locator(".fd-provider-rail");
    await rail.waitFor();
    await page.getByText("Click and Book Plus", { exact: true }).waitFor();

    assert.equal(await page.getByText("Agilsmart", { exact: true }).count(), 1);
    assert.equal(await rail.locator(".fd-provider-rail-item").count(), 2);
    // 03 §5: names and 14px icons. No health word belongs on this rail.
    assert.equal(await rail.locator("img").count(), 2);
    assert.doesNotMatch(
      await rail.innerText(),
      /disponible|verificando|incidencias|sin verificar|requiere/i,
    );

    // And nothing on this screen asks the backend how the providers are doing.
    await page.waitForTimeout(1200);
    assert.equal(statusRequests, 0);
  }, { autoOpen: false });
});

test("narrow desktop keeps filters beside results without mobile panel tabs", async () => {
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

    assert.equal(await page.getByRole("tablist").count(), 0);
    assert.equal(await page.getByRole("heading", { name: "Filtros" }).isVisible(), true);
    assert.equal(await page.getByRole("heading", { name: "Resultados", exact: true }).isVisible(), true);
    const workspace = page.locator(".fd-results");
    const layout = await workspace.evaluate((element) => ({
      columns: getComputedStyle(element).gridTemplateColumns,
      width: element.getBoundingClientRect().width,
    }));
    assert.match(layout.columns, /^248px /);
    assert.ok(layout.width > 248);
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
    // 04 §2: one segmented of three options, no separators between groups.
    const baggageControl = page.getByRole("radiogroup", { name: "Equipaje incluido" });
    await baggageControl.waitFor({ state: "visible" });
    const baggageOptions = baggageControl.getByRole("radio");
    assert.equal(await baggageOptions.count(), 3);
    assert.deepEqual(await baggageOptions.allTextContents(), ["Todos", "Mano", "Bodega"]);
    assert.equal(await segment(baggageControl, "Todos").getAttribute("aria-checked"), "true");
    assert.equal(await segment(baggageControl, "Mano").getAttribute("aria-checked"), "false");
    assert.equal(await segment(baggageControl, "Bodega").getAttribute("aria-checked"), "false");
    assert.equal(await page.getByRole("switch", { name: "Equipaje de mano" }).count(), 0);
    assert.equal(await page.getByRole("switch", { name: "Maleta de bodega" }).count(), 0);

    await clickSegment(segment(baggageControl, "Bodega"));
    assert.equal(await segment(baggageControl, "Todos").getAttribute("aria-checked"), "false");

    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);
    // Read through a declared local: the route callback that fills this in is a
    // closure, so at this point the checker still believes the initialiser.
    const filters = submittedFilters as Record<string, unknown> | null;
    assert.ok(filters, "the search was submitted without filters");
    assert.equal(filters.carryOnRequired, true);
    assert.equal(filters.checkedBaggageRequired, true);
  }, { autoOpen: false });
});

test("location suggestions stay above the narrow desktop workspace after a search", async () => {
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

    await page.getByRole("heading", { name: "Resultados", exact: true }).waitFor({ state: "visible" });
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
