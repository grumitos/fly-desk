import assert from "node:assert/strict";
import { randomBytes, randomInt } from "node:crypto";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import {
  followSearchJob,
  openPurchasePath,
  purchasePathOf,
  searchOffers,
  searchPayloads,
  startSearch,
  type SearchJob,
} from "./support/api-client.ts";
import { runSearch } from "./support/flows.ts";
import { defineSuite, type TestScope, type TrackedContext } from "./support/harness.ts";
import type { OfferSpec } from "./support/fixtures.ts";
import { addMonths, day, eventually, locationUses, monthKey, querySqlite, TODAY, writeSqlite } from "./support/scenario.ts";
import { mintSession, readRedirectExpiry, readSessionStamps, REDIRECT_COOKIE, SESSION_COOKIE, type MintedSession } from "./support/sessions.ts";
import { isDarkTheme, login, searchForm, searchLink, signInThroughGate, topBar } from "./support/ui.ts";

/*
 * The session and the gate in front of the desk: a sliding window with a hard
 * cap, one way back to the gate, a front door that grants nothing to a client
 * that merely claims to be trusted or brings a cookie it made itself, and
 * purchase paths that only ever lead to the provider's own search.
 */

/* The product's floors (`src/web-auth.ts`): nothing shorter can be configured,
   so older sessions are minted instead of waited for. */
const TTL_SECONDS = 300;
const MAX_LIFETIME_SECONDS = 600;
const sessionEnv = {
  FLY_DESK_WEB_SESSION_TTL_SECONDS: String(TTL_SECONDS),
  FLY_DESK_WEB_SESSION_MAX_LIFETIME_SECONDS: String(MAX_LIFETIME_SECONDS),
};
const suite = defineSuite({
  file: import.meta.filename,
  stack: { serviceEnv: { web: sessionEnv, redirect: sessionEnv } },
});

const CUSCO: OfferSpec[] = [
  { outbound: ["LA2045 LIM-CUZ 05:40-07:05"], price: 142.8, baggage: { carryOn: true, checked: 0 } },
  { outbound: ["H2 5102 LIM-CUZ 06:25-07:50"], price: 118.4, baggage: { carryOn: true, checked: 0 }, gds: 1 },
];

/** A signed-out context holding a session minted with the given stamps; the browser keeps it for an hour whatever the stamps say. */
async function contextWithSession(scope: TestScope, minted: MintedSession): Promise<TrackedContext> {
  const tracked = await scope.newContext();
  const { hostname } = new URL(scope.stack.baseUrl);
  const expires = Math.floor(Date.now() / 1000) + 3600;
  await tracked.context.addCookies([
    { name: SESSION_COOKIE, value: minted.session, domain: hostname, path: "/", httpOnly: true, sameSite: "Lax", expires },
    { name: REDIRECT_COOKIE, value: minted.redirect, domain: hostname, path: "/r", httpOnly: true, sameSite: "Lax", expires },
  ]);
  return tracked;
}

/** Every `Set-Cookie` the stack sent to this context, as `name=value`. */
function recordSetCookies(tracked: TrackedContext): string[] {
  const seen: string[] = [];
  tracked.context.on("response", (response) => {
    void response.headersArray().then((headers) => {
      for (const header of headers) {
        if (header.name.toLowerCase() === "set-cookie") seen.push(header.value.split(";")[0]!);
      }
    }, () => undefined);
  });
  return seen;
}

async function cookieValue(tracked: TrackedContext, name: string): Promise<string | undefined> {
  return (await tracked.context.cookies()).find((cookie) => cookie.name === name)?.value;
}

suite.test("a theme chosen at the gate is the theme of the desk behind it", async (scope) => {
  const { stack } = scope;
  const tracked = await scope.newContext();
  const page = await tracked.newPage();
  await page.goto(`${stack.baseUrl}/`);
  await page.waitForURL((url) => url.pathname === "/login");
  assert.equal(await isDarkTheme(page), false);
  await login.themeToggle(page).click();
  assert.equal(await isDarkTheme(page), true);

  await signInThroughGate(page, stack.password);
  await page.waitForURL((url) => url.pathname === "/");
  await topBar.themeToggle(page).waitFor();
  assert.equal(await isDarkTheme(page), true, "the desk forgot the theme chosen at the gate");
  assert.equal(await topBar.themeToggle(page).getAttribute("aria-pressed"), "true");

  /* The server draws the gate in the same theme from the cookie it left. */
  const theme = (await tracked.context.cookies()).find((cookie) => cookie.name === "flydesk_theme")?.value;
  assert.equal(theme, "dark");
  const gate = await fetch(`${stack.baseUrl}/login`, { headers: { cookie: `flydesk_theme=${theme}` } });
  assert.match(await gate.text(), /<html lang="es" class="dark" data-theme="dark">/);
});

suite.test("working past half of the window re-issues both cookies from the same sign-in", async (scope) => {
  const { stack } = scope;
  const now = Date.now();
  const minted = mintSession(stack.sessionSecret, { issuedAtMs: now - 200_000, expiresAtMs: now + 100_000 });
  const tracked = await contextWithSession(scope, minted);
  const setCookies = recordSetCookies(tracked);
  const page = await tracked.newPage();

  const shell = await page.goto(`${stack.baseUrl}/`);
  assert.equal(new URL(page.url()).pathname, "/", "a session with 100 s left was refused");
  const renewed = (await shell!.headersArray()).filter((header) => header.name.toLowerCase() === "set-cookie").map((header) => header.value);
  const sessionCookie = renewed.find((value) => value.startsWith(`${SESSION_COOKIE}=`));
  const redirectCookie = renewed.find((value) => value.startsWith(`${REDIRECT_COOKIE}=`));
  assert.ok(sessionCookie && redirectCookie, "loading the desk past half of the window did not re-issue both cookies");

  const stamps = readSessionStamps(sessionCookie.split(";")[0]!.slice(SESSION_COOKIE.length + 1));
  assert.ok(stamps);
  assert.equal(stamps.issuedAtMs, minted.issuedAtMs, "the renewal moved the sign-in stamp");
  assert.ok(Math.abs(stamps.expiresAtMs - (Date.now() + TTL_SECONDS * 1000)) < 10_000, "the renewed window is not a fresh TTL");
  assert.match(sessionCookie, /Path=\//);
  assert.equal(readRedirectExpiry(redirectCookie.split(";")[0]!.slice(REDIRECT_COOKIE.length + 1)), stamps.expiresAtMs, "the /r cookie outlives the session");
  assert.match(redirectCookie, /Path=\/r/);
  assert.equal(await cookieValue(tracked, SESSION_COOKIE), sessionCookie.split(";")[0]!.slice(SESSION_COOKIE.length + 1));

  /* Once renewed, the next requests carry no cookie at all. */
  const renewals = setCookies.length;
  await searchForm.location(page, "Origen").fill("lim");
  await searchForm.suggestion(page, "LIM").waitFor();
  assert.equal(setCookies.length, renewals, "a request early in the new window wrote a cookie");
});

suite.test("a session at its cap sends a busy desk to the gate once, carrying the search it was on", async (scope) => {
  const { fake, stack } = scope;
  const fresh = Date.now();
  const tracked = await contextWithSession(scope, mintSession(stack.sessionSecret, { issuedAtMs: fresh, expiresAtMs: fresh + TTL_SECONDS * 1000 }));
  const setCookies = recordSetCookies(tracked);
  const page = await tracked.newPage();
  const gateVisits: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame() && new URL(frame.url()).pathname === "/login") gateVisits.push(frame.url());
  });

  /* A sweep of two months keeps two polls in flight; every provider holds. */
  fake.hold("*", (request) => request.op === "agil.search" || request.op === "cbplus.search");
  const months = [monthKey(TODAY), addMonths(monthKey(TODAY), 1)];
  await page.goto(`${stack.baseUrl}${searchLink({ mode: "migration", trip: "one-way", origin: "LIM", destination: "CUZ", months })}`);
  await searchForm.submit(page).waitFor();

  /* The desk is on screen; now its session becomes one signed in almost ten
     minutes ago, whose cap falls in four seconds — and no amount of polling
     may push it back. */
  const capAtMs = Date.now() + 4_000;
  const capped = mintSession(stack.sessionSecret, { issuedAtMs: capAtMs - MAX_LIFETIME_SECONDS * 1000, expiresAtMs: capAtMs });
  const { hostname } = new URL(stack.baseUrl);
  const expires = Math.floor(Date.now() / 1000) + 3600;
  await tracked.context.addCookies([
    { name: SESSION_COOKIE, value: capped.session, domain: hostname, path: "/", httpOnly: true, sameSite: "Lax", expires },
    { name: REDIRECT_COOKIE, value: capped.redirect, domain: hostname, path: "/r", httpOnly: true, sameSite: "Lax", expires },
  ]);
  await runSearch(page);
  const searchPath = `${new URL(page.url()).pathname}${new URL(page.url()).search}`;
  assert.match(searchPath, /months=/);

  await page.waitForURL((url) => url.pathname === "/login", { timeout: 40_000 });
  assert.ok(Date.now() >= capAtMs, "sent to the gate before the cap");
  assert.equal(new URL(page.url()).searchParams.get("next"), searchPath, "the gate lost the search the desk was on");
  /* The polls that also got their 401 do not navigate again. */
  await login.password(page).waitFor();
  assert.equal(gateVisits.length, 1, `the desk went to the gate ${gateVisits.length} times`);
  const extended = setCookies
    .filter((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`))
    .map((cookie) => readSessionStamps(cookie.slice(SESSION_COOKIE.length + 1))?.expiresAtMs ?? Number.POSITIVE_INFINITY)
    .filter((expiresAtMs) => expiresAtMs > capAtMs);
  assert.deepEqual(extended, [], "a renewal pushed the session past its cap");

  /* Signing in again lands on the search the desk was on. */
  await signInThroughGate(page, stack.password);
  await page.waitForURL((url) => url.pathname === "/" && url.search === new URL(searchPath, stack.baseUrl).search);
  await searchForm.months(page).waitFor();
});

suite.test("signing out clears both cookies, and a purchase path no longer opens", async (scope) => {
  const { fake, stack } = scope;
  fake.setFlights("both", { origin: "LIM", destination: "CUZ" }, CUSCO);
  const api = await scope.api();
  const { job } = await followSearchJob(api, await startSearch(api, searchPayloads.exact("LIM", "CUZ", day(90))));
  const path = purchasePathOf(searchOffers(job)[0]!);
  assert.equal((await openPurchasePath(api, path)).response.status, 302);

  const { tracked, page } = await scope.signedInPage("/");
  assert.ok(await cookieValue(tracked, SESSION_COOKIE) && await cookieValue(tracked, REDIRECT_COOKIE));
  const out = await page.request.post(`${stack.baseUrl}/logout`, { maxRedirects: 0 });
  assert.equal(out.status(), 303);
  assert.equal(out.headers().location, "/login");
  assert.equal(await cookieValue(tracked, SESSION_COOKIE), undefined, "the session cookie survived the sign-out");
  assert.equal(await cookieValue(tracked, REDIRECT_COOKIE), undefined, "the /r cookie survived the sign-out");

  await page.goto(`${stack.baseUrl}${path}`);
  assert.deepEqual(tracked.redirects.map((entry) => entry.status), [401], "the purchase path opened after the sign-out");
  await page.goto(`${stack.baseUrl}/`);
  await page.waitForURL((url) => url.pathname === "/login");
});

/* ---- Hostile clients, over plain HTTP through the front proxy ---- */

/* Documentation ranges, one per test, so a client one test locks out is
   never a client another test signs in with. */
function clientAddress(network: "198.51.100" | "203.0.113"): string {
  return `${network}.${randomInt(1, 255)}`;
}

async function formLogin(scope: TestScope, password: string, options: { client?: string; next?: string } = {}): Promise<Response> {
  const body = new URLSearchParams({ password, ...(options.next === undefined ? {} : { next: options.next }) });
  return fetch(`${scope.stack.baseUrl}/login`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(options.client ? { "x-fly-desk-login-client-ip": options.client } : {}),
    },
    body,
  });
}

suite.test("the sixth failed sign-in of a client is refused with Retry-After, and nobody else pays for it", async (scope) => {
  const { stack } = scope;
  /* The edge stamps each client's address (Pages, `x-fly-desk-login-client-ip`). */
  const attacker = clientAddress("198.51.100");
  let bystander = clientAddress("198.51.100");
  while (bystander === attacker) bystander = clientAddress("198.51.100");

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const wrong = await formLogin(scope, `${stack.password}-${attempt}`, { client: attacker });
    assert.equal(wrong.status, 303, `attempt ${attempt}`);
    assert.equal(new URL(wrong.headers.get("location") ?? "", stack.baseUrl).searchParams.get("error"), "1");
  }
  const refused = await formLogin(scope, `${stack.password}-6`, { client: attacker });
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get("retry-after")) > 0, "no Retry-After on the refusal");
  const refusedRight = await formLogin(scope, stack.password, { client: attacker });
  assert.equal(refusedRight.status, 429, "the right password got through a closed door");
  const refusedJson = await fetch(`${stack.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-fly-desk-login-client-ip": attacker },
    body: JSON.stringify({ password: stack.password }),
  });
  assert.equal(refusedJson.status, 429);

  const welcome = await formLogin(scope, stack.password, { client: bystander });
  assert.equal(welcome.status, 303);
  assert.equal(welcome.headers.get("location"), "/");
  assert.ok(welcome.headers.getSetCookie().some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`)));
  const bystanderMistake = await formLogin(scope, "not-the-password", { client: bystander });
  assert.equal(bystanderMistake.status, 303, "another client inherited the lockout");
});

suite.test("a hostile return path lands on the desk and never leaves the origin", async (scope) => {
  const { stack } = scope;
  for (const next of [
    "//evil.com", "/.//evil.com", "/..//evil.com", "/%2e//evil.com", "https://evil.com", "/\\evil.com", "/\\/evil.com",
    "javascript:alert(1)", "relative/path", "/login",
  ]) {
    const gate = await fetch(`${stack.baseUrl}/login?next=${encodeURIComponent(next)}`, { redirect: "manual" });
    assert.equal(gate.status, 200, next);
    assert.doesNotMatch(await gate.text(), /name="next"/, `the gate carried ${next}`);
    const signedIn = await formLogin(scope, stack.password, { client: clientAddress("203.0.113"), next });
    assert.equal(signedIn.status, 303, next);
    assert.equal(signedIn.headers.get("location"), "/", `${next} sent the sign-in to ${signedIn.headers.get("location")}`);
  }
});

suite.test("a return path with markup in it is kept as text by the gate and handed back whole", async (scope) => {
  const { stack } = scope;
  const query = "\"><script>alert(1)</script>";
  const next = `/?origin=${encodeURIComponent(query)}`;
  const gate = await fetch(`${stack.baseUrl}/login?next=${encodeURIComponent(next)}`, { redirect: "manual" });
  assert.equal(gate.status, 200);
  const html = await gate.text();
  assert.match(html, /name="next"/, "the gate dropped a return path on this origin");
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>|"><script>/, "the gate wrote the return path out as markup");

  const signedIn = await formLogin(scope, stack.password, { client: clientAddress("203.0.113"), next });
  assert.equal(signedIn.status, 303);
  const landed = new URL(signedIn.headers.get("location") ?? "", stack.baseUrl);
  assert.equal(landed.origin, new URL(stack.baseUrl).origin);
  assert.equal(landed.pathname, "/");
  assert.equal(landed.searchParams.get("origin"), query, "the return path did not come back whole");
});

suite.test("a session cookie that was forged, altered, expired or issued in the old format opens nothing", async (scope) => {
  const { fake, stack } = scope;
  fake.setFlights("both", { origin: "LIM", destination: "CUZ" }, CUSCO);
  const api = await scope.api();
  const { job } = await followSearchJob(api, await startSearch(api, searchPayloads.exact("LIM", "CUZ", day(99))));
  const path = purchasePathOf(searchOffers(job)[0]!);
  assert.equal((await openPurchasePath(api, path)).response.status, 302);

  const now = Date.now();
  const stamps = { issuedAtMs: now - 1_000, expiresAtMs: now + 120_000 };
  const genuine = mintSession(stack.sessionSecret, stamps);
  const tamper = (value: string, part: number, change: (field: string) => string) =>
    value.split(".").map((field, index) => (index === part ? change(field) : field)).join(".");
  const flip = (signature: string) => `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
  const later = (stamp: string) => String(Number(stamp) + 86_400_000);
  const foreign = mintSession(randomBytes(32).toString("base64url"), stamps);
  const expired = mintSession(stack.sessionSecret, { issuedAtMs: now - 200_000, expiresAtMs: now - 1_000 });
  const [, , sessionExpiry, sessionNonce, sessionSignature] = genuine.session.split(".");
  const forgeries: Array<[string, { session: string; redirect: string }]> = [
    ["signed with another secret", foreign],
    ["with its expiry pushed back", { session: tamper(genuine.session, 2, later), redirect: tamper(genuine.redirect, 1, later) }],
    ["with its signature altered", { session: tamper(genuine.session, 4, flip), redirect: tamper(genuine.redirect, 3, flip) }],
    ["past its expiry", expired],
    ["in the old v1 shape", { session: ["v1", sessionExpiry, sessionNonce, sessionSignature].join("."), redirect: expired.redirect }],
  ];

  const open = (cookie: string, target: string) => fetch(`${stack.baseUrl}${target}`, { headers: { cookie }, redirect: "manual" });
  assert.equal((await open(`${SESSION_COOKIE}=${genuine.session}`, "/")).status, 200, "the genuine session was refused");
  assert.equal((await open(`${SESSION_COOKIE}=${genuine.session}`, "/api/diagnostics")).status, 200);
  assert.equal((await open(`${REDIRECT_COOKIE}=${genuine.redirect}`, path)).status, 302, "the genuine /r cookie was refused");
  for (const [label, forged] of forgeries) {
    const desk = await open(`${SESSION_COOKIE}=${forged.session}`, "/");
    assert.equal(desk.status, 302, `a session ${label} opened the desk`);
    assert.match(desk.headers.get("location") ?? "", /^\/login\b/, `a session ${label} was not sent to the gate`);
    assert.equal((await open(`${SESSION_COOKIE}=${forged.session}`, "/api/diagnostics")).status, 401, `a session ${label} reached the API`);
    assert.equal((await open(`${REDIRECT_COOKIE}=${forged.redirect}`, path)).status, 401, `a /r cookie ${label} opened a purchase path`);
  }
});

suite.test("the shell and the gate answer with their security headers", async (scope) => {
  const { stack } = scope;
  const api = await scope.api();
  for (const [label, response] of [
    ["the gate", await fetch(`${stack.baseUrl}/login`, { redirect: "manual" })],
    ["the desk", await api.fetch("/")],
  ] as const) {
    assert.equal(response.status, 200, label);
    const csp = response.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'self'/, `${label}: CSP`);
    assert.match(csp, /frame-ancestors 'none'/, `${label}: CSP`);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", label);
    assert.equal(response.headers.get("x-frame-options"), "DENY", label);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer", label);
    assert.equal(response.headers.get("cache-control"), "no-store", label);
  }
});

suite.test("without a session nothing reaches a provider, and headers claiming trust grant none", async (scope) => {
  const { fake, stack } = scope;
  fake.setFlights("both", { origin: "LIM", destination: "CUZ" }, CUSCO);
  const spoofed = {
    "x-flydesk-client-loopback": "1",
    "x-flydesk-client-address": "127.0.0.1",
    "x-flydesk-api-token": "forged-token",
    "x-flydesk-search-proxy": "1",
    "x-fly-desk-login-client-ip": "127.0.0.1",
    "x-forwarded-for": "127.0.0.1",
  };
  const search = JSON.stringify(searchPayloads.exact("LIM", "CUZ", day(95)));
  for (const headers of [{}, spoofed]) {
    const attempts: Array<[string, Response]> = [
      ["search", await fetch(`${stack.baseUrl}/api/search`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: search })],
      ["matrix", await fetch(`${stack.baseUrl}/api/matrix`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(searchPayloads.matrix("LIM", "CUZ", day(95), day(96), 7)) })],
      ["locations", await fetch(`${stack.baseUrl}/api/locations?q=lim`, { headers })],
      ["provider status", await fetch(`${stack.baseUrl}/api/provider-status`, { headers })],
      ["quotation", await fetch(`${stack.baseUrl}/api/quotation`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" })],
      ["diagnostics", await fetch(`${stack.baseUrl}/api/diagnostics`, { headers })],
    ];
    for (const [label, response] of attempts) {
      assert.equal(response.status, 401, `${label} with ${Object.keys(headers).length ? "spoofed headers" : "no session"}`);
    }
  }
  /* Diagnostics take the credentials the rest of the API takes; the Click and
     Book Plus token status is retired, and answers nobody. */
  const api = await scope.api();
  const diagnostics = await api.fetch("/api/diagnostics");
  assert.equal(diagnostics.status, 200, "diagnostics refused a session");
  assert.equal((await diagnostics.json() as { ok?: unknown }).ok, true);
  for (const [label, retired] of [
    ["no session", await fetch(`${stack.baseUrl}/api/costamar/token-status`)],
    ["spoofed headers", await fetch(`${stack.baseUrl}/api/costamar/token-status`, { headers: spoofed })],
    ["a session", await api.fetch("/api/costamar/token-status")],
  ] as const) {
    assert.equal(retired.status, 404, `the retired token status answered ${label}`);
  }
  assert.deepEqual(fake.requests().map((request) => request.op), [], "an unauthenticated request reached a provider");

  /* A signed-in search that claims to be the web unit's own delegation is
     still counted by the web unit: the claim is stripped at the door. */
  const before = locationUses(stack.appDataDir);
  const claimed = await api.fetch("/api/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-flydesk-search-proxy": "1" },
    body: JSON.stringify(searchPayloads.exact("LIM", "CUZ", day(96))),
  });
  assert.equal(claimed.status, 200);
  const { job } = await followSearchJob(api, await claimed.json() as SearchJob);
  assert.equal(job.searchStatus, "completed");
  const after = locationUses(stack.appDataDir);
  assert.equal((after.get("origin:LIM") ?? 0) - (before.get("origin:LIM") ?? 0), 1, "a search claiming to be delegated went uncounted");
  assert.equal((after.get("destination:CUZ") ?? 0) - (before.get("destination:CUZ") ?? 0), 1);
});

suite.test("provider addresses sent by a client are ignored and nothing leaves for them", async (scope) => {
  const { fake } = scope;
  fake.setFlights("both", { origin: "LIM", destination: "CUZ" }, CUSCO);
  const api = await scope.api();
  const hostile = "https://provider.evil.example";
  const started = await startSearch(api, searchPayloads.exact("LIM", "CUZ", day(97), undefined, {
    extra: { providerConfig: { costamar: { apiBaseUrl: hostile, brandBaseUrl: hostile, engineBaseUrl: hostile, markupBaseUrl: hostile } } },
  }));
  const { job } = await followSearchJob(api, started);
  assert.equal(job.searchStatus, "completed");
  assert.equal(searchOffers(job).filter((offer) => offer.providerSource === "costamar").length, 2);
  assert.ok(fake.requests("cbplus").every((request) => request.origin.endsWith(".zdev.tech")), "a Click and Book Plus call left for another host");
  const cbplusOffer = searchOffers(job).find((offer) => offer.providerSource === "costamar")!;
  const { response } = await openPurchasePath(api, purchasePathOf(cbplusOffer));
  assert.equal(response.status, 302);
  assert.equal(new URL(response.headers.get("location") ?? "").host, "flights.zdev.tech");
  /* `assertInvariants` also holds: no process tried to reach anything else. */
});

suite.test("a purchase path altered in the cache never sends the browser off the provider's own search", async (scope) => {
  const { fake, stack } = scope;
  fake.setFlights("cbplus", { origin: "LIM", destination: "CUZ" }, CUSCO);
  const api = await scope.api();
  const { job } = await followSearchJob(api, await startSearch(api, searchPayloads.exact("LIM", "CUZ", day(94))));
  const path = purchasePathOf(searchOffers(job).find((offer) => offer.providerSource === "costamar")!);
  assert.equal((await openPurchasePath(api, path)).response.status, 302);

  /* The stored row is all that stands between `/r/<id>` and the browser. */
  const dbPath = join(stack.appDataDir, "fly-desk-cache.sqlite");
  const id = decodeURIComponent(path.slice("/r/".length));
  const [row] = querySqlite<{ payload: string }>(dbPath, "SELECT payload FROM purchase_paths WHERE id = ?", [id]);
  assert.ok(row, "the purchase path was not stored");
  const stored = JSON.parse(row.payload) as { path: { url: string } };
  const genuine = new URL(stored.path.url);
  assert.equal(genuine.host, "flights.zdev.tech");
  const route = `${genuine.pathname}${genuine.search}`;
  for (const [label, url] of [
    ["another host", `https://provider.evil.example${route}`],
    ["a look-alike host", `https://flights.zdev.tech.evil.example${route}`],
    ["plain HTTP", `http://flights.zdev.tech${route}`],
    ["credentials in the address", `https://user:secret@flights.zdev.tech${route}`],
  ] as const) {
    writeSqlite(dbPath, [{
      sql: "UPDATE purchase_paths SET payload = ? WHERE id = ?",
      params: [JSON.stringify({ ...stored, path: { ...stored.path, url } }), id],
    }]);
    const { response } = await openPurchasePath(api, path);
    assert.equal(response.status, 409, `${label}: answered ${response.status}`);
    assert.equal(response.headers.get("location"), null, `${label}: redirected to ${response.headers.get("location")}`);
    await response.body?.cancel();
  }
});

/**
 * Sends the headers of an upload that declares `bytes` and none of its body,
 * and resolves with the answer.
 */
function declareUpload(url: string, bytes: number, headers: Record<string, string>): Promise<{ status: number; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(url, { method: "POST", agent: false, headers: { ...headers, "content-length": String(bytes) } }, (incoming) => {
      incoming.resume();
      resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers });
      outgoing.destroy();
    });
    outgoing.on("error", reject);
    outgoing.flushHeaders();
  });
}

suite.test("an oversized body is refused at once, by the proxy and by the web unit itself", async (scope) => {
  const { fake, stack } = scope;
  const api = await scope.api();
  const headers = { "content-type": "application/json", cookie: api.cookieHeader("/api/search") };
  const body = JSON.stringify({ padding: "x".repeat(2 * 1024 * 1024) });

  /* The proxy counts what arrives, as Caddy's body limit does: the whole
     upload goes, and the refusal comes past its first megabyte. */
  let startedAt = Date.now();
  const atTheProxy = await fetch(`${stack.baseUrl}/api/search`, { method: "POST", headers, body });
  assert.equal(atTheProxy.status, 413, "through the proxy");
  assert.ok(Date.now() - startedAt < 3_000, `through the proxy: the refusal took ${Date.now() - startedAt} ms`);

  /* The web unit refuses on the declared length, before a byte of the body,
     and closes the connection. Only the declaration is sent: the close does
     not wait for an upload, so a client still sending one mostly reads a reset
     instead of the 413. */
  startedAt = Date.now();
  const atTheWebUnit = await declareUpload(`${stack.urls.web}/api/search`, Buffer.byteLength(body), headers);
  assert.equal(atTheWebUnit.status, 413, "at the web unit");
  assert.ok(Date.now() - startedAt < 3_000, `at the web unit: the refusal took ${Date.now() - startedAt} ms`);
  assert.equal(atTheWebUnit.headers.connection, "close");
  assert.deepEqual(fake.requests().map((request) => request.op), []);
});

suite.test("a forged quotation request is refused without asking a provider", async (scope) => {
  const { fake } = scope;
  fake.setFlights("both", { origin: "LIM", destination: "CUZ" }, CUSCO);
  const api = await scope.api();
  const { job } = await followSearchJob(api, await startSearch(api, searchPayloads.exact("LIM", "CUZ", day(98))));
  const callsBefore = fake.requests().length;
  const quote = (body: string) => api.fetch("/api/quotation", { method: "POST", headers: { "content-type": "application/json" }, body });
  assert.equal((await quote("{}")).status, 400);
  assert.equal((await quote(JSON.stringify({ searchSessionId: job.searchJobId }))).status, 400);
  assert.equal((await quote("{not json")).status, 400);
  assert.equal((await quote(JSON.stringify({ searchSessionId: "00000000-0000-4000-8000-000000000000", offerId: "forged" }))).status, 404);
  assert.equal((await quote(JSON.stringify({ searchSessionId: job.searchJobId, offerId: "forged-offer" }))).status, 404);
  assert.equal(fake.requests().length, callsBefore, "a forged quotation reached a provider");
});
