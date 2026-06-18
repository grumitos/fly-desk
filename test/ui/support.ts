import assert from "node:assert/strict";
import type { Locator, Page } from "playwright";

export async function waitForPressed(button: Locator): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await button.getAttribute("aria-pressed") === "true") {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.equal(await button.getAttribute("aria-pressed"), "true");
}

export async function clickSegment(button: Locator): Promise<void> {
  await button.click();
  await waitForPressed(button);
}

export async function waitForStableIndicator(indicator: Locator): Promise<void> {
  let previous: { width: number; x: number } | undefined;
  let stableFrames = 0;

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const current = await indicator.evaluate((element) => {
      const style = getComputedStyle(element);
      const matrix = new DOMMatrixReadOnly(style.transform);
      return {
        width: Number.parseFloat(style.width),
        x: matrix.m41,
      };
    });

    if (!Number.isFinite(current.width) || !Number.isFinite(current.x)) {
      throw new Error(`Segmented indicator has invalid geometry: ${JSON.stringify(current)}`);
    }

    stableFrames = previous
      && Math.abs(previous.width - current.width) <= 0.01
      && Math.abs(previous.x - current.x) <= 0.01
      ? stableFrames + 1
      : 0;
    previous = current;

    if (stableFrames >= 2) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("Segmented indicator did not settle before the timeout.");
}

export async function waitForLocationFieldsClosed(
  page: Page,
  expected: { destination: string; origin: string },
): Promise<void> {
  await page.waitForFunction((values) => {
    const origin = document.querySelector<HTMLInputElement>('[aria-label="Origen"]');
    const destination = document.querySelector<HTMLInputElement>('[aria-label="Destino"]');

    return origin?.value === values.origin
      && destination?.value === values.destination
      && origin.getAttribute("aria-expanded") === "false"
      && destination.getAttribute("aria-expanded") === "false"
      && document.querySelectorAll('[role="listbox"]').length === 0;
  }, expected);
}

export async function waitForFontsReady(page: Page): Promise<void> {
  await page.waitForFunction(() => document.fonts.status === "loaded", null, {
    polling: 100,
    timeout: 5000,
  }).catch(() => undefined);
}

export async function routeLocationUsageSuggestions(
  page: Page,
  suggestions: { origin: string[]; destination: string[] },
): Promise<void> {
  await page.route("**/api/location-usage-suggestions**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ suggestions }),
    });
  });
}
