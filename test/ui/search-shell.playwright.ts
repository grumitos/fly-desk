import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page, Route } from "playwright";
import { withDesktopPage } from "../helpers/ui.ts";
import { buildOffer } from "../helpers/ui-fixtures.ts";
import {
  clickSegment,
  waitForFontsReady,
  waitForPressed,
  waitForStableIndicator,
} from "./support.ts";

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

    const modeGroup = page.locator('[data-slot="toggle-group"]').filter({
      has: page.getByRole("button", { name: "Exacto" }),
    });
    assert.equal(await modeGroup.count(), 1);
    assert.equal(
      await page.getByRole("button", { name: "Exacto" }).getAttribute("data-slot"),
      "toggle-group-item",
    );
    const exactMode = page.getByRole("button", { name: "Exacto" });
    const flexibleMode = page.getByRole("button", { name: "Flexible" });
    await exactMode.focus();
    await exactMode.press("ArrowRight");
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Flexible");
    await page.keyboard.press("Space");
    await waitForPressed(flexibleMode);

    const passengerButton = page.getByRole("button", { name: "Seleccionar pasajeros" });
    await passengerButton.click();
    assert.equal(
      await page.locator('[data-slot="button-group"]').filter({
        has: page.getByRole("button", { name: "Agregar adultos" }),
      }).count(),
      1,
    );
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

    await page.locator("#location-origen").evaluate((input) => {
      const control = input.parentElement;
      const rect = control?.getBoundingClientRect();
      if (!rect) throw new Error("Missing origin control");
      window.scrollTo(0, 0);
      return { x: rect.left + 16, y: rect.top + rect.height / 2 };
    }).then(({ x, y }) => page.mouse.click(x, y));
    assert.equal(await page.evaluate(() => document.activeElement?.id), "location-origen");
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
    await page.locator(".fd-workspace-enter").waitFor({ state: "visible" });

    await page.locator("#location-destino").evaluate((input) => {
      const control = input.parentElement;
      const rect = control?.getBoundingClientRect();
      if (!rect) throw new Error("Missing destination control");
      return { x: rect.left + 16, y: rect.top + rect.height / 2 };
    }).then(({ x, y }) => page.mouse.click(x, y));
    assert.equal(await page.evaluate(() => document.activeElement?.id), "location-destino");
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

    assert.ok(idleBounds.width >= 1220 && idleBounds.width <= 1260, JSON.stringify(idleBounds));
    assert.ok(Math.abs(idleBounds.left - idleBounds.right) <= 24, JSON.stringify(idleBounds));
    assert.ok(idleBounds.centerOffset !== null && idleBounds.centerOffset <= 0 && idleBounds.centerOffset >= -24, JSON.stringify(idleBounds));

    await page.evaluate(() => {
      type LayoutAnimationSnapshot = {
        keyframes: Array<{ properties: string[]; transform: string; width: string }>;
        options: { duration: number; easing: string };
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
              duration: Number(options.duration ?? 0),
              easing: String(options.easing ?? ""),
            }
            : {
              duration: Number(options ?? 0),
              easing: "",
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
    await page.locator(".fd-workspace-enter").waitFor({ state: "visible" });
    await page.getByTestId("search-shell-frame").evaluate(async (frame) => {
      await Promise.all(frame.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
    });
    const layoutAnimations = await page.evaluate(() => {
      type LayoutAnimationSnapshot = {
        keyframes: Array<{ properties: string[]; transform: string; width: string }>;
        options: { duration: number; easing: string };
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
    assert.equal(layoutAnimation.options.duration, 180);
    assert.equal(layoutAnimation.options.easing, "cubic-bezier(0.22, 1, 0.36, 1)");
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

    await page.getByRole("button", { name: "Buscar" }).click();
    const notice = page.locator(".fd-search-alert");
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
        searchFrameWidth: Math.round(searchFrame?.width ?? 0),
        searchGridWidth: Math.round(searchGrid?.width ?? 0),
        width: Math.round(rect.width),
      };
    });

    assert.ok(Math.abs(noticeBounds.width - noticeBounds.searchGridWidth) <= 2, JSON.stringify(noticeBounds));
    assert.ok(noticeBounds.searchFrameWidth > noticeBounds.width + 40, JSON.stringify(noticeBounds));
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

    const copyConfig = page.getByRole("button", { name: "Copiar configuración" });
    await copyConfig.click();
    const notice = page.locator(".fd-search-alert");
    await notice.filter({ hasText: "No se pudo copiar la configuración. Revisa el permiso del navegador e intenta nuevamente." }).waitFor();
    await notice.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
    });

    const before = await page.evaluate(() => {
      const alert = document.querySelector<HTMLElement>(".fd-search-alert");
      const workspace = document.querySelector<HTMLElement>(".fd-shell-workspace");
      if (!alert || !workspace) throw new Error("Missing alert or workspace");
      (window as unknown as { __flyDeskNoticeMutations: string[] }).__flyDeskNoticeMutations = [];
      const observer = new MutationObserver((records) => {
        const mutations = (window as unknown as { __flyDeskNoticeMutations: string[] }).__flyDeskNoticeMutations;
        records.forEach((record) => {
          record.removedNodes.forEach((node) => {
            if (node instanceof HTMLElement && node.matches(".fd-search-alert")) mutations.push("removed");
          });
          record.addedNodes.forEach((node) => {
            if (node instanceof HTMLElement && node.matches(".fd-search-alert")) mutations.push("added");
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
        workspaceTop: Math.round(workspace.getBoundingClientRect().top),
      };
    });

    await copyConfig.click();
    await copyConfig.click();
    await page.waitForTimeout(120);

    const after = await page.evaluate(() => {
      const alert = document.querySelector<HTMLElement>(".fd-search-alert");
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

test("wide desktop shell uses half of the leftover viewport width", async () => {
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
    assert.ok(idleBounds.frameWidth >= 1720 && idleBounds.frameWidth <= 1736, JSON.stringify(idleBounds));

    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);
    await page.getByTestId("result-card").waitFor();

    const workspaceBounds = await page.evaluate(() => {
      const frame = document.querySelector<HTMLElement>('[data-testid="search-shell-frame"]')?.getBoundingClientRect();
      const grid = document.querySelector<HTMLElement>(".fd-workspace-enter")?.getBoundingClientRect();
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
    assert.ok(workspaceBounds.cardWidth >= 1120 && workspaceBounds.cardWidth <= 1144, JSON.stringify(workspaceBounds));
  }, { autoOpen: false });
});

test("segmented hover keeps the shared indicator stable and theme hover inverts colors", async () => {
  await withDesktopPage(async ({ page }) => {
    const modeControl = page.locator(".fd-segmented-control").filter({
      has: page.getByRole("button", { name: "Exacto" }),
    });
    const modeIndicator = modeControl.locator(".fd-segmented-indicator");
    const formBounds = async () => page.locator("main form").evaluate((form) => {
      const rect = form.getBoundingClientRect();
      return { left: Math.round(rect.left), width: Math.round(rect.width) };
    });

    await page.waitForFunction(() => {
      const exactButton = Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent?.trim() === "Exacto");
      const indicator = exactButton
        ?.closest(".fd-segmented-control")
        ?.querySelector<HTMLElement>(".fd-segmented-indicator");
      return indicator && getComputedStyle(indicator).opacity === "1";
    });
    await waitForFontsReady(page);
    await waitForPressed(page.getByRole("button", { name: "Exacto" }));
    await waitForStableIndicator(modeIndicator);

    const beforeIndicator = await modeIndicator.evaluate((indicator) => {
      const style = getComputedStyle(indicator);
      const matrix = new DOMMatrixReadOnly(style.transform);
      return {
        width: Number.parseFloat(style.width),
        x: matrix.m41,
      };
    });
    const beforeForm = await formBounds();

    await page.getByRole("button", { name: "Flexible" }).hover();
    const afterIndicator = await modeIndicator.evaluate((indicator) => {
      const style = getComputedStyle(indicator);
      const matrix = new DOMMatrixReadOnly(style.transform);
      return {
        width: Number.parseFloat(style.width),
        x: matrix.m41,
      };
    });
    const flexibleHoverStyle = await page.getByRole("button", { name: "Flexible" }).evaluate((button) => {
      const style = getComputedStyle(button);
      return {
        backgroundColor: style.backgroundColor,
        fontWeight: style.fontWeight,
      };
    });
    const activeStyle = await page.getByRole("button", { name: "Exacto" }).evaluate((button) =>
      getComputedStyle(button).fontWeight,
    );

    assert.ok(Math.abs(afterIndicator.x - beforeIndicator.x) <= 0.5, JSON.stringify({ afterIndicator, beforeIndicator }));
    assert.ok(Math.abs(afterIndicator.width - beforeIndicator.width) <= 0.5, JSON.stringify({ afterIndicator, beforeIndicator }));
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
        const button = Array.from(document.querySelectorAll("button"))
          .find((candidate) => candidate.textContent?.trim().replace(/\s+/g, " ") === name) as HTMLButtonElement | undefined;
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
    assert.ok(activeMetrics.every((metric) => metric.height === 32), JSON.stringify(activeMetrics));
    assert.ok(activeMetrics.every((metric) => metric.paddingLeft === metric.paddingRight), JSON.stringify(activeMetrics));

    type SearchModeGapMetrics = {
      indicatorBorderRadius: string;
      modeToReveal: number | null;
      modeToTrip: number | null;
      revealToTrip: number | null;
    };
    const readSearchModeGapMetrics = async () => page.evaluate<SearchModeGapMetrics>(`
      (() => {
        const buttons = Array.from(document.querySelectorAll("button"));
        const buttonByText = (text) => buttons.find((button) =>
          button.textContent?.trim().replace(/\\s+/g, " ") === text
        );
        const modeControl = buttonByText("Exacto")?.closest(".fd-segmented-control") ?? null;
        const tripControl = buttonByText("Ida y vuelta")?.closest(".fd-segmented-control") ?? null;
        const reveal = document.querySelector(".fd-inline-reveal");
        const indicator = modeControl?.querySelector(".fd-segmented-indicator") ?? null;
        const rect = (element) => element?.getBoundingClientRect() ?? null;
        const modeRect = rect(modeControl);
        const tripRect = rect(tripControl);
        const revealRect = rect(reveal);
        const distance = (left, right) =>
          left === null || left === undefined || right === null || right === undefined
            ? null
            : Math.round(left - right);

        return {
          indicatorBorderRadius: indicator ? getComputedStyle(indicator).borderRadius : "",
          modeToReveal: distance(revealRect?.left, modeRect?.right),
          modeToTrip: distance(tripRect?.left, modeRect?.right),
          revealToTrip: distance(tripRect?.left, revealRect?.right),
        };
      })()
    `);
    const exactGaps = await readSearchModeGapMetrics();
    assert.equal(exactGaps.indicatorBorderRadius, "0px");
    assert.equal(exactGaps.modeToTrip, 8, JSON.stringify(exactGaps));

    await clickSegment(page.getByRole("button", { name: "Flexible" }));
    const flexibleGaps = await readSearchModeGapMetrics();
    assert.equal(flexibleGaps.indicatorBorderRadius, "0px");
    assert.equal(flexibleGaps.modeToReveal, 8, JSON.stringify(flexibleGaps));
    assert.equal(flexibleGaps.revealToTrip, 8, JSON.stringify(flexibleGaps));

    await clickSegment(page.getByRole("button", { name: "Migratorio" }));
    const migratoryGaps = await readSearchModeGapMetrics();
    assert.equal(migratoryGaps.indicatorBorderRadius, "0px");
    assert.equal(migratoryGaps.modeToTrip, 8, JSON.stringify(migratoryGaps));

    const themeToggle = page.getByRole("button", { name: "Cambiar tema" });
    const themeGroup = page.locator("header .fd-segmented-control").filter({ has: themeToggle });
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
    const themeIndicatorOpacity = await themeGroup.locator(".fd-segmented-indicator").evaluate((indicator) =>
      getComputedStyle(indicator).opacity,
    );

    assert.equal(themeHoverStyle.backgroundColor, themePalette.dark.background);
    assert.equal(themeHoverStyle.color, themePalette.dark.foreground);
    assert.equal(themeIndicatorOpacity, "0");

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
    await page.getByRole("button", { name: "Flexible" }).click();
    await page.getByRole("button", { name: "Salida desde" }).waitFor();

    const metrics = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("form label.fd-label")).map((label) => {
        const field = label.parentElement;
        const control = field?.querySelector(".fd-control, button[aria-haspopup='dialog'], button[aria-label='Seleccionar pasajeros']") ?? null;
        const icon = control?.querySelector("svg") ?? null;
        const value = control?.querySelector("input, .fd-field-value-swap, span.min-w-0") ?? null;
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
    await page.waitForTimeout(1000);

    assert.equal(cancelRequests, 1);
    assert.ok(pollRequests <= 1, `Expected at most one in-flight poll after cancel, got ${pollRequests}.`);
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
    const migratory = page.getByRole("button", { name: "Migratorio" });
    const flexible = page.getByRole("button", { name: "Flexible" });
    assert.equal(await migratory.isEnabled(), true);
    assert.equal(await flexible.isEnabled(), true);
    await flexible.click();

    assert.equal(await page.getByText("Salida desde", { exact: true }).count(), 1);
    assert.equal(await page.getByText("Salida hasta", { exact: true }).count(), 1);

    await migratory.click();
    const monthFromField = page.getByRole("button", { name: "Mes desde", exact: true });
    const monthUntilField = page.getByRole("button", { name: "Mes hasta", exact: true });
    assert.equal(await monthFromField.isEnabled(), true);
    assert.equal(await monthUntilField.isEnabled(), true);
    assert.match(await monthFromField.innerText(), /Marzo 2026/);
    assert.match(await monthUntilField.innerText(), /Octubre 2026/);

    await monthFromField.click();
    const monthCalendar = page.getByRole("dialog", { name: "Calendario de mes desde" });
    await monthCalendar.waitFor();
    await assert.equal(await monthCalendar.getByRole("button", { name: /Enero de 2026/i }).isDisabled(), true);
    await assert.equal(await monthCalendar.getByRole("button", { name: /Febrero de 2026/i }).isDisabled(), true);
    await assert.equal(await monthCalendar.getByRole("button", { name: /Marzo de 2026/i }).isDisabled(), false);
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

    const stayGroup = page.getByRole("group", { name: "Estadía" });
    await stayGroup.waitFor({ state: "visible" });

    await assert.equal(await stayGroup.getAttribute("aria-disabled"), "true");
    await assert.equal(await page.getByRole("button", { name: "Quitar noche" }).isDisabled(), true);
    await assert.equal(await page.getByRole("button", { name: "Agregar noche" }).isDisabled(), true);
    assert.match(await stayGroup.innerText(), /Estadía/);
    assert.match(await stayGroup.innerText(), /7 noches/);
    assert.match(await stayGroup.getAttribute("class") ?? "", /fd-control-disabled-section/);
  });
});
