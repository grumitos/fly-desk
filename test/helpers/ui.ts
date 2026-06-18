import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupPrefixedTempArtifacts, TEMP_ARTIFACT_SWEEP_MIN_AGE_MS } from "../../src/temp-artifacts.ts";
import { startTestServer, type ServerHandle } from "./server.ts";

type DesktopHarness = {
  baseUrl: string;
  browser: Browser;
  server: ServerHandle;
};

let desktopHarness: DesktopHarness | undefined;

export async function openDesktop(page: Page, baseUrl: string): Promise<void> {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("combobox", { name: "Origen" }).waitFor();
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
  run: (context: { baseUrl: string; context: BrowserContext; page: Page }) => Promise<T>,
  options?: {
    autoOpen?: boolean;
    createPage?: (context: { baseUrl: string; context: BrowserContext }) => Promise<Page>;
  },
): Promise<T> {
  if (!desktopHarness) {
    throw new Error("Desktop test harness has not been started.");
  }

  const autoOpen = options?.autoOpen ?? true;
  const { baseUrl, browser } = desktopHarness;
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  const page = options?.createPage
    ? await options.createPage({ baseUrl, context })
    : await context.newPage();

  try {
    if (autoOpen) {
      await openDesktop(page, baseUrl);
    }

    return await run({ baseUrl, context, page });
  } catch (error) {
    const failureDir = join(process.cwd(), "test-results", "ui");
    mkdirSync(failureDir, { recursive: true });
    const screenshotPath = join(failureDir, `failure-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
    throw error;
  } finally {
    await context.close();
  }
}

export async function startDesktopTestHarness(): Promise<void> {
  if (desktopHarness) {
    return;
  }

  await cleanupPrefixedTempArtifacts(undefined, { olderThanMs: TEMP_ARTIFACT_SWEEP_MIN_AGE_MS });
  const server = await startTestServer();

  try {
    const browser = await chromium.launch({ headless: true });
    desktopHarness = {
      baseUrl: server.baseUrl,
      browser,
      server,
    };
  } catch (error) {
    await server.stop();
    throw error;
  }
}

export async function stopDesktopTestHarness(): Promise<void> {
  const harness = desktopHarness;
  desktopHarness = undefined;
  if (!harness) {
    return;
  }

  try {
    await harness.browser.close();
  } finally {
    try {
      await harness.server.stop();
    } finally {
      await cleanupPrefixedTempArtifacts(undefined, { olderThanMs: TEMP_ARTIFACT_SWEEP_MIN_AGE_MS });
    }
  }
}
