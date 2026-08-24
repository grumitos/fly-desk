import assert from "node:assert/strict";
import type { Locator, Page } from "playwright";

/*
 * Segmented controls (01 §3, 11 §8) are a radio group: one choice out of n,
 * applied on the gesture. The options carry `aria-checked`, not `aria-pressed`
 * — that belonged to the shadcn ToggleGroup the redesign removed, and a toggle
 * button says "on/off" where the plate says "one of these".
 *
 * There is no sliding pill to wait for either: 07 §5 and 11 §8 make the pill a
 * `::before` of the active option, so it changes place with `tacto` instead of
 * travelling. `aria-checked` flipping *is* the whole settled state.
 */
export function segment(scope: Page | Locator, name: string | RegExp): Locator {
  return scope.getByRole("radio", { name, exact: typeof name === "string" });
}

export async function waitForSegmentChecked(option: Locator): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await option.getAttribute("aria-checked") === "true") {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.equal(await option.getAttribute("aria-checked"), "true");
}

export async function clickSegment(option: Locator): Promise<void> {
  await option.click();
  await waitForSegmentChecked(option);
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

/**
 * Open a shared link, which runs the search it carries.
 *
 * Named rather than inlined precisely because there is no gesture left to see:
 * the cases that call it navigate and then wait for a list, and nothing between
 * those two lines would otherwise say where the search came from.
 */
export async function openSharedSearchLink(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
}

/**
 * The session key `frontend/src/lib/search-share.ts` writes whenever a search
 * puts itself on the address bar. Spelled out here because a Playwright file
 * cannot import the app's modules — the same reason `filters.playwright.ts`
 * spells out the workspace preferences key.
 */
const OWN_SEARCH_URL_SESSION_KEY = "fly-desk:search-url-written-here:v1";

/**
 * Open a search URL the way a reload does: the form arrives filled and idle,
 * because the tab is looking at its own address bar rather than at a link.
 *
 * A link runs the search it carries, so this is how a case that is really about
 * the idle form — its geometry, its choreography, or the gesture that starts a
 * search — still gets a form with a route already in it.
 */
export async function openSearchUrlWithoutLaunching(page: Page, url: string): Promise<void> {
  await page.addInitScript(([key, search]) => {
    try {
      window.sessionStorage.setItem(key, search);
    } catch {
      // A tab that cannot remember runs the search; the case will say so.
    }
  }, [OWN_SEARCH_URL_SESSION_KEY, new URL(url).search] as [string, string]);
  await page.goto(url, { waitUntil: "domcontentloaded" });
}
