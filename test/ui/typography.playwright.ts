import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright";
import { registerDesktopHarness, withDesktopPage } from "../helpers/ui.ts";
import { buildOffer } from "../helpers/ui-fixtures.ts";
import { clickSegment, openSharedSearchLink, segment, waitForFontsReady } from "./support.ts";

registerDesktopHarness();

/*
 * What this file asserts is typography, which until now nothing did: not the
 * family, not the weight, not the digit column. A whole pass of typographic
 * coherence could land inert — a new rule under `@layer` that an unlayered rule
 * in `index.css` outranks — and the suite would stay green.
 *
 * `getComputedStyle().fontFamily` is no use here: it returns the declared list,
 * not the face that was painted, so `"IBM Plex Mono", ui-monospace` reads the
 * same whether the font loaded or not. And `document.fonts.check` returns false
 * negatives for a weight that has not been painted yet.
 *
 * The only reliable signal is rendered width, and what separates this product's
 * two families is not their name but a metric property: in a monospace an "i"
 * takes exactly as much room as an "m". The probe is hung *inside* the element
 * so it inherits its whole typography — family, body, weight, spacing — and
 * measures those two strings. It gives the same verdict with the font loaded
 * and with the fallback, because `ui-monospace` is monospaced too and
 * `system-ui` is proportional too.
 */
async function isMonospaced(page: Page, selector: string): Promise<boolean> {
  return await page.evaluate((target) => {
    const node = document.querySelector<HTMLElement>(target);
    if (!node) throw new Error(`No element matches ${target}`);

    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;top:-4000px;left:0;white-space:pre;";
    node.appendChild(probe);
    const inkOf = (text: string) => {
      probe.textContent = text;
      const range = document.createRange();
      range.selectNodeContents(probe);
      return range.getBoundingClientRect().width;
    };
    const narrow = inkOf("iiiiiiii");
    const wide = inkOf("mmmmmmmm");
    probe.remove();
    if (narrow === 0 || wide === 0) throw new Error(`${target} paints nothing`);
    return Math.abs(narrow - wide) < 0.5;
  }, selector);
}

async function routeSingleOfferSearch(page: Page): Promise<void> {
  await page.route("**/api/locations**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ suggestions: [] }),
    });
  });
  await page.route("**/api/search", async (route) => {
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    const offer = buildOffer({ id: "typography-1", origin: "LIM", destination: "BIO" });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        searchJobId: "typography-search",
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
        providerMeta: { exactProvider: "agil-local", coverageMode: "core" },
        warnings: [],
      }),
    });
  });
}

const SEARCH_URL =
  "/?mode=exact&trip=round-trip&origin=LIM&destination=BIO&departure=2026-06-08&return=2026-06-20&adults=1&children=0&infants=0&sort=cheapest&maxStops=1";

test("a mixed value keeps its figure in mono and the noun beside it out of it", async () => {
  await withDesktopPage(async ({ page }) => {
    await waitForFontsReady(page);

    /* «1 pasajero»: the figure is a figure and the word is a word. The whole
       field cannot go mono — that would be monospaced prose — nor stay sans,
       which is where this came from. */
    assert.equal(
      await isMonospaced(page, '[aria-label="Seleccionar pasajeros"] .fd-field-value .fd-mono'),
      true,
    );
    /* And the label beside it does not: if the whole control had moved to mono,
       this case would be passing for the wrong reason. */
    assert.equal(await isMonospaced(page, '[aria-label="Seleccionar pasajeros"] .fd-field-label'), false);

    const mixed = await page.evaluate(() => {
      const value = document.querySelector<HTMLElement>('[aria-label="Seleccionar pasajeros"] .fd-field-value');
      const figure = value?.querySelector<HTMLElement>(".fd-mono");
      return {
        text: value?.innerText ?? "",
        figure: figure?.textContent ?? "",
        figureWeight: figure ? getComputedStyle(figure).fontWeight : "",
        valueWeight: value ? getComputedStyle(value).fontWeight : "",
      };
    });
    /* The literal space between figure and noun: breaking the JSX across lines
       collapses it and prints «1pasajero». It has happened twice. */
    assert.match(mixed.text, /^1 pasajero$/);
    assert.equal(mixed.figure, "1");
    /* Every field value in the form is 600, and the figure claims no importance
       over the destination beside it. */
    assert.equal(mixed.figureWeight, "600");
    assert.equal(mixed.valueWeight, "600");
  });
});

test("the stay counter keeps its width from the ninth night to the tenth", async () => {
  await withDesktopPage(async ({ page }) => {
    await waitForFontsReady(page);
    await clickSegment(segment(page.getByRole("radiogroup", { name: "Modo de búsqueda" }), "Flexible"));
    const slot = page.locator(".fd-stay-value");
    await slot.waitFor();

    assert.equal(await isMonospaced(page, ".fd-stay-figure"), true);

    const remove = page.getByRole("button", { name: "Quitar noche" });
    const add = page.getByRole("button", { name: "Agregar noche" });
    for (let step = 0; step < 96 && !(await remove.isDisabled()); step += 1) {
      await remove.click();
    }

    const widths: Record<number, number> = {};
    for (let nights = 1; nights <= 12; nights += 1) {
      const box = await slot.boundingBox();
      assert.ok(box, `No box at ${nights} nights`);
      widths[nights] = Math.round(box.width * 100) / 100;
      if (nights < 12) await add.click();
    }

    /* The two-digit column is the only thing this case fixes: from the second
       night on, the slot does not move, and the jump it used to take on
       reaching the tenth — 60.9 to 68.1px — is gone. The first night is
       narrower because what changes there is the noun, not the figure. */
    for (let nights = 3; nights <= 12; nights += 1) {
      assert.ok(
        Math.abs(widths[nights] - widths[2]) <= 0.5,
        `The slot is ${widths[nights]}px at ${nights} nights and ${widths[2]}px at 2: ${JSON.stringify(widths)}`,
      );
    }

    const reservation = await page.evaluate(() => {
      const figure = document.querySelector<HTMLElement>(".fd-stay-figure");
      if (!figure) return null;
      const style = getComputedStyle(figure);
      const probe = document.createElement("span");
      probe.style.cssText = "position:absolute;top:-4000px;left:0;white-space:pre;";
      probe.textContent = "88";
      figure.appendChild(probe);
      const range = document.createRange();
      range.selectNodeContents(probe);
      const twoDigits = range.getBoundingClientRect().width;
      probe.remove();
      return { minWidth: Number.parseFloat(style.minWidth), twoDigits };
    });
    assert.ok(reservation, "No stay figure");
    /* `2ch` is the advance of two digits in the counter's own monospace, so
       this is asserted against the measurement rather than against a number
       written here. */
    assert.ok(
      Math.abs(reservation.minWidth - reservation.twoDigits) <= 0.5,
      `The reservation is ${reservation.minWidth}px and two digits measure ${reservation.twoDigits}px`,
    );
  });
});

test("the figure weight is a weight its font actually ships", async () => {
  await withDesktopPage(async ({ page }) => {
    await waitForFontsReady(page);
    const weights = await page.evaluate(async () => {
      const root = getComputedStyle(document.documentElement);
      /* Ask for the face before asking about it: `document.fonts` only knows
         what the page has needed to paint, and the idle screen paints mono at
         600 and nothing else. */
      await Promise.all([600, 700, 800].map((weight) =>
        document.fonts.load(`${weight} 22px "IBM Plex Mono"`, "0123456789").catch(() => undefined)));
      const monoFaces: number[] = [];
      document.fonts.forEach((face) => {
        if (face.family.includes("IBM Plex Mono") && face.status === "loaded") {
          monoFaces.push(Number.parseInt(face.weight, 10));
        }
      });
      return {
        figure: root.getPropertyValue("--fd-weight-figure").trim(),
        ceiling: monoFaces.length > 0 ? Math.max(...monoFaces) : null,
      };
    });

    /* IBM Plex Mono is static and stops at Bold: the 800 the plate gives every
       figure does not exist in this family, and the token asked for it anyway. */
    assert.equal(weights.figure, "700");
    if (weights.ceiling !== null) {
      assert.ok(
        Number(weights.figure) <= weights.ceiling,
        `The token asks for ${weights.figure} and the family stops at ${weights.ceiling}`,
      );
    }
  });
});

test("the counters of the results surface share one alphabet, one weight and one column", async () => {
  await withDesktopPage(async ({ page }) => {
    await waitForFontsReady(page);
    /*
     * The six counters live in five application states that never coincide on
     * one screen — list header, filter panel, filter sheet, phone strip and
     * month grid — so what is asserted here is the CSS contract: they are
     * mounted inside `.fd-shell` itself, under the same container queries as in
     * production, and the six spellings are checked to resolve to one thing.
     */
    const readings = await page.evaluate(() => {
      const shell = document.querySelector(".fd-shell")!;
      const host = document.createElement("div");
      host.style.cssText = "position:absolute;top:-4000px;left:0;width:320px;";
      host.innerHTML = `
        <span data-probe="header" class="fd-panel-count">386</span>
        <span data-probe="airline" class="fd-airline-row-count">12</span>
        <span data-probe="pill" class="fd-status-pill fd-status-pill-count">3</span>
        <span data-probe="strip" class="fd-filter-strip-count">3</span>
        <span data-probe="month" class="fd-count">12</span>
        <span data-probe="hidden" class="fd-count">8</span>`;
      shell.appendChild(host);
      const out: Record<string, { weight: string; monospaced: boolean }> = {};
      for (const node of host.querySelectorAll<HTMLElement>("[data-probe]")) {
        const style = getComputedStyle(node);
        const probe = document.createElement("span");
        probe.style.cssText = "position:absolute;top:-4000px;left:0;white-space:pre;";
        node.appendChild(probe);
        const inkOf = (text: string) => {
          probe.textContent = text;
          const range = document.createRange();
          range.selectNodeContents(probe);
          return range.getBoundingClientRect().width;
        };
        /* A monospace gives the "i" the same advance as the "m". */
        const monospaced = Math.abs(inkOf("iiiiiiii") - inkOf("mmmmmmmm")) < 0.5;
        probe.remove();
        out[node.dataset.probe!] = { weight: style.fontWeight, monospaced };
      }
      host.remove();
      return out;
    });

    for (const [name, reading] of Object.entries(readings)) {
      assert.equal(reading.monospaced, true, `The «${name}» counter is not painted in the monospace`);
      assert.equal(reading.weight, "700", `The «${name}» counter weighs ${reading.weight}`);
    }
  });
});

test("the phone's collapsed bar writes the same data in the same alphabet as the form", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await routeSingleOfferSearch(page);
    await openSharedSearchLink(page, `${baseUrl}${SEARCH_URL}`);
    await page.locator(".fd-mobile-search-summary").waitFor();
    await waitForFontsReady(page);

    /* It reads sans, it is touched, and the form it opens writes it in mono:
       the same data changing alphabet inside a single gesture. */
    assert.equal(await isMonospaced(page, ".fd-mobile-search-route > span"), true);
    assert.equal(await isMonospaced(page, ".fd-mobile-search-meta .fd-mono"), true);
    /* «Exacto» and «pasajero» are names and stay proportional: the lines that
       carry them did not move alphabet wholesale. */
    assert.equal(await isMonospaced(page, ".fd-mobile-search-meta"), false);

    const weights = await page.evaluate(() => {
      const meta = document.querySelector<HTMLElement>(".fd-mobile-search-meta");
      const figure = meta?.querySelector<HTMLElement>(".fd-mono");
      const aside = Array.from(document.querySelectorAll<HTMLElement>(".fd-mobile-search-trip"));
      return {
        line: meta ? getComputedStyle(meta).fontWeight : "",
        figure: figure ? getComputedStyle(figure).fontWeight : "",
        numeric: figure ? getComputedStyle(figure).fontVariantNumeric : "",
        text: meta?.innerText ?? "",
        aside: aside.map((node) => node.innerText.trim()),
        asideFigure: aside[0]?.querySelector<HTMLElement>(".fd-mono")
          ? getComputedStyle(aside[0].querySelector<HTMLElement>(".fd-mono")!).fontWeight
          : "",
        clips: (() => {
          const bar = document.querySelector<HTMLElement>(".fd-mobile-search-summary")!;
          return bar.scrollWidth > bar.clientWidth + 1
            || (meta ? meta.scrollWidth > meta.clientWidth + 1 : false);
        })(),
      };
    });
    assert.equal(weights.figure, "600");
    assert.equal(weights.asideFigure, "600");
    assert.equal(weights.numeric, "tabular-nums");
    /*
     * Two blocks, and the dates keep the left one to themselves. Plate 1d puts
     * the count and the mode in the width the two station codes leave over,
     * because on one line they did not fit: measured at 360 the single meta
     * line asked for 304px of a 262px box and «Exacto» was the word the
     * ellipsis ate. This used to read `/· 1 pasajero · Exacto$/` off the meta
     * line, which is the shape the plate replaces.
     */
    assert.match(weights.text, /^\d{2} \w{3} \d{4} – \d{2} \w{3} \d{4}$/);
    assert.deepEqual(weights.aside, ["1 pasajero", "Exacto"]);
    assert.equal(weights.clips, false);
  });
});

test("the phone's filter strip binds every icon size to the height of its control", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await routeSingleOfferSearch(page);
    await openSharedSearchLink(page, `${baseUrl}${SEARCH_URL}`);
    await page.locator(".fd-filter-strip .fd-active-chip").first().waitFor();

    const law = await page.evaluate(() => {
      const strip = document.querySelector<HTMLElement>(".fd-filter-strip")!;
      const read = (selector: string) => {
        const node = strip.querySelector<HTMLElement>(selector);
        if (!node) return null;
        const svg = node.querySelector("svg");
        return {
          height: Math.round(node.getBoundingClientRect().height * 10) / 10,
          icon: svg ? Math.round(svg.getBoundingClientRect().width * 10) / 10 : null,
        };
      };
      /* The cross's control is the chip around it, not the button: the cross
         declares no height of its own and the law binds the icon to the height
         of the control it lives in. */
      const chip = strip.querySelector<HTMLElement>(".fd-active-chip");
      const cross = strip.querySelector<HTMLElement>(".fd-active-chip-remove svg");
      return {
        floor: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--fd-control-touch")),
        rung: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--fd-icon-18")),
        filters: read(".fd-filter-strip-open"),
        cross: chip && cross
          ? {
              height: Math.round(chip.getBoundingClientRect().height * 10) / 10,
              icon: Math.round(cross.getBoundingClientRect().width * 10) / 10,
            }
          : null,
        copy: read(".fd-filter-strip-copy"),
      };
    });

    /* 7b: "each icon size is bound to a control height, so the icon is never
       chosen by taste". On a phone, 40 takes 18. */
    for (const name of ["filters", "cross", "copy"] as const) {
      const piece = law[name];
      assert.ok(piece, `The strip has no ${name}`);
      assert.equal(piece.height, law.floor, `«${name}» is ${piece.height} tall and the touch floor is ${law.floor}`);
      assert.equal(piece.icon, law.rung, `«${name}» draws a ${piece.icon} icon inside ${piece.height}`);
    }
  });
});

/*
 * 11 is the monospace's rung.
 *
 * `--fd-text-mono-meta` is the body the catalogue gives figures and specs *in
 * the monospace*; `--fd-text-meta` is the sans one beside it. Six sans lines
 * had taken the mono rung and were the smallest text in the product for a
 * reason nobody had written down — the detail's ladder, the row's «Horario por
 * confirmar», its «+n más» chip, the calendar's legend.
 *
 * The probes are mounted inside `.fd-shell`, under the same container queries
 * as in production, because these lines live in states that never coincide on
 * one screen. The family is measured and not read: `getComputedStyle` returns
 * the declared list, which says «IBM Plex Mono, ui-monospace» whether or not
 * anything monospaced was painted.
 */
test("the monospace's rung is not spent on sans text", async () => {
  await withDesktopPage(async ({ page }) => {
    await waitForFontsReady(page);

    const readings = await page.evaluate(() => {
      const shell = document.querySelector(".fd-shell")!;
      const host = document.createElement("div");
      host.style.cssText = "position:absolute;top:-4000px;left:0;width:420px;";
      host.innerHTML = `
        <span data-probe="rail" class="fd-rail-leg">2 h 15 min en BOG</span>
        <span data-probe="unknown" class="fd-card__leg-unknown">Horario por confirmar</span>
        <span data-probe="alts" class="fd-card__alts-more">+3 más</span>
        <span data-probe="legend" class="fd-cal-legend">Sin tarifa</span>
        <span data-probe="stops" class="fd-card__leg-stops">1 escala · BOG</span>
        <span data-probe="duration" class="fd-card__leg-duration">8h 05m</span>`;
      shell.appendChild(host);
      const out: Record<string, { size: string; monospaced: boolean }> = {};
      for (const node of host.querySelectorAll<HTMLElement>("[data-probe]")) {
        const probe = document.createElement("span");
        probe.style.cssText = "position:absolute;top:-4000px;left:0;white-space:pre;";
        node.appendChild(probe);
        const inkOf = (text: string) => {
          probe.textContent = text;
          const range = document.createRange();
          range.selectNodeContents(probe);
          return range.getBoundingClientRect().width;
        };
        const monospaced = Math.abs(inkOf("iiiiiiii") - inkOf("mmmmmmmm")) < 0.5;
        probe.remove();
        out[node.dataset.probe!] = { size: getComputedStyle(node).fontSize, monospaced };
      }
      host.remove();
      return out;
    });

    for (const name of ["rail", "unknown", "alts", "legend"] as const) {
      assert.equal(readings[name]!.monospaced, false, `«${name}» is painted in the monospace`);
      assert.equal(readings[name]!.size, "12px", `«${name}» is sans at ${readings[name]!.size}`);
    }

    /* The rung is not wrong, it is the monospace's — so the figure beside them
       keeps it. If this one had moved too, the four above would be passing for
       the wrong reason. */
    assert.equal(readings.duration!.monospaced, true);
    assert.equal(readings.duration!.size, "11px");

    /* And the one exception, asserted so it is a decision and not an oversight.
       The stops label is sans on the mono rung and stays there: «1 escala ·
       BOG» measures 75 at this body, that 75 is the floor `787` is derived
       from, and `useShellSize.ts` gives the detail column its margin out of the
       same label at 112. At 12 both thresholds rise and a 1440 desk — which
       measures exactly 824 against the 824 it needs — loses its third column.
       Moving it is a re-derivation of the row, not a typographic pass. */
    assert.equal(readings.stops!.monospaced, false);
    assert.equal(readings.stops!.size, "11px");
  });
});

/*
 * 7b again, on the surface the previous case's sibling covers for the filter
 * strip: an icon takes its size from the height of the control it sits in, and
 * on a phone every 40 takes 18.
 */
test("the airline row of the filter sheet binds its box to the 40 it lives in", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await routeSingleOfferSearch(page);
    await openSharedSearchLink(page, `${baseUrl}${SEARCH_URL}`);
    await page.getByTestId("result-card").first().waitFor();

    await page.getByRole("button", { name: "Abrir filtros" }).click();
    const sheet = page.locator(".fd-filter-sheet");
    await sheet.locator(".fd-airline-row").first().waitFor();

    const law = await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>(".fd-filter-sheet .fd-airline-row")!;
      const box = row.querySelector<HTMLElement>('[data-slot="checkbox"]')!;
      const logo = row.querySelector<HTMLElement>(".fd-airline-row-logo");
      const read = (node: Element | null) => node
        ? Math.round(node.getBoundingClientRect().width * 10) / 10
        : null;
      return {
        floor: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--fd-control-touch")),
        rung: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--fd-icon-18")),
        rowHeight: Math.round(row.getBoundingClientRect().height * 10) / 10,
        box: read(box),
        logo: read(logo),
      };
    });

    assert.equal(law.rowHeight, law.floor, `the row is ${law.rowHeight} tall against a touch floor of ${law.floor}`);
    assert.equal(law.box, law.rung, `the box is ${law.box} inside a control of ${law.rowHeight}`);
    /* The mark beside it was already at the rung; if it were not, the case
       above would be pinning half a row. */
    assert.equal(law.logo, law.rung);
  });
});

/*
 * The other half of the same row. On a desk it is `--fd-control-standard`, and
 * the table gives a 32 the 16 rung — which is exactly what the shared
 * `Checkbox` ships, so the desk is right for free and nothing in this
 * stylesheet says so. That is the whole reason for this case: the number is
 * held by a Tailwind utility on a component four other surfaces mount, and one
 * bump of that utility would break the law here with every rule in the repo
 * still reading as written.
 */
test("the same airline row takes the 16 its 32 asks for on a desk", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await routeSingleOfferSearch(page);
    await openSharedSearchLink(page, `${baseUrl}${SEARCH_URL}`);
    await page.getByTestId("result-card").first().waitFor();
    await page.locator(".fd-airline-row").first().waitFor();

    const law = await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>(".fd-airline-row")!;
      const box = row.querySelector<HTMLElement>('[data-slot="checkbox"]')!;
      const read = (node: Element) => Math.round(node.getBoundingClientRect().width * 10) / 10;
      const token = (name: string) =>
        Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
      return {
        standard: token("--fd-control-standard"),
        rung: token("--fd-icon-16"),
        inSheet: Boolean(row.closest(".fd-filter-sheet")),
        rowHeight: Math.round(row.getBoundingClientRect().height * 10) / 10,
        box: read(box),
      };
    });

    /* The desk's panel, not the phone's sheet under another name — otherwise
       this case and the one above would be measuring the same row twice. */
    assert.equal(law.inSheet, false);
    assert.equal(law.rowHeight, law.standard, `the row is ${law.rowHeight} tall against a standard of ${law.standard}`);
    assert.equal(law.box, law.rung, `the box is ${law.box} inside a control of ${law.rowHeight}`);
  });
});

/*
 * The same law on the surface where the sale is closed. The detail's action bar
 * is two 40px controls on a phone and one of them — «Cotizar», the one that
 * matters — was drawing a 16 icon inside its 40 while «Abrir» beside it, in the
 * same block of the same stylesheet, already read the 18.
 */
test("the detail's action bar binds both its icons to the 40 it is on a phone", async () => {
  await withDesktopPage(async ({ baseUrl, page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await routeSingleOfferSearch(page);
    await openSharedSearchLink(page, `${baseUrl}${SEARCH_URL}`);
    await page.getByTestId("result-card").first().click();
    await page.locator(".fd-detail-quote-action").waitFor();

    const bar = await page.evaluate(() => {
      const read = (selector: string) => {
        const node = document.querySelector<HTMLElement>(selector);
        const svg = node?.querySelector("svg");
        return node && svg
          ? {
              height: Math.round(node.getBoundingClientRect().height * 10) / 10,
              icon: Math.round(svg.getBoundingClientRect().width * 10) / 10,
            }
          : null;
      };
      return {
        floor: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--fd-control-touch")),
        rung: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--fd-icon-18")),
        quote: read(".fd-detail-quote-action"),
        provider: read(".fd-detail-provider-action"),
      };
    });

    for (const name of ["quote", "provider"] as const) {
      const control = bar[name];
      assert.ok(control, `The action bar has no ${name}`);
      assert.equal(control.height, bar.floor, `«${name}» is ${control.height} tall`);
      assert.equal(control.icon, bar.rung, `«${name}» draws a ${control.icon} icon inside ${control.height}`);
    }
  });
});

/*
 * The calendar's two literals, which were a 32 and a 40 that happened to equal
 * the catalogue rather than reading it. The sheet's 40 was already a token; the
 * desk's 32 is one now, and this is what says the substitution was of an
 * identical value. The legend beside it is the same sans-on-the-mono-rung fix
 * as the case above, asserted here on the real surface.
 */
test("the calendar cell is the catalogue's control and its legend is sans metadata", async () => {
  await withDesktopPage(async ({ page }) => {
    await waitForFontsReady(page);
    await page.getByRole("button", { name: /^Salida:/ }).click();
    const calendar = page.getByRole("dialog", { name: "Calendario de fechas" });
    await calendar.waitFor();
    await calendar.locator(".fd-cal-cell:not([data-blank='true'])").first().waitFor();

    const geometry = await page.evaluate(() => {
      const cell = document.querySelector<HTMLElement>(".fd-cal-cell:not([data-blank='true'])")!;
      const legend = document.querySelector<HTMLElement>(".fd-cal-legend");
      return {
        standard: getComputedStyle(document.documentElement).getPropertyValue("--fd-control-standard").trim(),
        cellHeight: getComputedStyle(cell).height,
        legendSize: legend ? getComputedStyle(legend).fontSize : null,
      };
    });

    assert.equal(geometry.standard, "32px");
    assert.equal(geometry.cellHeight, geometry.standard);
    assert.equal(geometry.legendSize, "12px");
  });
});
