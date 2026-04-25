import test from "node:test";
import assert from "node:assert/strict";
import { openDesktop, withDesktopPage } from "./helpers/ui";

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
    await origin.fill("li");

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
    assert.ok(options.every((option) => Boolean(option.id)));
    assert.ok(options.every((option) => option.selected === "false"));
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
    assert.ok(labels.includes("Quitar ninos"));
    assert.ok(labels.includes("Agregar ninos"));
    assert.ok(labels.includes("Quitar bebes"));
    assert.ok(labels.includes("Agregar bebes"));
  });
});
