import { test } from "node:test";
import assert from "node:assert/strict";
import type { Locator, Page, Route } from "playwright";
import { openDesktop, withDesktopPage } from "./helpers/ui.ts";
import { buildOffer } from "./helpers/ui-fixtures.ts";

async function waitForPressed(button: Locator): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await button.getAttribute("aria-pressed") === "true") {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.equal(await button.getAttribute("aria-pressed"), "true");
}

async function clickSegment(button: Locator): Promise<void> {
  await button.click();
  await waitForPressed(button);
}

async function waitForStableIndicator(indicator: Locator): Promise<void> {
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

async function waitForLocationFieldsClosed(
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

async function waitForFontsReady(page: Page): Promise<void> {
  await page.waitForFunction(() => document.fonts.status === "loaded", null, {
    polling: 100,
    timeout: 5000,
  }).catch(() => undefined);
}

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
    await stopButton.hover();
    assert.equal(await stopButton.evaluate((button) => button.matches(":hover")), true);
    assert.match(await stopButton.innerText(), /Detener/);

    await stopButton.click();
    await page.getByRole("button", { name: "Buscar" }).waitFor();
    await page.getByRole("heading", { name: "Búsqueda detenida" }).waitFor();
    await page.waitForTimeout(1000);

    assert.equal(cancelRequests, 1);
    assert.equal(pollRequests, 0);
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
    assert.doesNotMatch(await page.locator("body").innerText(), /4 d[ií]as/);
    const flexibleDateLabels = await page.locator("#date-salida-desde-label, #date-salida-hasta-label").evaluateAll((labels) =>
      labels.map((label) => ({
        height: Math.round(label.getBoundingClientRect().height),
        text: label.textContent?.trim(),
      })),
    );
    assert.deepEqual(flexibleDateLabels.map((label) => label.text), ["Salida desde", "Salida hasta"]);
    assert.ok(flexibleDateLabels.every((label) => label.height <= 14), JSON.stringify(flexibleDateLabels));
    assert.equal(await page.locator(".fd-label-word-extra").count(), 0);
    assert.equal(
      await page.locator(".fd-inline-reveal").evaluate((element) => getComputedStyle(element).transitionProperty),
      "opacity",
    );
    await assert.equal(await migratory.isDisabled(), false);

    await migratory.click();
    const monthFromField = page.getByRole("button", { name: "Mes desde", exact: true });
    const monthUntilField = page.getByRole("button", { name: "Mes hasta", exact: true });
    await assert.equal(await monthFromField.count(), 1);
    await assert.equal(await monthUntilField.count(), 1);
    await assert.equal(await monthFromField.isDisabled(), false);
    await assert.equal(await monthUntilField.isDisabled(), false);
    assert.match(await monthFromField.innerText(), /Marzo 2026/);
    assert.match(await monthUntilField.innerText(), /Octubre 2026/);
    assert.doesNotMatch(await page.locator("body").innerText(), /MES(?:ES)?\s*[\r\n]+[0-9]+ seleccionado/i);

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

test("invalid shared dates do not roll over in the search form", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.goto(`${baseUrl}/?mode=exact&trip=round-trip&origin=LIM&destination=MIA&departure=2026-06-31&return=2026-07-10&adults=1&children=0&infants=0`, {
      waitUntil: "domcontentloaded",
    });

    const departureButton = page.getByRole("button", { name: "Salida" });
    await page.waitForFunction(() => {
      const button = document.querySelector('[aria-labelledby="date-salida-label"]');
      return button?.textContent?.includes("Fecha inválida");
    });
    await assert.equal(await departureButton.innerText(), "Fecha inválida");
    await assert.equal(await departureButton.getAttribute("aria-invalid"), "true");
    await assert.equal(await page.getByRole("button", { name: "Buscar" }).isDisabled(), true);
    await assert.equal(await page.getByText("Fecha inválida.").count(), 1);
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

test("one-way flexible search sends the selected stay-range payload without hidden expansion", async () => {
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
          sortMode: "cheapest",
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
    assert.equal(leg?.departureStart, "2026-04-02");
    assert.equal(leg?.departureEnd, "2026-04-04");
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
    await waitForLocationFieldsClosed(page, {
      origin: "LIM - Lima, Perú",
      destination: "MIA - FL, Estados Unidos",
    });

    const reusableUrl = page.url();
    const sharedUrl = new URL(reusableUrl);
    assert.equal(sharedUrl.searchParams.has("launchPayload"), false);
    assert.equal(sharedUrl.searchParams.get("mode"), "exact");
    assert.equal(sharedUrl.searchParams.get("trip"), "round-trip");
    assert.equal(sharedUrl.searchParams.get("origin"), "LIM");
    assert.equal(sharedUrl.searchParams.get("destination"), "MIA");
    assert.equal(sharedUrl.searchParams.get("departure"), "2026-03-31");
    assert.equal(sharedUrl.searchParams.get("return"), "2026-04-01");
    assert.equal(sharedUrl.searchParams.get("sort"), "cheapest");
    assert.equal(sharedUrl.searchParams.get("adults"), "1");
    assert.equal(sharedUrl.searchParams.get("children"), "0");
    assert.equal(sharedUrl.searchParams.get("infants"), "0");

    const replayPage = await browser.newPage();
    await replayPage.route("**/api/locations**", routeLocations);
    await replayPage.route("**/api/search", routeSearch);

    await replayPage.goto(reusableUrl, { waitUntil: "domcontentloaded" });
    await replayPage.getByRole("combobox", { name: "Origen" }).waitFor();

    assert.equal(new URL(replayPage.url()).searchParams.has("launchPayload"), false);
    assert.equal(payloads.length, 1);
    await waitForLocationFieldsClosed(replayPage, {
      origin: "LIM - Lima, Perú",
      destination: "MIA - FL, Estados Unidos",
    });
    assert.equal(await replayPage.getByRole("combobox", { name: "Origen" }).inputValue(), "LIM - Lima, Perú");
    assert.equal(await replayPage.getByRole("combobox", { name: "Destino" }).inputValue(), "MIA - FL, Estados Unidos");

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

test("paste accepts desktop search config JSON and sends the same exact backend request", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
    let payload: Record<string, unknown> | undefined;

    await page.route("**/api/locations**", async (route) => {
      const url = new URL(route.request().url());
      const query = url.searchParams.get("q")?.toLowerCase() ?? "";
      const suggestions = query.includes("bio")
        ? [{ code: "BIO", city: "Bilbao", country: "España", countryCode: "ES", label: "BIO - Bilbao, España" }]
        : [{ code: "LIM", city: "Lima", country: "Perú", countryCode: "PE", label: "LIM - Lima, Perú" }];

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions }),
      });
    });
    await page.route("**/api/search", async (route) => {
      payload = route.request().postDataJSON() as Record<string, unknown>;
      const cachedOffer = buildOffer({
        id: "clipboard-cache-offer",
        origin: "LIM",
        destination: "BIO",
        mainCarrier: "IB",
        validatingCarrier: "IB",
        comparisonMetrics: {
          totalDurationMinutes: 920,
          totalStops: 2,
        },
        stops: 2,
        itineraries: [
          {
            direction: "outbound",
            durationMinutes: 760,
            stops: 1,
            segments: [
              {
                flightNumber: "IB 610",
                origin: "LIM",
                destination: "MAD",
                departureAt: "2026-06-08T17:30:00Z",
                arrivalAt: "2026-06-09T11:10:00Z",
              },
              {
                flightNumber: "IB 426",
                origin: "MAD",
                destination: "BIO",
                departureAt: "2026-06-09T13:00:00Z",
                arrivalAt: "2026-06-09T14:05:00Z",
              },
            ],
          },
          {
            direction: "inbound",
            durationMinutes: 780,
            stops: 1,
            segments: [
              {
                flightNumber: "IB 447",
                origin: "BIO",
                destination: "MAD",
                departureAt: "2026-06-20T09:15:00Z",
                arrivalAt: "2026-06-20T10:20:00Z",
              },
              {
                flightNumber: "IB 6659",
                origin: "MAD",
                destination: "LIM",
                departureAt: "2026-06-20T12:05:00Z",
                arrivalAt: "2026-06-20T19:30:00Z",
              },
            ],
          },
        ],
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "clipboard-search",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: payload.sortMode,
          request: payload.request,
          offers: [cachedOffer],
          allOffers: [cachedOffer],
          searchMeta: {
            requestedAt: "2026-05-04T15:21:48.419Z",
            completedAt: "2026-05-04T15:21:48.419Z",
            providersUsed: ["agil-local", "costamar"],
            warnings: ["Mostrando resultados cacheados mientras actualizamos en segundo plano."],
            partial: true,
            searchState: "search_cached",
          },
          providerMeta: {
            exactProvider: "agil-local",
            coverageMode: "core",
          },
          warnings: [],
        }),
      });
    });

    await openDesktop(page, baseUrl);
    const copyConfig = page.getByRole("button", { name: "Copiar configuración" });
    const pasteConfig = page.getByRole("button", { name: "Pegar configuración" });
    assert.equal(await copyConfig.isDisabled(), true);
    assert.equal(await pasteConfig.isDisabled(), false);

    await page.evaluate((rawPayload) => navigator.clipboard.writeText(rawPayload), JSON.stringify({
      type: "fly-desk-search-config",
      version: 2,
      copiedAt: "2026-05-04T15:21:48.419Z",
      mode: "exact",
      tripType: "round-trip",
      sortMode: "cheapest",
      providerConfig: null,
      request: {
        tripType: "round-trip",
        searchMode: "exact",
        cabin: "ECONOMY",
        currencyCode: "USD",
        coverageMode: "core",
        redirectMode: "best-effort",
        passengers: { adults: 1, children: 0, infants: 0 },
        filters: {
          nonStop: false,
          baggageRequired: false,
          maxStops: 1,
          includedAirlineCodes: [],
        },
        legs: [{
          origin: "LIM",
          destination: "BIO",
          originLabel: "Lima, Perú (LIM)",
          destinationLabel: "Bilbao, España (BIO)",
          departureDate: "2026-06-08",
          returnDate: "2026-06-20",
        }],
        locale: "es-PE",
        market: "PE",
      },
    }));

    await pasteConfig.click();
    await page.waitForFunction(() => {
      const origin = document.querySelector<HTMLInputElement>('[aria-label="Origen"]');
      const destination = document.querySelector<HTMLInputElement>('[aria-label="Destino"]');
      return origin?.value.includes("LIM") && destination?.value.includes("BIO");
    });
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('button[aria-label="Copiar configuración"]')?.disabled);
    assert.equal(await copyConfig.isDisabled(), false);

    await copyConfig.click();
    const copiedPayload = await page.evaluate(async () => JSON.parse(String(await navigator.clipboard.readText())) as {
      type?: string;
      sortMode?: string;
      request?: { legs?: Array<Record<string, unknown>>; filters?: Record<string, unknown> };
    });
    assert.equal(copiedPayload.type, "fly-desk-search-config");
    assert.equal(copiedPayload.sortMode, "cheapest");
    assert.equal(copiedPayload.request?.legs?.[0]?.origin, "LIM");
    assert.equal(copiedPayload.request?.legs?.[0]?.destination, "BIO");
    assert.equal(copiedPayload.request?.filters?.maxStops, 1);

    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);

    const request = payload?.request as {
      tripType?: string;
      searchMode?: string;
      legs?: Array<Record<string, unknown>>;
      passengers?: Record<string, unknown>;
      filters?: Record<string, unknown>;
    };
    const leg = request.legs?.[0];

    assert.equal(payload?.sortMode, "cheapest");
    assert.equal(request.tripType, "round-trip");
    assert.equal(request.searchMode, "exact");
    assert.equal(leg?.origin, "LIM");
    assert.equal(leg?.destination, "BIO");
    assert.equal(leg?.departureDate, "2026-06-08");
    assert.equal(leg?.returnDate, "2026-06-20");
    assert.equal(request.passengers?.adults, 1);
    assert.equal(request.filters?.maxStops, 1);
    await page.getByText("Cache revalidando").waitFor();
    await page.getByText("1 vuelo").waitFor();
    await page.getByText("LIM - MAD - BIO").waitFor();
  }, { autoOpen: false });
});

test("topbar brand opens the current instance root without hardcoding the port", async () => {
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
          searchJobId: "brand-reset-search",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: payload.sortMode,
          request: payload.request,
          offers: [],
          allOffers: [],
          searchMeta: {
            requestedAt: "2026-05-04T15:21:48.419Z",
            completedAt: "2026-05-04T15:21:48.419Z",
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
    await page.getByRole("combobox", { name: "Origen" }).waitFor();
    await page.waitForFunction(() => {
      const origin = document.querySelector<HTMLInputElement>('[aria-label="Origen"]');
      const destination = document.querySelector<HTMLInputElement>('[aria-label="Destino"]');
      return origin?.value.includes("LIM") && destination?.value.includes("BIO");
    });

    const instanceRoot = `${new URL(baseUrl).origin}/`;
    const brandLink = page.getByRole("link", { name: "Abrir Fly Desk" });
    const brandHref = await brandLink.getAttribute("href");
    const brandStyle = await brandLink.evaluate((link) => {
      const style = getComputedStyle(link);
      return {
        backgroundColor: style.backgroundColor,
        borderStyle: style.borderStyle,
      };
    });
    assert.equal(brandHref, instanceRoot);
    assert.equal(brandStyle.backgroundColor, "rgba(0, 0, 0, 0)");
    assert.equal(brandStyle.borderStyle, "none");
    assert.equal(await page.getByRole("button", { name: "Copiar configuración" }).isDisabled(), false);

    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);
    await page.locator(".fd-workspace-enter").waitFor({ state: "visible" });

    await brandLink.click();
    await page.waitForURL(instanceRoot);
    await page.waitForFunction(() => {
      const origin = document.querySelector<HTMLInputElement>('[aria-label="Origen"]');
      const destination = document.querySelector<HTMLInputElement>('[aria-label="Destino"]');
      return origin?.value === ""
        && destination?.value === ""
        && window.location.search === ""
        && !document.querySelector(".fd-workspace-enter");
    });
    assert.equal(await page.getByRole("button", { name: "Copiar configuración" }).isDisabled(), true);
  }, { autoOpen: false });
});

test("exact results paginate visible offers with hidden minimal result scroll", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 1180, height: 700 });
    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/search", async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      const offers = Array.from({ length: 18 }, (_, index) => {
        const carrier = `P${String(index + 1).padStart(2, "0")}`;
        return buildOffer({
          id: `paged-offer-${index + 1}`,
          origin: "LIM",
          destination: "BIO",
          mainCarrier: carrier,
          validatingCarrier: carrier,
          price: {
            total: { amount: 520 + index, currencyCode: "USD" },
            base: { amount: 430 + index, currencyCode: "USD" },
            taxes: { amount: 90, currencyCode: "USD" },
          },
          itineraries: [
            {
              direction: "outbound",
              durationMinutes: 760 + index,
              stops: 1,
              segments: [
                {
                  flightNumber: `${carrier} ${100 + index}`,
                  marketingCarrier: carrier,
                  origin: "LIM",
                  destination: "BIO",
                  departureAt: "2026-06-08T17:30:00Z",
                  arrivalAt: "2026-06-09T14:05:00Z",
                },
              ],
            },
            {
              direction: "inbound",
              durationMinutes: 780 + index,
              stops: 1,
              segments: [
                {
                  flightNumber: `${carrier} ${200 + index}`,
                  marketingCarrier: carrier,
                  origin: "BIO",
                  destination: "LIM",
                  departureAt: "2026-06-20T09:15:00Z",
                  arrivalAt: "2026-06-20T19:30:00Z",
                },
              ],
            },
          ],
        });
      });

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "paged-search",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: payload.sortMode,
          request: payload.request,
          offers,
          allOffers: offers,
          searchMeta: {
            requestedAt: "2026-05-04T15:21:48.419Z",
            completedAt: "2026-05-04T15:21:48.419Z",
            providersUsed: ["agil-local"],
            warnings: ["Tarifas sujetas a disponibilidad."],
            partial: false,
            searchState: "search_live",
          },
          providerMeta: {
            exactProvider: "agil-local",
            coverageMode: "core",
          },
          warnings: ["Tarifas sujetas a disponibilidad."],
        }),
      });
    });

    await page.goto(`${baseUrl}/?mode=exact&trip=round-trip&origin=LIM&destination=BIO&departure=2026-06-08&return=2026-06-20&adults=1&children=0&infants=0&sort=cheapest&maxStops=1`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();
    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);

    const pagination = page.getByTestId("results-pagination");
    await pagination.waitFor({ state: "visible" });
    await page.getByText("1 aviso").waitFor();
    assert.equal(await page.locator(".fd-alert.fd-alert-warning").count(), 0);
    await page.waitForFunction(() => {
      const body = document.querySelector<HTMLElement>('[data-testid="results-page-body"]');
      const cards = document.querySelectorAll('[data-testid="result-card"]').length;
      return Boolean(body && cards > 0 && cards < 18 && getComputedStyle(body).scrollbarWidth === "none");
    });

    const visibleCards = await page.locator('[data-testid="result-card"]').count();
    const paginationText = await pagination.innerText();
    assert.ok(visibleCards > 0);
    assert.ok(visibleCards < 18);
    assert.match(paginationText, new RegExp(`^1-${visibleCards} de 18`));

    const metrics = await page.getByTestId("results-page-body").evaluate((element) => ({
      clientHeight: element.clientHeight,
      listHeight: element.querySelector<HTMLElement>(".fd-results-list")?.getBoundingClientRect().height ?? 0,
      overflowY: getComputedStyle(element).overflowY,
      scrollbarWidth: getComputedStyle(element).scrollbarWidth,
      scrollHeight: element.scrollHeight,
    }));
    assert.equal(metrics.overflowY, "auto");
    assert.equal(metrics.scrollbarWidth, "none");
    assert.ok(metrics.scrollHeight >= metrics.clientHeight || metrics.clientHeight - metrics.listHeight < 72, JSON.stringify(metrics));

    await page.getByRole("button", { name: "Página siguiente" }).click();
    const pagedCards = page.locator('[data-testid="result-card"]');
    await pagedCards.filter({ hasText: `P${String(visibleCards + 1).padStart(2, "0")}` }).first().waitFor();
    assert.match(await pagination.innerText(), new RegExp(`^${visibleCards + 1}-\\d+ de 18`));
    assert.equal(await pagedCards.filter({ hasText: "P01" }).count(), 0);

    const firstVisibleCard = pagedCards.first();
    assert.equal(await firstVisibleCard.locator(".fd-result-card__schedule").count(), 2);
    assert.equal(await firstVisibleCard.locator(".fd-result-card__schedules").getAttribute("data-trip-type"), "round-trip");
    assert.match(await firstVisibleCard.locator(".fd-result-card__schedules").innerText(), /Ida/);
    assert.match(await firstVisibleCard.locator(".fd-result-card__schedules").innerText(), /Vuelta/);
    assert.doesNotMatch(await firstVisibleCard.locator(".fd-result-card__route").innerText(), /Vuelta/);
  }, { autoOpen: false });
});

test("grouped result variants show only schedule differences", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 1180, height: 700 });
    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/search", async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      const groupedOffer = (id: string, returnDeparture: string, returnArrival: string) => buildOffer({
        id,
        providerSource: "costamar",
        airline: "KLM",
        mainCarrier: "KL",
        validatingCarrier: "KL",
        rawRefs: { recommendationId: "REC-compact:0" },
        price: {
          total: { amount: 1361.14, currencyCode: "USD" },
          base: { amount: 1120, currencyCode: "USD" },
          taxes: { amount: 241.14, currencyCode: "USD" },
        },
        itineraries: [
          {
            direction: "outbound",
            durationMinutes: 960,
            stops: 1,
            segments: [
              {
                flightNumber: "KL 744",
                marketingCarrier: "KL",
                origin: "LIM",
                destination: "AMS",
                departureAt: "2026-05-28T17:30:00-05:00",
                arrivalAt: "2026-05-30T09:30:00+02:00",
              },
              {
                flightNumber: "KL 1501",
                marketingCarrier: "KL",
                origin: "AMS",
                destination: "MAD",
                departureAt: "2026-05-30T11:00:00+02:00",
                arrivalAt: "2026-05-30T13:30:00+02:00",
              },
            ],
          },
          {
            direction: "inbound",
            durationMinutes: 780,
            stops: 1,
            segments: [
              {
                flightNumber: "KL 1502",
                marketingCarrier: "KL",
                origin: "MAD",
                destination: "AMS",
                departureAt: returnDeparture,
                arrivalAt: returnArrival,
              },
            ],
          },
        ],
      });

      const offers = [
        groupedOffer("late-return", "2026-06-04T20:30:00+02:00", "2026-06-05T15:25:00-05:00"),
        groupedOffer("early-return", "2026-06-04T06:00:00+02:00", "2026-06-04T15:25:00-05:00"),
        groupedOffer("mid-return", "2026-06-04T13:05:00+02:00", "2026-06-05T15:25:00-05:00"),
      ];

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "grouped-compact-search",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: payload.sortMode,
          request: payload.request,
          offers,
          allOffers: offers,
          searchMeta: {
            requestedAt: "2026-05-04T15:21:48.419Z",
            completedAt: "2026-05-04T15:21:48.419Z",
            providersUsed: ["costamar"],
            warnings: [],
            partial: false,
            searchState: "search_live",
          },
          providerMeta: {
            exactProvider: "costamar",
            coverageMode: "core",
          },
          warnings: [],
        }),
      });
    });

    await page.goto(`${baseUrl}/?mode=exact&trip=round-trip&origin=LIM&destination=MAD&departure=2026-05-28&return=2026-06-04&adults=1&children=0&infants=0&sort=cheapest`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();
    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);

    const group = page.getByTestId("result-offer-group");
    await group.waitFor();
    assert.equal(await group.getByTestId("result-card").count(), 1);
    assert.equal(await group.getByTestId("result-variant-card").count(), 2);

    const variants = group.getByTestId("result-variant-card");
    const variantText = await variants.allInnerTexts();
    assert.match(variantText[0] ?? "", /Vuelta\s+13:05 - 15:25\+1/);
    assert.match(variantText[1] ?? "", /Vuelta\s+20:30 - 15:25\+1/);
    assert.doesNotMatch(variantText.join(" "), /KLM|Costamar|USD|Equipaje|04\/06/);
  }, { autoOpen: false });
});

test("normal results wait for saved column layout before drawing cards", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 1180, height: 700 });

    let releaseLayout!: () => void;
    let markLayoutRequested!: () => void;
    const layoutReleased = new Promise<void>((resolve) => {
      releaseLayout = resolve;
    });
    const layoutRequested = new Promise<void>((resolve) => {
      markLayoutRequested = resolve;
    });

    await page.route("**/api/results-layout", async (route) => {
      markLayoutRequested();
      await layoutReleased;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          layout: {
            version: 1,
            savedAt: "2026-05-11T17:18:33.592Z",
            columns: {
              carrier: 117,
              dates: 260,
              duration: 94,
              stops: 145,
              price: 127,
              links: 40,
            },
          },
        }),
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
      const offers = [buildOffer({ id: "saved-layout-offer", origin: "LIM", destination: "BIO" })];

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "saved-layout-search",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: payload.sortMode,
          request: payload.request,
          offers,
          allOffers: offers,
          searchMeta: {
            requestedAt: "2026-05-11T17:18:33.592Z",
            completedAt: "2026-05-11T17:18:33.592Z",
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

    await page.goto(`${baseUrl}/?mode=exact&trip=round-trip&origin=LIM&destination=BIO&departure=2026-06-08&return=2026-06-20&adults=1&children=0&infants=0&sort=cheapest&maxStops=1`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();

    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
      layoutRequested,
    ]);

    await page.locator('[data-testid="result-card"]').waitFor({ state: "detached" });
    await page.locator(".fd-skeleton").first().waitFor({ state: "visible" });
    assert.equal(await page.locator('[data-testid="result-card"]').count(), 0);

    releaseLayout();
    await page.locator('[data-testid="result-card"]').waitFor({ state: "visible" });

    const layout = await page.locator(".fd-results-list").evaluate((list) => {
      const style = getComputedStyle(list);
      return {
        fixed: list.classList.contains("fd-results-list--fixed-layout"),
        carrier: style.getPropertyValue("--fd-results-col-carrier").trim(),
        dates: style.getPropertyValue("--fd-results-col-dates").trim(),
        duration: style.getPropertyValue("--fd-results-col-duration").trim(),
        stops: style.getPropertyValue("--fd-results-col-stops").trim(),
        price: style.getPropertyValue("--fd-results-col-price").trim(),
        links: style.getPropertyValue("--fd-results-col-links").trim(),
      };
    });

    assert.deepEqual(layout, {
      fixed: true,
      carrier: "155fr",
      dates: "345fr",
      duration: "125fr",
      stops: "192fr",
      price: "169fr",
      links: "53fr",
    });
  }, { autoOpen: false });
});

test("grouped provider offer renders Agilsmart and Costamar external links vertically", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 1180, height: 700 });
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
        id: "grouped-provider-offer",
        providerSource: "agil-local",
        purchasePaths: [
          {
            id: "grouped-agil-path",
            provider: "agil-local",
            type: "deeplink",
            label: "Agilsmart",
            url: "https://example.test/agil",
            precision: "exact-offer",
            score: 1,
            requiresNewTab: true,
            commercialMode: "provider",
            state: "deeplink_exact",
          },
          {
            id: "grouped-costamar-path",
            provider: "costamar",
            type: "search-redirect",
            label: "Costamar",
            url: "https://example.test/costamar",
            precision: "exact-search",
            score: 0.8,
            requiresNewTab: true,
            commercialMode: "provider",
            state: "search_redirect",
          },
        ],
      });

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "grouped-provider-search",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: payload.sortMode,
          request: payload.request,
          offers: [offer],
          allOffers: [offer],
          searchMeta: {
            requestedAt: "2026-05-04T15:21:48.419Z",
            completedAt: "2026-05-04T15:21:48.419Z",
            providersUsed: ["agil-local", "costamar"],
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
    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);

    const card = page.getByTestId("result-card").first();
    await card.waitFor();
    const actions = card.locator(".fd-result-card__provider-action");
    assert.equal(await actions.count(), 2);
    await card.getByRole("button", { name: "Abrir Agilsmart" }).waitFor();
    await card.getByRole("button", { name: "Buscar en Costamar" }).waitFor();

    const layout = await actions.evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
      };
    }));
    assert.ok(layout[1].top >= layout[0].bottom, JSON.stringify(layout));
    assert.ok(layout.every((item) => item.width <= 38), JSON.stringify(layout));
  }, { autoOpen: false });
});

test("result filters refine loaded offers without restarting the search", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    let searchRequests = 0;
    const offers = ["H2", "P02", "P03", "P04"].map((carrier, index) => {
      const carrierName = carrier === "H2" ? "Sky Airline" : undefined;

      return buildOffer({
        id: `local-filter-offer-${carrier}`,
        origin: "LIM",
        destination: "BIO",
        mainCarrier: carrier,
        validatingCarrier: carrier,
        airline: carrier,
        price: {
          total: { amount: 620 + index, currencyCode: "USD" },
          base: { amount: 520 + index, currencyCode: "USD" },
          taxes: { amount: 100, currencyCode: "USD" },
        },
        itineraries: [
          {
            direction: "outbound",
            durationMinutes: 480,
            stops: 0,
            segments: [
              {
                flightNumber: `${carrier} 123`,
                marketingCarrier: carrier,
                marketingCarrierName: carrierName,
                origin: "LIM",
                destination: "BIO",
                departureAt: "2026-06-08T14:00:00Z",
                arrivalAt: "2026-06-08T22:00:00Z",
              },
            ],
          },
          {
            direction: "inbound",
            durationMinutes: 470,
            stops: 0,
            segments: [
              {
                flightNumber: `${carrier} 456`,
                marketingCarrier: carrier,
                marketingCarrierName: carrierName,
                origin: "BIO",
                destination: "LIM",
                departureAt: "2026-06-20T15:00:00Z",
                arrivalAt: "2026-06-20T22:50:00Z",
              },
            ],
          },
        ],
      });
    });

    await page.setViewportSize({ width: 1440, height: 760 });
    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/search", async (route) => {
      searchRequests += 1;
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "local-filter-search",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: payload.sortMode,
          request: payload.request,
          offers,
          allOffers: offers,
          searchMeta: {
            requestedAt: "2026-05-04T15:21:48.419Z",
            completedAt: "2026-05-04T15:21:48.419Z",
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

    await page.goto(`${baseUrl}/?mode=exact&trip=round-trip&origin=LIM&destination=BIO&departure=2026-06-08&return=2026-06-20&adults=1&children=0&infants=0&sort=cheapest&maxStops=1`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();
    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);
    await page.getByTestId("result-card").first().waitFor();

    await page.getByRole("checkbox", { name: "Sky" }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="result-card"]').length === 1);

    assert.equal(searchRequests, 1);
    assert.equal(await page.getByRole("button", { name: "Buscar" }).isVisible(), true);
    assert.equal(await page.getByRole("button", { name: "Detener búsqueda" }).count(), 0);
    assert.equal(await page.getByText("Actualizando").count(), 0);
    assert.equal(await page.getByRole("checkbox", { name: "H2" }).count(), 0);
    assert.equal(await page.getByTestId("result-card").filter({ hasText: "Sky" }).count(), 1);

    const airlineListScroll = await page.locator(".fd-scrollbar-hidden").evaluateAll((nodes) =>
      nodes.some((node) => getComputedStyle(node).scrollbarWidth === "none"),
    );
    assert.equal(airlineListScroll, true);
  }, { autoOpen: false });
});

test("empty local filter results do not blame a provider that already reported no flights", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    let searchRequests = 0;
    const offers = [
      buildOffer({
        id: "costamar-carry-on-only",
        origin: "TPP",
        destination: "LIM",
        mainCarrier: "H2",
        validatingCarrier: "H2",
        airline: "Sky Airline",
        baggage: {
          carryOnIncluded: true,
          checkedIncluded: false,
          description: "Solo equipaje de mano",
        },
        purchasePaths: [
          {
            provider: "costamar",
            type: "search-redirect",
            label: "Costamar",
            url: "https://example.test/costamar",
          },
        ],
        itineraries: [
          {
            direction: "outbound",
            durationMinutes: 80,
            stops: 0,
            segments: [
              {
                flightNumber: "H2 123",
                marketingCarrier: "H2",
                marketingCarrierName: "Sky Airline",
                origin: "TPP",
                destination: "LIM",
                departureAt: "2026-05-13T14:00:00Z",
                arrivalAt: "2026-05-13T15:20:00Z",
              },
            ],
          },
        ],
      }),
    ];

    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/search", async (route) => {
      searchRequests += 1;
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "filtered-empty-provider-warning",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: payload.sortMode,
          request: payload.request,
          offers,
          allOffers: offers,
          searchMeta: {
            requestedAt: "2026-05-13T18:16:23.838Z",
            completedAt: "2026-05-13T18:16:23.838Z",
            providersUsed: ["agil-local", "costamar"],
            warnings: ["Agil returned no offers for this search."],
            partial: false,
            searchState: "search_live",
          },
          providerMeta: {
            exactProvider: "agil-local",
            coverageMode: "core",
          },
          warnings: ["Agil returned no offers for this search."],
        }),
      });
    });

    await page.goto(`${baseUrl}/?mode=exact&trip=one-way&origin=TPP&destination=LIM&departure=2026-05-13&adults=1&children=0&infants=0&sort=cheapest`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();
    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);
    await page.getByTestId("result-card").first().waitFor();
    await page.getByText("Agilsmart sin vuelos").waitFor();

    await page.getByRole("switch", { name: "Incluye equipaje" }).click();
    await page.getByText("No hay búsquedas que coincidan").waitFor();

    assert.equal(await page.getByTestId("result-card").count(), 0);
    assert.equal(await page.getByText("Agilsmart no devolvió vuelos").count(), 0);
    assert.equal(await page.getByText("Agilsmart sin vuelos").count(), 0);
    assert.equal(await page.getByText("1 aviso").count(), 1);
    assert.equal(searchRequests, 1);
  }, { autoOpen: false });
});

test("empty exact results identify providers that reported no flights", async () => {
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
          searchJobId: "no-flights-search",
          searchComplete: true,
          searchStatus: "completed",
          revision: 1,
          sortMode: payload.sortMode,
          request: payload.request,
          offers: [],
          allOffers: [],
          searchMeta: {
            requestedAt: "2026-05-04T15:21:48.419Z",
            completedAt: "2026-05-04T15:21:48.419Z",
            providersUsed: ["agil-local", "costamar"],
            warnings: [
              "Agil returned no offers for this search.",
              "Costamar returned no offers for this search.",
            ],
            partial: false,
            searchState: "search_live",
          },
          providerMeta: {
            exactProvider: "agil-local",
            coverageMode: "core",
          },
          warnings: [
            "Agil returned no offers for this search.",
            "Costamar returned no offers for this search.",
          ],
        }),
      });
    });

    await page.goto(`${baseUrl}/?mode=exact&trip=round-trip&origin=LIM&destination=BIO&departure=2026-06-08&return=2026-06-20&adults=1&children=0&infants=0&sort=cheapest&maxStops=1`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("combobox", { name: "Origen" }).waitFor();

    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);

    await page.getByText("Agilsmart y Costamar no devolvieron vuelos").waitFor();
    await page.getByText("Los proveedores consultados informaron que no hay vuelos para esta combinación.").waitFor();
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
            exactProvider: "costamar",
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
              providerSource: "costamar",
              selectable: true,
              requiresRequery: false,
              stateCode: "live",
              tooltip: "Mejor tarifa",
              offer: {
                id: "costamar-matrix-offer",
                providerSource: "costamar",
                providerOfferRef: "costamar-ref",
                tripType: "round-trip",
                validatingCarrier: "H2",
                mainCarrier: "H2",
                origin: "LIM",
                destination: "MIA",
                itineraries: [
                  {
                    id: "outbound",
                    direction: "outbound",
                    durationMinutes: 345,
                    stops: 0,
                    layoverMinutes: [],
                    segments: [
                      {
                        id: "outbound-1",
                        marketingCarrier: "H2",
                        marketingCarrierName: "Sky Airline",
                        flightNumber: "2550",
                        origin: "LIM",
                        destination: "MIA",
                        departureAt: "2026-04-03T14:25:00",
                        arrivalAt: "2026-04-03T20:10:00",
                        durationMinutes: 345,
                      },
                    ],
                  },
                  {
                    id: "inbound",
                    direction: "inbound",
                    durationMinutes: 370,
                    stops: 0,
                    layoverMinutes: [],
                    segments: [
                      {
                        id: "inbound-1",
                        marketingCarrier: "H2",
                        marketingCarrierName: "Sky Airline",
                        flightNumber: "2551",
                        origin: "MIA",
                        destination: "LIM",
                        departureAt: "2026-04-10T08:30:00",
                        arrivalAt: "2026-04-10T14:40:00",
                        durationMinutes: 370,
                      },
                    ],
                  },
                ],
                price: {
                  total: { amount: 480, currencyCode: "USD" },
                },
                priceConfidence: "live",
                priceStatus: "unverified",
                purchasePaths: [],
                comparisonMetrics: {
                  totalDurationMinutes: 715,
                  totalStops: 0,
                  baggageScore: 0,
                  purchasePathScore: 0,
                },
                tags: [],
                warnings: [],
              },
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

    assert.equal(payload?.sortMode, "cheapest");
    assert.equal(request.tripType, "round-trip");
    assert.equal(request.searchMode, "roundtrip-grid");
    assert.equal(request.flexibleMode, "exact-stay");
    assert.equal(leg?.departureStart, "2026-04-03");
    assert.equal(leg?.departureEnd, "2026-04-05");
    assert.equal(leg?.stayNights, 7);
    await page.getByText("USD 480").waitFor();
    const flexibleCard = page.getByTestId("result-card").first();
    assert.equal(await flexibleCard.locator(".fd-result-card__schedule").count(), 2);
    assert.equal(await flexibleCard.locator(".fd-result-card__schedules").getAttribute("data-trip-type"), "round-trip");
    assert.doesNotMatch(await flexibleCard.locator(".fd-result-card__route").innerText(), /Vuelta/);
    const bodyText = await page.locator("body").innerText();
    assert.doesNotMatch(bodyText, /\b00:00\b/);
    assert.match(bodyText, /14:25/);
    assert.match(bodyText, /20:10/);
    assert.match(bodyText, /08:30/);
    assert.match(bodyText, /14:40/);
    assert.match(bodyText, /11h 55m/);
    assert.doesNotMatch(bodyText, /Horario por confirmar/);
    const sortControl = page.getByLabel("Orden de resultados");
    assert.match(await sortControl.getAttribute("class") ?? "", /items-stretch/);
    assert.doesNotMatch(await sortControl.getAttribute("class") ?? "", /p-0\.5/);
    assert.equal(await sortControl.locator(".fd-segmented-indicator").count(), 1);
    assert.deepEqual(
      (await sortControl.getByRole("button").allTextContents()).map((label) => label.trim()),
      ["Precio", "Duración"],
    );
    assert.equal(await page.getByRole("button", { name: "Ordenar por precio" }).getAttribute("aria-pressed"), "true");
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
    await page.getByRole("button", { name: "Mes desde", exact: true }).click();
    await page.getByRole("dialog", { name: "Calendario de mes desde" }).getByRole("button", { name: /Mayo de 2026/i }).click();
    await page.getByRole("button", { name: "Mes hasta", exact: true }).click();
    await page.getByRole("dialog", { name: "Calendario de mes hasta" }).getByRole("button", { name: /Junio de 2026/i }).click();
    await page.getByRole("combobox", { name: "Origen" }).fill("LIM");
    await page.getByRole("combobox", { name: "Destino" }).fill("MIA");
    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);
    await page.locator(".fd-migration-grid").getByText("USD 512.00").waitFor();
    const topbarControls = page.getByTestId("topbar-search-controls");
    assert.equal(await topbarControls.getByRole("button", { name: "Migratorio" }).count(), 1);
    assert.equal(await page.locator("main").getByRole("button", { name: "Migratorio" }).count(), 0);
    const topbarHeight = async () => Math.round(await page.locator("header").evaluate((element) =>
      element.getBoundingClientRect().height,
    ));
    const migrationTopbarHeight = await topbarHeight();
    await clickSegment(topbarControls.getByRole("button", { name: "Flexible" }));
    const flexibleTopbarHeight = await topbarHeight();
    assert.ok(Math.abs(migrationTopbarHeight - flexibleTopbarHeight) <= 2);
    assert.equal(await topbarControls.locator(".fd-segmented-indicator").count(), 2);
    assert.doesNotMatch(await topbarControls.getByRole("button", { name: "Flexible" }).getAttribute("class") ?? "", /bg-card/);
    await clickSegment(topbarControls.getByRole("button", { name: "Exacto" }));
    assert.ok(Math.abs(await topbarHeight() - flexibleTopbarHeight) <= 2);
    await clickSegment(topbarControls.getByRole("button", { name: "Migratorio" }));
    assert.ok(Math.abs(await topbarHeight() - flexibleTopbarHeight) <= 2);
    assert.equal(await page.getByTestId("migration-month-card").count(), 2);
    const migrationCard = page.getByTestId("migration-month-card").first();
    assert.equal(await migrationCard.locator(".fd-result-card__schedule").count(), 1);
    assert.equal(await migrationCard.locator(".fd-result-card__schedules").getAttribute("data-trip-type"), "one-way");
    assert.doesNotMatch(await migrationCard.locator(".fd-result-card__schedules").innerText(), /Vuelta/);
    const bodyText = await page.locator("body").innerText();
    assert.doesNotMatch(bodyText, /\b00:00\b/);
    assert.match(bodyText, /14:00/);
    assert.match(bodyText, /Mayo de 2026/i);

    assert.equal(payloads.length, 2);
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
    assert.equal(firstLeg?.departureStart, "2026-05-01");
    assert.equal(firstLeg?.departureEnd, "2026-05-31");
    assert.equal(firstLeg?.returnDate, undefined);
  });
});

test("mobile workspace keeps search modes inline instead of crowding the topbar", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/results-layout", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ layout: null }),
      });
    });
    await page.route("**/api/search", async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      const offer = buildOffer({ id: "mobile-layout-offer", origin: "LIM", destination: "MIA" });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: "mobile-layout-search",
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

    await page.goto(`${baseUrl}/?layout=editor&mode=exact&trip=one-way&origin=LIM&destination=MIA&departure=2026-06-08&adults=1&children=0&infants=0`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("button", { name: "Buscar" }).click();
    await page.getByTestId("result-card").waitFor();

    assert.equal(await page.getByTestId("topbar-search-controls").getByRole("button", { name: "Exacto" }).count(), 0);
    assert.equal(await page.locator("main").getByRole("button", { name: "Exacto" }).count(), 1);
    assert.equal(await page.locator(".fd-result-card--layout-guide").evaluate((element) => getComputedStyle(element).display), "none");
    const editorHeight = await page.locator(".fd-results-layout-editor").evaluate((element) => element.getBoundingClientRect().height);
    assert.ok(editorHeight <= 96, `mobile layout editor is too tall: ${editorHeight}`);
  });
});

test("migratory search renders monthly progress and refilters each month locally", async () => {
  await withDesktopPage(async ({ page }) => {
    let requestCount = 0;
    let heldSecondRoute: Route | null = null;
    let heldSecondPayload: Record<string, unknown> | null = null;

    const migrationOffer = (id: string, amount: number, stops: number) => buildOffer({
      id,
      mainCarrier: stops === 0 ? "LA" : "AA",
      validatingCarrier: stops === 0 ? "LA" : "AA",
      comparisonMetrics: {
        totalDurationMinutes: stops === 0 ? 480 : 780,
        totalStops: stops,
      },
      price: {
        total: { amount, currencyCode: "USD" },
        base: { amount: Math.max(0, amount - 90), currencyCode: "USD" },
        taxes: { amount: 90, currencyCode: "USD" },
      },
      itineraries: [
        {
          direction: "outbound",
          durationMinutes: stops === 0 ? 480 : 780,
          stops,
          layoverMinutes: stops === 0 ? [] : [180],
          segments: stops === 0
            ? [
                {
                  flightNumber: "LA 2011",
                  marketingCarrier: "LA",
                  origin: "LIM",
                  destination: "MIA",
                  departureAt: "2026-04-15T14:00:00Z",
                  arrivalAt: "2026-04-15T22:00:00Z",
                },
              ]
            : [
                {
                  flightNumber: "AA 100",
                  marketingCarrier: "AA",
                  origin: "LIM",
                  destination: "BOG",
                  departureAt: "2026-04-15T08:00:00Z",
                  arrivalAt: "2026-04-15T11:00:00Z",
                },
                {
                  flightNumber: "AA 200",
                  marketingCarrier: "AA",
                  origin: "BOG",
                  destination: "MIA",
                  departureAt: "2026-04-15T14:00:00Z",
                  arrivalAt: "2026-04-15T19:00:00Z",
                },
              ],
        },
      ],
    });
    const fulfillSearch = async (
      route: Route,
      payload: Record<string, unknown>,
      offers: unknown[],
      id: string,
    ) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          searchJobId: id,
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
    };

    await page.route("**/api/locations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suggestions: [] }),
      });
    });
    await page.route("**/api/search", async (route) => {
      requestCount += 1;
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      if (requestCount === 1) {
        await fulfillSearch(route, payload, [
          migrationOffer("migration-cheapest-stop", 90, 1),
          migrationOffer("migration-direct", 150, 0),
        ], "migration-progress-1");
        return;
      }

      if (requestCount === 2) {
        heldSecondRoute = route;
        heldSecondPayload = payload;
        return;
      }

      await fulfillSearch(route, payload, [], `migration-progress-${requestCount}`);
    });

    await page.getByRole("button", { name: "Migratorio" }).click();
    await page.getByRole("combobox", { name: "Origen" }).fill("LIM");
    await page.getByRole("combobox", { name: "Destino" }).fill("MIA");
    await Promise.all([
      page.waitForResponse("**/api/search"),
      page.getByRole("button", { name: "Buscar" }).click(),
    ]);

    const migrationGrid = page.locator(".fd-migration-grid");
    await migrationGrid.getByText("USD 90.00").waitFor();
    await page.waitForFunction(() => document.querySelectorAll(".fd-migration-month-card--loading").length > 0);
    assert.equal(await page.getByTestId("migration-month-card").count(), 8);
    assert.equal(await page.getByRole("button", { name: "Detener búsqueda" }).count(), 1);

    await page.getByRole("switch", { name: "Solo directos" }).click();
    await migrationGrid.getByText("USD 150.00").waitFor();
    assert.equal(await migrationGrid.getByText("USD 90.00").count(), 0);

    if (heldSecondRoute && heldSecondPayload) {
      await fulfillSearch(heldSecondRoute, heldSecondPayload, [], "migration-progress-2");
    }
    await page.waitForFunction(() => document.querySelector('button[aria-label="Buscar"]'));
    assert.equal(requestCount, 8);
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
          sortMode: "cheapest",
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
    assert.doesNotMatch(await workspaceTabs.getAttribute("class") ?? "", /p-0\.5/);
    assert.doesNotMatch(await workspaceTabs.getAttribute("class") ?? "", /gap-1/);
    assert.equal(await workspaceTabs.locator(".fd-segmented-indicator").count(), 1);
    assert.doesNotMatch(await page.getByRole("tab", { name: "Resultados" }).getAttribute("class") ?? "", /data-\[state=active\]:bg-card/);
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
                { code: "ZZZ", city: "Zed City", country: "Pruebas", countryCode: "ZZ", label: "Zed City, Pruebas (ZZZ)" },
                { code: "ZZY", city: "Zeta Field", country: "Pruebas", countryCode: "ZZ", label: "Zeta Field, Pruebas (ZZY)" },
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
          sortMode: "cheapest",
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
    await destination.click();
    const suggestionsResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/locations"
        && url.searchParams.get("q") === "ZZ"
        && response.status() === 200;
    });
    await destination.fill("ZZ");
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

    await page.keyboard.press("Control+Shift+L");
    const logText = await page.getByRole("textbox", { name: "Registro de búsqueda" }).inputValue();
    assert.match(logText, /HTTP 500/);
    assert.match(logText, /Profile 40: Agil local session data is incomplete in Chrome localStorage/);
    assert.match(logText, /connectOverCDP/);
  });
});
