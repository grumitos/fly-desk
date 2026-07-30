import assert from "node:assert/strict";
import test from "node:test";
import { withDesktopPage } from "../helpers/ui.ts";
import { buildOffer } from "../helpers/ui-fixtures.ts";

const VIEWPORTS = [
  { label: "desktop", width: 1440, height: 900, wideWorkspace: true },
  { label: "tablet", width: 1024, height: 768, wideWorkspace: false },
  { label: "mobile", width: 390, height: 844, wideWorkspace: false },
] as const;

for (const viewport of VIEWPORTS) {
  test(`active workspace remains coherent at the ${viewport.label} QA viewport`, async () => {
    await withDesktopPage(async ({ baseUrl, page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.route("**/api/locations**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ suggestions: [] }),
        });
      });
      await page.route("**/api/search", async (route) => {
        const payload = route.request().postDataJSON() as Record<string, unknown>;
        const offer = buildOffer({
          id: `responsive-${viewport.label}`,
          signature: `agil-local:responsive-${viewport.label}`,
          providerOfferRef: `responsive-${viewport.label}`,
          providerSource: "agil-local",
          tripType: "one-way",
          origin: "LIM",
          destination: "MIA",
          mainCarrier: "LA",
          validatingCarrier: "LA",
          priceConfidence: "live",
          priceStatus: "unverified",
          comparisonMetrics: {
            totalDurationMinutes: 360,
            totalStops: 0,
            baggageScore: 2,
            purchasePathScore: 1,
          },
          itineraries: [
            {
              id: `responsive-${viewport.label}-outbound`,
              direction: "outbound",
              durationMinutes: 360,
              stops: 0,
              layoverMinutes: [],
              segments: [
                {
                  id: `responsive-${viewport.label}-outbound-1`,
                  flightNumber: "LA 2460",
                  marketingCarrier: "LA",
                  marketingCarrierName: "LATAM Airlines",
                  origin: "LIM",
                  destination: "MIA",
                  departureAt: "2026-06-08T08:30:00-05:00",
                  arrivalAt: "2026-06-08T15:30:00-04:00",
                  durationMinutes: 360,
                },
              ],
            },
          ],
          purchasePaths: [
            {
              id: `responsive-${viewport.label}-agil-path`,
              provider: "agil-local",
              type: "deeplink",
              label: "Agilsmart",
              url: "https://example.test/agil/responsive",
              precision: "exact-offer",
              score: 1,
              requiresNewTab: true,
              commercialMode: "provider",
              state: "deeplink_exact",
            },
          ],
          tags: [],
          warnings: [],
        });

        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            searchJobId: `responsive-${viewport.label}-search`,
            searchComplete: true,
            searchStatus: "completed",
            revision: 1,
            sortMode: payload.sortMode,
            request: payload.request,
            offers: [offer],
            allOffers: [offer],
            searchMeta: {
              requestedAt: "2026-07-30T12:00:00.000Z",
              completedAt: "2026-07-30T12:00:01.000Z",
              providersUsed: ["agil-local"],
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

      await page.goto(`${baseUrl}/?mode=exact&trip=one-way&origin=LIM&destination=MIA&departure=2026-06-08&adults=1&children=0&infants=0`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByRole("combobox", { name: "Origen" }).waitFor();
      await assertNoHorizontalOverflow(page, `${viewport.label}:idle`);
      await assertSearchGridContained(page, `${viewport.label}:idle`);

      await page.keyboard.press("Tab");
      const brand = page.getByRole("link", { name: "Abrir Fly Desk" });
      assert.equal(await brand.evaluate((element) => element === document.activeElement), true);
      const focusStyle = await brand.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          boxShadow: style.boxShadow,
          outlineColor: style.outlineColor,
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
        };
      });
      const hasVisibleOutline = focusStyle.outlineStyle !== "none"
        && focusStyle.outlineWidth !== "0px"
        && focusStyle.outlineColor !== "rgba(0, 0, 0, 0)"
        && focusStyle.outlineColor !== "transparent";
      assert.ok(
        focusStyle.boxShadow !== "none" || hasVisibleOutline,
        JSON.stringify(focusStyle),
      );

      const themeToggle = page.getByRole("button", { name: "Cambiar tema" });
      assert.equal(await themeToggle.getAttribute("aria-pressed"), "false");
      await themeToggle.click();
      await page.locator("html.dark").waitFor();
      assert.equal(await themeToggle.getAttribute("aria-pressed"), "true");
      await themeToggle.click();
      await page.locator("html:not(.dark)").waitFor();

      await Promise.all([
        page.waitForResponse("**/api/search"),
        page.getByRole("button", { name: "Buscar" }).click(),
      ]);
      const card = page.getByTestId("result-card");
      await card.waitFor();

      await assertNoHorizontalOverflow(page, `${viewport.label}:results`);
      await assertSearchGridContained(page, `${viewport.label}:results`);
      assert.equal(await page.getByTestId("search-shell-frame").isVisible(), true);
      assert.equal(await page.getByRole("heading", { name: "Resultados" }).isVisible(), true);

      if (viewport.wideWorkspace) {
        assert.equal(await page.getByRole("tablist").isVisible().catch(() => false), false);
        assert.equal(await page.getByRole("heading", { name: "Filtros" }).isVisible(), true);
      } else {
        const resultsTab = page.getByRole("tab", { name: "Resultados" });
        const filtersTab = page.getByRole("tab", { name: "Filtros" });
        await resultsTab.waitFor();
        assert.equal(await resultsTab.getAttribute("aria-selected"), "true");
        await filtersTab.click();
        assert.equal(await page.getByRole("heading", { name: "Filtros" }).isVisible(), true);
        await assertNoHorizontalOverflow(page, `${viewport.label}:filters`);
        await resultsTab.click();
      }

      await card.getByRole("button", { name: /^Seleccionar oferta/ }).click();
      await page.getByTestId("detail-panel-body").waitFor();
      await assertNoHorizontalOverflow(page, `${viewport.label}:detail`);
    }, { autoOpen: false });
  });
}

async function assertNoHorizontalOverflow(
  page: import("playwright").Page,
  state: string,
): Promise<void> {
  const metrics = await page.evaluate(() => ({
    bodyClientWidth: document.body.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    documentClientWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
  }));

  assert.ok(
    metrics.bodyScrollWidth <= metrics.bodyClientWidth + 1
      && metrics.documentScrollWidth <= metrics.documentClientWidth + 1,
    `${state}: ${JSON.stringify(metrics)}`,
  );
}

async function assertSearchGridContained(
  page: import("playwright").Page,
  state: string,
): Promise<void> {
  const metrics = await page.locator(".fd-search-grid").evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));

  assert.ok(
    metrics.scrollWidth <= metrics.clientWidth + 1,
    `${state}: search grid overflow ${JSON.stringify(metrics)}`,
  );
}
