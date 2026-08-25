import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import { registerDesktopHarness, withDesktopPage } from "../helpers/ui.ts";
import { buildOffer } from "../helpers/ui-fixtures.ts";
import { clickSegment, openSearchUrlWithoutLaunching, openSharedSearchLink, segment } from "./support.ts";

registerDesktopHarness();

/**
 * The one mobile control height, read from the catalogue that defines it
 * (`--fd-control-touch`) rather than restated per assertion. 02 §12 is about
 * every square control agreeing on a height, which is a claim about the token;
 * a literal in each test turns one decision into twenty-seven of them.
 */
async function mobileTouchHeight(page: Page): Promise<number> {
  return page.evaluate(() => Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--fd-control-touch"),
  ));
}

const VIEWPORTS = [
  { label: "desktop", width: 1440, height: 900, shell: "wide" },
  { label: "tablet", width: 1024, height: 768, shell: "narrow" },
  { label: "mobile", width: 390, height: 844, shell: "mobile" },
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
                  operatingCarrier: "P9",
                  operatingCarrierName: "Aires, Aerovías de Integración Regional, S.A.",
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

      await openSearchUrlWithoutLaunching(page, `${baseUrl}/?mode=exact&trip=one-way&origin=LIM&destination=MIA&departure=2026-06-08&adults=1&children=0&infants=0`);
      await page.getByRole("combobox", { name: "Origen" }).waitFor();
      await assertNoHorizontalOverflow(page, `${viewport.label}:idle`);
      await assertSearchGridContained(page, `${viewport.label}:idle`);
      const captureDir = process.env.FLY_DESK_UI_CAPTURE_DIR;
      if (captureDir) {
        await page.screenshot({
          path: `${captureDir}/${viewport.label}-idle.png`,
          fullPage: true,
        });
      }

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
      /*
       * 02 §6 / plate 8c. The carrier column is the box that has to contain the
       * name and the operator: on the desk it is column 2 (186px) and the
       * `carrier-line` wrapper dissolves into it with `display: contents`, so
       * that wrapper has no rect to measure there. `.fd-card__carrier` is the
       * one element with a box in both dispositions.
       */
      const cardLayout = await card.evaluate((element) => {
        const provider = element.querySelector<HTMLElement>(".fd-card__provider");
        const baggage = element.querySelector<HTMLElement>(".fd-card__baggage");
        const carrier = element.querySelector<HTMLElement>(".fd-card__carrier");
        const carrierName = element.querySelector<HTMLElement>(".fd-card__carrier-name");
        const carrierOperator = element.querySelector<HTMLElement>(".fd-card__carrier-operator");
        const legs = element.querySelector<HTMLElement>(".fd-card__legs");
        const stops = element.querySelector<HTMLElement>(".fd-card__leg-stops");
        const list = element.closest<HTMLElement>(".fd-list");
        const carrierBox = carrier?.getBoundingClientRect();
        const carrierNameBox = carrierName?.getBoundingClientRect();
        const carrierOperatorBox = carrierOperator?.getBoundingClientRect();
        const legsBox = legs?.getBoundingClientRect();
        return {
          columns: getComputedStyle(element).gridTemplateColumns,
          providerVisible: provider ? getComputedStyle(provider).display !== "none" : false,
          baggageRow: baggage ? getComputedStyle(baggage).gridRow : "",
          headVisible: (() => {
            const head = document.querySelector<HTMLElement>("[data-testid='results-column-head']");
            return Boolean(head) && getComputedStyle(head as HTMLElement).display !== "none";
          })(),
          carrierRight: carrierBox?.right ?? 0,
          carrierNameWidth: carrierNameBox?.width ?? 0,
          carrierOperatorRight: carrierOperatorBox?.right ?? 0,
          legsLeft: legsBox?.left ?? 0,
          listWidth: list?.getBoundingClientRect().width ?? 0,
          stopsWidth: stops?.getBoundingClientRect().width ?? 0,
        };
      });
      assert.ok(cardLayout.carrierNameWidth > 0, JSON.stringify(cardLayout));
      // The operator ellipsis happens inside the carrier box; it never spills.
      assert.ok(cardLayout.carrierOperatorRight <= cardLayout.carrierRight + 1, JSON.stringify(cardLayout));
      /*
       * 02 §2: the disposition answers to the width of the list, not to the
       * shell, so the expectation is read off the same container the CSS asks.
       * The threshold is 787 — the manual says 660, but its sum omits the row's
       * own padding; 750 was the same measurement before the elastic lane's
       * floor was measured rather than borrowed from the duration lane, 819 was
       * it while the baggage lane was charged to the result cell instead of to
       * «who flies», and 775 was it while the row was still a card with a
       * `max-content` duration lane. It is `428 + 284 + 75` now. That is the
       * point of the last assertion: whichever disposition the list lands in,
       * the airport codes still have a box to live in.
       */
      const stacked = cardLayout.listWidth < 787;
      if (stacked) {
        /* 02 §6: the provider icon leaves for the detail. The chevron left with
           it — it was decorative and `aria-hidden`, and its lane was 24 of the
           310 a 360px phone has — so the stacked row is four lanes: logo, name,
           the pair's own fixed 32, and the price. The pair keeps the carrier
           line, where 8c and `Deriva.dc.html` draw it; carrying it in the legs
           block instead costs the elastic stops lane 36 and takes the airport
           code away from Flexible on a narrow phone. There is no column header
           here either: four lanes and two rows have nothing a six-lane header
           could name. */
        assert.equal(cardLayout.providerVisible, false, JSON.stringify(cardLayout));
        assert.equal(cardLayout.headVisible, false, JSON.stringify(cardLayout));
        assert.match(cardLayout.columns, /^24px [\d.]+px 32px [\d.]+px$/);
        assert.equal(cardLayout.baggageRow, "1", JSON.stringify(cardLayout));
      } else {
        /* 8c's 32 / 186 / 1fr / 116 / 26, with the baggage lane paid for out of
           «who flies» rather than out of the result cell, and the logo's four
           pixels moved into the baggage lane so the header above can name it:
           28 / 142 / 1fr / 36 / 116 / 26. Column 2 still stops before the legs
           track, and the header is drawn on the same six lanes. */
        assert.ok(cardLayout.carrierRight <= cardLayout.legsLeft + 1, JSON.stringify(cardLayout));
        assert.equal(cardLayout.providerVisible, true, JSON.stringify(cardLayout));
        assert.equal(cardLayout.headVisible, true, JSON.stringify(cardLayout));
        assert.match(cardLayout.columns, /^28px 142px /);
      }
      assert.ok(cardLayout.stopsWidth >= 32, JSON.stringify(cardLayout));

      await assertNoHorizontalOverflow(page, `${viewport.label}:results`);
      if (captureDir) {
        await page.screenshot({
          path: `${captureDir}/${viewport.label}-results.png`,
          fullPage: true,
        });
      }
      if (viewport.shell === "mobile") {
        const summary = page.getByRole("button", { name: "Editar búsqueda" });
        await summary.waitFor();
        const summaryMetrics = await summary.evaluate((element) => ({
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
        }));
        assert.ok(summaryMetrics.scrollWidth <= summaryMetrics.clientWidth + 1);
        // 1d: the list column is not a card (8a), so its header is the 32px
        // status row — count and pill left, order right — and it never retracts.
        assert.equal(
          Math.round((await page.locator(".fd-list .fd-list-header").boundingBox())?.height ?? 0),
          32,
        );
        // 1d: the desk's "Ordenar" label does not survive the 32px status row.
        assert.equal(await page.locator(".fd-list-header .fd-result-sort-label").isVisible(), false);
      } else {
        await assertSearchGridContained(page, `${viewport.label}:results`);
      }
      assert.equal(await page.getByTestId("search-shell-frame").isVisible(), true);
      assert.equal(
        await page.getByRole("heading", { name: "Resultados", exact: true }).isVisible(),
        viewport.shell !== "mobile",
      );

      if (viewport.shell === "wide") {
        assert.equal(await page.getByRole("tablist").isVisible().catch(() => false), false);
        assert.equal(await page.getByRole("heading", { name: "Filtros" }).isVisible(), true);
      } else if (viewport.shell === "narrow") {
        assert.equal(await page.getByRole("tablist").count(), 0);
        assert.equal(await page.getByRole("heading", { name: "Filtros" }).isVisible(), true);
        assert.equal(await page.getByRole("button", { name: "Abrir filtros" }).count(), 0);
      } else {
        assert.equal(await page.getByRole("tablist").count(), 0);
        // 02 §9 step 6: the 26px filter button of the status row only exists
        // while the tools are retracted. Expanded, the way in is the "Filtros"
        // chip that heads the strip (1d).
        assert.equal(await page.locator(".fd-status-row-filters").isVisible(), false);
        const filtersButton = page.getByRole("button", { name: "Abrir filtros" });
        await filtersButton.waitFor();
        await filtersButton.click();
        const filtersSheet = page.getByRole("dialog", { name: "Filtros" });
        await filtersSheet.waitFor();
        assert.equal(await page.getByRole("heading", { name: "Filtros" }).isVisible(), true);
        assert.equal(await filtersSheet.getByRole("button", { name: "Limpiar" }).isVisible(), true);
        /* 04 §2 draws the sheet's segmented at the mobile control height and
           01 §10 closes the 38/40/36 spread across the plates at that one
           height in all 27 places. The height itself is the catalogue's, not a
           number copied here — it moved from 44 to 40 when three of these in a
           column proved to be more room than a mis-tap is worth. */
        const touchHeight = await mobileTouchHeight(page);
        assert.equal(touchHeight, 40);
        assert.equal(
          Math.round((await filtersSheet.locator(".fd-segmented").first().boundingBox())?.height ?? 0),
          touchHeight,
        );
        assert.equal(
          Math.round((await filtersSheet.locator(".fd-airline-row").first().boundingBox())?.height ?? 0),
          touchHeight,
        );
        // 1e writes the primary action of the sheet as «Ver 386 vuelos»: the
        // count is the label, not a badge after it. The drawing overrides the
        // «Ver resultados» wording of 04 §2 (precedence rule 1).
        assert.match(
          await filtersSheet.getByRole("button", { name: /^Ver / }).innerText(),
          /^Ver [\d.,]+ vuelos?$/,
        );
        await assertNoHorizontalOverflow(page, `${viewport.label}:filters`);
        if (captureDir) {
          await page.screenshot({
            path: `${captureDir}/${viewport.label}-filters-sheet.png`,
            fullPage: true,
          });
        }
        await clickSegment(segment(filtersSheet, "Directo"));
        await filtersSheet.getByRole("button", { name: "Cerrar filtros" }).click();
        await filtersSheet.waitFor({ state: "detached" });
        await page.waitForFunction(() => !window.history.state?.fdSheet);

        // 1d: the chips are the middle band of the block — one line that
        // scrolls sideways, never a second row that would push the list down.
        const filterStrip = page.locator(".fd-filter-strip");
        await filterStrip.locator(".fd-active-chip").filter({ hasText: "Directo" }).waitFor();
        const filterStripLayout = await filterStrip.evaluate((element) => {
          const style = getComputedStyle(element);
          return { flexWrap: style.flexWrap, overflowX: style.overflowX };
        });
        assert.equal(filterStripLayout.flexWrap, "nowrap");
        assert.equal(filterStripLayout.overflowX, "auto");

        const resultsBody = page.getByTestId("results-list-body");
        const scrollMetrics = await resultsBody.evaluate((element) => {
          const spacer = document.createElement("div");
          spacer.style.cssText = "height:1200px;flex:0 0 1200px";
          spacer.setAttribute("data-test-scroll-spacer", "true");
          element.append(spacer);
          element.scrollTop = 100;
          element.dispatchEvent(new Event("scroll"));
          return {
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
            scrollTop: element.scrollTop,
          };
        });
        assert.ok(scrollMetrics.scrollHeight > scrollMetrics.clientHeight, JSON.stringify(scrollMetrics));
        assert.equal(scrollMetrics.scrollTop, 100, JSON.stringify(scrollMetrics));
        // 1d + 02 §9: summary, chips and notice are ONE container with ONE
        // max-height. The search frame no longer collapses on its own — there
        // is a single collapse flag, on the block.
        await page.waitForFunction(() => (
          document.querySelector<HTMLElement>(".fd-tools-block")?.dataset.collapsed === "true"
        ));
        // Step 6: once retracted, the status row grows its 26px filter button.
        await page.locator('.fd-status-row-filters[data-collapsed="true"]').waitFor();

        await page.waitForTimeout(320);
        await resultsBody.evaluate((element) => {
          element.scrollTop = 0;
          element.dispatchEvent(new Event("scroll"));
        });
        // Step 4: back at scrollTop 0 the block returns, and with it the chips.
        await page.waitForFunction(() => (
          document.querySelector<HTMLElement>(".fd-tools-block")?.dataset.collapsed === "false"
        ));
        assert.equal(await page.locator(".fd-status-row-filters").isVisible(), false);
      }

      let preservedMobileScroll: number | undefined;
      if (viewport.shell === "mobile") {
        const resultsBody = page.getByTestId("results-list-body");
        await resultsBody.evaluate((element) => {
          element.scrollTop = 64;
        });
        preservedMobileScroll = await resultsBody.evaluate((element) => element.scrollTop);
        assert.ok(preservedMobileScroll > 0);
      }

      const selectOffer = card.getByRole("button", { name: /^Seleccionar oferta/ });
      if (viewport.shell === "mobile") {
        await selectOffer.evaluate((button) => {
          if (!(button instanceof HTMLElement)) {
            throw new Error("The card's hit area is not an HTML element.");
          }

          button.click();
        });
      } else {
        await selectOffer.click();
      }
      await page.getByTestId("detail-panel-body").waitFor();
      if (viewport.shell !== "wide") {
        const detailSheet = page.getByRole("dialog", { name: "Oferta" });
        await detailSheet.waitFor();
        // 11 §0 rule 3: every action has a visible way back. In armazón B the
        // side sheet carries no chrome of its own (8a) — the detail header is
        // the header — so the close lives inside the panel either way.
        assert.equal(await detailSheet.getByRole("button", { name: /^Cerrar/ }).isVisible(), true);
        if (viewport.shell === "mobile") {
          assert.equal(
            await page.getByTestId("results-list-body").evaluate((element) => element.scrollTop),
            preservedMobileScroll,
          );
        }
      }
      await assertNoHorizontalOverflow(page, `${viewport.label}:detail`);
      if (captureDir) {
        await page.screenshot({
          path: `${captureDir}/${viewport.label}-detail.png`,
          fullPage: true,
        });
      }
      if (viewport.shell === "mobile") {
        const detailSheet = page.getByRole("dialog", { name: "Oferta" });
        await detailSheet.getByRole("button", { name: "Cerrar oferta" }).click();
        await detailSheet.waitFor({ state: "detached" });
        assert.equal(
          await page.getByTestId("results-list-body").evaluate((element) => element.scrollTop),
          preservedMobileScroll,
        );

        /* 1d and 04 §3: the title goes, the order stays. The right of the
           status row reads «↕ Precio» at 12/600 in `--muted-fg`; 02 §5 lists
           exactly what may be hidden on a phone, and the order is not on that
           list — the only sort thing dropped is the desk's "Ordenar" label.
           Last assertion of the test on purpose: everything above it is the
           part of armazón C that is already right. */
        assert.match((await page.locator(".fd-list-header-trail").innerText()).trim(), /Precio/);
      }
    }, { autoOpen: false });
  });
}

test("mobile search overlays use the shared full and partial sheet patterns", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const captureDir = process.env.FLY_DESK_UI_CAPTURE_DIR;
    await page.route("**/api/location-usage-suggestions**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          frequent: {
            origin: ["LIM", "CUZ", "MAD"],
            destination: ["MIA", "JFK"],
          },
          recent: { origin: [], destination: [] },
        }),
      });
    });
    await page.route("**/api/locations**", async (route) => {
      const query = (new URL(route.request().url()).searchParams.get("q") ?? "").trim().toUpperCase();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          suggestions: query
            ? [{
                code: "LIM",
                city: "Lima",
                country: "Perú",
                countryCode: "PE",
                label: "Lima, Perú (LIM)",
              }]
            : [],
        }),
      });
    });

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    const routeCard = page.locator(".fd-route-fields");
    await routeCard.waitFor();
    /* 02 §4 · one component, two mountings: the phone's row of frequents is the
       same `.fd-quick-chips` strip the desk puts under each field, merged into
       one and titled. There is no `Mobile…` copy of it to look for. */
    await page.locator(".fd-mobile-quick-block .fd-quick-chips").waitFor();
    // 1c draws both segmenteds full width, and 01 §10 closes the plate spread
    // (38 in 1c/2b, 40 in 1e/8d, 36 in 2c/1d) at one height everywhere: the
    // mobile control of 02 §12, "sin excepciones".
    for (const segmented of await page.locator(".fd-search-controls-row .fd-segmented").all()) {
      assert.equal(Math.round((await segmented.boundingBox())?.height ?? 0), await mobileTouchHeight(page));
    }
    // 1c: origin and destination are ONE card — 58 + 1px of divider + 58.
    assert.equal(Math.round((await routeCard.boundingBox())?.height ?? 0), 117);
    assert.equal(
      Math.round((await page.locator(".fd-daterange-control").boundingBox())?.height ?? 0),
      58,
    );
    assert.equal(
      Math.round((await page.getByRole("button", { name: "Seleccionar pasajeros" }).boundingBox())?.height ?? 0),
      58,
    );
    assert.equal(await routeCard.locator(".fd-quick-chips").count(), 0);
    assert.equal(await page.locator(".fd-mobile-quick-block .fd-quick-chip").count(), 5);
    assert.equal(await page.getByText("Frecuentes", { exact: true }).isVisible(), true);
    // 1c: five elastic chips at the mobile control height, no separator (02 §4).
    assert.equal(
      Math.round((await page.locator(".fd-mobile-quick-block .fd-quick-chips").boundingBox())?.height ?? 0),
      await mobileTouchHeight(page),
    );
    const searchButtonBox = await page.getByRole("button", { name: "Buscar", exact: true }).boundingBox();
    const quickChipsBox = await page.locator(".fd-mobile-quick-block .fd-quick-chips").boundingBox();
    assert.ok(
      searchButtonBox && quickChipsBox && searchButtonBox.y + searchButtonBox.height <= quickChipsBox.y,
      JSON.stringify({ searchButtonBox, quickChipsBox }),
    );
    assert.ok(
      searchButtonBox && quickChipsBox && quickChipsBox.y - (searchButtonBox.y + searchButtonBox.height) >= 28,
      JSON.stringify({ searchButtonBox, quickChipsBox }),
    );
    const policy = page.locator(".fd-policy-line");
    const providerRail = page.locator(".fd-provider-rail");
    const policyBox = await policy.boundingBox();
    const providerRailBox = await providerRail.boundingBox();
    assert.match((await policy.innerText()).trim(), /^Ventana .+·hasta \d+ noches$/);
    assert.doesNotMatch(await policy.innerText(), /pasajeros|ida y vuelta|de búsqueda/);
    assert.ok(policyBox && policyBox.y + policyBox.height <= 844, JSON.stringify(policyBox));
    assert.ok(
      policyBox && providerRailBox && policyBox.y + policyBox.height <= providerRailBox.y,
      JSON.stringify({ policyBox, providerRailBox }),
    );
    assert.ok(
      policyBox && providerRailBox && providerRailBox.y - (policyBox.y + policyBox.height) <= 12,
      JSON.stringify({ policyBox, providerRailBox }),
    );
    assert.ok(
      providerRailBox && providerRailBox.y + providerRailBox.height <= 844,
      JSON.stringify(providerRailBox),
    );

    const origin = page.getByRole("combobox", { name: "Origen", exact: true });
    await origin.waitFor();
    await origin.click();

    const locationSheet = page.getByRole("dialog", { name: "Origen" });
    await locationSheet.waitFor();
    const locationSearch = locationSheet.getByRole("combobox", { name: "Origen: buscar ciudad o IATA" });
    await locationSearch.fill("lim");
    const locationOption = locationSheet.getByRole("option", { name: /LIM/ });
    await locationOption.waitFor();
    assert.equal(Math.round((await locationOption.boundingBox())?.height ?? 0), 60);
    await assertNoHorizontalOverflow(page, "mobile:location-sheet");
    if (captureDir) await page.screenshot({ path: `${captureDir}/mobile-location-sheet.png`, fullPage: true });
    await locationOption.click();
    await locationSheet.waitFor({ state: "detached" });

    /* The value line of an empty half, to compare the filled one against once
       the sheet has committed a range: a date that arrives must land where the
       «Elegir» it replaces was standing. */
    const emptyHalfLine = await page.locator(".fd-daterange-control").evaluate((control) => {
      const value = control.querySelector(".fd-field-value");
      if (!value) throw new Error("Missing date value line.");
      return Math.round(value.getBoundingClientRect().top - control.getBoundingClientRect().top);
    });

    await page.getByRole("button", { name: /^Salida:/ }).click();
    const dateSheet = page.getByRole("dialog", { name: "Fechas" });
    await dateSheet.waitFor();
    const dateSheetBox = await dateSheet.boundingBox();
    assert.ok(dateSheetBox && dateSheetBox.height >= 790, JSON.stringify(dateSheetBox));
    assert.equal(await dateSheet.getByRole("button", { name: "Mes anterior" }).count(), 0);
    assert.equal(await dateSheet.locator(".fd-cal-weekdays").count(), 1);
    assert.equal(
      Math.round((await dateSheet.locator(".fd-cal-cell:not([data-blank='true'])").first().boundingBox())?.height ?? 0),
      await mobileTouchHeight(page),
    );
    assert.equal(await dateSheet.getByRole("button", { name: "Borrar" }).isVisible(), true);
    assert.equal(await dateSheet.getByRole("button", { name: "Aplicar" }).isVisible(), true);
    assert.equal(await dateSheet.getByRole("button", { name: "Cerrar fechas" }).isVisible(), true);
    await assertNoHorizontalOverflow(page, "mobile:calendar-sheet");
    /*
     * 02 §7: the pinned head *is* the top edge of the scrolling region, and it
     * holds the weekday row. Two regressions live here and both were visible
     * with a scrolled grid: the sheet body used to open with 12px of its own
     * `padding-top`, which a scroller paints its content through — a strip of
     * sliding day cells above the header — and the weekday row used to be a
     * second sticky whose offset was a copy of the header's height, which is
     * not a constant. Measured while scrolled, because at rest a gap is only a
     * gap and the strip shows nothing.
     */
    const pinnedHead = await dateSheet.locator(".fd-sheet-body").evaluate((body) => {
      body.scrollTop = 300;
      const pinned = body.querySelector(".fd-cal-sticky");
      const head = body.querySelector(".fd-cal-head");
      const weekdays = body.querySelector(".fd-cal-weekdays");
      if (!pinned || !head || !weekdays) throw new Error("Missing pinned calendar head.");
      const bodyRect = body.getBoundingClientRect();
      const pinnedRect = pinned.getBoundingClientRect();
      return {
        scrollTop: body.scrollTop,
        strip: Math.round(pinnedRect.top - bodyRect.top),
        headToWeekdays: Math.round(
          weekdays.getBoundingClientRect().top - head.getBoundingClientRect().bottom,
        ),
        weekdaysPinned: pinned.contains(weekdays),
      };
    });
    assert.deepEqual(pinnedHead, { scrollTop: 300, strip: 0, headToWeekdays: 0, weekdaysPinned: true });
    if (captureDir) await page.screenshot({ path: `${captureDir}/mobile-calendar-sheet.png`, fullPage: true });

    /* A range, so the return half grows its cross: 11 §2.2 commits the draft on
       every way out of the sheet, the closing cross included. */
    const dayCells = dateSheet.locator(".fd-cal-cell:not([data-blank='true']):not([disabled])");
    await dayCells.nth(3).click();
    await dayCells.nth(8).click();
    await dateSheet.getByRole("button", { name: "Cerrar fechas" }).click();
    await dateSheet.waitFor({ state: "detached" });

    /*
     * 02 §12 grows the cross to 44 and the field stays 58: the half may not
     * grow with it. It did — the 44px target carried a bottom margin the size
     * of the label band, its 60px margin box grew the row to 76, the control
     * clipped that back to 58 and the date rendered near the bottom edge with
     * the cross cut off.
     */
    const filledHalf = await page.locator(".fd-daterange-control").evaluate((control) => {
      const half = control.querySelector<HTMLElement>('.fd-daterange-half[data-half="end"]');
      const value = half?.querySelector(".fd-field-value");
      const clear = half?.querySelector(".fd-daterange-clear");
      if (!half || !value || !clear) throw new Error("Missing filled return half.");
      const controlRect = control.getBoundingClientRect();
      const clearRect = clear.getBoundingClientRect();
      return {
        halfFitsControl: half.getBoundingClientRect().height <= controlRect.height,
        valueLine: Math.round(value.getBoundingClientRect().top - controlRect.top),
        clearHeight: Math.round(clearRect.height),
        clearInsideControl: clearRect.top >= controlRect.top - 0.5
          && clearRect.bottom <= controlRect.bottom + 0.5,
        /* And on the axis of the control, not of the value line. */
        clearOffCentre: Math.round(
          Math.abs((clearRect.top + clearRect.bottom) / 2 - (controlRect.top + controlRect.bottom) / 2),
        ),
      };
    });
    assert.deepEqual(filledHalf, {
      halfFitsControl: true,
      valueLine: emptyHalfLine,
      clearHeight: await mobileTouchHeight(page),
      clearInsideControl: true,
      clearOffCentre: 0,
    });

    await page.getByRole("button", { name: "Seleccionar pasajeros" }).click();
    const passengerSheet = page.getByRole("dialog", { name: "Pasajeros" });
    await passengerSheet.waitFor();
    const passengerSheetBox = await passengerSheet.boundingBox();
    assert.ok(passengerSheetBox && passengerSheetBox.height >= 560 && passengerSheetBox.height <= 570, JSON.stringify(passengerSheetBox));
    // 2d: the same passenger row the popover uses, at 64 inside the sheet.
    assert.equal(Math.round((await passengerSheet.locator(".fd-pax-rows > .fd-pax-row").first().boundingBox())?.height ?? 0), 64);
    assert.equal(
      Math.round((await passengerSheet.getByRole("button", { name: "Agregar adultos" }).boundingBox())?.height ?? 0),
      await mobileTouchHeight(page),
    );
    await assertNoHorizontalOverflow(page, "mobile:passenger-sheet");
    if (captureDir) await page.screenshot({ path: `${captureDir}/mobile-passenger-sheet.png`, fullPage: true });
    await passengerSheet.getByRole("button", { name: "Cerrar pasajeros" }).click();
    await passengerSheet.waitFor({ state: "detached" });

    await clickSegment(segment(page, "Migratorio"));
    await page.getByRole("button", { name: /^Meses:/ }).click();
    const monthSheet = page.getByRole("dialog", { name: "Meses" });
    await monthSheet.waitFor();
    assert.equal(await monthSheet.getByRole("button", { name: "Mes anterior" }).count(), 0);
    assert.equal(
      Math.round((await monthSheet.locator(".fd-cal-cell-month").first().boundingBox())?.height ?? 0),
      await mobileTouchHeight(page),
    );
    assert.equal(await monthSheet.getByRole("button", { name: "Borrar" }).isVisible(), true);
    assert.equal(await monthSheet.getByRole("button", { name: "Aplicar" }).isVisible(), true);
    await assertNoHorizontalOverflow(page, "mobile:month-sheet");
    if (captureDir) await page.screenshot({ path: `${captureDir}/mobile-month-sheet.png`, fullPage: true });
  }, { autoOpen: false });
});

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

test("the desk card gives the codeshare a line and the trip a single row", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    /*
     * Three things the plate got wrong for real data, all reported from the
     * desk. The baggage icons had taken the second line of the carrier column,
     * which is where the operating airline belongs — the one fact the passenger
     * meets at the counter. Baggage is a property of the fare, so it travels
     * with the price.
     *
     * The third was two stacked legs leaving a third of a 1920 card empty, and
     * the answer was a side-by-side pair past 1073px of list. That disposition
     * is retired: a table row's stops lane takes the slack by itself — it is
     * 432px at 1920 — and a second anatomy would need a second column header.
     * So the legs stack at every desk width now, and this case pins that: the
     * two leg rows have different tops at 1440 *and* at 1920.
     */
    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/search", async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      const base = buildOffer({ id: "codeshare" });
      const offers = [buildOffer({
        id: "codeshare",
        destination: "MAD",
        itineraries: [
          {
            ...base.itineraries[0],
            segments: [{
              ...base.itineraries[0].segments[0],
              marketingCarrier: "AF",
              marketingCarrierName: "Air France",
              operatingCarrier: "DL",
              operatingCarrierName: "Delta",
            }],
          },
          base.itineraries[1],
        ] as never,
      })];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "codeshare-search",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: payload.sortMode,
          request: payload.request,
          offers,
          allOffers: offers,
          searchMeta: {
            requestedAt: "2026-07-30T12:00:00.000Z",
            completedAt: "2026-07-30T12:00:01.000Z",
            providersUsed: ["agil-local"],
            warnings: [],
            partial: false,
            searchState: "search_live",
          },
          providerMeta: { exactProvider: "agil-local", coverageMode: "core" },
          warnings: [],
        }),
      });
    });

    for (const width of [1440, 1920] as const) {
      await page.setViewportSize({ width, height: 940 });
      await openSharedSearchLink(page, `${baseUrl}/?mode=exact&trip=round-trip&origin=LIM&destination=MAD&departure=2026-09-12&return=2026-09-19&adults=1&children=0&infants=0`);
      await page.getByTestId("result-card").first().waitFor();

      const card = await page.getByTestId("result-card").first().evaluate((element) => {
        const legTops = Array.from(element.querySelectorAll<HTMLElement>(".fd-card__leg"))
          .map((leg) => Math.round(leg.getBoundingClientRect().top));
        const baggage = element.querySelector<HTMLElement>(".fd-card__baggage");
        const price = element.querySelector<HTMLElement>(".fd-card__price");
        const operator = element.querySelector<HTMLElement>(".fd-card__carrier-operator");
        const carrier = element.querySelector<HTMLElement>(".fd-card__carrier");
        return {
          height: Math.round(element.getBoundingClientRect().height),
          legTops,
          operator: operator?.textContent?.trim() ?? "",
          operatorInsideCarrier: Boolean(operator && carrier?.contains(operator)),
          baggageLeft: baggage ? baggage.getBoundingClientRect().left : 0,
          priceLeft: price ? price.getBoundingClientRect().left : 0,
          carrierRight: carrier ? carrier.getBoundingClientRect().right : 0,
        };
      });

      // The codeshare is on the carrier column, not squeezed out by luggage.
      assert.equal(card.operator, "op. Delta", JSON.stringify(card));
      assert.equal(card.operatorInsideCarrier, true, JSON.stringify(card));
      // Baggage sits with the fare it belongs to, between the legs and the price.
      assert.ok(card.baggageLeft > card.carrierRight, JSON.stringify(card));
      assert.ok(card.baggageLeft < card.priceLeft, JSON.stringify(card));
      /* 52 either way: plate 1b's row, with its hairline inside the height and
         no padding but the horizontal 10. It was 58 while the row was a card
         whose 13px padding and 1px border were part of it. */
      assert.equal(card.height, 52, JSON.stringify(card));
      assert.equal(card.legTops.length, 2, JSON.stringify(card));
      assert.equal(card.legTops[0] === card.legTops[1], false, JSON.stringify(card));
    }
  }, { autoOpen: false });
});

test("the stacked card keeps the baggage on the carrier line and the stops whole", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    /*
     * The phone counterpart of the test above, and the two things the stacked
     * anatomy got wrong. The baggage had no placement in the stacked query — it
     * carried a `flex` that a grid item ignores — so auto-placement opened an
     * implicit third row and dropped the pair into the 24px logo track, half of
     * it outside the card's own padding. And the stops lane, 57px, was
     * ellipsising «2 esc · PTY, MIA» down to a dangling «2 esc…», hiding the
     * codes it was being cut to show.
     *
     * The pair has not moved: it keeps the carrier line, between the name and
     * the price, which is where 8c and `Deriva.dc.html` draw it. `MovilCompacta`
     * moves it down into the legs block as a fifth lane and this file shipped
     * that first — but the maqueta can afford the move only because it also
     * drops the airport code from the stops label, which decision 3 forbids.
     * What changed is that its lane is a fixed 32 rather than an `auto` that
     * exists only when the provider said something: the placement is still
     * explicit, which is the half of this case that catches the original
     * defect, and the geometry no longer depends on the fare.
     */
    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/search", async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      const base = buildOffer({ id: "stacked" });
      const outbound = base.itineraries[0];
      const offers = [buildOffer({
        id: "stacked",
        itineraries: [
          {
            ...outbound,
            stops: 2,
            layoverMinutes: [90, 70],
            segments: [
              { ...outbound.segments[0], destination: "PTY" },
              {
                ...outbound.segments[0],
                id: "stacked-outbound-segment-2",
                flightNumber: "LA 456",
                origin: "PTY",
                destination: "BOG",
                departureAt: "2026-04-15T17:00:00Z",
                arrivalAt: "2026-04-15T19:00:00Z",
              },
              {
                ...outbound.segments[0],
                id: "stacked-outbound-segment-3",
                flightNumber: "LA 789",
                origin: "BOG",
                destination: "MIA",
                departureAt: "2026-04-15T20:00:00Z",
                arrivalAt: "2026-04-15T22:00:00Z",
              },
            ],
          },
          base.itineraries[1],
        ] as never,
      })];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "stacked-search",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: payload.sortMode,
          request: payload.request,
          offers,
          allOffers: offers,
          searchMeta: {
            requestedAt: "2026-07-30T12:00:00.000Z",
            completedAt: "2026-07-30T12:00:01.000Z",
            providersUsed: ["agil-local"],
            warnings: [],
            partial: false,
            searchState: "search_live",
          },
          providerMeta: { exactProvider: "agil-local", coverageMode: "core" },
          warnings: [],
        }),
      });
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await openSharedSearchLink(page, `${baseUrl}/?mode=exact&trip=round-trip&origin=LIM&destination=MIA&departure=2026-04-15&return=2026-04-22&adults=1&children=0&infants=0`);
    await page.getByTestId("result-card").first().waitFor();

    const card = await page.getByTestId("result-card").first().evaluate((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const rectOf = (selector: string) => {
        const node = element.querySelector<HTMLElement>(selector);
        return node ? node.getBoundingClientRect() : null;
      };
      const baggageNode = element.querySelector<HTMLElement>(".fd-card__baggage");
      const baggage = rectOf(".fd-card__baggage");
      const carrier = rectOf(".fd-card__carrier");
      const price = rectOf(".fd-card__price");
      const legs = rectOf(".fd-card__legs");
      return {
        rows: style.gridTemplateRows.trim().split(/\s+/).length,
        columns: style.gridTemplateColumns,
        height: Math.round(box.height),
        contentLeft: box.left + Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.borderLeftWidth),
        contentRight: box.right - Number.parseFloat(style.paddingRight) - Number.parseFloat(style.borderRightWidth),
        baggage: baggage && { left: baggage.left, right: baggage.right, top: baggage.top, bottom: baggage.bottom },
        baggageRow: baggageNode ? getComputedStyle(baggageNode).gridRow : "",
        carrierRight: carrier?.right ?? 0,
        priceLeft: price?.left ?? 0,
        legsTop: legs?.top ?? 0,
        stops: Array.from(element.querySelectorAll<HTMLElement>(".fd-card__leg-stops")).map((lane) => ({
          text: lane.querySelector<HTMLElement>(".fd-card__leg-stops-short")?.textContent?.trim() ?? "",
          clientWidth: lane.clientWidth,
          scrollWidth: lane.scrollWidth,
        })),
      };
    });

    // 8c: two rows and no third. The implicit one cost 22px of card height.
    assert.equal(card.rows, 2, JSON.stringify(card));
    /* Four lanes, and the last of them is the price rather than a 14px
       chevron: the chevron was decorative, `aria-hidden`, and its lane plus its
       gap was 24 of the 310 a 360px phone has to spend on a row. The third is
       the pair's, a fixed 32 whether or not this fare has one. */
    assert.match(card.columns, /^24px [\d.]+px 32px [\d.]+px$/);
    /* The pair rides the carrier line, between the name and the price, and
       stays inside the card's own padding on both sides. */
    assert.ok(card.baggage, JSON.stringify(card));
    assert.ok(card.baggage!.left >= card.contentLeft - 0.5, JSON.stringify(card));
    assert.ok(card.baggage!.right <= card.contentRight + 0.5, JSON.stringify(card));
    assert.equal(card.baggageRow, "1", JSON.stringify(card));
    assert.ok(card.baggage!.left >= card.carrierRight, JSON.stringify(card));
    assert.ok(card.baggage!.right <= card.priceLeft, JSON.stringify(card));
    assert.ok(card.baggage!.bottom <= card.legsTop, JSON.stringify(card));
    // 02 §13 forbids clipping a cifra, and an ellipsis here eats the airports.
    assert.equal(card.stops.length, 2, JSON.stringify(card));
    assert.equal(card.stops[0].text, "2 esc", JSON.stringify(card));
    for (const lane of card.stops) {
      assert.ok(lane.scrollWidth <= lane.clientWidth, JSON.stringify(card));
    }
  }, { autoOpen: false });
});
