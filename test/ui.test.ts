import test from "node:test";
import assert from "node:assert/strict";
import type { Route } from "playwright";
import { openDesktop, withDesktopPage } from "./helpers/ui";
import { buildOffer } from "./helpers/ui-fixtures";

test("current React shell exposes the primary search controls", async () => {
  await withDesktopPage(async ({ page }) => {
    const controls = await page.evaluate(() => ({
      comboboxes: Array.from(document.querySelectorAll('[role="combobox"]')).map((input) => ({
        name: input.getAttribute("aria-label"),
        expanded: input.getAttribute("aria-expanded"),
        controls: input.getAttribute("aria-controls"),
      })),
      listboxes: document.querySelectorAll('[role="listbox"]').length,
      swapLabel: document.querySelector('button[aria-label="Intercambiar ruta"]')?.getAttribute("aria-label"),
      passengerLabel: document.querySelector('button[aria-label="Seleccionar pasajeros"]')?.getAttribute("aria-label"),
      submitText: Array.from(document.querySelectorAll("button"))
        .map((button) => button.textContent?.trim())
        .find((text) => text === "Buscar"),
    }));

    assert.deepEqual(controls.comboboxes.map((control) => control.name), ["Origen", "Destino"]);
    assert.deepEqual(controls.comboboxes.map((control) => control.expanded), ["false", "false"]);
    assert.ok(controls.comboboxes.every((control) => Boolean(control.controls)));
    assert.equal(controls.listboxes, 0);
    assert.equal(controls.swapLabel, "Intercambiar ruta");
    assert.equal(controls.passengerLabel, "Seleccionar pasajeros");
    assert.equal(controls.submitText, "Buscar");
  });
});

test("current React shell exposes flexible and migratory search modes", async () => {
  await withDesktopPage(async ({ page }) => {
    const visibleText = await page.locator("body").innerText();

    assert.doesNotMatch(visibleText, /0 resultados/);
    assert.doesNotMatch(visibleText, /Listo para consultar/);
    assert.doesNotMatch(visibleText, /Multidestino/);
    assert.match(visibleText, /Migratorio/);

    const migratory = page.getByRole("button", { name: "Migratorio" });
    await assert.equal(await migratory.isDisabled(), false);

    const flexible = page.getByRole("button", { name: "Flexible" });
    await assert.equal(await flexible.isDisabled(), false);
    await flexible.click();

    assert.match(await page.locator("body").innerText(), /SALIDA\s*DESDE/);
    assert.match(await page.locator("body").innerText(), /SALIDA\s*HASTA/);
    assert.match(await page.locator("body").innerText(), /4 d[ií]as/);
    await page.waitForFunction(() => {
      const animatedWords = Array.from(document.querySelectorAll(".fd-label-word-extra"))
        .map((element) => element.textContent?.trim());
      return animatedWords.includes("desde") && animatedWords.includes("hasta");
    });
    await assert.equal(await migratory.isDisabled(), false);

    await migratory.click();
    const departureField = page.getByRole("button", { name: "Salida", exact: true });
    const returnField = page.getByRole("button", { name: "Regreso", exact: true });
    await assert.equal(await departureField.count(), 1);
    await assert.equal(await returnField.count(), 1);
    await assert.equal(await departureField.isDisabled(), true);
    await assert.equal(await returnField.isDisabled(), true);
    assert.match(await departureField.innerText(), /No aplica/);
    assert.match(await returnField.innerText(), /No aplica/);
    await assert.equal(await page.getByRole("button", { name: "Ida y vuelta" }).isDisabled(), true);
    await assert.equal(await page.getByRole("button", { name: "Solo ida" }).isDisabled(), true);
    await assert.equal(await page.getByRole("button", { name: "Solo ida" }).getAttribute("aria-pressed"), "true");
    await assert.equal(await page.getByRole("button", { name: "Buscar" }).isVisible(), true);
  });
});

test("one-way exact search keeps the return field visible but disabled", async () => {
  await withDesktopPage(async ({ page }) => {
    await page.getByRole("button", { name: "Solo ida" }).click();

    const returnField = page.locator('button[aria-labelledby="date-regreso-label"]');
    await returnField.waitFor({ state: "visible" });
    assert.equal(await returnField.count(), 1);
    assert.equal(await returnField.isDisabled(), true);
    assert.match(await returnField.innerText(), /No aplica/);
    assert.match(await returnField.locator("xpath=..").getAttribute("class") ?? "", /fd-disabled-section/);
  });
});

test("one-way flexible search keeps stay controls visible but disabled", async () => {
  await withDesktopPage(async ({ page }) => {
    await page.getByRole("button", { name: "Flexible" }).click();
    await page.getByRole("button", { name: "Solo ida" }).click();

    const flexibleWindow = page.getByRole("button", { name: /4 d[ií]as/ });
    const stayGroup = page.getByRole("group", { name: "Estadía" });
    await stayGroup.waitFor({ state: "visible" });

    await assert.equal(await flexibleWindow.isDisabled(), false);
    await assert.equal(await stayGroup.getAttribute("aria-disabled"), "true");
    await assert.equal(await page.getByRole("button", { name: "Quitar noche" }).isDisabled(), true);
    await assert.equal(await page.getByRole("button", { name: "Agregar noche" }).isDisabled(), true);
    assert.match(await stayGroup.innerText(), /Estadía/);
    assert.match(await stayGroup.innerText(), /7 noches/);
    assert.match(await stayGroup.getAttribute("class") ?? "", /fd-control-disabled-section/);
  });
});

test("autocomplete uses combobox, listbox, and option semantics", async () => {
  await withDesktopPage(async ({ baseUrl, browser }) => {
    const page = await browser.newPage();
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
  await withDesktopPage(async ({ baseUrl, browser }) => {
    const page = await browser.newPage();
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

    await page.getByRole("button", { name: "Buscar" }).focus();
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

test("search fields show invalid outline without helper text", async () => {
  await withDesktopPage(async ({ page }) => {
    const origin = page.getByRole("combobox", { name: "Origen" });

    await origin.fill("12");
    await page.getByRole("combobox", { name: "Destino" }).focus();

    await assert.equal(await origin.getAttribute("aria-invalid"), "true");
    assert.match(await origin.locator("xpath=..").getAttribute("class") ?? "", /fd-control-invalid/);
    await assert.equal(await page.getByText("Ingresa un origen válido.").count(), 0);

    await page.getByRole("button", { name: "Flexible" }).click();
    await page.getByRole("combobox", { name: "Origen" }).fill("LIM");
    await page.getByRole("combobox", { name: "Destino" }).fill("MIA");
    await page.getByRole("button", { name: "Buscar" }).click();

    await assert.equal(await page.getByRole("button", { name: "Salida desde" }).getAttribute("aria-invalid"), "true");
    await assert.equal(await page.getByText("Selecciona el inicio del rango.").count(), 0);
    await assert.equal(await page.getByText("Selecciona el fin del rango.").count(), 0);
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

test("one-way flexible search sends an expanded stay-range payload", async () => {
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
          sortMode: "best-value",
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
    assert.equal(leg?.departureStart, "2026-03-31");
    assert.equal(leg?.departureEnd, "2026-04-08");
    assert.equal(leg?.departureDate, undefined);
    assert.equal(leg?.returnDate, undefined);
  });
});

test("search URL stores the payload and reopens it without auto-searching", async () => {
  await withDesktopPage(async ({ baseUrl, browser }) => {
    const payloads: Record<string, unknown>[] = [];
    const page = await browser.newPage();
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
    await page.waitForTimeout(260);
    assert.equal(await page.getByRole("listbox").count(), 0);

    const reusableUrl = page.url();
    const sharedUrl = new URL(reusableUrl);
    assert.equal(sharedUrl.searchParams.has("launchPayload"), false);
    assert.equal(sharedUrl.searchParams.get("mode"), "exact");
    assert.equal(sharedUrl.searchParams.get("trip"), "round-trip");
    assert.equal(sharedUrl.searchParams.get("origin"), "LIM");
    assert.equal(sharedUrl.searchParams.get("destination"), "MIA");
    assert.equal(sharedUrl.searchParams.get("departure"), "2026-03-31");
    assert.equal(sharedUrl.searchParams.get("return"), "2026-04-01");
    assert.equal(sharedUrl.searchParams.get("sort"), "best-value");
    assert.equal(sharedUrl.searchParams.get("adults"), "1");
    assert.equal(sharedUrl.searchParams.get("children"), "0");
    assert.equal(sharedUrl.searchParams.get("infants"), "0");

    const replayPage = await browser.newPage();
    await replayPage.route("**/api/locations**", routeLocations);
    await replayPage.route("**/api/search", routeSearch);

    await replayPage.goto(reusableUrl, { waitUntil: "domcontentloaded" });
    await replayPage.getByRole("combobox", { name: "Origen" }).waitFor();
    await replayPage.waitForTimeout(260);

    assert.equal(new URL(replayPage.url()).searchParams.has("launchPayload"), false);
    assert.equal(payloads.length, 1);
    await replayPage.waitForFunction(() => {
      const origin = document.querySelector<HTMLInputElement>('[aria-label="Origen"]');
      const destination = document.querySelector<HTMLInputElement>('[aria-label="Destino"]');
      return origin?.value === "LIM - Lima, Perú" && destination?.value === "MIA - FL, Estados Unidos";
    });
    assert.equal(await replayPage.getByRole("combobox", { name: "Origen" }).inputValue(), "LIM - Lima, Perú");
    assert.equal(await replayPage.getByRole("combobox", { name: "Destino" }).inputValue(), "MIA - FL, Estados Unidos");
    assert.equal(await replayPage.getByRole("listbox").count(), 0);

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

test("round-trip flexible search sends matrix exact-stay payload", async () => {
  await withDesktopPage(async ({ page }) => {
    let payload: Record<string, unknown> | undefined;

    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/matrix", async (route) => {
      payload = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          matrixJobId: "matrix-1",
          matrixComplete: true,
          matrixStatus: "completed",
          revision: 1,
          request: payload?.request,
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
          cells: [
            {
              key: "2026-04-03_2026-04-10",
              departureDate: "2026-04-03",
              returnDate: "2026-04-10",
              stayNights: 7,
              price: { amount: 480, currencyCode: "USD" },
              confidence: "live",
              providerSource: "agil-local",
              selectable: true,
              requiresRequery: false,
              stateCode: "live",
              tooltip: "Mejor tarifa",
            },
          ],
          axes: {
            departureDates: ["2026-04-03"],
            returnDates: ["2026-04-10"],
          },
          confidenceSummary: { live: 1 },
          recommendations: [],
        }),
      });
    });

    await page.getByRole("button", { name: "Flexible" }).click();
    await page.getByRole("combobox", { name: "Origen" }).fill("LIM");
    await page.getByRole("combobox", { name: "Destino" }).fill("MIA");
    await page.getByRole("button", { name: "Salida desde" }).click();
    await page.getByRole("dialog", { name: "Calendario de salida desde" }).getByRole("button", { name: "03 abr 2026" }).click();
    await page.getByRole("button", { name: "Salida hasta" }).click();
    await page.getByRole("dialog", { name: "Calendario de salida hasta" }).getByRole("button", { name: "05 abr 2026" }).click();
    await Promise.all([
      page.waitForResponse("**/api/matrix"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);

    const request = payload?.request as {
      tripType?: string;
      searchMode?: string;
      flexibleMode?: string;
      legs?: Array<Record<string, unknown>>;
    };
    const leg = request.legs?.[0];

    assert.equal(request.tripType, "round-trip");
    assert.equal(request.searchMode, "roundtrip-grid");
    assert.equal(request.flexibleMode, "exact-stay");
    assert.equal(leg?.departureStart, "2026-03-31");
    assert.equal(leg?.departureEnd, "2026-04-09");
    assert.equal(leg?.stayNights, 7);
    await page.getByText("USD 480").waitFor();
    const bodyText = await page.locator("body").innerText();
    assert.doesNotMatch(bodyText, /\b00:00\b/);
    assert.match(bodyText, /Horario por confirmar/);
    const sortControl = page.getByLabel("Orden de resultados");
    assert.match(await sortControl.getAttribute("class") ?? "", /items-stretch/);
    assert.doesNotMatch(await sortControl.getAttribute("class") ?? "", /p-0\.5/);
    assert.match(await page.getByRole("button", { name: "Ordenar por mejor valor" }).getAttribute("class") ?? "", /bg-card/);
    await assert.equal(await page.getByRole("button", { name: "Ordenar por mejor valor" }).getAttribute("aria-pressed"), "true");
  });
});

test("migratory search sends monthly stay-range requests", async () => {
  await withDesktopPage(async ({ page }) => {
    const payloads: Record<string, unknown>[] = [];
    const migratory = page.getByRole("button", { name: "Migratorio" });

    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/search", async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      payloads.push(payload);
      const offers = payloads.length === 1
        ? [
            buildOffer({
              id: "migration-offer-1",
              itineraries: [
                {
                  direction: "outbound",
                  durationMinutes: 80,
                  stops: 0,
                  segments: [
                    {
                      flightNumber: "LA 2011",
                      origin: "LIM",
                      destination: "MIA",
                      departureAt: "2026-04-15T14:00:00Z",
                      arrivalAt: "2026-04-15T15:20:00Z",
                    },
                  ],
                },
              ],
            }),
          ]
        : [];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: `migration-month-${payloads.length}`,
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: "cheapest",
          request: payload.request,
          offers,
          allOffers: offers,
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

    await assert.equal(await migratory.isDisabled(), false);
    await migratory.click();
    await page.getByRole("combobox", { name: "Origen" }).fill("LIM");
    await page.getByRole("combobox", { name: "Destino" }).fill("MIA");
    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);
    await page.getByText("USD 512").waitFor();
    const topbarControls = page.getByTestId("topbar-search-controls");
    assert.equal(await topbarControls.getByRole("button", { name: "Migratorio" }).count(), 1);
    assert.equal(await page.locator("main").getByRole("button", { name: "Migratorio" }).count(), 0);
    const topbarHeight = async () => Math.round(await page.locator("header").evaluate((element) =>
      element.getBoundingClientRect().height,
    ));
    const migrationTopbarHeight = await topbarHeight();
    await topbarControls.getByRole("button", { name: "Flexible" }).click();
    await page.waitForTimeout(240);
    const flexibleTopbarHeight = await topbarHeight();
    assert.ok(Math.abs(migrationTopbarHeight - flexibleTopbarHeight) <= 2);
    assert.match(await topbarControls.getByRole("button", { name: "Flexible" }).getAttribute("class") ?? "", /rounded-\[7px\]/);
    await topbarControls.getByRole("button", { name: "Exacto" }).click();
    await page.waitForTimeout(240);
    assert.ok(Math.abs(await topbarHeight() - flexibleTopbarHeight) <= 2);
    await topbarControls.getByRole("button", { name: "Migratorio" }).click();
    await page.waitForTimeout(240);
    assert.ok(Math.abs(await topbarHeight() - flexibleTopbarHeight) <= 2);
    assert.equal(await page.getByTestId("migration-month-card").count(), 8);
    const bodyText = await page.locator("body").innerText();
    assert.doesNotMatch(bodyText, /\b00:00\b/);
    assert.match(bodyText, /14:00/);
    assert.match(bodyText, /Marzo de 2026/i);

    assert.equal(payloads.length, 8);
    const firstRequest = payloads[0].request as {
      tripType?: string;
      searchMode?: string;
      legs?: Array<Record<string, unknown>>;
      filters?: Record<string, unknown>;
    };
    const firstLeg = firstRequest.legs?.[0];

    assert.equal(firstRequest.tripType, "one-way");
    assert.equal(firstRequest.searchMode, "stay-range");
    assert.equal(firstRequest.filters?.maxResults, 25);
    assert.equal(firstRequest.filters?.compactAllOffers, true);
    assert.equal(firstLeg?.departureStart, "2026-03-31");
    assert.equal(firstLeg?.departureEnd, "2026-03-31");
    assert.equal(firstLeg?.returnDate, undefined);
  });
});

test("workspace panel tabs use the shared filled segmented style", async () => {
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
          sortMode: "best-value",
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
    assert.match(await workspaceTabs.getAttribute("class") ?? "", /items-stretch/);
    assert.doesNotMatch(await workspaceTabs.getAttribute("class") ?? "", /gap-1/);
    assert.match(await page.getByRole("tab", { name: "Resultados" }).getAttribute("class") ?? "", /data-\[state=active\]:rounded-\[7px\]/);
  });
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
                { code: "MIA", city: "Miami", country: "Estados Unidos", countryCode: "US", label: "Miami, Estados Unidos (MIA)" },
                { code: "FLL", city: "Fort Lauderdale", country: "Estados Unidos", countryCode: "US", label: "Fort Lauderdale, Estados Unidos (FLL)" },
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
          sortMode: "best-value",
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
    const suggestionsResponse = page.waitForResponse("**/api/locations**");
    await destination.fill("MI");
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

    await page.getByRole("button", { name: "Alternar registro" }).click();
    const logText = await page.getByRole("textbox", { name: "Registro de búsqueda" }).inputValue();
    assert.match(logText, /HTTP 500/);
    assert.match(logText, /Profile 40: Agil local session data is incomplete in Chrome localStorage/);
    assert.match(logText, /connectOverCDP/);
  });
});
