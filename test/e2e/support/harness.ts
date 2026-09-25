import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { after, before, test, type TestContext } from "node:test";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
  type Response as PlaywrightResponse,
} from "playwright";
import { signIn, type ApiSession } from "./api-client.ts";
import { startFakeUpstream, type FakeOp, type FakeUpstream } from "./fake-upstream.ts";
import { isLoopbackHostname } from "./provider-origins.ts";
import { describeRequests, FALLBACK_OPS, TODAY } from "./scenario.ts";
import { startStack, type LogMark, type Stack, type StackOptions } from "./stack.ts";

/*
 * One spec file = one fake upstream, one stack and one browser, started in
 * `before` and stopped in `after`. Every test gets fresh browser contexts, a
 * reset fake, and — when it fails — screenshots, what every unit of the stack
 * wrote while it ran and the fake's request log under
 * `test-results/e2e/<spec>/<test>/`.
 */

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
export const RESULTS_ROOT = join(REPO_ROOT, "test-results", "e2e");
const DEFAULT_TEST_TIMEOUT_MS = 180_000;

export interface SuiteOptions {
  /** `import.meta.filename` of the spec: names its artifact folder. */
  file: string;
  stack?: Omit<StackOptions, "fakeUpstreamUrl">;
}

export interface TestOptions {
  timeout?: number;
  /** Keeps the test and reports its failure as a known gap instead of a failure. */
  todo?: string;
  /** Why the test cannot run here; it is reported as skipped. */
  skip?: string;
  /** Uncaught errors in the page fail the test unless this is set. */
  allowPageErrors?: boolean;
  /** Fallback operations (`FALLBACK_OPS`) the test exercises on purpose. */
  allowedFallbacks?: readonly FakeOp[];
}

export interface ContextOptions extends BrowserContextOptions {
  /** Signs the context in through the API and hands it the two cookies. */
  signedIn?: boolean;
  /** Clipboard read/write for the stack's origin. */
  clipboard?: boolean;
}

export interface ApiResponseRecord {
  url: string;
  status: number;
  body: string;
}

/** What a page asked of `/api/*`, in order. */
export interface ApiRequestRecord {
  at: number;
  method: string;
  url: string;
  body: string | null;
}

export interface PageRecord {
  page: Page;
  errors: string[];
  console: Array<{ type: string; text: string }>;
}

/** A `/r/<id>` answer a page received, recorded instead of followed. */
export interface RedirectRecord {
  from: string;
  status: number;
  location: string;
}

/* What a page shows in place of the provider site a `/r/<id>` points at. */
const REDIRECT_STUB = "<!doctype html><html lang=\"es\"><title>Redirect captured</title><p>E2E: provider redirect captured, not followed.</p></html>";

/* Chromium resolves no name but loopback: whatever a route cannot see — the
   target of a redirect is never routed — still cannot leave the machine. */
const BROWSER_ARGS = ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1"];

/** A browser context and everything it did. */
export class TrackedContext {
  readonly context: BrowserContext;
  readonly pages: PageRecord[] = [];
  /** Every `/api/*` answer any page of this context received. */
  readonly apiResponses: ApiResponseRecord[] = [];
  /** Every `/api/*` request any page of this context sent. */
  readonly apiRequests: ApiRequestRecord[] = [];
  /** Non-loopback URLs a page asked for; aborted before leaving the machine. */
  readonly blocked: string[] = [];
  /** Every `/r/<id>` answer, in order; a 3xx is recorded and not followed. */
  readonly redirects: RedirectRecord[] = [];
  #pendingBodies: Promise<void>[] = [];

  constructor(context: BrowserContext) {
    this.context = context;
    context.on("page", (page) => this.#watch(page));
    context.on("response", (response) => this.#record(response));
    context.on("request", (request) => {
      let pathname = "";
      try {
        pathname = new URL(request.url()).pathname;
      } catch {
        return;
      }
      if (pathname.startsWith("/api/")) {
        this.apiRequests.push({ at: Date.now(), method: request.method(), url: request.url(), body: request.postData() });
      }
    });
  }

  async newPage(): Promise<Page> {
    return this.context.newPage();
  }

  /**
   * Closes a tab the way a user does, `beforeunload` and `pagehide` included.
   *
   * The routes come off first: Playwright intercepts every request of a routed
   * context and drops the ones a closing page still has in flight, which is
   * exactly the cancellation beacon the page sends on its way out. The browser
   * keeps resolving nothing but loopback (`BROWSER_ARGS`), so nothing can leave
   * the machine while the routes are gone, and a `/r/<id>` is not asked for
   * during a close.
   */
  async closeTabAsUser(page: Page): Promise<void> {
    await this.context.unrouteAll({ behavior: "ignoreErrors" });
    await page.close({ runBeforeUnload: true });
  }

  record(page: Page): PageRecord {
    const found = this.pages.find((entry) => entry.page === page);
    assert.ok(found, "page does not belong to this context");
    return found;
  }

  /** Waits for the body reads still in flight, then returns every `/api/*` answer. */
  async apiBodies(): Promise<ApiResponseRecord[]> {
    await Promise.allSettled(this.#pendingBodies);
    return [...this.apiResponses];
  }

  pageErrors(): string[] {
    return this.pages.flatMap((entry) => entry.errors);
  }

  consoleText(): string {
    return this.pages.flatMap((entry) => entry.console.map((message) => `[${message.type}] ${message.text}`)).join("\n");
  }

  #watch(page: Page): void {
    const record: PageRecord = { page, errors: [], console: [] };
    this.pages.push(record);
    page.on("pageerror", (error) => record.errors.push(error.stack ?? error.message));
    page.on("console", (message) => record.console.push({ type: message.type(), text: message.text() }));
  }

  #record(response: PlaywrightResponse): void {
    let pathname: string;
    try {
      pathname = new URL(response.url()).pathname;
    } catch {
      return;
    }
    if (!pathname.startsWith("/api/")) {
      return;
    }
    this.#pendingBodies.push(response.text().then(
      (body) => {
        this.apiResponses.push({ url: response.url(), status: response.status(), body });
      },
      () => undefined,
    ));
  }
}

/** What one test owns: its contexts, and its artifacts if it fails. */
export class TestScope {
  readonly suite: Suite;
  readonly name: string;
  readonly contexts: TrackedContext[] = [];
  /** Where the stack's logs stood when the test began. */
  readonly logMark?: LogMark;

  constructor(suite: Suite, name: string, logMark?: LogMark) {
    this.suite = suite;
    this.name = name;
    this.logMark = logMark;
  }

  get fake(): FakeUpstream {
    return this.suite.fake;
  }

  get stack(): Stack {
    return this.suite.stack;
  }

  /** A signed-in API client through the front proxy. */
  api(): Promise<ApiSession> {
    return signIn(this.stack.baseUrl, this.stack.password);
  }

  /** A fresh context, signed in, with one page open on `path`. */
  async signedInPage(path = "/", options: ContextOptions = {}): Promise<{ tracked: TrackedContext; page: Page }> {
    const tracked = await this.newContext({ ...options, signedIn: true });
    const page = await tracked.newPage();
    await page.goto(`${this.stack.baseUrl}${path}`);
    return { tracked, page };
  }

  async newContext(options: ContextOptions = {}): Promise<TrackedContext> {
    const { signedIn, clipboard, ...contextOptions } = options;
    const context = await this.suite.browser.newContext({
      locale: "es-PE",
      timezoneId: "America/Lima",
      viewport: { width: 1440, height: 900 },
      ...contextOptions,
    });
    const tracked = new TrackedContext(context);
    this.contexts.push(tracked);
    /* The browser is outside the egress preload: anything that is not the
       stack is refused here, and a `/r/<id>` is asked without following its
       redirect, so the provider site it names is recorded rather than
       visited. */
    await context.route((url) => !isLoopbackHostname(url.hostname), (route) => {
      tracked.blocked.push(route.request().url());
      return route.abort("blockedbyclient");
    });
    await context.route((url) => isLoopbackHostname(url.hostname) && url.pathname.startsWith("/r/"), async (route) => {
      const answer = await route.fetch({ maxRedirects: 0 });
      tracked.redirects.push({
        from: route.request().url(),
        status: answer.status(),
        location: answer.headers().location ?? "",
      });
      if (answer.status() >= 300 && answer.status() < 400) {
        await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: REDIRECT_STUB });
        return;
      }
      await route.fulfill({ response: answer });
    });
    if (clipboard) {
      await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: this.stack.baseUrl });
    }
    if (signedIn) {
      await this.signInContext(tracked);
    }
    return tracked;
  }

  /** Hands a context the session and `/r` cookies of a fresh API sign-in. */
  async signInContext(tracked: TrackedContext): Promise<void> {
    const session = await this.api();
    const { hostname } = new URL(this.stack.baseUrl);
    await tracked.context.addCookies(session.cookies().map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: hostname,
      path: cookie.path,
      httpOnly: true,
      sameSite: "Lax" as const,
    })));
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.contexts.map((tracked) => tracked.context.close()));
  }

  async captureFailure(error: unknown): Promise<void> {
    const dir = join(RESULTS_ROOT, this.suite.specName, slug(this.name));
    try {
      mkdirSync(dir, { recursive: true });
      let index = 0;
      for (const tracked of this.contexts) {
        for (const record of tracked.pages) {
          index += 1;
          if (!record.page.isClosed()) {
            await record.page.screenshot({ path: join(dir, `page-${index}.png`), fullPage: true, timeout: 5_000 }).catch(() => undefined);
          }
        }
      }
      writeFileSync(join(dir, "error.txt"), error instanceof Error ? `${error.stack ?? error.message}` : String(error));
      /* Every unit's stdout and stderr, the pooled workers' stderr included,
         from the moment this test began. */
      writeFileSync(join(dir, "stack.log"), this.suite.stack?.logs(undefined, this.logMark) ?? "stack not started");
      writeFileSync(join(dir, "fake-requests.txt"), [
        describeRequests(this.suite.fake?.requests() ?? []),
        `blocked backend egress: ${JSON.stringify(this.suite.fake?.blocked ?? [])}`,
      ].join("\n"));
      writeFileSync(join(dir, "browser.txt"), this.contexts.map((tracked, contextIndex) => [
        `==== context ${contextIndex + 1}`,
        `pages: ${tracked.pages.map((record) => record.page.isClosed() ? "(closed)" : record.page.url()).join(" | ")}`,
        `page errors:\n${tracked.pageErrors().join("\n")}`,
        `console:\n${tracked.consoleText()}`,
        `blocked browser requests:\n${tracked.blocked.join("\n")}`,
      ].join("\n")).join("\n\n"));
    } catch (artifactError) {
      console.error(`[e2e] could not write failure artifacts to ${dir}:`, artifactError);
    }
  }
}

export class Suite {
  readonly specName: string;
  readonly options: SuiteOptions;
  fake!: FakeUpstream;
  stack!: Stack;
  browser!: Browser;

  constructor(options: SuiteOptions) {
    this.options = options;
    this.specName = basename(options.file).replace(/\.e2e\.ts$/, "");
  }

  test(name: string, run: (scope: TestScope, t: TestContext) => Promise<void>, options: TestOptions = {}): void {
    test(name, { timeout: options.timeout ?? DEFAULT_TEST_TIMEOUT_MS, todo: options.todo, skip: options.skip }, async (t) => {
      this.fake.reset();
      const scope = new TestScope(this, name, this.stack?.mark(`test: ${name}`));
      try {
        await run(scope, t);
        this.assertInvariants(scope, options);
      } catch (error) {
        await scope.captureFailure(error);
        throw error;
      } finally {
        await scope.close();
      }
    });
  }

  /* Holds for every test: nothing left the machine, no fallback path ran, no
     fixture broke, no page threw, and no answer a page received carried an
     offer's provider handles (`rawRefs`) or the backend's dedupe key
     (`signature`), which stay behind the backend boundary. */
  private assertInvariants(scope: TestScope, options: TestOptions): void {
    assert.deepEqual(this.fake.blocked, [], "a stack process tried to reach a host outside the fake upstream");
    const allowedFallbacks = options.allowedFallbacks ?? [];
    assert.deepEqual(
      this.fake.requests((request) => FALLBACK_OPS.includes(request.op) && !allowedFallbacks.includes(request.op))
        .map((request) => `${request.op} ${request.origin}${request.path}`),
      [],
      "a provider fallback path ran",
    );
    assert.deepEqual(this.fake.requests((request) => request.error !== undefined).map((request) => request.error), []);
    if (!options.allowPageErrors) {
      assert.deepEqual(scope.contexts.flatMap((tracked) => tracked.pageErrors()), [], "a page threw");
    }
    /* The answers read so far: a long poll still open when the test ends is left to the context's close. */
    assert.deepEqual(
      scope.contexts.flatMap((tracked) => tracked.apiResponses)
        .filter((answer) => /"(?:rawRefs|signature)"\s*:/.test(answer.body))
        .map((answer) => new URL(answer.url).pathname),
      [],
      "an /api answer carried an offer's provider handles",
    );
  }
}

export function defineSuite(options: SuiteOptions): Suite {
  const suite = new Suite(options);

  before(async () => {
    suite.fake = await startFakeUpstream();
    suite.stack = await startStack({ today: TODAY, ...options.stack, fakeUpstreamUrl: suite.fake.url });
    const channel = process.env.FLY_DESK_TEST_BROWSER_CHANNEL?.trim() || undefined;
    suite.browser = await chromium.launch({ channel, headless: true, args: BROWSER_ARGS });
  });

  after(async () => {
    await suite.browser?.close().catch(() => undefined);
    await suite.stack?.stop();
    await suite.fake?.close();
  });

  return suite;
}

function slug(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "test";
}
