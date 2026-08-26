import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { createScryptPasswordHash } from "../../src/web-auth.ts";
import { startTestServer, type ServerHandle } from "../helpers/server.ts";

/*
 * The gate is the one screen of this product that no pass over `frontend/`
 * reaches: it is a string in `src/web-auth.ts`, served before a bundle exists,
 * with a stylesheet of its own. So it needs a harness of its own too — the same
 * shape as `registerDesktopHarness`, but on a server with the gate switched on,
 * since `/login` redirects away whenever `FLY_DESK_WEB_AUTH` is not set.
 *
 * What is measured here is paint, not declarations. Both defects this file
 * covers were legal CSS that computed exactly as written; what was wrong was
 * where the pixels landed.
 */
let browser: Browser | undefined;
let server: ServerHandle | undefined;

before(async () => {
  server = await startTestServer({
    FLY_DESK_WEB_AUTH: "1",
    FLY_DESK_WEB_SESSION_SECRET: "login-ui-suite-session-secret-over-32-chars",
    FLY_DESK_WEB_PASSWORD_HASH: createScryptPasswordHash("login-ui-suite"),
  });

  try {
    browser = await chromium.launch({
      channel: process.env.FLY_DESK_TEST_BROWSER_CHANNEL?.trim() || undefined,
      headless: true,
    });
  } catch (error) {
    await server.stop();
    server = undefined;
    throw error;
  }
});

after(async () => {
  try {
    await browser?.close();
  } finally {
    await server?.stop();
    browser = undefined;
    server = undefined;
  }
});

async function withLoginPage<T>(
  viewport: { width: number; height: number },
  run: (page: Page) => Promise<T>,
): Promise<T> {
  if (!browser || !server) {
    throw new Error("The login test harness has not been started.");
  }

  /* One device pixel per CSS pixel, so a screenshot row is a CSS row and the
     numbers below are the ones the plates are written in. */
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    /* The gate asks Google for Inter. Nothing measured here comes from a font
       metric — every length below is a rung of 5b, declared — so the faces are
       refused rather than waited for, and the file stops depending on a CDN
       being reachable from wherever the suite is running. */
    await page.route("https://fonts.g*/**", (route) => route.abort());
    await page.goto(`${server.baseUrl}/login`, { waitUntil: "domcontentloaded" });
    await page.locator(".fd-button").waitFor();
    return await run(page);
  } finally {
    await context.close();
  }
}

/*
 * The painted colour of every row of one pixel column, read back through the
 * page itself: a screenshot is the only place a focus ring exists, since
 * neither an outline nor a box-shadow is part of any box the DOM will report.
 */
async function paintedColumn(
  page: Page,
  column: { top: number; bottom: number; x: number },
): Promise<string[]> {
  const shot = await page.screenshot();
  return await page.evaluate(async (probe) => {
    const image = new Image();
    image.src = probe.dataUrl;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("The probe canvas has no 2d context.");
    }

    context.drawImage(image, 0, 0);
    const rows: string[] = [];
    for (let y = probe.top; y < probe.bottom; y += 1) {
      const pixel = context.getImageData(probe.x, y, 1, 1).data;
      rows.push(`${pixel[0]},${pixel[1]},${pixel[2]}`);
    }
    return rows;
  }, { ...column, dataUrl: `data:image/png;base64,${shot.toString("base64")}` });
}

async function boxOf(page: Page, selector: string): Promise<{ bottom: number; centreX: number; top: number }> {
  return await page.evaluate((target) => {
    const node = document.querySelector(target);
    if (!node) {
      throw new Error(`No element matches ${target}`);
    }

    const box = node.getBoundingClientRect();
    return { bottom: Math.round(box.bottom), centreX: Math.round(box.left + box.width / 2), top: Math.round(box.top) };
  }, selector);
}

test("a focused control keeps its ring inside the gap it shares with its neighbour", async () => {
  await withLoginPage({ width: 1440, height: 960 }, async (page) => {
    const field = await boxOf(page, ".fd-field-control");
    const submit = await boxOf(page, ".fd-button");
    const gap = submit.top - field.bottom;

    /* The gap is the 10px the form declares. Asserted, because a gap that had
       silently gone to zero would make everything below pass by being empty. */
    assert.equal(gap, 10);

    const page_background = (await paintedColumn(page, {
      top: field.bottom + 2,
      bottom: field.bottom + 3,
      x: 8,
    }))[0];

    /* The field first: it is what `autofocus` lands on, so it is the ring the
       agent sees before touching anything. */
    await page.evaluate(() => document.getElementById("password")?.focus());
    assert.deepEqual(
      new Set(await paintedColumn(page, { top: field.bottom, bottom: submit.top, x: field.centreX })),
      new Set([page_background]),
    );

    /* Then the submit, reached the way `:focus-visible` asks to be reached. Its
       ring is the one that was 4px wide and took 4 of the 10. */
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), "BUTTON");
    assert.deepEqual(
      new Set(await paintedColumn(page, { top: field.bottom, bottom: submit.top, x: submit.centreX })),
      new Set([page_background]),
    );

    /*
     * And the ring is still drawn — inside. Without this the case above passes
     * for the wrong reason the moment a focus style stops being painted at all,
     * which is the cheapest way to keep ink out of a gap.
     */
    const insideSubmit = await paintedColumn(page, { top: submit.top, bottom: submit.top + 4, x: submit.centreX });
    const fill = await page.evaluate(() => getComputedStyle(document.querySelector(".fd-button")!).backgroundColor);
    const [ringRow, fillRow] = [insideSubmit[0], insideSubmit[3]];
    assert.notEqual(ringRow, fillRow);
    assert.equal(`rgb(${fillRow?.split(",").join(", ")})`, fill);
  });
});

test("the keyboard leaves nothing behind the fold at the reference phone", async () => {
  const KEYBOARD_OPEN = 400;
  const PHONE = 720;

  /* The directive is the whole fix: it is what makes the browser hand this page
     a layout viewport the size of what the keyboard leaves visible, instead of
     the full height of the phone. Neither height below is reachable without it. */
  await withLoginPage({ width: 360, height: KEYBOARD_OPEN }, async (page) => {
    assert.match(
      await page.evaluate(() => document.querySelector<HTMLMetaElement>('meta[name="viewport"]')?.content ?? ""),
      /interactive-widget=resizes-content/,
    );

    assert.equal(await page.evaluate(() => document.documentElement.clientHeight), KEYBOARD_OPEN);
    assert.equal(
      await page.evaluate(() => {
        const scroller = document.scrollingElement!;
        return scroller.scrollHeight - scroller.clientHeight;
      }),
      0,
    );
    /* The foot of the form, which is the half that used to go under the
       keyboard: the submit is what the agent has to reach to get in. */
    assert.ok((await boxOf(page, ".fd-button")).bottom <= KEYBOARD_OPEN);
  });

  /*
   * The same page in the box the layout viewport used to keep while the
   * keyboard was up. The card centres itself in 720 and the submit lands under
   * the fold — with 320px of layout viewport the visible area cannot reach.
   */
  await withLoginPage({ width: 360, height: PHONE }, async (page) => {
    assert.ok((await boxOf(page, ".fd-button")).bottom > KEYBOARD_OPEN);
  });
});

test("the square glyph control takes the rung of the column it is in", async () => {
  /*
   * 7b binds the size of a pictogram to the height of the control holding it.
   * The mobile column is 34 / 40 / 46 and its smallest rung takes 16, the same
   * as the 32 of its desktop twin; the 36 · 18 pair this page carried was read
   * off the retired 36 / 44 / 52 and had no row left in either table.
   */
  const glyph = (page: Page) => page.evaluate(() => {
    const cell = getComputedStyle(document.querySelector(".fd-capsule-cell")!);
    const icon = getComputedStyle(document.querySelector(".fd-capsule-cell svg")!);
    return { cell: cell.height, icon: icon.height, square: cell.width === cell.height };
  });

  await withLoginPage({ width: 1440, height: 960 }, async (page) => {
    assert.deepEqual(await glyph(page), { cell: "32px", icon: "16px", square: true });
  });
  await withLoginPage({ width: 360, height: 720 }, async (page) => {
    assert.deepEqual(await glyph(page), { cell: "34px", icon: "16px", square: true });
  });
});
