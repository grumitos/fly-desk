import { chromium, type Browser, type Page } from "playwright";
import { cleanupPrefixedTempArtifacts, TEMP_ARTIFACT_SWEEP_MIN_AGE_MS } from "../../src/temp-artifacts";
import { withServer } from "./server";

export async function openDesktop(page: Page, baseUrl: string): Promise<void> {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.waitForSelector("#searchForm");
}

export async function setDateValue(page: Page, id: string, value: string): Promise<void> {
  await page.evaluate(([targetId, targetValue]) => {
    const input = document.getElementById(targetId) as HTMLInputElement | null;
    if (!input) {
      throw new Error(`Missing input ${targetId}`);
    }

    input.value = targetValue;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, [id, value]);
}

export async function withDesktopPage<T>(
  run: (context: { baseUrl: string; browser: Browser; page: Page }) => Promise<T>,
  options?: {
    autoOpen?: boolean;
    createPage?: (context: { baseUrl: string; browser: Browser }) => Promise<Page>;
  },
): Promise<T> {
  const autoOpen = options?.autoOpen ?? true;

  return withServer(async (baseUrl) => {
    await cleanupPrefixedTempArtifacts(undefined, { olderThanMs: TEMP_ARTIFACT_SWEEP_MIN_AGE_MS });
    const browser = await chromium.launch({ headless: true });
    const page = options?.createPage
      ? await options.createPage({ baseUrl, browser })
      : await browser.newPage();

    try {
      if (autoOpen) {
        await openDesktop(page, baseUrl);
      }

      return await run({ baseUrl, browser, page });
    } finally {
      await browser.close();
      await cleanupPrefixedTempArtifacts(undefined, { olderThanMs: TEMP_ARTIFACT_SWEEP_MIN_AGE_MS });
    }
  });
}
