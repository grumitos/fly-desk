import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/*
 * Boots a release the way the platform does, before it ships: the artifact
 * unpacked into an empty directory, its prepare hook run with only the build
 * user's environment, and the web, search and redirect units started from it
 * as their systemd units start them. Then it asks what only a working release
 * answers: each unit's health, a sign-in, the shell with its runtime settings
 * and one of its assets. The environment carries what a production file may:
 * a date override production must ignore, and settings left empty that must
 * keep their defaults. What the platform relies on is checked as well: the
 * capabilities the release declares to it, and that the release cannot fetch a
 * package it does not carry.
 *
 *   bun scripts/release-smoke.ts <fly-desk.tar.gz>
 *
 * Nothing here reaches a provider: prewarm is off and no search is run. The
 * units never outlive the smoke: they are stopped when it passes, fails, runs
 * past its deadline or is interrupted.
 */

type Unit = "runner" | "web" | "redirect";

const SMOKE_TIMEOUT_MS = 120_000;
const HEALTH_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 10_000;
/* The platform's PATH for the prepare hook (`vps-app-release.sh`). */
const BUILDER_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
/* What a Bun process needs from a Windows host; nothing else is inherited. */
const WINDOWS_HOST_ENV = ["SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT"];
const DEFAULT_SEARCH_MAX_FUTURE_DAYS = 365;
const DEFAULT_MIGRATION_CONCURRENT_MONTHS = 2;
const DEFAULT_WEB_SESSION_TTL_SECONDS = 12 * 60 * 60;
/* What a release may declare in `deploy/release-capabilities`, one name a line
   (`docs/DEPLOY_APP.md`, "Release Capabilities"), and the most the file weighs. */
const KNOWN_RELEASE_CAPABILITIES: ReadonlySet<string> = new Set(["cbplus-token-file"]);
const RELEASE_CAPABILITIES_MAX_BYTES = 1024;

const artifactArgument = process.argv[2];
if (!artifactArgument || !existsSync(artifactArgument)) {
  console.error("Usage: bun scripts/release-smoke.ts <fly-desk.tar.gz>");
  process.exit(2);
}
const artifact = resolve(artifactArgument);
const bun = process.execPath;
const root = mkdtempSync(join(tmpdir(), "fly-desk-release-smoke-"));
const app = join(root, "app");
const home = join(root, "home");
const state = join(root, "state");
const scratch = join(root, "tmp");
for (const dir of [home, state, scratch]) {
  mkdirSync(dir, { recursive: true });
}

const hostEnv: Record<string, string> = process.platform === "win32"
  ? Object.fromEntries(["PATH", ...WINDOWS_HOST_ENV].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]]))
  : { PATH: BUILDER_PATH };
const baseEnv: Record<string, string> = { ...hostEnv, HOME: home, TMPDIR: scratch, TEMP: scratch, TMP: scratch };

const children = new Map<Unit, ChildProcess>();
const logs = new Map<Unit, string[]>();
const passed: string[] = [];

/* The last resort, for an exit that skips the orderly stop: each unit's whole
   tree, pooled search workers included, is killed on the spot. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    if (child.exitCode === null && child.signalCode === null) {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    }
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // Nothing of the group is left.
  }
}

process.on("exit", () => children.forEach(killTree));
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    console.error(`[release-smoke] ${signal}: stopping the units.`);
    process.exit(1);
  });
}
setTimeout(() => {
  console.error(`[release-smoke] no verdict within ${SMOKE_TIMEOUT_MS / 1000} s: stopping the units.`);
  process.exit(1);
}, SMOKE_TIMEOUT_MS).unref();

function check(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function limaToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date());
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (typeof address === "object" && address ? resolvePort(address.port) : reject(new Error("No free port."))));
    });
  });
}

function unpack(): void {
  /* The archive goes in on stdin and the target with forward slashes: the GNU
     tar of a Windows Git install reads `C:\…` as a remote host. */
  const result = spawnSync("tar", ["-xzf", "-", "-C", root.replaceAll("\\", "/")], { input: readFileSync(artifact), encoding: "utf8" });
  check(result.status === 0, `Unpacking the artifact failed: ${result.stderr}`);
  check(existsSync(join(app, "REVISION")), "The artifact has no app/REVISION.");
  passed.push("artifact unpacked into an empty directory");
}

function prepare(revision: string): void {
  const result = spawnSync("bash", ["./deploy/prepare-release.sh"], {
    cwd: app,
    env: { ...baseEnv, RELEASE_DIR: app, REVISION: revision, BUN_BIN: bun },
    encoding: "utf8",
  });
  check(result.status === 0, `The prepare hook failed (exit ${result.status}): ${result.stdout}${result.stderr}`);
  check(!existsSync(join(app, "node_modules")), "The prepare hook installed packages into the release.");
  passed.push("prepare hook ran as the build user would, and installed nothing");
}

function passwordHash(password: string): string {
  const result = spawnSync(bun, ["--no-env-file", "scripts/generate-web-password-hash.ts"], {
    cwd: app,
    env: baseEnv,
    input: `${password}\n`,
    encoding: "utf8",
  });
  check(result.status === 0, `The release's password hash script failed: ${result.stderr}`);
  return result.stdout.trim();
}

function start(unit: Unit, entry: string, env: Record<string, string>): void {
  const lines: string[] = [];
  logs.set(unit, lines);
  const child = spawn(bun, ["--no-env-file", entry], {
    cwd: app,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  const keep = (chunk: Buffer) => lines.push(...chunk.toString("utf8").split(/\r?\n/).filter(Boolean));
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  children.set(unit, child);
}

async function waitForHealth(unit: Unit, url: string): Promise<void> {
  const child = children.get(unit)!;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    check(child.exitCode === null && child.signalCode === null, `The ${unit} unit exited before it was healthy.`);
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        passed.push(`${unit} answers /api/health`);
        return;
      }
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(100);
  }
  throw new Error(`The ${unit} unit did not answer /api/health within ${HEALTH_TIMEOUT_MS} ms.`);
}

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/* A unit stops the way systemd stops it; whatever of its process group is left
   afterwards, pooled search workers included, is killed. */
async function stop(unit: Unit, child: ChildProcess): Promise<void> {
  if (child.pid === undefined) {
    return;
  }
  const exited = new Promise<void>((resolveExit) => (isRunning(child) ? child.once("exit", () => resolveExit()) : resolveExit()));
  if (process.platform === "win32") {
    killTree(child);
  } else {
    if (isRunning(child)) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
      await Promise.race([exited, Bun.sleep(STOP_GRACE_MS)]);
    }
    killTree(child);
  }
  await Promise.race([exited, Bun.sleep(3_000)]);
  if (isRunning(child)) {
    console.error(`[release-smoke] the ${unit} unit (pid ${child.pid}) is still running.`);
  }
}

function declaredCapabilities(): void {
  const path = join(app, "deploy", "release-capabilities");
  const entry = lstatSync(path, { throwIfNoEntry: false });
  check(entry !== undefined && entry.isFile(), "The release has no regular file at deploy/release-capabilities (a symlink is not one): it declares no capability to the platform.");
  check(entry.size <= RELEASE_CAPABILITIES_MAX_BYTES, `deploy/release-capabilities is ${entry.size} bytes, over its ${RELEASE_CAPABILITIES_MAX_BYTES}-byte bound.`);
  const lines = readFileSync(path, "utf8").split("\n");
  check(lines.pop() === "", "deploy/release-capabilities does not end its last line with a line feed.");
  lines.forEach((line, index) => check(
    KNOWN_RELEASE_CAPABILITIES.has(line),
    `Line ${index + 1} of deploy/release-capabilities is ${JSON.stringify(line)}, not a known capability (${[...KNOWN_RELEASE_CAPABILITIES].join(", ")}): one name a line, LF endings, no comments, no blank lines.`,
  ));
  check(
    lines.includes("cbplus-token-file"),
    "deploy/release-capabilities does not declare cbplus-token-file: the platform would restart the search and redirect units on every token renewal.",
  );
  passed.push(`the release declares its capabilities to the platform: ${lines.join(", ")}`);
}

function cannotFetchPackages(): void {
  const result = spawnSync(bun, ["--no-env-file", "-e", "try { await import(\"playwright\"); console.log(\"RESOLVED\"); } catch (error) { console.log(String(error)); }"], {
    cwd: app,
    env: baseEnv,
    encoding: "utf8",
    timeout: 60_000,
  });
  check(
    result.status === 0 && result.stdout.includes("Cannot find package") && !result.stdout.includes("RESOLVED"),
    `The release resolved a package it does not carry (bunfig.toml must keep install-on-import off): ${result.stdout}${result.stderr}`,
  );
  passed.push("an import of a package the release does not carry fails instead of fetching it");
}

async function signInAndReadShell(webUrl: string, password: string): Promise<void> {
  const login = await fetch(`${webUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  check(login.status === 200, `Signing in answered ${login.status}.`);
  const sessionCookie = login.headers.getSetCookie().find((cookie) => cookie.startsWith("flydesk_session="));
  check(sessionCookie, "Signing in set no session cookie.");
  const maxAge = Number(/;\s*Max-Age=(\d+)/i.exec(sessionCookie)?.[1]);
  check(maxAge === DEFAULT_WEB_SESSION_TTL_SECONDS, `An empty FLY_DESK_WEB_SESSION_TTL_SECONDS gave a session of ${maxAge} s instead of ${DEFAULT_WEB_SESSION_TTL_SECONDS} s.`);
  passed.push("sign-in works, and an empty session setting keeps its 12-hour default");

  const todayBefore = limaToday();
  const shell = await fetch(`${webUrl}/`, { headers: { cookie: sessionCookie.split(";")[0]! }, redirect: "manual" });
  const todayAfter = limaToday();
  check(shell.status === 200, `The signed-in shell answered ${shell.status}.`);
  const html = await shell.text();
  const embedded = /window\.__FLYDESK_RUNTIME__ = (\{.*?\});<\/script>/s.exec(html)?.[1];
  check(embedded, "The shell carries no runtime settings.");
  const runtime = JSON.parse(embedded) as {
    migrationConcurrentMonths: number;
    searchDatePolicy: { minSearchDate: string; maxSearchDate: string; maxFutureDays: number };
  };
  const policy = runtime.searchDatePolicy;
  check([todayBefore, todayAfter].includes(policy.minSearchDate), `The desk's today is ${policy.minSearchDate}, not Lima's ${todayBefore}: SEARCH_TODAY_OVERRIDE reached production.`);
  check(policy.maxFutureDays === DEFAULT_SEARCH_MAX_FUTURE_DAYS && policy.maxSearchDate === addDays(policy.minSearchDate, DEFAULT_SEARCH_MAX_FUTURE_DAYS),
    `An empty SEARCH_MAX_FUTURE_DAYS gave a window of ${policy.maxFutureDays} days.`);
  check(runtime.migrationConcurrentMonths === DEFAULT_MIGRATION_CONCURRENT_MONTHS,
    `An empty FLY_DESK_MIGRATION_CONCURRENT_MONTHS gave ${runtime.migrationConcurrentMonths}.`);
  passed.push("the shell's date window starts on Lima's today and empty settings keep their defaults");

  const asset = /(?:src|href)="(\/assets\/[^"]+)"/.exec(html)?.[1];
  check(asset, "The shell references no built asset.");
  const assetResponse = await fetch(`${webUrl}${asset}`);
  check(assetResponse.status === 200, `The built asset ${asset} answered ${assetResponse.status}.`);
  await assetResponse.arrayBuffer();
  passed.push("the built frontend is served");
}

async function main(): Promise<void> {
  unpack();
  const revision = readFileSync(join(app, "REVISION"), "utf8").trim();
  prepare(revision);
  declaredCapabilities();
  cannotFetchPackages();

  const password = randomBytes(18).toString("base64url");
  const [runnerPort, webPort, redirectPort] = [await freePort(), await freePort(), await freePort()];
  const unitEnv: Record<string, string> = {
    ...baseEnv,
    FLY_DESK_APP_DATA_DIR: state,
    FLY_DESK_WEB_AUTH: "1",
    FLY_DESK_WEB_PASSWORD_HASH: passwordHash(password),
    FLY_DESK_WEB_SESSION_SECRET: randomBytes(32).toString("base64url"),
    FLY_DESK_COOKIE_SECURE: "1",
    FLY_DESK_TRUST_LOOPBACK_CLIENT: "0",
    FLY_DESK_SEARCH_WORKER_PROCESSES: "1",
    FLY_DESK_PROVIDER_PREWARM: "0",
    SEARCH_TODAY_OVERRIDE: "2000-01-01",
    SEARCH_MAX_FUTURE_DAYS: "",
    FLY_DESK_MIGRATION_CONCURRENT_MONTHS: "",
    FLY_DESK_WEB_SESSION_TTL_SECONDS: "",
    FLY_DESK_WEB_SESSION_MAX_LIFETIME_SECONDS: "",
  };
  const urls: Record<Unit, string> = {
    runner: `http://127.0.0.1:${runnerPort}`,
    web: `http://127.0.0.1:${webPort}`,
    redirect: `http://127.0.0.1:${redirectPort}`,
  };
  start("runner", "src/index.ts", { ...unitEnv, HOST: "127.0.0.1", PORT: String(runnerPort), FLY_DESK_SEARCH_SERVICE_URL: "" });
  start("web", "src/index.ts", { ...unitEnv, HOST: "127.0.0.1", PORT: String(webPort), FLY_DESK_SEARCH_SERVICE_URL: urls.runner });
  start("redirect", "src/redirect-index.ts", { ...unitEnv, FLY_DESK_REDIRECT_HOST: "127.0.0.1", FLY_DESK_REDIRECT_PORT: String(redirectPort) });
  for (const unit of ["runner", "web", "redirect"] as const) {
    await waitForHealth(unit, urls[unit]);
  }
  await signInAndReadShell(urls.web, password);
}

let failure: unknown;
const startedAt = Date.now();
try {
  await main();
} catch (error) {
  failure = error;
} finally {
  await Promise.all([...children].map(([unit, child]) => stop(unit, child)));
  children.clear();
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    // SQLite handles on Windows can outlive the process briefly.
  }
}

passed.forEach((line) => console.log(`ok  ${line}`));
if (failure) {
  console.error(`FAIL ${failure instanceof Error ? failure.message : String(failure)}`);
  for (const [unit, lines] of logs) {
    console.error(`---- ${unit} (last lines)\n${lines.slice(-40).join("\n")}`);
  }
  process.exit(1);
}
console.log(`Release smoke passed in ${((Date.now() - startedAt) / 1000).toFixed(1)} s.`);
