import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page, Route } from "playwright";
import { withDesktopPage } from "../helpers/ui.ts";
import { buildOffer } from "../helpers/ui-fixtures.ts";
import {
  clickSegment,
  segment,
  waitForFontsReady,
  waitForSegmentChecked,
} from "./support.ts";

async function clickLocationFieldSurface(page: Page, fieldId: string): Promise<void> {
  const control = page.locator(`#${fieldId}`).locator("..");
  const box = await control.boundingBox();
  assert.ok(box, `Missing ${fieldId} control`);

  await control.click({ position: { x: 16, y: box.height / 2 } });
  await page.waitForFunction((expectedId) => document.activeElement?.id === expectedId, fieldId);
}

test("search controls preserve accessible behavior through shadcn primitives", async () => {
  await withDesktopPage(async ({ page }) => {
    const origin = page.getByRole("combobox", { name: "Origen" });
    const destination = page.getByRole("combobox", { name: "Destino" });
    assert.equal(await origin.getAttribute("aria-expanded"), "false");
    assert.equal(await destination.getAttribute("aria-expanded"), "false");
    assert.ok(await origin.getAttribute("aria-controls"));
    assert.ok(await destination.getAttribute("aria-controls"));
    assert.equal(await page.getByRole("listbox").count(), 0);
    assert.equal(await origin.getAttribute("data-slot"), "input");

    /* 11 §8 replaced the shadcn ToggleGroup with the `<Segmented>` of 01 §3:
       one radio group, `aria-checked` on the options, and arrows that move
       *and* choose — a segmented control has no "highlighted but not applied"
       state (11 §0 rule 2 forbids confirming without a gesture, and an arrow
       key is one). */
    const modeGroup = page.getByRole("radiogroup", { name: "Modo de búsqueda" });
    assert.equal(await modeGroup.count(), 1);
    const exactMode = segment(modeGroup, "Exacto");
    const flexibleMode = segment(modeGroup, "Flexible");
    assert.equal(await exactMode.getAttribute("aria-checked"), "true");
    await exactMode.focus();
    await exactMode.press("ArrowRight");
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Flexible");
    await waitForSegmentChecked(flexibleMode);

    const passengerButton = page.getByRole("button", { name: "Seleccionar pasajeros" });
    await passengerButton.click();
    assert.equal(await passengerButton.getAttribute("aria-expanded"), "true");
    assert.equal(await page.getByRole("button", { name: "Agregar adultos" }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Quitar adultos" }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Intercambiar ruta" }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Buscar" }).count(), 1);

    const themeToggle = page.getByRole("button", { name: "Cambiar tema" });
    await themeToggle.hover();
    const tooltip = page.getByRole("tooltip");
    await tooltip.waitFor();
    assert.match((await tooltip.textContent()) ?? "", /Cambiar a tema (claro|oscuro)/);
  });
});

test("location field surfaces focus the input in idle and search layouts", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.route("**/api/locations**", async (route) => {
      const query = (new URL(route.request().url()).searchParams.get("q") ?? "").trim().toUpperCase();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          suggestions: [
            { code: query || "LIM", city: "Lima", country: "PE", countryCode: "PE", label: `Lima, PE (${query || "LIM"})` },
          ],
        }),
      });
    });
    await page.route("**/api/search", async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "surface-focus-search",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: payload.sortMode,
          request: payload.request,
          offers: [],
          allOffers: [],
          searchMeta: {
            requestedAt: "2026-05-27T00:00:00.000Z",
            completedAt: "2026-05-27T00:00:00.000Z",
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

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();

    await page.evaluate(() => window.scrollTo(0, 0));
    await clickLocationFieldSurface(page, "location-origen");
    await page.keyboard.type("lim");
    await page.getByRole("listbox").waitFor();

    await page.goto(`${baseUrl}/?mode=exact&trip=round-trip&origin=LIM&destination=MAD&departure=2026-06-08&return=2026-06-20&adults=1&children=0&infants=0&sort=cheapest`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("combobox", { name: "Destino" }).waitFor();
    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);
    await page.locator(".fd-results").waitFor({ state: "visible" });

    await clickLocationFieldSurface(page, "location-destino");
    await page.keyboard.press("Control+A");
    await page.keyboard.type("mad");
    await page.getByRole("listbox").waitFor();
  }, { autoOpen: false });
});

test("idle search form transitions smoothly into the workspace layout", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/search", async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "layout-width-search",
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
    });

    await page.goto(`${baseUrl}/?mode=exact&trip=round-trip&origin=LIM&destination=BIO&departure=2026-06-08&return=2026-06-20&adults=1&children=0&infants=0&sort=cheapest&maxStops=1`, {
      waitUntil: "domcontentloaded",
    });
    await page.setViewportSize({ width: 1440, height: 760 });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();

    const idleBounds = await page.getByTestId("search-shell-frame").evaluate((frame) => {
      const rect = frame.getBoundingClientRect();
      const main = frame.closest("main")?.getBoundingClientRect();
      return {
        centerOffset: main
          ? Math.round((rect.top + rect.height / 2) - (main.top + main.height / 2))
          : null,
        left: Math.round(rect.left),
        right: Math.round(window.innerWidth - rect.right),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
      };
    });

    assert.ok(idleBounds.width >= 1160 && idleBounds.width <= 1200, JSON.stringify(idleBounds));
    assert.ok(Math.abs(idleBounds.left - idleBounds.right) <= 24, JSON.stringify(idleBounds));
    assert.ok(idleBounds.centerOffset !== null && idleBounds.centerOffset <= 0 && idleBounds.centerOffset >= -72, JSON.stringify(idleBounds));

    await page.evaluate(() => {
      type LayoutAnimationSnapshot = {
        keyframes: Array<{ properties: string[]; transform: string; width: string }>;
        options: { delay: number; duration: number; easing: string; fill: string };
      };
      type LayoutAnimationWindow = Window & typeof globalThis & {
        __flyDeskLayoutAnimations?: LayoutAnimationSnapshot[];
        __flyDeskOriginalAnimate?: typeof Element.prototype.animate;
      };

      const win = window as LayoutAnimationWindow;
      win.__flyDeskLayoutAnimations = [];
      win.__flyDeskOriginalAnimate ??= Element.prototype.animate;

      Element.prototype.animate = function (
        this: Element,
        keyframes?: Keyframe[] | PropertyIndexedKeyframes | null,
        options?: number | KeyframeAnimationOptions,
      ): Animation {
        if (this instanceof HTMLElement && this.dataset.testid === "search-shell-frame") {
          const normalizedKeyframes = Array.isArray(keyframes)
            ? keyframes.map((frame) => {
              const record = frame as Record<string, unknown>;
              return {
                properties: Object.keys(record).sort(),
                transform: String(record.transform ?? ""),
                width: String(record.width ?? ""),
              };
            })
            : [];
          const normalizedOptions = typeof options === "object" && options !== null
            ? {
              delay: Number(options.delay ?? 0),
              duration: Number(options.duration ?? 0),
              easing: String(options.easing ?? ""),
              fill: String(options.fill ?? ""),
            }
            : {
              delay: 0,
              duration: Number(options ?? 0),
              easing: "",
              fill: "",
            };

          win.__flyDeskLayoutAnimations?.push({
            keyframes: normalizedKeyframes,
            options: normalizedOptions,
          });
        }

        return win.__flyDeskOriginalAnimate!.call(this, keyframes, options);
      };
    });

    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);
    await page.locator(".fd-results").waitFor({ state: "visible" });
    await page.getByTestId("search-shell-frame").evaluate(async (frame) => {
      await Promise.all(frame.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
    });
    const layoutAnimations = await page.evaluate(() => {
      type LayoutAnimationSnapshot = {
        keyframes: Array<{ properties: string[]; transform: string; width: string }>;
        options: { delay: number; duration: number; easing: string; fill: string };
      };
      type LayoutAnimationWindow = Window & typeof globalThis & {
        __flyDeskLayoutAnimations?: LayoutAnimationSnapshot[];
      };

      return (window as LayoutAnimationWindow).__flyDeskLayoutAnimations ?? [];
    });

    const workspaceBounds = await page.getByTestId("search-shell-frame").evaluate((frame) => {
      const rect = frame.getBoundingClientRect();
      return {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        opacity: getComputedStyle(frame).opacity,
      };
    });

    assert.ok(workspaceBounds.width > idleBounds.width + 120, JSON.stringify({ idleBounds, workspaceBounds }));
    assert.ok(workspaceBounds.top < idleBounds.top - 120, JSON.stringify({ idleBounds, workspaceBounds }));
    assert.equal(workspaceBounds.opacity, "1");

    assert.equal(layoutAnimations.length, 1, JSON.stringify(layoutAnimations));
    const [layoutAnimation] = layoutAnimations;
    /* 07 §1: «60 ms · bloque de campos · translateY al tope, estructura». The
       cue is not decoration — through it the form stays put while the CTA
       starts spinning, which is the table's whole first row. `backwards` is
       what holds the first keyframe through the cue; without it the block is
       already at the top for those 60ms and only then jumps back to animate. */
    assert.equal(layoutAnimation.options.delay, 60);
    assert.equal(layoutAnimation.options.duration, 220);
    assert.equal(layoutAnimation.options.fill, "backwards");
    /* Compared against the token rather than a copy of its value: the FLIP
       reads `--fd-ease-estructura` off the cascade so that the reduced-motion
       block reaches it, and Lightning CSS ships the curve minified. What has to
       hold is that this is the estructura curve, not how it is spelled. */
    const estructuraEasing = await page.evaluate(
      () => getComputedStyle(document.documentElement).getPropertyValue("--fd-ease-estructura").trim(),
    );
    assert.equal(layoutAnimation.options.easing, estructuraEasing);
    assert.equal(layoutAnimation.keyframes.length, 2, JSON.stringify(layoutAnimation));
    assert.ok(layoutAnimation.keyframes.every((keyframe) => !keyframe.properties.includes("opacity")), JSON.stringify(layoutAnimation));

    const [fromKeyframe, toKeyframe] = layoutAnimation.keyframes;
    const fromWidth = Number.parseFloat(fromKeyframe.width);
    const toWidth = Number.parseFloat(toKeyframe.width);
    assert.ok(Math.abs(fromWidth - idleBounds.width) <= 1, JSON.stringify({ idleBounds, layoutAnimation }));
    assert.ok(Math.abs(toWidth - workspaceBounds.width) <= 1, JSON.stringify({ workspaceBounds, layoutAnimation }));
    assert.equal(toKeyframe.transform, "translate3d(0, 0, 0)");

    const translateMatch = /^translate3d\((-?\d+(?:\.\d+)?)px, (-?\d+(?:\.\d+)?)px, 0\)$/.exec(fromKeyframe.transform);
    assert.ok(translateMatch, JSON.stringify(layoutAnimation));
    const [, deltaXText, deltaYText] = translateMatch;
    const deltaX = Number.parseFloat(deltaXText);
    const deltaY = Number.parseFloat(deltaYText);
    assert.ok(Math.abs(deltaX - (idleBounds.left - workspaceBounds.left)) <= 2, JSON.stringify({ idleBounds, workspaceBounds, layoutAnimation }));
    assert.ok(Math.abs(deltaY - (idleBounds.top - workspaceBounds.top)) <= 2, JSON.stringify({ idleBounds, workspaceBounds, layoutAnimation }));
  }, { autoOpen: false });
});

test("search-level notices use the idle search controls width after a failed search", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 1440, height: 760 });
    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/search", async (route) => {
      await route.abort("failed");
    });

    await page.goto(`${baseUrl}/?mode=exact&trip=round-trip&origin=LIM&destination=MAD&departure=2026-05-28&return=2026-06-04&adults=1&children=0&infants=0&sort=cheapest`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();

    const searchTopBeforeNotice = await page.locator(".fd-search-grid").evaluate((element) =>
      Math.round(element.getBoundingClientRect().top),
    );

    await page.getByRole("button", { name: "Buscar" }).click();
    const notice = page.getByRole("status");
    await notice.filter({ hasText: "No se pudo conectar con Fly Desk. Intenta nuevamente." }).waitFor();
    await notice.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
    });

    const noticeBounds = await notice.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const searchGrid = document.querySelector<HTMLElement>(".fd-search-grid")?.getBoundingClientRect();
      const searchFrame = document.querySelector<HTMLElement>('[data-testid="search-shell-frame"]')?.getBoundingClientRect();
      return {
        left: Math.round(rect.left),
        right: Math.round(window.innerWidth - rect.right),
        searchGridBottom: Math.round(searchGrid?.bottom ?? 0),
        searchGridTop: Math.round(searchGrid?.top ?? 0),
        searchFrameWidth: Math.round(searchFrame?.width ?? 0),
        searchGridWidth: Math.round(searchGrid?.width ?? 0),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
      };
    });

    /*
     * 1a is one centred 1180px measure: form, chips and rail all sit inside it,
     * so a notice that arrives afterwards belongs to that measure too — it
     * cannot be wider than the form, and it cannot push the form up (07 §0
     * rule 1: what responds is the control, and nothing else moves).
     * `index.css` already says so, with
     * `.fd-search-stage-idle .fd-search-frame > .fd-alert-line { position: absolute; top: 100% }`.
     */
    assert.ok(Math.abs(noticeBounds.searchGridTop - searchTopBeforeNotice) <= 1, JSON.stringify({ searchTopBeforeNotice, noticeBounds }));
    assert.ok(noticeBounds.top >= noticeBounds.searchGridBottom + 6, JSON.stringify(noticeBounds));
    assert.ok(Math.abs(noticeBounds.width - noticeBounds.searchGridWidth) <= 2, JSON.stringify(noticeBounds));
    assert.ok(Math.abs(noticeBounds.searchFrameWidth - noticeBounds.width) <= 2, JSON.stringify(noticeBounds));
    assert.ok(Math.abs(noticeBounds.left - noticeBounds.right) <= 24, JSON.stringify(noticeBounds));
  }, { autoOpen: false });
});

test("repeated clipboard notice failures keep the workspace from remounting the alert", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 1280, height: 760 });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async () => {
            throw new DOMException("Clipboard blocked", "NotAllowedError");
          },
        },
      });
    });
    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/search", async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      const offer = buildOffer({ id: "clipboard-notice-offer", origin: "LIM", destination: "MAD" });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "clipboard-notice-search",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: payload.sortMode,
          request: payload.request,
          offers: [offer],
          allOffers: [offer],
          searchMeta: {
            requestedAt: "2026-05-21T10:12:58.582Z",
            completedAt: "2026-05-21T10:12:58.582Z",
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

    await page.goto(`${baseUrl}/?mode=exact&trip=round-trip&origin=LIM&destination=MAD&departure=2026-05-28&return=2026-06-04&adults=1&children=0&infants=0&sort=cheapest`, {
      waitUntil: "domcontentloaded",
    });
    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);
    await page.getByTestId("result-card").waitFor();

    const activeSearchBeforeNotice = await page.locator(".fd-search-grid").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { bottom: Math.round(rect.bottom), top: Math.round(rect.top) };
    });

    const copyConfig = page.getByRole("button", { name: "Copiar configuración" });
    await copyConfig.click();
    const notice = page.getByRole("status");
    await notice.filter({ hasText: "No se pudo copiar la configuración. Revisa el permiso del navegador e intenta nuevamente." }).waitFor();
    await notice.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
    });

    const before = await page.evaluate(() => {
      const alert = document.querySelector<HTMLElement>(".fd-alert-line");
      const workspace = document.querySelector<HTMLElement>(".fd-shell-workspace");
      if (!alert || !workspace) throw new Error("Missing alert or workspace");
      (window as unknown as { __flyDeskNoticeMutations: string[] }).__flyDeskNoticeMutations = [];
      const observer = new MutationObserver((records) => {
        const mutations = (window as unknown as { __flyDeskNoticeMutations: string[] }).__flyDeskNoticeMutations;
        records.forEach((record) => {
          record.removedNodes.forEach((node) => {
            if (node instanceof HTMLElement && node.matches(".fd-alert-line")) mutations.push("removed");
          });
          record.addedNodes.forEach((node) => {
            if (node instanceof HTMLElement && node.matches(".fd-alert-line")) mutations.push("added");
          });
        });
      });
      observer.observe(document.querySelector<HTMLElement>(".fd-search-stage") ?? document.body, {
        childList: true,
        subtree: true,
      });
      (window as unknown as { __flyDeskNoticeObserver: MutationObserver }).__flyDeskNoticeObserver = observer;
      return {
        alertTop: Math.round(alert.getBoundingClientRect().top),
        searchGridTop: Math.round(document.querySelector<HTMLElement>(".fd-search-grid")?.getBoundingClientRect().top ?? 0),
        workspaceTop: Math.round(workspace.getBoundingClientRect().top),
      };
    });

    assert.ok(Math.abs(before.searchGridTop - activeSearchBeforeNotice.top) <= 1, JSON.stringify({ activeSearchBeforeNotice, before }));
    assert.ok(before.alertTop >= activeSearchBeforeNotice.bottom + 6, JSON.stringify({ activeSearchBeforeNotice, before }));

    await copyConfig.click();
    await copyConfig.click();
    await page.waitForTimeout(120);

    const after = await page.evaluate(() => {
      const alert = document.querySelector<HTMLElement>(".fd-alert-line");
      const workspace = document.querySelector<HTMLElement>(".fd-shell-workspace");
      if (!alert || !workspace) throw new Error("Missing alert or workspace after retries");
      const mutations = (window as unknown as { __flyDeskNoticeMutations: string[] }).__flyDeskNoticeMutations;
      (window as unknown as { __flyDeskNoticeObserver?: MutationObserver }).__flyDeskNoticeObserver?.disconnect();
      return {
        alertTop: Math.round(alert.getBoundingClientRect().top),
        workspaceTop: Math.round(workspace.getBoundingClientRect().top),
        mutations,
      };
    });

    assert.deepEqual(after.mutations, []);
    assert.ok(Math.abs(after.alertTop - before.alertTop) <= 1, JSON.stringify({ before, after }));
    assert.ok(Math.abs(after.workspaceTop - before.workspaceTop) <= 1, JSON.stringify({ before, after }));
  }, { autoOpen: false });
});

test("wide desktop shell expands from the idle measure into the workspace width", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/search", async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      const offer = buildOffer({ id: "wide-layout-offer", origin: "LIM", destination: "MIA" });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "wide-layout-search",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: payload.sortMode,
          request: payload.request,
          offers: [offer],
          allOffers: [offer],
          searchMeta: {
            requestedAt: "2026-03-31T00:00:00.000Z",
            completedAt: "2026-03-31T00:00:00.000Z",
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

    await page.goto(`${baseUrl}/?mode=exact&trip=round-trip&origin=LIM&destination=MIA&departure=2026-06-08&return=2026-06-20&adults=1&children=0&infants=0&sort=cheapest`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();

    const idleBounds = await page.evaluate(() => {
      const frame = document.querySelector<HTMLElement>('[data-testid="search-shell-frame"]')?.getBoundingClientRect();
      const topbar = document.querySelector<HTMLElement>(".fd-topbar > div")?.getBoundingClientRect();
      return {
        frameWidth: Math.round(frame?.width ?? 0),
        topbarWidth: Math.round(topbar?.width ?? 0),
      };
    });

    assert.equal(idleBounds.topbarWidth, 1760, JSON.stringify(idleBounds));
    assert.ok(idleBounds.frameWidth >= 1160 && idleBounds.frameWidth <= 1200, JSON.stringify(idleBounds));

    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);
    await page.getByTestId("result-card").waitFor();
    // The idle -> active FLIP animates the frame's own width (07 §1), so the
    // card appearing is not the same instant as the geometry settling. Wait on
    // that animation rather than on a duration: this asserts the resting
    // layout, and a card is visible while its entry animation still runs.
    await page.evaluate(async () => {
      const frame = document.querySelector<HTMLElement>('[data-testid="search-shell-frame"]');
      if (!frame) return;
      await Promise.all(frame.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
    });

    const workspaceBounds = await page.evaluate(() => {
      const frame = document.querySelector<HTMLElement>('[data-testid="search-shell-frame"]')?.getBoundingClientRect();
      const grid = document.querySelector<HTMLElement>(".fd-results")?.getBoundingClientRect();
      const card = document.querySelector<HTMLElement>('[data-testid="result-card"]')?.getBoundingClientRect();
      const topbar = document.querySelector<HTMLElement>(".fd-topbar > div")?.getBoundingClientRect();
      return {
        cardWidth: Math.round(card?.width ?? 0),
        frameWidth: Math.round(frame?.width ?? 0),
        gridWidth: Math.round(grid?.width ?? 0),
        topbarWidth: Math.round(topbar?.width ?? 0),
      };
    });

    assert.equal(workspaceBounds.topbarWidth, 1760, JSON.stringify(workspaceBounds));
    assert.ok(workspaceBounds.frameWidth >= 1720 && workspaceBounds.frameWidth <= 1736, JSON.stringify(workspaceBounds));
    assert.ok(workspaceBounds.gridWidth >= 1720 && workspaceBounds.gridWidth <= 1736, JSON.stringify(workspaceBounds));
    // 1b / 02 §3: the workspace is `248px minmax(0,1fr) 316px` with a 10px gap,
    // so the card is whatever the middle track leaves — the list column is not
    // a card any more (8a) and adds no inset of its own.
    assert.equal(
      workspaceBounds.cardWidth,
      workspaceBounds.gridWidth - 248 - 316 - 10 * 2,
      JSON.stringify(workspaceBounds),
    );
  }, { autoOpen: false });
});

test("the segmented pill belongs to the active option and theme hover inverts colors", async () => {
  await withDesktopPage(async ({ page }) => {
    /*
     * 07 §5 and 11 §8: there is no sliding indicator any more. The pill is the
     * `::before` of the active option, so it changes place with `tacto` instead
     * of travelling — and hovering another option must not move it, because
     * hover is "solo color y opacidad" (07 §0).
     */
    const modeControl = page.getByRole("radiogroup", { name: "Modo de búsqueda" });
    const exactMode = segment(modeControl, "Exacto");
    const flexibleMode = segment(modeControl, "Flexible");
    const formBounds = async () => page.locator("main form").evaluate((form) => {
      const rect = form.getBoundingClientRect();
      return { left: Math.round(rect.left), width: Math.round(rect.width) };
    });
    const pillOf = async (option: typeof exactMode) => option.evaluate((element) => {
      const style = getComputedStyle(element, "::before");
      return { background: style.backgroundColor, content: style.content };
    });

    await waitForFontsReady(page);
    await waitForSegmentChecked(exactMode);
    assert.equal(await page.locator(".fd-segmented-indicator").count(), 0);

    const beforeForm = await formBounds();
    const pillOnActive = await pillOf(exactMode);
    const pillOnInactive = await pillOf(flexibleMode);
    // 01 §3: the pill is `--card` inset 2px inside the active cell; the others
    // have no pill at all.
    assert.notEqual(pillOnActive.content, "none");
    assert.equal(pillOnInactive.content, "none");

    await flexibleMode.hover();
    const flexibleHoverStyle = await flexibleMode.evaluate((button) => {
      const style = getComputedStyle(button);
      return {
        backgroundColor: style.backgroundColor,
        fontWeight: style.fontWeight,
      };
    });
    const activeStyle = await exactMode.evaluate((button) => getComputedStyle(button).fontWeight);

    // Hovering an option does not hand it the pill, and does not take it from
    // the active one.
    assert.deepEqual(await pillOf(exactMode), pillOnActive);
    assert.equal((await pillOf(flexibleMode)).content, "none");
    assert.equal(flexibleHoverStyle.backgroundColor, "rgba(0, 0, 0, 0)");
    assert.ok(Number(activeStyle) >= 700);
    assert.ok(Number(flexibleHoverStyle.fontWeight) < Number(activeStyle));
    assert.deepEqual(await formBounds(), beforeForm);

    type SegmentMetric = {
      height: number;
      name: string;
      paddingLeft: string;
      paddingRight: string;
      width: number;
    };
    const readSegmentMetrics = async () => page.evaluate<SegmentMetric[]>(() => {
      const names = ["Exacto", "Flexible", "Migratorio", "Ida y vuelta", "Solo ida"];
      return names.flatMap((name) => {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>(".fd-segmented-item"))
          .find((candidate) => candidate.textContent?.trim().replace(/\s+/g, " ") === name);
        if (!button) return [];

        const style = getComputedStyle(button);
        const rect = button.getBoundingClientRect();
        return [{
          name,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          paddingLeft: style.paddingLeft,
          paddingRight: style.paddingRight,
        }];
      });
    });
    const activeMetrics = await readSegmentMetrics();
    // 1a draws the desk segmented at 32 with a 1px border, so the option box is
    // 30. 01 §3: `repeat(n,auto)` gives every option the same air, which is
    // what the equal left/right padding checks.
    assert.ok(activeMetrics.every((metric) => metric.height === 30), JSON.stringify(activeMetrics));
    assert.ok(activeMetrics.every((metric) => metric.paddingLeft === metric.paddingRight), JSON.stringify(activeMetrics));

    type SearchModeGapMetrics = {
      modeToReveal: number | null;
      modeToTrip: number | null;
      revealToTrip: number | null;
    };
    const readSearchModeGapMetrics = async () => page.evaluate<SearchModeGapMetrics>(`
      (() => {
        const options = Array.from(document.querySelectorAll(".fd-segmented-item"));
        const optionByText = (text) => options.find((option) =>
          option.textContent?.trim().replace(/\\s+/g, " ") === text
        );
        const modeControl = optionByText("Exacto")?.closest(".fd-segmented") ?? null;
        const tripControl = optionByText("Ida y vuelta")?.closest(".fd-segmented") ?? null;
        const reveal = document.querySelector(".fd-inline-reveal");
        const rect = (element) => element?.getBoundingClientRect() ?? null;
        const modeRect = rect(modeControl);
        const tripRect = rect(tripControl);
        const revealRect = rect(reveal);
        const distance = (left, right) =>
          left === null || left === undefined || right === null || right === undefined
            ? null
            : Math.round(left - right);

        return {
          modeToReveal: distance(revealRect?.left, modeRect?.right),
          modeToTrip: distance(tripRect?.left, modeRect?.right),
          revealToTrip: distance(tripRect?.left, revealRect?.right),
        };
      })()
    `);
    // 1a: the controls row runs on the 8px gap of the closed scale (01 §3).
    const exactGaps = await readSearchModeGapMetrics();
    assert.equal(exactGaps.modeToTrip, 8, JSON.stringify(exactGaps));

    await clickSegment(flexibleMode);
    const flexibleGaps = await readSearchModeGapMetrics();
    assert.equal(flexibleGaps.modeToReveal, 8, JSON.stringify(flexibleGaps));
    assert.equal(flexibleGaps.revealToTrip, 8, JSON.stringify(flexibleGaps));

    await clickSegment(segment(modeControl, "Migratorio"));
    const migratoryGaps = await readSearchModeGapMetrics();
    assert.equal(migratoryGaps.modeToTrip, 8, JSON.stringify(migratoryGaps));

    /* 02 §4: the theme toggle is a capsule cell of its own, not a segment —
       there is no group pill behind it to keep out of the way. */
    const themeToggle = page.getByRole("button", { name: "Cambiar tema" });
    assert.equal(await page.locator("header .fd-capsule").filter({ has: themeToggle }).count(), 1);
    const themePalette = await page.evaluate(`
      (() => {
        const root = document.documentElement;
        const wasDark = root.classList.contains("dark");
        const normalizeColor = (value) => {
          const probe = document.createElement("span");
          probe.style.color = value.trim();
          document.body.append(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        };
        const readPalette = () => {
          const style = getComputedStyle(root);
          return {
            background: normalizeColor(style.getPropertyValue("--color-background")),
            foreground: normalizeColor(style.getPropertyValue("--color-foreground")),
          };
        };

        root.classList.remove("dark");
        const light = readPalette();
        root.classList.add("dark");
        const dark = readPalette();
        root.classList.toggle("dark", wasDark);

        return { dark, light };
      })()
    `) as { dark: { background: string; foreground: string }; light: { background: string; foreground: string } };

    await themeToggle.hover();
    await page.waitForFunction((expected) => {
      const button = document.querySelector<HTMLButtonElement>("button[aria-label='Cambiar tema']");
      if (!button?.matches(":hover")) return false;

      const style = getComputedStyle(button);
      return style.backgroundColor === expected.background && style.color === expected.foreground;
    }, themePalette.dark);
    const themeHoverStyle = await themeToggle.evaluate((button) => {
      const style = getComputedStyle(button);
      return {
        backgroundColor: style.backgroundColor,
        color: style.color,
      };
    });

    assert.equal(themeHoverStyle.backgroundColor, themePalette.dark.background);
    assert.equal(themeHoverStyle.color, themePalette.dark.foreground);

    await themeToggle.click();
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    await themeToggle.hover();
    await page.waitForFunction((expected) => {
      const button = document.querySelector<HTMLButtonElement>("button[aria-label='Cambiar tema']");
      if (!button?.matches(":hover")) return false;

      const style = getComputedStyle(button);
      return style.backgroundColor === expected.background && style.color === expected.foreground;
    }, themePalette.light);
    const darkModeThemeHoverStyle = await themeToggle.evaluate((button) => {
      const style = getComputedStyle(button);
      return {
        backgroundColor: style.backgroundColor,
        color: style.color,
      };
    });

    assert.equal(darkModeThemeHoverStyle.backgroundColor, themePalette.light.background);
    assert.equal(darkModeThemeHoverStyle.color, themePalette.light.foreground);
  });
});

test("search field labels and filled rows share a consistent vertical center", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.goto(`${baseUrl}/?mode=exact&trip=round-trip&origin=LIM&destination=BIO&departure=2026-06-08&return=2026-06-20&adults=1&children=0&infants=0&sort=cheapest&maxStops=1`, {
      waitUntil: "domcontentloaded",
    });
    await clickSegment(segment(page, "Flexible"));
    await page.getByRole("button", { name: "Salida desde" }).waitFor();

    const metrics = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("form .fd-field-label")).map((label) => {
        const field = label.parentElement;
        const control = field?.matches(".fd-field-control")
          ? field
          : field?.querySelector("button[aria-haspopup='dialog']") ?? null;
        const icon = field?.querySelector("svg") ?? null;
        const value = field?.querySelector("input, .fd-field-value") ?? null;
        const controlBox = control?.getBoundingClientRect();
        const labelBox = label.getBoundingClientRect();
        const iconBox = icon?.getBoundingClientRect();
        const valueBox = value?.getBoundingClientRect();
        const controlCenter = controlBox ? controlBox.top + controlBox.height / 2 : null;
        const iconCenter = iconBox ? iconBox.top + iconBox.height / 2 : null;
        const valueCenter = valueBox ? valueBox.top + valueBox.height / 2 : null;

        return {
          label: label.textContent?.trim(),
          groupCenterOffset: controlCenter !== null && valueBox
            ? ((labelBox.top + valueBox.bottom) / 2) - controlCenter
            : null,
          rowCenterDelta: iconCenter !== null && valueCenter !== null ? iconCenter - valueCenter : null,
          valueHeight: valueBox?.height ?? null,
        };
      });
    });

    assert.deepEqual(metrics.map((item) => item.label), ["Origen", "Destino", "Salida desde", "Salida hasta", "Pasajeros"]);
    assert.ok(metrics.every((item) => item.groupCenterOffset !== null && Math.abs(item.groupCenterOffset) <= 0.75), JSON.stringify(metrics));
    assert.ok(metrics.every((item) => item.rowCenterDelta !== null && Math.abs(item.rowCenterDelta) <= 0.5), JSON.stringify(metrics));
    assert.ok(metrics.every((item) => item.valueHeight !== null && Math.abs(item.valueHeight - 16) <= 1), JSON.stringify(metrics));
  }, { autoOpen: false });
});

test("running search button cancels the active job and returns to editing", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    let cancelRequests = 0;
    let pollRequests = 0;
    let searchRequests = 0;
    let releaseCancelResponse!: () => void;
    let signalCancelStarted!: () => void;
    const cancelResponseGate = new Promise<void>((resolve) => {
      releaseCancelResponse = resolve;
    });
    const cancelStarted = new Promise<void>((resolve) => {
      signalCancelStarted = resolve;
    });

    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/search**", async (route) => {
      const url = new URL(route.request().url());
      const method = route.request().method();

      if (method === "POST" && url.pathname === "/api/search") {
        searchRequests += 1;
        const payload = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            searchJobId: "cancellable-job",
            searchComplete: false,
            searchStatus: "running",
            revision: 1,
            sortMode: payload.sortMode,
            request: payload.request,
            offers: [],
            allOffers: [],
            searchMeta: {
              requestedAt: "2026-05-04T15:21:48.419Z",
              completedAt: "2026-05-04T15:21:48.419Z",
              providersUsed: ["agil-local"],
              warnings: ["Consultando Agil. Los resultados se iran agregando."],
              partial: true,
              searchState: "search_partial",
            },
            providerMeta: {
              exactProvider: "agil-local",
              coverageMode: "core",
            },
            warnings: ["Consultando Agil. Los resultados se iran agregando."],
          }),
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/search/cancellable-job/cancel") {
        cancelRequests += 1;
        signalCancelStarted();
        assert.equal(url.searchParams.get("cachePartial"), "1");
        await cancelResponseGate;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            searchJobId: "cancellable-job",
            searchComplete: true,
            searchStatus: "cancelled",
            revision: 2,
            sortMode: "cheapest",
            request: {
              tripType: "round-trip",
              searchMode: "exact",
              legs: [{
                origin: "LIM",
                destination: "BIO",
                departureDate: "2026-06-08",
                returnDate: "2026-06-20",
              }],
              passengers: { adults: 1, children: 0, infants: 0 },
              filters: { nonStop: false, baggageRequired: false },
            },
            offers: [],
            allOffers: [],
            searchMeta: {
              requestedAt: "2026-05-04T15:21:48.419Z",
              completedAt: "2026-05-04T15:21:49.419Z",
              providersUsed: ["agil-local"],
              warnings: ["Search cancelled by user."],
              partial: false,
              searchState: "search_cancelled",
            },
            providerMeta: {
              exactProvider: "agil-local",
              coverageMode: "core",
            },
            warnings: ["Search cancelled by user."],
          }),
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/search/cancellable-job") {
        pollRequests += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            searchJobId: "cancellable-job",
            searchComplete: false,
            searchStatus: "running",
            revision: 1,
            sortMode: "cheapest",
            request: undefined,
            offers: [],
            allOffers: [],
          }),
        });
        return;
      }

      await route.continue();
    });

    await page.goto(`${baseUrl}/?mode=exact&trip=round-trip&origin=LIM&destination=BIO&departure=2026-06-08&return=2026-06-20&adults=1&children=0&infants=0&sort=cheapest&maxStops=1`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/api/search") && response.request().method() === "POST"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);

    const stopButton = page.getByRole("button", { name: "Detener búsqueda" });
    await stopButton.waitFor();
    await page.getByTestId("search-shell-frame").evaluate(async (frame) => {
      await Promise.all(frame.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
    });
    await stopButton.hover();
    assert.equal(await stopButton.evaluate((button) => button.matches(":hover")), true);
    assert.match(await stopButton.innerText(), /Detener/);

    pollRequests = 0;
    await stopButton.click();
    await page.getByRole("button", { name: "Buscar" }).waitFor();
    await page.getByRole("heading", { name: "Búsqueda detenida" }).waitFor();
    await cancelStarted;

    await page.getByRole("button", { name: "Buscar" }).click();
    await page.waitForTimeout(150);

    assert.equal(cancelRequests, 1);
    assert.equal(searchRequests, 1, "A repeated search must wait until partial-cache cancellation finishes.");
    assert.ok(pollRequests <= 1, `Expected at most one in-flight poll after cancel, got ${pollRequests}.`);

    const resumedSearch = page.waitForResponse((response) =>
      response.url().endsWith("/api/search") && response.request().method() === "POST"
    );
    releaseCancelResponse();
    await resumedSearch;
    assert.equal(searchRequests, 2);
  }, { autoOpen: false });
});

test("generic operation warning never becomes a search-level failure notice", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    let searchComplete = false;
    await page.clock.install();
    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/search**", async (route) => {
      const url = new URL(route.request().url());
      const method = route.request().method();

      if (method === "POST" && url.pathname === "/api/search") {
        const payload = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            searchJobId: "running-generic-warning-job",
            searchComplete: false,
            searchStatus: "running",
            revision: 1,
            sortMode: payload.sortMode,
            request: payload.request,
            offers: [],
            allOffers: [],
            searchMeta: {
              requestedAt: "2026-05-04T15:21:48.419Z",
              completedAt: "2026-05-04T15:21:48.419Z",
              providersUsed: ["agil-local"],
              warnings: ["No se pudo completar la operación. Intenta nuevamente."],
              partial: true,
              searchState: "search_partial",
            },
            providerMeta: {
              exactProvider: "agil-local",
              coverageMode: "core",
            },
            warnings: ["No se pudo completar la operación. Intenta nuevamente."],
          }),
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/search/running-generic-warning-job") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            searchJobId: "running-generic-warning-job",
            searchComplete,
            searchStatus: searchComplete ? "completed" : "running",
            revision: searchComplete ? 2 : 1,
            sortMode: "cheapest",
            request: undefined,
            offers: [],
            allOffers: [],
            warnings: ["No se pudo completar la operación. Intenta nuevamente."],
          }),
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/search/running-generic-warning-job/cancel") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
        return;
      }

      await route.continue();
    });

    await page.goto(`${baseUrl}/?mode=exact&trip=round-trip&origin=LIM&destination=BIO&departure=2026-06-08&return=2026-06-20&adults=1&children=0&infants=0&sort=cheapest&maxStops=1`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/api/search") && response.request().method() === "POST"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);
    await page.getByRole("button", { name: "Detener búsqueda" }).waitFor();

    await page.clock.fastForward(13_000);

    const genericWarning = page.getByRole("status").filter({
      hasText: "No se pudo completar la operación. Intenta nuevamente.",
    });
    assert.equal(await page.locator('[title*="No se pudo completar la operación"]').count(), 0);
    assert.equal(await genericWarning.count(), 0);

    searchComplete = true;
    await page.clock.fastForward(1_000);
    await page.getByRole("button", { name: "Buscar" }).waitFor();
    assert.equal(await genericWarning.count(), 0);
    assert.equal(await page.locator('[title*="No se pudo completar la operación"]').count(), 0);
    /* 04 §8 and 11 §3: «Parcial» reports progress and nothing else. `partial`
       stays true on the meta once the job is done, so keying the pill on it
       left it spinning for ever on a search that had already stopped. */
    await page.waitForFunction(() =>
      !Array.from(document.querySelectorAll(".fd-status-pill"))
        .some((pill) => pill.textContent?.trim() === "Parcial")
    );
  }, { autoOpen: false });
});

test("a provider that fails is said in one line, and the empty list stops blaming the route", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    let searchComplete = false;
    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });

    /* Both providers down. The backend leaves the job `completed` with zero
       offers and the reason only in `providerDiagnostics`, which is exactly the
       shape that used to be drawn as «Sin resultados para esta consulta». */
    const failedJob = (complete: boolean, request?: unknown) => ({
      searchJobId: "both-providers-failed-job",
      searchComplete: complete,
      searchStatus: complete ? "completed" : "running",
      revision: complete ? 2 : 1,
      sortMode: "cheapest",
      request,
      offers: [],
      allOffers: [],
      searchMeta: {
        requestedAt: "2026-05-04T15:21:48.419Z",
        completedAt: "2026-05-04T15:21:48.419Z",
        providersUsed: ["agil-local", "costamar"],
        warnings: [],
        partial: true,
        searchState: "search_partial",
      },
      providerMeta: { exactProvider: "agil-local", coverageMode: "core" },
      warnings: [],
      providerDiagnostics: complete
        ? [
            {
              providerId: "agil-local",
              kind: "exact",
              status: "failed",
              events: [],
              error: "Agilsmart is temporarily unavailable.",
            },
            {
              providerId: "costamar",
              kind: "exact",
              status: "failed",
              events: [],
              error: "Click and Book Plus request timed out.",
            },
          ]
        : [
            { providerId: "agil-local", kind: "exact", status: "running", events: [] },
            { providerId: "costamar", kind: "exact", status: "running", events: [] },
          ],
    });

    await page.route("**/api/search**", async (route) => {
      const url = new URL(route.request().url());
      const method = route.request().method();

      if (method === "POST" && url.pathname === "/api/search") {
        const payload = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(failedJob(false, payload.request)),
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/search/both-providers-failed-job") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(failedJob(searchComplete)),
        });
        return;
      }

      await route.continue();
    });

    await page.goto(`${baseUrl}/?mode=exact&trip=round-trip&origin=LIM&destination=BIO&departure=2026-06-08&return=2026-06-20&adults=1&children=0&infants=0&sort=cheapest`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/api/search") && response.request().method() === "POST"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);

    searchComplete = true;
    await page.getByRole("button", { name: "Buscar" }).waitFor();

    // The reason reaches the screen with the provider's name and the cause.
    const notice = page.getByRole("status").filter({ hasText: "No se pudo consultar a ningún proveedor" });
    await notice.waitFor();
    const noticeText = (await notice.innerText()).replace(/\s+/g, " ");
    assert.match(noticeText, /Agilsmart no disponible/);
    assert.match(noticeText, /Click and Book Plus sin respuesta a tiempo/);

    // And the column no longer asks the agent to widen a search that never ran.
    await page.getByRole("heading", { name: "No se pudo consultar a los proveedores" }).waitFor();
    assert.equal(await page.getByText("Sin resultados para esta consulta").count(), 0);
    assert.equal(await page.getByRole("button", { name: "Volver a editar la búsqueda" }).count(), 1);

    // 04 §8: one line, dismissible, and it does not come back in the same search.
    await page.getByRole("button", { name: "Descartar el aviso" }).click();
    await page.waitForFunction(() =>
      !Array.from(document.querySelectorAll('[role="status"]'))
        .some((node) => node.textContent?.includes("No se pudo consultar a ningún proveedor"))
    );
  }, { autoOpen: false });
});

test("page refresh cancels the active search and asks the server to cache partial results", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/search**", async (route) => {
      const url = new URL(route.request().url());
      const method = route.request().method();

      if (method === "POST" && url.pathname === "/api/search") {
        const payload = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            searchJobId: "refresh-job",
            searchComplete: false,
            searchStatus: "running",
            revision: 1,
            sortMode: payload.sortMode,
            request: payload.request,
            offers: [buildOffer({ id: "refresh-partial-offer" })],
            allOffers: [buildOffer({ id: "refresh-partial-offer" })],
            searchMeta: {
              requestedAt: "2026-05-04T15:21:48.419Z",
              completedAt: "2026-05-04T15:21:48.419Z",
              providersUsed: ["agil-local"],
              warnings: ["Consultando Agil. Los resultados se iran agregando."],
              partial: true,
              searchState: "search_partial",
            },
            providerMeta: {
              exactProvider: "agil-local",
              coverageMode: "core",
            },
            warnings: ["Consultando Agil. Los resultados se iran agregando."],
          }),
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/search/refresh-job/cancel") {
        assert.equal(url.searchParams.get("cachePartial"), "1");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
        return;
      }

      await route.continue();
    });

    await page.goto(`${baseUrl}/?mode=exact&trip=round-trip&origin=LIM&destination=BIO&departure=2026-06-08&return=2026-06-20&adults=1&children=0&infants=0&sort=cheapest&maxStops=1`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/api/search") && response.request().method() === "POST"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);

    await page.getByRole("button", { name: "Detener búsqueda" }).waitFor();
    const refreshCancelRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return request.method() === "POST"
        && url.pathname === "/api/search/refresh-job/cancel"
        && url.searchParams.get("cachePartial") === "1";
    });
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await refreshCancelRequest;
  }, { autoOpen: false });
});

test("flexible and migratory modes expose their distinct controls", async () => {
  await withDesktopPage(async ({ page }) => {
    const migratory = segment(page, "Migratorio");
    const flexible = segment(page, "Flexible");
    assert.equal(await migratory.isEnabled(), true);
    assert.equal(await flexible.isEnabled(), true);
    await flexible.click();

    assert.equal(await page.getByText("Salida desde", { exact: true }).count(), 1);
    assert.equal(await page.getByText("Salida hasta", { exact: true }).count(), 1);

    await migratory.click();
    const monthRangeField = page.getByRole("button", { name: /^Meses:/ });
    assert.equal(await monthRangeField.isEnabled(), true);
    assert.match((await monthRangeField.getAttribute("aria-label")) ?? "", /Mar 2026.*Oct 2026/);

    await monthRangeField.click();
    const monthCalendar = page.getByRole("dialog", { name: "Selector de meses" });
    await monthCalendar.waitFor();
    await assert.equal(await monthCalendar.getByRole("button", { name: /Enero de 2026/i }).isDisabled(), true);
    await assert.equal(await monthCalendar.getByRole("button", { name: /Febrero de 2026/i }).isDisabled(), true);
    await assert.equal(await monthCalendar.getByRole("button", { name: /Marzo de 2026/i }).isDisabled(), false);
    /* 06 §6 caps the sweep at twelve months, so from March 2026 the picker
       reaches February 2027 and stops. It used to offer twelve and then refuse
       everything past the eighth — a limit the UI announced and broke. */
    await assert.equal(await monthCalendar.getByRole("button", { name: /Noviembre de 2026/i }).isDisabled(), false);
    await assert.equal(await monthCalendar.getByRole("button", { name: /Febrero de 2027/i }).isDisabled(), false);
    await assert.equal(await monthCalendar.getByRole("button", { name: /Marzo de 2027/i }).isDisabled(), true);
    // 11 §1: Migratorio sweeps months, so the trip-type control dims in place
    // and keeps its value — it is not emptied and not removed.
    await assert.equal(await segment(page, "Ida y vuelta").isDisabled(), true);
    await assert.equal(await segment(page, "Solo ida").isDisabled(), true);
    await assert.equal(await segment(page, "Solo ida").getAttribute("aria-checked"), "true");
    await assert.equal(await page.getByRole("button", { name: "Buscar" }).isVisible(), true);
  });
});

test("migratory month picker disables months before the runtime minimum", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.route(`${baseUrl}/`, async (route) => {
      const response = await route.fetch();
      const body = (await response.text())
        .replace(/"minSearchDate":"[^"]+"/, '"minSearchDate":"2026-04-01"')
        .replace(/"maxSearchDate":"[^"]+"/, '"maxSearchDate":"2027-04-01"');
      await route.fulfill({ response, body });
    });

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();
    await clickSegment(segment(page, "Migratorio"));
    await page.getByRole("button", { name: /^Meses:/ }).click();

    const calendar = page.getByRole("dialog", { name: "Selector de meses" });
    await calendar.waitFor();
    assert.equal(await calendar.getByRole("button", { name: /Enero de 2026/i }).isDisabled(), true);
    assert.equal(await calendar.getByRole("button", { name: /Febrero de 2026/i }).isDisabled(), true);
    assert.equal(await calendar.getByRole("button", { name: /Marzo de 2026/i }).isDisabled(), true);
    assert.equal(await calendar.getByRole("button", { name: /Abril de 2026/i }).isDisabled(), false);
  }, { autoOpen: false });
});

test("one-way exact search keeps the return field visible but disabled", async () => {
  await withDesktopPage(async ({ page }) => {
    await clickSegment(segment(page, "Solo ida"));

    const returnField = page.getByRole("button", { name: "Regreso: No aplica" });
    await returnField.waitFor({ state: "visible" });
    assert.equal(await returnField.count(), 1);
    assert.equal(await returnField.isDisabled(), true);
    assert.equal(await returnField.getAttribute("aria-label"), "Regreso: No aplica");
    assert.equal(await returnField.locator("xpath=..").getAttribute("data-half"), "end");
  });
});

test("one-way flexible search keeps stay controls visible but disabled", async () => {
  await withDesktopPage(async ({ page }) => {
    await clickSegment(segment(page, "Flexible"));
    await clickSegment(segment(page, "Solo ida"));

    const stayGroup = page.getByRole("group", { name: "Estadía" });
    await stayGroup.waitFor({ state: "visible" });

    await assert.equal(await stayGroup.getAttribute("aria-disabled"), "true");
    await assert.equal(await page.getByRole("button", { name: "Quitar noche" }).isDisabled(), true);
    await assert.equal(await page.getByRole("button", { name: "Agregar noche" }).isDisabled(), true);
    assert.match(await stayGroup.innerText(), /Estadía/);
    assert.match(await stayGroup.innerText(), /7 noches/);
    // 01 §1: disabled is `opacity:.45` over the whole control and nothing else
    // — no new grey, no different border, no `cursor:pointer`.
    const disabledStyle = await stayGroup.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
      const style = getComputedStyle(element);
      return { cursor: style.cursor, opacity: Number(style.opacity) };
    });
    assert.equal(disabledStyle.cursor, "not-allowed");
    assert.ok(Math.abs(disabledStyle.opacity - 0.45) <= 0.01, JSON.stringify(disabledStyle));
  });
});

/**
 * The choreography of 07 §1 and the way back of 11 §2.4.
 *
 * Read off `document.getAnimations()` rather than by watching pixels: what the
 * table specifies is *when each piece starts*, and the schedule is the only
 * thing that answers that without racing the compositor.
 */
async function routeChoreographySearch(page: Page, offers: number, delayMs = 0): Promise<void> {
  await page.route("**/api/locations**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ suggestions: [] }) });
  });
  await page.route("**/api/location-usage-suggestions**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ suggestions: { origin: ["LIM", "CUZ"], destination: ["MAD", "MIA"] } }),
    });
  });
  await page.route("**/api/search", async (route) => {
    /* The table is a schedule, and a schedule can only be read while it is
       running: answered instantly, the spinner, the skeleton and both FLIPs are
       already gone by the time the workspace is on screen. */
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    const list = Array.from({ length: offers }, (_, index) => buildOffer({ id: `choreo-${index}` }));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        searchJobId: "choreography",
        searchComplete: true,
        searchStatus: "completed",
        revision: 1,
        sortMode: payload.sortMode,
        request: payload.request,
        offers: list,
        allOffers: list,
        searchMeta: {
          requestedAt: "2026-03-31T00:00:00.000Z",
          completedAt: "2026-03-31T00:00:00.000Z",
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
}

const CHOREOGRAPHY_URL = "/?mode=exact&trip=round-trip&origin=LIM&destination=BIO&departure=2026-06-08&return=2026-06-20&adults=1&children=0&infants=0&sort=cheapest";

type ScheduleWindow = Window & typeof globalThis & { __fdSchedule?: string[] };

/**
 * Collect every animation that runs over the next `windowMs`, as
 * `selector · name · delay · duration`.
 *
 * Sampling once is a race: the chips of the 60ms cue are done at 180ms, and the
 * two FLIPs are removed as soon as they finish because they fill backwards
 * only. Polling each frame is what makes the schedule readable whole.
 */
async function recordSchedule(page: Page, windowMs: number): Promise<void> {
  await page.evaluate((limit) => {
    const win = window as ScheduleWindow;
    const seen = new Set<string>();
    win.__fdSchedule = [];
    const started = performance.now();
    const tick = () => {
      for (const animation of document.getAnimations()) {
        const effect = animation.effect as KeyframeEffect | null;
        const timing = effect?.getComputedTiming();
        const target = effect?.target as HTMLElement | null;
        const classes = typeof target?.className === "string"
          ? target.className.split(/\s+/).filter((name) => name.startsWith("fd-")).join(".")
          : "";
        const name = (animation as CSSAnimation).animationName
          ?? (animation as CSSTransition).transitionProperty
          ?? "flip";
        const entry = `${target?.tagName.toLowerCase() ?? "?"}.${classes} · ${name} · ${timing?.delay} · ${timing?.duration}`;
        if (!seen.has(entry)) {
          seen.add(entry);
          win.__fdSchedule?.push(entry);
        }
      }
      if (performance.now() - started < limit) requestAnimationFrame(tick);
    };
    tick();
  }, windowMs);
}

async function readSchedule(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as ScheduleWindow).__fdSchedule ?? []);
}

/** Wait until the list has stopped reflowing, which is when a page settles. */
async function waitForListSettled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const win = window as typeof window & { __fdLastHeight?: number; __fdStableSince?: number };
    const node = document.querySelector(".fd-list-viewport");
    if (!node) return false;
    const height = node.scrollHeight;
    if (win.__fdLastHeight !== height) {
      win.__fdLastHeight = height;
      win.__fdStableSince = performance.now();
      return false;
    }
    return performance.now() - (win.__fdStableSince ?? 0) > 250;
  }, null, { polling: 50 });
}

test("07 §1 · the desk hands the workspace its cues in the order of the table", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await routeChoreographySearch(page, 2, 900);
    await page.goto(`${baseUrl}${CHOREOGRAPHY_URL}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();
    await page.locator(".fd-quick-chips").first().waitFor();

    await recordSchedule(page, 700);
    await page.getByRole("button", { name: "Buscar" }).click();
    await page.locator(".fd-shell-workspace").waitFor();
    await page.waitForTimeout(750);
    const scheduled = await readSchedule(page);
    const find = (needle: string) => scheduled.find((entry) => entry.includes(needle));
    const all = JSON.stringify(scheduled, null, 2);

    // 0 ms · the CTA spins on `bucle-giro` and nothing else has moved.
    assert.match(find("· spin ·") ?? "", /· spin · 0 · 1100$/, all);
    // 60 ms · the frequent chips leave by opacity over 120 ms.
    assert.match(find("fd-quick-chips") ?? "", /fd-exit-opacity · 60 · 120$/, all);
    // 60 ms · the block of fields and the segments travel on `estructura`.
    assert.match(find("fd-search-frame") ?? "", / · 60 · 220$/, all);
    assert.match(find("fd-trip-mode-controls") ?? "", / · 60 · 220$/, all);
    // 140 ms · filters from the left, detail from the right, the list by opacity.
    assert.match(find("fd-filter-column") ?? "", /fd-enter-left · 140 · 220$/, all);
    assert.match(find("fd-panel") ?? "", /fd-enter-right · 140 · 220$/, all);
    assert.match(find("div.fd-list ·") ?? "", /fd-crossfade · 140 · 220$/, all);
    // 180 ms · the skeleton, with the real grid. 180 + 220 = 400, inside 420.
    assert.match(find("fd-results-list--skeleton") ?? "", /fd-crossfade · 180 · 220$/, all);

    // The segments end up in the title bar (07 §1: «mismo tamaño y peso: solo
    // cambia de sitio»).
    await page.waitForFunction(() => (
      document.querySelector<HTMLElement>(".fd-trip-mode-controls")?.dataset.placement === "topbar"
    ));
  });
});

test("11 §2.4 · clicking a field on a desk hands the segments back to the form", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await routeChoreographySearch(page, 2);
    await page.goto(`${baseUrl}${CHOREOGRAPHY_URL}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();

    await page.getByRole("button", { name: "Buscar" }).click();
    await page.locator(".fd-shell-workspace").waitFor();
    await page.waitForFunction(() => (
      document.querySelector<HTMLElement>(".fd-trip-mode-controls")?.dataset.placement === "topbar"
    ));
    const active = await page.locator(".fd-tools-block").boundingBox();
    assert.ok(active);

    await recordSchedule(page, 400);
    await page.getByRole("combobox", { name: "Origen" }).click();
    await page.waitForTimeout(450);

    // «La misma secuencia invertida en 180 ms» — one budget, no cue in front.
    const scheduled = await readSchedule(page);
    /* The recorder was armed before the click and the schedule still holds the
       *outbound* FLIP of 07 §1, so the return is the last of the two. */
    const controlsFlip = scheduled.findLast((entry) => entry.includes("fd-trip-mode-controls"));
    assert.match(controlsFlip ?? "", / · 0 · 180$/, JSON.stringify(scheduled, null, 2));

    await page.waitForFunction(() => (
      document.querySelector<HTMLElement>(".fd-trip-mode-controls")?.dataset.placement === "form"
    ));
    /* The form recovers its resting anatomy and the block grows; the results
       stay behind — they are not cleared. The frequent-station chips do **not**
       come back: they are furniture of the idle screen, and once a search
       exists they compete with the results for the same eye. */
    assert.equal(await page.locator(".fd-quick-chips").count(), 0);
    assert.equal(await page.locator(".fd-shell-workspace").isVisible(), true);
    /* 52 → 94 measured: the summary band gives way to the form's resting
       anatomy. The old threshold was «+60», which only held because the
       frequent chips were still padding the block; what 11 §2.4 actually asks
       is that the form come back **whole**, so the clipping check is the one
       that matters. */
    await page.waitForFunction((previous) => (
      (document.querySelector(".fd-tools-block")?.getBoundingClientRect().height ?? 0) > previous + 30
    ), active.height);
    const clipped = await page.locator(".fd-tools-block").evaluate(async (node) => {
      await Promise.all(node.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
      return node.scrollHeight - node.clientHeight;
    });
    assert.ok(clipped <= 1, `El formulario reabierto queda recortado ${clipped}px.`);
    // Focus stays where the agent put it.
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Origen");
  });
});

test("11 §2.4 · the phone's summary reopens the whole form, not a clipped one", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await routeChoreographySearch(page, 2);
    await page.goto(`${baseUrl}${CHOREOGRAPHY_URL}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();

    await page.getByRole("button", { name: "Buscar" }).click();
    await page.locator(".fd-mobile-search-summary").waitFor();

    await page.getByRole("button", { name: "Editar búsqueda" }).click();

    /* 02 §9 caps the retractable block at 182px because that is the height of
       the *summary* band. While the form is open the block is the form, and
       «el bloque crece a su alto natural» (2h): capped, the passenger field and
       the CTA sat 301px below the clip and there was no way back out. */
    await page.getByRole("button", { name: "Seleccionar pasajeros" }).waitFor({ state: "visible" });
    /* Measured once the growth has landed: while it runs, the block is clipped
       on purpose — that is what animating a height means. */
    const overflow = await page.locator(".fd-tools-block").evaluate(async (node) => {
      await Promise.all(node.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
      return node.scrollHeight - node.clientHeight;
    });
    assert.equal(overflow, 0);
  });
});

/**
 * 02 §11 · «Al volver del detalle (o de cualquier hoja), la lista recupera su
 * scrollTop exacto. Al cambiar de página del paginado, la lista vuelve a 0 sin
 * animación.» — and 01 §9 names the same restoration among what the session
 * remembers.
 *
 * The list is never unmounted by a sheet, which is *why* the position survives;
 * the test is here so that stops being an accident. It asserts a non-zero
 * starting position first, so a future page size that leaves the list unable to
 * scroll fails here instead of passing vacuously.
 */
test("02 §11 · the list keeps its exact scrollTop across the detail sheet", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await routeChoreographySearch(page, 24);
    await page.goto(`${baseUrl}${CHOREOGRAPHY_URL}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();
    await page.getByRole("button", { name: "Buscar" }).click();
    await page.getByTestId("result-card").first().waitFor();
    /* The page size is measured from the viewport, so it settles a frame or two
       after the cards land — and settling changes `pageCount`, which is one of
       the two things 02 §11 *does* send the list back to 0. Scrolling before
       that is testing the wrong moment. */
    await waitForListSettled(page);

    await page.locator(".fd-list-viewport").evaluate((node) => { node.scrollTop = node.scrollHeight; });
    /* Scrolling that far retracts the tools (02 §9), the list grows by their
       height and the browser clamps the position down to match. That is the
       same place in the *content*, so the baseline is taken once it settles —
       otherwise the test compares a position against the viewport it had before
       it grew. The 300ms lock of 02 §9 is why it settles at all. */
    await page.waitForFunction(() => {
      const win = window as typeof window & { __fdTop?: number; __fdSince?: number };
      const node = document.querySelector(".fd-list-viewport");
      if (!node) return false;
      const top = Math.round(node.scrollTop);
      if (win.__fdTop !== top) {
        win.__fdTop = top;
        win.__fdSince = performance.now();
        return false;
      }
      return performance.now() - (win.__fdSince ?? 0) > 400;
    }, null, { polling: 50 });
    const scrolled = await page.locator(".fd-list-viewport")
      .evaluate((node) => Math.round(node.scrollTop));
    assert.ok(scrolled > 0, `the mobile list has no scroll to restore: ${scrolled}`);

    /* The *last* card, because it is the one on screen at this position.
       Clicking one further up would have the runner scroll it into view first,
       and then the position under test is lost by the gesture rather than by
       the sheet — which is a way of measuring nothing. */
    await page.getByTestId("result-card").last().click();
    await page.getByRole("dialog").waitFor();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelectorAll('[role="dialog"]').length === 0);

    const restored = await page.locator(".fd-list-viewport")
      .evaluate((node) => Math.round(node.scrollTop));
    assert.equal(restored, scrolled);
  });
});

test("02 §11 · changing page returns the list to 0 with no animated scroll", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await routeChoreographySearch(page, 60);
    await page.goto(`${baseUrl}${CHOREOGRAPHY_URL}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();
    await page.getByRole("button", { name: "Buscar" }).click();
    await page.getByTestId("result-card").first().waitFor();
    await waitForListSettled(page);

    await page.locator(".fd-list-viewport").evaluate((node) => { node.scrollTop = node.scrollHeight; });
    const nextPage = page.getByRole("button", { name: "Página siguiente" });
    await nextPage.waitFor();
    await nextPage.click();

    /* 07 §0 rule 2 and 07 §5: the page change is a crossfade at fixed height,
       and the scroll back to the top is not animated — so there is no
       `scroll-behavior: smooth` to wait out and no animation on the viewport. */
    const settled = await page.locator(".fd-list-viewport").evaluate((node) => ({
      scrollTop: Math.round(node.scrollTop),
      scrollBehavior: getComputedStyle(node).scrollBehavior,
      animations: node.getAnimations().length,
    }));
    assert.equal(settled.scrollTop, 0);
    assert.equal(settled.scrollBehavior, "auto");
    assert.equal(settled.animations, 0);
  });
});

/**
 * Ficha 11 · the three gestures the walk found broken.
 *
 * They are here because none of them is visible in a diff: the cross threw,
 * the highlight never moved, and the cross that 11 §2.1 asks for did not exist.
 */
async function routeLocationMatches(page: Page): Promise<void> {
  await page.route("**/api/locations**", async (route) => {
    const query = new URL(route.request().url()).searchParams.get("q")?.trim() ?? "";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        suggestions: query.length >= 2
          ? [
            { code: "MAD", city: "Madrid", country: "España", countryCode: "ES", label: "Madrid, España (MAD)" },
            { code: "MIA", city: "Miami", country: "EE. UU.", countryCode: "US", label: "Miami, EE. UU. (MIA)" },
          ]
          : [],
      }),
    });
  });
  await page.route("**/api/location-usage-suggestions**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ suggestions: { origin: ["LIM", "CUZ"], destination: ["MAD", "MIA"] } }),
    });
  });
}

test("11 §2.2 · the cross on the return half empties both dates and hands focus back", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await routeLocationMatches(page);
    await page.goto(`${baseUrl}${CHOREOGRAPHY_URL}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /^Regreso:/ }).waitFor();

    await page.getByRole("button", { name: "Quitar regreso" }).click();

    /* «Borra las dos fechas, deja las mitades en Elegir y devuelve el foco a la
       mitad de salida.» Emptying the departure is a gesture of the ficha, not an
       edge case: deriving the return ceiling from it built an Invalid Date and
       `toISOString()` threw, so the handler died and the control kept showing
       the dates the agent had just asked to remove. */
    await page.waitForFunction(() => (
      document.querySelector('[aria-label^="Salida:"]')?.getAttribute("aria-label") === "Salida: Elegir"
      && document.querySelector('[aria-label^="Regreso:"]')?.getAttribute("aria-label") === "Regreso: Elegir"
    ));
    // 11 §0.4: never the `<body>` — and the cross erases itself as it works.
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
      "Salida: Elegir",
    );
  });
});

test("11 §2.1 · one letter keeps Recientes, two highlight the first match", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await routeLocationMatches(page);
    await page.goto(`${baseUrl}${CHOREOGRAPHY_URL}`, { waitUntil: "domcontentloaded" });
    const origin = page.getByRole("combobox", { name: "Origen" });
    await origin.waitFor();

    await origin.click();
    await origin.fill("m");
    await page.waitForFunction(() => {
      const box = document.querySelector('[role="listbox"]');
      return Boolean(box?.parentElement?.textContent?.includes("Frecuentes"));
    });
    // «Escribir 1 letra · nada cambia en la lista, se sigue viendo Recientes.»
    assert.equal(await page.getByRole("option").count(), 2);

    await origin.fill("mad");
    await page.waitForFunction(() => (
      document.querySelector('[aria-label="Origen"]')?.getAttribute("aria-activedescendant") !== null
    ));
    const matches = await page.getByRole("option").evaluateAll((items) => items.map((item) => ({
      selected: item.getAttribute("aria-selected"),
      text: item.textContent ?? "",
    })));
    // «Se resalta la primera fila» — and only it: «resaltado ≠ elegido».
    assert.equal(matches[0]?.selected, "true");
    assert.ok(matches.slice(1).every((match) => match.selected === "false"), JSON.stringify(matches));
    assert.equal(await origin.inputValue(), "mad");
  });
});

test("11 §2.1 · the cross on a field empties it and reopens Recientes", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await routeLocationMatches(page);
    await page.goto(`${baseUrl}${CHOREOGRAPHY_URL}`, { waitUntil: "domcontentloaded" });
    const origin = page.getByRole("combobox", { name: "Origen" });
    await origin.waitFor();
    await origin.click();
    await origin.fill("mad");
    await page.getByRole("option").first().waitFor();

    await page.getByRole("button", { name: "Limpiar origen" }).click();

    // «Vacía el campo y **reabre** el panel con Recientes · foco en el campo.»
    await page.waitForFunction(() => {
      const input = document.querySelector<HTMLInputElement>('[aria-label="Origen"]');
      const box = document.querySelector('[role="listbox"]');
      return input?.value === ""
        && document.activeElement === input
        && Boolean(box?.parentElement?.textContent?.match(/Recientes|Frecuentes/));
    });
  });
});
