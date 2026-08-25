import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import { registerDesktopHarness, withDesktopPage } from "../helpers/ui.ts";
import { buildOffer } from "../helpers/ui-fixtures.ts";
import { openSharedSearchLink } from "./support.ts";

registerDesktopHarness();

/*
 * The gestures and the history — the «Gestos» plate and §0 of «Movimiento».
 *
 * Nothing covered any of this: every suite that opens a layer closes it with the
 * cross, the scrim or `Esc`, which are exactly the three ways out a phone does
 * not use. The two conventions the operating system arrives with — back, and the
 * swipe towards the edge the sheet came in through — were the only ones without
 * a single assertion.
 *
 * A UI file cannot import the application's modules, so class names and keys are
 * spelled out here, the same reason `filters.playwright.ts` spells out the
 * workspace preferences and `support.ts` the search session key.
 */

/** The mark every layer leaves in `history.state` (`hooks/useOverlayHistory.ts`). */
const OVERLAY_HISTORY_KEY = "fdSheet";

type HistoryProbe = { length: number; mark: string | null };

async function historyProbe(page: Page): Promise<HistoryProbe> {
  return page.evaluate((key) => ({
    length: window.history.length,
    mark: (window.history.state as Record<string, unknown> | null)?.[key] as string ?? null,
  }), OVERLAY_HISTORY_KEY);
}

/**
 * Stretch the sheet's exit so it can be looked at.
 *
 * Not a test trick: the exit's duration lives in one row of the catalog and both
 * the CSS and `sheet.tsx`'s timer read it from there, so rewriting the token
 * moves the two together. That this alone is enough to freeze the close is, in
 * passing, the proof the number is no longer copied into JavaScript.
 */
async function holdTheExit(page: Page): Promise<void> {
  await page.addStyleTag({ content: ":root { --fd-dur-exit-hoja: 2000ms; }" });
}

type DragResult = {
  transforms: string[];
  drag: string | null;
  dragX: string;
  width: number;
  height: number;
};

/**
 * Play a finger over an element of the sheet and report what the panel did.
 *
 * `stepDelayMs` is the only way to give the recogniser a velocity to measure: it
 * samples once a frame has passed, so a tight loop — which is what one
 * `dispatchEvent` after another is — produces zero velocity and leaves the
 * decision to the distance. Which is what the distance cases want.
 */
async function dragSheet(
  page: Page,
  options: { selector: string; by: { x?: number; y?: number }[]; release: boolean; stepDelayMs?: number },
): Promise<DragResult> {
  return page.evaluate(async ({ selector, by, release, stepDelayMs }) => {
    const target = document.querySelector<HTMLElement>(selector);
    const panel = target?.closest<HTMLElement>(".fd-sheet");
    if (!target || !panel) throw new Error(`Missing sheet for ${selector}.`);

    const box = panel.getBoundingClientRect();
    const startX = Math.round(box.left + box.width / 2);
    const startY = Math.round(box.top + box.height / 2);
    const touchAt = (clientX: number, clientY: number) => new Touch({
      identifier: 7,
      target,
      clientX,
      clientY,
    });
    const fire = (type: string, clientX: number, clientY: number) => {
      target.dispatchEvent(new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches: type === "touchend" ? [] : [touchAt(clientX, clientY)],
        changedTouches: [touchAt(clientX, clientY)],
      }));
    };

    fire("touchstart", startX, startY);
    const transforms: string[] = [];
    let lastX = startX;
    let lastY = startY;
    for (const step of by) {
      if (stepDelayMs) await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
      lastX = startX + (step.x ?? 0);
      lastY = startY + (step.y ?? 0);
      fire("touchmove", lastX, lastY);
      transforms.push(panel.style.transform);
    }
    const dragX = panel.style.getPropertyValue("--fd-sheet-drag-x");
    if (release) fire("touchend", lastX, lastY);

    return {
      transforms,
      drag: panel.dataset.drag ?? null,
      /* Read after the release when there was a dismissal: it is what the exit
         uses as its first frame. */
      dragX: panel.style.getPropertyValue("--fd-sheet-drag-x") || dragX,
      width: box.width,
      height: box.height,
    };
  }, options);
}

function quotableOffer() {
  return buildOffer({
    id: "gesture-offer",
    signature: "costamar:gesture-offer",
    providerOfferRef: "gesture-offer",
    providerSource: "costamar",
    tripType: "one-way",
    origin: "LIM",
    destination: "MIA",
    quotationPreparedAt: "2026-06-01T12:00:00.000Z",
    usdToPenRate: 3.61,
    price: {
      total: { amount: 512, currencyCode: "USD" },
      base: { amount: 420, currencyCode: "USD" },
      taxes: { amount: 92, currencyCode: "USD" },
    },
    itineraries: [{
      id: "gesture-offer-outbound",
      direction: "outbound",
      durationMinutes: 360,
      stops: 0,
      layoverMinutes: [],
      segments: [{
        id: "gesture-offer-outbound-1",
        flightNumber: "LA 2460",
        marketingCarrier: "LA",
        marketingCarrierName: "LATAM Airlines",
        origin: "LIM",
        destination: "MIA",
        departureAt: "2026-06-08T08:30:00-05:00",
        arrivalAt: "2026-06-08T15:30:00-04:00",
        durationMinutes: 360,
      }],
    }],
  });
}

async function routeOneOfferSearch(page: Page): Promise<void> {
  const offer = quotableOffer();
  await page.route("**/api/locations**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ suggestions: [] }) });
  });
  await page.route("**/api/search", async (route) => {
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        searchJobId: "gesture-search",
        searchComplete: true,
        searchStatus: "completed",
        revision: 1,
        sortMode: payload.sortMode,
        request: payload.request,
        offers: [offer],
        allOffers: [offer],
        searchMeta: {
          requestedAt: "2026-06-01T12:00:00.000Z",
          completedAt: "2026-06-01T12:00:01.000Z",
          providersUsed: ["costamar"],
          warnings: [],
          partial: false,
          searchState: "search_live",
        },
        providerMeta: { exactProvider: "costamar", coverageMode: "core" },
        warnings: [],
      }),
    });
  });
}

const SEARCH_QUERY = "?mode=exact&trip=one-way&origin=LIM&destination=MIA&departure=2026-06-08"
  + "&adults=1&children=0&infants=0&sort=cheapest";

/**
 * A card's select area names itself differently once the offer is chosen — and
 * it is still chosen on the way back from the sheet.
 */
const SELECT_OFFER = /^(Seleccionar oferta|Oferta seleccionada)/;

/** Leave the phone's detail sheet open, and hand it back. */
async function openMobileDetailSheet(page: Page, baseUrl: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  await routeOneOfferSearch(page);
  await openSharedSearchLink(page, `${baseUrl}/${SEARCH_QUERY}`);
  await page.getByTestId("result-card").waitFor();
  /* A card's select area is a button under its content; on a phone the list
     covers it for Playwright's mouse, not for a finger. */
  await page.getByRole("button", { name: SELECT_OFFER }).first()
    .evaluate((button) => (button as HTMLElement).click());
  const sheet = page.getByRole("dialog", { name: "Oferta" });
  await sheet.waitFor();
  await page.getByTestId("detail-panel-body").waitFor();
  /* The sheet rises from the edge over 320 ms, and until that ends it is neither
     where the measurements go nor where the finger will find it. Waiting on its
     own animations is how to say that without writing the number again. */
  await sheet.evaluate((panel) => Promise.all(panel.getAnimations().map((animation) => animation.finished)));
  return sheet;
}

test("the detail sheet gets its grabber back, and the grabber an area a thumb hits", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    const sheet = await openMobileDetailSheet(page, baseUrl);

    /* It was the sheet that opens most often and the only one without a
       grabber: it mounts without chrome — it arrives with a header of its own —
       and the grabber lived inside the chrome. The grabber is the gesture, not
       the title bar. */
    assert.equal(await sheet.locator(".fd-sheet-handle-zone").count(), 1);

    const reach = await page.evaluate(() => {
      const zone = document.querySelector<HTMLElement>(".fd-sheet-handle-zone");
      const bar = document.querySelector<HTMLElement>(".fd-sheet-handle");
      if (!zone || !bar) throw new Error("Missing grabber.");

      const zoneBox = zone.getBoundingClientRect();
      const barBox = bar.getBoundingClientRect();
      const x = Math.round(zoneBox.left + zoneBox.width / 2);
      /* How far the touch actually reaches, asked of the document pixel by
         pixel rather than read off the declared height: the extension is a
         pseudo-element and has no box in the flow. */
      const top = Math.ceil(zoneBox.top);
      let reached = 0;
      for (let y = top; y < top + 80; y += 1) {
        const hit = document.elementFromPoint(x, y);
        if (hit !== zone && !zone.contains(hit)) break;
        reached = y - top + 1;
      }

      return {
        barHeight: Math.round(barBox.height),
        zoneHeight: Math.round(zoneBox.height),
        touchHeight: reached,
        touchAction: getComputedStyle(zone).touchAction,
      };
    });

    // The drawn bar is still the plate's, and so is its box.
    assert.equal(reach.barHeight, 4, JSON.stringify(reach));
    assert.equal(reach.zoneHeight, 16, JSON.stringify(reach));
    /* What grows is the sensitive area, up to the 24px floor the geometry
       itself cites (WCAG 2.5.8) and that 16 did not reach. */
    assert.ok(reach.touchHeight >= 24, JSON.stringify(reach));
    assert.equal(reach.touchAction, "pan-y", JSON.stringify(reach));

    /* And it takes it from nobody. The extension passes over the air the header
       reserves above its first control, so the document has to be asked who
       receives the touch right there: if the back chevron lost its share, this
       would have traded a dismissal for a way out. */
    const back = await sheet.locator(".fd-detail-close").evaluate((button) => {
      const box = button.getBoundingClientRect();
      const at = (fraction: number) => {
        const hit = document.elementFromPoint(
          Math.round(box.left + box.width / 2),
          Math.round(box.top + box.height * fraction),
        );
        return hit === button || button.contains(hit);
      };
      return { height: Math.round(box.height), top: at(0.02), middle: at(0.5), bottom: at(0.98) };
    });
    assert.deepEqual(back, { height: back.height, top: true, middle: true, bottom: true }, JSON.stringify(back));
  }, { autoOpen: false });
});

test("the grabber grows over the header's air, not over its cross", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await routeOneOfferSearch(page);
    await openSharedSearchLink(page, `${baseUrl}/${SEARCH_QUERY}`);
    await page.getByTestId("result-card").waitFor();

    /* The other six sheets do carry chrome, and there the grabber's extension
       passes over the whole header, title and cross included. Whether it fits in
       the air the header reserves is not a sum to do in one's head: the document
       is asked. */
    await page.getByRole("button", { name: "Abrir filtros" }).click();
    const filters = page.getByRole("dialog", { name: "Filtros" });
    await filters.waitFor();
    await filters.evaluate((panel) => Promise.all(panel.getAnimations().map((animation) => animation.finished)));

    const cross = await filters.locator(".fd-sheet-close").evaluate((button) => {
      const box = button.getBoundingClientRect();
      const at = (fraction: number) => {
        const hit = document.elementFromPoint(
          Math.round(box.left + box.width / 2),
          Math.round(box.top + box.height * fraction),
        );
        return hit === button || button.contains(hit);
      };
      return { height: Math.round(box.height), top: at(0.02), middle: at(0.5), bottom: at(0.98) };
    });
    assert.deepEqual(
      cross,
      { height: cross.height, top: true, middle: true, bottom: true },
      JSON.stringify(cross),
    );
  }, { autoOpen: false });
});

test("the detail declares the split of axes: vertical scrolls, horizontal dismisses", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    const sheet = await openMobileDetailSheet(page, baseUrl);

    assert.equal(await sheet.getAttribute("data-back-swipe"), "true");
    assert.equal(
      await sheet.evaluate((panel) => getComputedStyle(panel).touchAction),
      "pan-y",
    );

    /* A vertical drag that does not start on the grabber belongs to the
       scroller and is handed back untouched: no transform, no drag mark. */
    const vertical = await dragSheet(page, {
      selector: "[data-testid='detail-panel-body']",
      by: [{ y: 60 }, { y: 120 }],
      release: true,
    });
    assert.deepEqual(vertical.transforms, ["", ""], JSON.stringify(vertical));
    assert.equal(vertical.drag, null, JSON.stringify(vertical));
    assert.equal(await sheet.isVisible(), true);

    /* The horizontal one, from that same place, is the sheet's — and follows the
       finger 1:1. */
    const horizontal = await dragSheet(page, {
      selector: "[data-testid='detail-panel-body']",
      by: [{ x: 30 }, { x: 90 }, { x: -50 }],
      release: false,
    });
    assert.deepEqual(
      horizontal.transforms.slice(0, 2),
      ["translateX(30px)", "translateX(90px)"],
      JSON.stringify(horizontal),
    );
    /* And only towards the edge it came in through: the other way it stays at
       zero, the same way the vertical one does not go up. */
    assert.equal(horizontal.transforms[2], "translateX(0px)", JSON.stringify(horizontal));
  }, { autoOpen: false });
});

test("a release short of the threshold springs the sheet back; past it, out by its edge", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    const sheet = await openMobileDetailSheet(page, baseUrl);
    await holdTheExit(page);

    const short = await dragSheet(page, {
      selector: "[data-testid='detail-panel-body']",
      by: [{ x: 60 }],
      release: true,
    });
    /* A third of its own measure, the way the vertical dismissal takes a third
       of its height: the threshold belongs to the sheet, not to a fixed number
       that on a wide phone asks for half the travel and on a narrow one for
       almost none. */
    assert.ok(60 < short.width / 3, JSON.stringify(short));
    await page.waitForTimeout(300);
    assert.equal(await sheet.isVisible(), true);
    // Sprung back: the panel hands `transform` to the settle transition.
    assert.equal(await sheet.evaluate((panel) => (panel as HTMLElement).style.transform), "");
    assert.equal(await sheet.getAttribute("data-drag"), "settle");

    const far = Math.round(short.width / 2);
    const thrown = await dragSheet(page, {
      selector: "[data-testid='detail-panel-body']",
      by: [{ x: far }],
      release: true,
    });
    assert.ok(far > thrown.width / 3, JSON.stringify(thrown));
    /* The exit starts where the finger left it. Returning to zero to leave
       again would have the gesture and the movement telling two different
       stories. */
    assert.equal(thrown.dragX, `${far}px`, JSON.stringify(thrown));

    const exit = await page.waitForFunction(() => {
      const panel = document.querySelector<HTMLElement>(
        '.fd-sheet-layer[data-closing="true"] .fd-sheet[data-dismiss="swipe"]',
      );
      return panel ? getComputedStyle(panel).animationName : null;
    }).then((handle) => handle.jsonValue());
    /* And it leaves by the edge it came in through rather than falling: that is
       the interactive-back convention, and it is what the header's chevron and
       this same sheet on the desk already say. */
    assert.equal(exit, "fd-exit-swipe");
  }, { autoOpen: false });
});

test("a short fast throw dismisses the sheet too", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    const sheet = await openMobileDetailSheet(page, baseUrl);

    /* 40px of 390 is nowhere near the third, but covered inside one frame it is
       a throw. Asking a thumb in a hurry for the distance leaves exactly the
       most common gesture with no answer. */
    const flick = await dragSheet(page, {
      selector: "[data-testid='detail-panel-body']",
      by: [{ x: 40 }],
      release: true,
      stepDelayMs: 20,
    });
    assert.ok(40 < flick.width / 3, JSON.stringify(flick));
    await sheet.waitFor({ state: "detached" });
    // Dismissed by the gesture: the list is still behind it, with its search.
    assert.equal(await page.getByTestId("result-card").isVisible(), true);
  }, { autoOpen: false });
});

test("the system back closes the detail sheet, and closing it consumes its entry", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    const sheet = await openMobileDetailSheet(page, baseUrl);

    const opened = await historyProbe(page);
    assert.equal(typeof opened.mark, "string", JSON.stringify(opened));

    /* The system back — Android's button, the edge gesture that drives it, the
       browser's own — closes the layer instead of taking the agent out of the
       application with it still open. */
    await page.goBack();
    await sheet.waitFor({ state: "detached" });
    assert.equal((await historyProbe(page)).mark, null);

    /* And the cross does exactly the same, because it goes down the same road:
       opening and closing three times leaves no three steps of rubbish behind. */
    const baseline = await historyProbe(page);
    for (let round = 0; round < 3; round += 1) {
      await page.getByRole("button", { name: SELECT_OFFER }).first()
        .evaluate((button) => (button as HTMLElement).click());
      await sheet.waitFor();
      await sheet.getByRole("button", { name: "Cerrar oferta" }).click();
      await sheet.waitFor({ state: "detached" });
      assert.equal((await historyProbe(page)).mark, null, `ronda ${round}`);
    }

    /* A layer spends one step at most: reopening replaces the entry ahead of it
       rather than stacking another. */
    const after = await historyProbe(page);
    assert.ok(after.length <= baseline.length + 1, JSON.stringify({ baseline, after }));
  }, { autoOpen: false });
});

test("the system back closes the quotation, which was outside the history", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await routeOneOfferSearch(page);
    await page.route("**/api/quotation", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchSessionId: "gesture-search",
          commercialText: "COTIZACIÓN BOLETO AÉREO\nUS$ 512 por adulto",
          offer: {
            ...quotableOffer(),
            priceConfidence: "validated",
            priceStatus: "verified",
            priceVerifiedAt: "2026-06-01T12:01:00.000Z",
          },
        }),
      });
    });

    await openSharedSearchLink(page, `${baseUrl}/${SEARCH_QUERY}`);
    await page.getByTestId("result-card").click();
    const baseline = await historyProbe(page);

    await page.getByRole("button", { name: "Cotizar" }).click();
    const quotation = page.getByRole("dialog", { name: "Cotización lista para pegar" });
    await quotation.waitFor();
    assert.equal(typeof (await historyProbe(page)).mark, "string");

    await page.goBack();
    await quotation.waitFor({ state: "detached" });
    assert.equal((await historyProbe(page)).mark, null);

    // And the cross spends the entry rather than leaving it for the next back.
    await page.getByRole("button", { name: "Cotizar" }).click();
    await quotation.waitFor();
    await page.getByRole("button", { name: "Cerrar la cotización" }).click();
    await quotation.waitFor({ state: "detached" });
    const after = await historyProbe(page);
    assert.equal(after.mark, null, JSON.stringify(after));
    assert.ok(after.length <= baseline.length + 1, JSON.stringify({ baseline, after }));
  }, { autoOpen: false });
});

test("the system back closes the schedules panel, and its title weighs what the scale says", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    const leg = (id: string, direction: "outbound" | "inbound", departureAt: string, arrivalAt: string) => ({
      id: `${id}-${direction}`,
      direction,
      durationMinutes: 430,
      stops: 0,
      layoverMinutes: [] as number[],
      segments: [{
        id: `${id}-${direction}-1`,
        flightNumber: direction === "outbound" ? "CM 210" : "CM 211",
        marketingCarrier: "CM",
        origin: direction === "outbound" ? "LIM" : "MIA",
        destination: direction === "outbound" ? "MIA" : "LIM",
        departureAt,
        arrivalAt,
        durationMinutes: 430,
      }],
    });
    const groupOffers = Array.from({ length: 10 }, (_, index) => {
      const id = `gesture-grouped-${index}`;
      const hour = String(6 + index).padStart(2, "0");
      return buildOffer({
        id,
        providerSource: "costamar",
        origin: "LIM",
        destination: "MIA",
        price: {
          total: { amount: 610 + index * 7, currencyCode: "USD" },
          base: { amount: 580 + index * 7, currencyCode: "USD" },
          taxes: { amount: 30, currencyCode: "USD" },
        },
        itineraries: [
          leg(id, "outbound", "2026-09-14T09:50:00-05:00", "2026-09-14T17:00:00-04:00"),
          leg(id, "inbound", `2026-09-24T${hour}:20:00-04:00`, `2026-09-24T${hour}:30:00-05:00`),
        ],
      });
    });
    const outboundOptionId = "costamar:GESTURE:outbound";

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ suggestions: [] }) });
    });
    await page.route("**/api/search", async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "gesture-group-search",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: payload.sortMode,
          request: payload.request,
          offers: groupOffers,
          allOffers: groupOffers,
          scheduleGroups: [{
            id: "costamar:GESTURE",
            providerSource: "costamar",
            outboundOptions: [{ id: outboundOptionId, itinerary: groupOffers[0]!.itineraries[0] }],
            inboundOptions: groupOffers.map((offer, index) => ({
              id: `costamar:GESTURE:inbound:${index}`,
              itinerary: offer.itineraries[1],
            })),
            combinations: groupOffers.map((offer, index) => ({
              outboundOptionId,
              inboundOptionId: `costamar:GESTURE:inbound:${index}`,
              offerId: offer.id,
            })),
            truncated: false,
          }],
          searchMeta: {
            requestedAt: "2026-08-01T21:06:13.178Z",
            completedAt: "2026-08-01T21:06:13.178Z",
            providersUsed: ["costamar"],
            warnings: [],
            partial: false,
            searchState: "search_live",
          },
          providerMeta: { exactProvider: "costamar", coverageMode: "core" },
          warnings: [],
        }),
      });
    });

    await openSharedSearchLink(
      page,
      `${baseUrl}/?mode=exact&trip=round-trip&origin=LIM&destination=MIA&departure=2026-09-14`
        + "&return=2026-09-24&adults=1&children=0&infants=0&sort=cheapest",
    );
    await page.getByTestId("result-card").first().waitFor();
    const baseline = await historyProbe(page);

    await page.getByRole("button", { name: /^Ver los \d+ horarios$/ }).click();
    const panel = page.getByRole("dialog", { name: /^Todos los horarios/ });
    await panel.waitFor();
    assert.equal(typeof (await historyProbe(page)).mark, "string");

    /*
     * The weight of the title, measured before anything else: `.fd-type-base`
     * declares `--fd-weight-label`, and the `font-bold` utility that sat beside
     * it painted nothing — the markup said 700 and the screen painted 600. The
     * type scale owns the weight; the utility was withdrawn for being inert, not
     * for taste.
     */
    const title = await panel.getByRole("heading", { name: "Todos los horarios" }).evaluate((node) => ({
      weight: getComputedStyle(node).fontWeight,
      classes: node.className,
      label: getComputedStyle(document.documentElement).getPropertyValue("--fd-weight-label").trim(),
    }));
    assert.equal(title.weight, title.label, JSON.stringify(title));
    assert.doesNotMatch(title.classes, /font-bold/, JSON.stringify(title));

    await page.goBack();
    await panel.waitFor({ state: "detached" });
    const after = await historyProbe(page);
    assert.equal(after.mark, null, JSON.stringify(after));
    assert.ok(after.length <= baseline.length + 1, JSON.stringify({ baseline, after }));
  }, { autoOpen: false });
});

test("without motion the sheet still closes: the exit is read from the catalog, and it is zero", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const sheet = await openMobileDetailSheet(page, baseUrl);

    /* Rule 5: under reduced motion the catalog's durations are zero. The timer
       that keeps the node alive for its exit reads that same row, so it hears
       about it without a `matchMedia` of its own — and above all does not sit
       waiting 160 ms for an animation that no longer happens. */
    const exit = await page.evaluate(() => getComputedStyle(document.documentElement)
      .getPropertyValue("--fd-dur-exit-hoja").trim());
    // Chromium serialises `0ms` as `0s`; zero is the number either way.
    assert.equal(Number.parseFloat(exit), 0, exit);

    await dragSheet(page, {
      selector: "[data-testid='detail-panel-body']",
      by: [{ x: 200 }],
      release: true,
    });
    await sheet.waitFor({ state: "detached" });
    assert.equal(await page.getByTestId("result-card").isVisible(), true);
  }, { autoOpen: false });
});
