import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page, Route } from "playwright";
import { openDesktop, withDesktopPage } from "../helpers/ui.ts";
import { routeLocationUsageSuggestions, waitForFontsReady } from "./support.ts";

test("autocomplete uses combobox, listbox, and option semantics", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          query: "li",
          suggestions: [
            { code: "LIM", city: "Lima", country: "Peru", countryCode: "PE", label: "Lima, Peru (LIM)" },
            { code: "LIS", city: "Lisbon", country: "Portugal", countryCode: "PT", label: "Lisbon, Portugal (LIS)" },
          ],
        }),
      });
    });

    await openDesktop(page, baseUrl);
    const origin = page.getByRole("combobox", { name: "Origen" });
    await origin.fill("l");

    const listbox = page.getByRole("listbox");
    await listbox.waitFor();
    const options = await listbox.getByRole("option").evaluateAll((items) =>
      items.map((item) => ({
        id: item.id,
        selected: item.getAttribute("aria-selected"),
        text: item.textContent?.trim() ?? "",
      })),
    );
    const state = await origin.evaluate((input) => ({
      expanded: input.getAttribute("aria-expanded"),
      controls: input.getAttribute("aria-controls"),
    }));

    assert.equal(state.expanded, "true");
    assert.equal(state.controls, await listbox.getAttribute("id"));
    assert.equal(options.length, 2);
    assert.match(options[0].text, /LIM/);
    assert.doesNotMatch(options[0].text, /LIM\s*LIM/);
    assert.ok(options.every((option) => Boolean(option.id)));
    assert.ok(options.every((option) => option.selected === "false"));
  }, { autoOpen: false });
});

test("autocomplete resolves an exact location match and closes suggestions", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          query: "lim",
          suggestions: [
            { code: "LIM", city: "Lima", country: "PE", countryCode: "PE", label: "All airports: Lima, PE (LIM)" },
          ],
        }),
      });
    });

    await openDesktop(page, baseUrl);
    const origin = page.getByRole("combobox", { name: "Origen" });
    await origin.fill("lim");
    await page.waitForResponse("**/api/locations**");

    assert.equal(await origin.inputValue(), "lim");

    await page.getByRole("combobox", { name: "Destino" }).focus();
    await page.waitForFunction(() => {
      const input = document.querySelector<HTMLInputElement>('[aria-label="Origen"]');
      return input?.value === "LIM - Lima, Perú";
    });

    const state = await origin.evaluate((input) => ({
      value: (input as HTMLInputElement).value,
      expanded: input.getAttribute("aria-expanded"),
      listboxes: document.querySelectorAll('[role="listbox"]').length,
    }));

    assert.equal(state.value, "LIM - Lima, Perú");
    assert.equal(state.expanded, "false");
    assert.equal(state.listboxes, 0);
  }, { autoOpen: false });
});

test("frequent location suggestions resolve labels and collapse their own row", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    let locationRequestCount = 0;
    await page.route("**/api/locations**", async (route) => {
      locationRequestCount += 1;
      const url = new URL(route.request().url());
      const query = (url.searchParams.get("q") ?? "LIM").trim().toUpperCase();
      const cityByCode: Record<string, string> = {
        BUE: "Buenos Aires",
        CUZ: "Cusco",
        LIM: "Lima",
        MAD: "Madrid",
        MIA: "Miami",
        TPP: "Tarapoto",
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          query,
          suggestions: [
            {
              code: query,
              city: cityByCode[query] ?? query,
              country: query === "MAD" ? "ES" : query === "MIA" ? "US" : query === "BUE" ? "AR" : "PE",
              countryCode: query === "MAD" ? "ES" : query === "MIA" ? "US" : query === "BUE" ? "AR" : "PE",
              label: `${cityByCode[query] ?? query}, ${query === "MAD" ? "ES" : query === "MIA" ? "US" : query === "BUE" ? "AR" : "PE"} (${query})`,
            },
          ],
        }),
      });
    });
    await routeLocationUsageSuggestions(page, {
      origin: ["LIM", "TPP", "CUZ"],
      destination: ["MAD", "MIA", "BUE"],
    });
    await page.addInitScript(() => {
      window.localStorage.setItem("flydesk-location-suggestion-details-v1", "legacy-cache");
    });

    await openDesktop(page, baseUrl);
    const exactPillBox = await page.getByRole("button", { name: "Exacto" }).boundingBox();
    const firstSuggestionBox = await page.getByRole("button", { name: "Usar LIM como origen" }).boundingBox();
    assert.ok(exactPillBox);
    assert.ok(firstSuggestionBox);
    assert.equal(Math.round(firstSuggestionBox.height), Math.round(exactPillBox.height));
    assert.equal(locationRequestCount, 0, "Ranking cards must not prewarm a browser-side location cache.");
    assert.equal(
      await page.evaluate(() => window.localStorage.getItem("flydesk-location-suggestion-details-v1")),
      null,
      "The retired browser cache should be deleted on startup.",
    );

    await page.getByRole("button", { name: "Usar LIM como origen" }).click();

    const origin = page.getByRole("combobox", { name: "Origen" });
    await page.waitForFunction(() => {
      const input = document.querySelector<HTMLInputElement>('[aria-label="Origen"]');
      return input?.value === "LIM - Lima, Perú";
    });
    await page.waitForTimeout(170);

    assert.equal(await origin.inputValue(), "LIM - Lima, Perú");
    assert.equal(await page.getByRole("button", { name: /como origen/ }).count(), 0);
    assert.equal(await page.getByRole("button", { name: /como destino/ }).count(), 3);
    assert.equal(locationRequestCount, 1, "The selected code should resolve from the server on demand.");
  }, { autoOpen: false });
});

test("late global ranking data does not recenter or resize the idle search block", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    let releaseRanking = () => undefined;
    const rankingGate = new Promise<void>((resolve) => {
      releaseRanking = resolve;
    });

    await page.route("**/api/location-usage-suggestions**", async (route) => {
      await rankingGate;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          suggestions: {
            origin: ["LIM", "TPP", "CUZ"],
            destination: ["MAD", "MIA", "BUE"],
          },
        }),
      });
    });

    await openDesktop(page, baseUrl);
    await waitForFontsReady(page);
    const before = await page.getByTestId("search-shell-frame").evaluate((element) => {
      const frame = element.getBoundingClientRect();
      const grid = element.querySelector<HTMLElement>(".fd-search-grid")?.getBoundingClientRect();
      return {
        frameHeight: Math.round(frame.height),
        frameTop: Math.round(frame.top),
        gridHeight: Math.round(grid?.height ?? 0),
      };
    });

    releaseRanking();
    await page.getByRole("button", { name: "Usar LIM como origen" }).waitFor();

    const after = await page.getByTestId("search-shell-frame").evaluate((element) => {
      const frame = element.getBoundingClientRect();
      const grid = element.querySelector<HTMLElement>(".fd-search-grid")?.getBoundingClientRect();
      return {
        frameHeight: Math.round(frame.height),
        frameTop: Math.round(frame.top),
        gridHeight: Math.round(grid?.height ?? 0),
      };
    });

    assert.ok(Math.abs(after.frameTop - before.frameTop) <= 1, JSON.stringify({ before, after }));
    assert.ok(Math.abs(after.frameHeight - before.frameHeight) <= 1, JSON.stringify({ before, after }));
    assert.ok(Math.abs(after.gridHeight - before.gridHeight) <= 1, JSON.stringify({ before, after }));
  }, { autoOpen: false });
});

test("idle location suggestions do not disturb autocomplete and swap geometry", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.route("**/api/locations**", async (route) => {
      const url = new URL(route.request().url());
      const query = url.searchParams.get("q") ?? "";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          query,
          suggestions: [
            { code: "LIM", city: "Lima", country: "PE", countryCode: "PE", label: "All airports: Lima, PE (LIM)" },
            { code: "LVD", city: "Lime Village", country: "US", countryCode: "US", label: "Lime Village, US (LVD)" },
          ],
        }),
      });
    });
    await routeLocationUsageSuggestions(page, {
      origin: ["LIM", "TPP", "CUZ"],
      destination: ["MAD", "MIA", "BUE"],
    });

    await openDesktop(page, baseUrl);
    await page.getByRole("combobox", { name: "Origen" }).fill("lim");
    await page.getByRole("listbox").waitFor();
    await page.waitForFunction(() => {
      const originControl = document.querySelector("#location-origen")?.parentElement?.getBoundingClientRect();
      const listbox = document.querySelector('[role="listbox"]')?.getBoundingClientRect();
      return Boolean(originControl && listbox && Math.abs(listbox.top - originControl.bottom - 4) <= 1);
    });

    const geometry = await page.evaluate(() => {
      const originControl = document.querySelector("#location-origen")?.parentElement?.getBoundingClientRect();
      const listbox = document.querySelector('[role="listbox"]')?.getBoundingClientRect();
      const swap = document.querySelector('button[aria-label="Intercambiar ruta"]')?.getBoundingClientRect();
      if (!originControl || !listbox || !swap) {
        throw new Error("Missing search geometry target");
      }

      return {
        autocompleteGap: listbox.top - originControl.bottom,
        originCenterY: originControl.top + originControl.height / 2,
        swapCenterY: swap.top + swap.height / 2,
      };
    });

    assert.ok(
      Math.abs(geometry.autocompleteGap - 4) <= 1,
      `Expected autocomplete gap to settle at 4px, received ${geometry.autocompleteGap}px`,
    );
    assert.ok(Math.abs(geometry.swapCenterY - geometry.originCenterY) <= 1);
  }, { autoOpen: false });
});

test("using both idle location suggestions keeps the search block anchored", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.route("**/api/locations**", async (route) => {
      const url = new URL(route.request().url());
      const query = (url.searchParams.get("q") ?? "LIM").trim().toUpperCase();
      const cityByCode: Record<string, string> = {
        BUE: "Buenos Aires",
        CUZ: "Cusco",
        LIM: "Lima",
        MAD: "Madrid",
        MIA: "Miami",
        TPP: "Tarapoto",
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          query,
          suggestions: [
            {
              code: query,
              city: cityByCode[query] ?? query,
              country: query === "MAD" ? "ES" : "PE",
              countryCode: query === "MAD" ? "ES" : "PE",
              label: `${cityByCode[query] ?? query}, ${query === "MAD" ? "ES" : "PE"} (${query})`,
            },
          ],
        }),
      });
    });
    await routeLocationUsageSuggestions(page, {
      origin: ["LIM", "TPP", "CUZ"],
      destination: ["MAD", "MIA", "BUE"],
    });

    await openDesktop(page, baseUrl);
    const frame = page.locator('[data-testid="search-shell-frame"]');
    const grid = page.locator(".fd-search-grid");
    const frameTopBefore = await frame.evaluate((element) => element.getBoundingClientRect().top);
    const gridHeightBefore = await grid.evaluate((element) => element.getBoundingClientRect().height);

    await page.getByRole("button", { name: "Usar LIM como origen" }).click();
    await page.waitForFunction(() => {
      const input = document.querySelector<HTMLInputElement>('[aria-label="Origen"]');
      return input?.value === "LIM - Lima, Perú";
    });
    await page.waitForTimeout(170);
    assert.equal(await page.getByRole("button", { name: /como origen/ }).count(), 0);

    await page.getByRole("button", { name: "Usar MAD como destino" }).click();
    await page.waitForFunction(() => {
      const input = document.querySelector<HTMLInputElement>('[aria-label="Destino"]');
      return input?.value === "MAD - Madrid, España";
    });
    await page.waitForTimeout(170);

    const frameTopAfter = await frame.evaluate((element) => element.getBoundingClientRect().top);
    const gridHeightAfter = await grid.evaluate((element) => element.getBoundingClientRect().height);

    assert.equal(await page.getByRole("button", { name: /como destino/ }).count(), 0);
    assert.ok(Math.abs(frameTopAfter - frameTopBefore) <= 1);
    assert.equal(Math.round(gridHeightAfter), Math.round(gridHeightBefore));
  }, { autoOpen: false });
});

test("idle validation helpers keep the search block anchored", async () => {
  await withDesktopPage(async ({ page }) => {
    await routeLocationUsageSuggestions(page, { origin: [], destination: [] });
    await page.reload();
    await page.getByRole("combobox", { name: "Origen" }).waitFor();

    const frameTopBefore = await page.locator('[data-testid="search-shell-frame"]').evaluate((element) =>
      element.getBoundingClientRect().top,
    );

    await page.getByRole("combobox", { name: "Origen" }).focus();
    await page.getByRole("combobox", { name: "Destino" }).focus();
    await page.getByText("Ingresa un origen válido.").waitFor();

    const frameTopAfter = await page.locator('[data-testid="search-shell-frame"]').evaluate((element) =>
      element.getBoundingClientRect().top,
    );

    assert.ok(Math.abs(frameTopAfter - frameTopBefore) <= 1);
  });
});

test("passenger steppers have accessible icon-only labels", async () => {
  await withDesktopPage(async ({ page }) => {
    await page.getByRole("button", { name: "Seleccionar pasajeros" }).click();

    const labels = await page.evaluate(() =>
      Array.from(document.querySelectorAll("button[aria-label]"))
        .map((button) => button.getAttribute("aria-label"))
        .filter((label): label is string => Boolean(label)),
    );

    assert.ok(labels.includes("Quitar adultos"));
    assert.ok(labels.includes("Agregar adultos"));
    assert.ok(labels.includes("Quitar niños"));
    assert.ok(labels.includes("Agregar niños"));
    assert.ok(labels.includes("Quitar bebés"));
    assert.ok(labels.includes("Agregar bebés"));
  });
});

test("passenger steppers cap the UI at nine travelers", async () => {
  await withDesktopPage(async ({ page }) => {
    await page.getByRole("button", { name: "Seleccionar pasajeros" }).click();
    const addAdults = page.getByRole("button", { name: "Agregar adultos" });

    for (let index = 0; index < 8; index += 1) {
      await addAdults.click();
    }

    assert.equal(await page.getByRole("button", { name: "Seleccionar pasajeros" }).innerText(), "9 pasajeros");
    assert.equal(await addAdults.isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Agregar niños" }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Agregar bebés" }).isDisabled(), true);
    assert.equal(await page.getByText("Máximo 9 pasajeros por búsqueda.").count(), 1);
  });
});

test("search fields show invalid outline and inline helper text", async () => {
  await withDesktopPage(async ({ page }) => {
    const origin = page.getByRole("combobox", { name: "Origen" });

    await origin.fill("12");
    await page.getByRole("combobox", { name: "Destino" }).focus();

    await assert.equal(await origin.getAttribute("aria-invalid"), "true");
    assert.match(await origin.locator("xpath=..").getAttribute("class") ?? "", /fd-control-invalid/);
    await assert.equal(await page.getByText("Ingresa un origen válido.").count(), 1);

    await page.getByRole("button", { name: "Flexible" }).click();
    await page.getByRole("combobox", { name: "Origen" }).fill("LIM");
    await page.getByRole("combobox", { name: "Destino" }).fill("MIA");
    await assert.equal(await page.getByRole("button", { name: "Buscar" }).isDisabled(), true);
    await page.getByRole("button", { name: "Salida desde" }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Salida hasta" }).click();
    await page.keyboard.press("Escape");

    await assert.equal(await page.getByRole("button", { name: "Salida desde" }).getAttribute("aria-invalid"), "true");
    await assert.equal(await page.getByText("Selecciona el inicio del rango.").count(), 1);
    await assert.equal(await page.getByText("Selecciona el fin del rango.").count(), 1);
  });
});
