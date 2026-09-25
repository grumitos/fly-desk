import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, mkdtempSync, rmSync, writeFileSync, type WriteStream } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { createScryptPasswordHash } from "../../../src/web-auth.ts";
import {
  FAKE_AGIL_IDENTITY,
  FAKE_AGIL_SUBSCRIPTION_KEY,
  FAKE_CBPLUS_TERMINAL_ID,
  fakeCbplusToken,
} from "./fixtures.ts";
import { startFrontProxy, type FrontProxy } from "./front-proxy.ts";
import { FAKE_CDP_PATH, FAKE_UPSTREAM_ENV } from "./provider-origins.ts";

/*
 * The production topology of `vps-platform/systemd/fly-desk*.service`, on
 * loopback: a search runner, a web unit delegating to it, a redirect service,
 * one shared app-data directory, and a Caddy-like proxy in front. Every Bun
 * process — the pooled search workers included — carries the egress preload.
 */

export type ServiceName = "runner" | "web" | "redirect";

type Env = Record<string, string | undefined>;
type BunChild = ChildProcessByStdio<null, Readable, Readable>;

export interface StackOptions {
  /** `FakeUpstream.url`: where the preload sends every provider request. */
  fakeUpstreamUrl: string;
  /** `SEARCH_TODAY_OVERRIDE` (YYYY-MM-DD); the real local date when omitted. */
  today?: string;
  /** Web password; random when omitted. */
  password?: string;
  /** The provider prewarm loop. Off by default: it calls providers on its own clock. */
  prewarm?: boolean;
  /** Applied to all three services; `undefined` removes a variable. */
  env?: Env;
  serviceEnv?: Partial<Record<ServiceName, Env>>;
  bunExecutable?: string;
  readyTimeoutMs?: number;
  /** Keep databases and logs after `stop()`. */
  keepData?: boolean;
  onLog?: (service: ServiceName, line: string) => void;
}

export interface Stack {
  /** The front proxy: what a browser would open. */
  baseUrl: string;
  urls: Readonly<Record<ServiceName, string>>;
  password: string;
  /** `FLY_DESK_API_TOKEN`, accepted by web and runner (the proxy strips it on `/r/*`, as Caddy does). */
  apiToken: string;
  /** `FLY_DESK_WEB_SESSION_SECRET`: lets a test mint a session that was signed in earlier. */
  sessionSecret: string;
  /** `FLY_DESK_APP_DATA_DIR`, shared by the three services. */
  appDataDir: string;
  root: string;
  pid: (service: ServiceName) => number | undefined;
  restart: (service: ServiceName, options?: { env?: Env }) => Promise<void>;
  logs: (service?: ServiceName) => string;
  stop: () => Promise<void>;
}

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const PRELOAD_PATH = resolve(import.meta.dirname, "egress-preload.ts");
const SERVICE_NAMES: readonly ServiceName[] = ["runner", "redirect", "web"];
const ENTRYPOINTS: Readonly<Record<ServiceName, string>> = {
  runner: "src/index.ts",
  web: "src/index.ts",
  redirect: "src/redirect-index.ts",
};
/* Variables a Bun process needs from the host. Everything else is set here, so
   nothing from the developer's shell (tokens, Chrome profiles) leaks in. */
const HOST_ENV = ["PATH", "SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "LANG", "LC_ALL", "TZ"];
/* Longer than the units' own 8 s shutdown deadline (`src/index.ts`). */
const POSIX_STOP_GRACE_MS = 10_000;
/* Windows has no SIGTERM for a child: stopping is TerminateProcess. Waiting past
   the session store's 180 ms write debounce keeps the last mutation on disk. */
const WINDOWS_STOP_SETTLE_MS = 400;
const LOG_LINES_KEPT = 4_000;
const CHROMIUM_UNSAFE_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6697, 10080,
]);

const livePids = new Set<number>();
let exitHookInstalled = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/* The whole tree: a runner takes its pooled workers down with it. Returns what
   the kill reported, for the log. */
function killTreeSync(pid: number): string {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8", windowsHide: true });
    return `${result.stdout ?? ""}${result.stderr ?? ""}`.replace(/\s+/g, " ").trim();
  }
  try {
    process.kill(-pid, "SIGKILL");
    return "SIGKILL sent to the process group";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function installExitHook(): void {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => livePids.forEach(killTreeSync));
  }
}

async function freeChromiumSafePort(taken: ReadonlySet<number>): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolvePort, reject) => {
      const probe = createTcpServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        probe.close(() => (typeof address === "object" && address ? resolvePort(address.port) : reject(new Error("No port."))));
      });
    });
    if (!CHROMIUM_UNSAFE_PORTS.has(port) && !taken.has(port)) {
      return port;
    }
  }
}

/* BUN_OPTIONS is split like a shell line: each argument quoted, slashes forward. */
function bunOptions(args: readonly string[]): string {
  return args.map((arg) => {
    if (arg.includes("\"")) {
      throw new Error(`Cannot pass ${arg} through BUN_OPTIONS.`);
    }
    return `"${arg.replace(/\\/g, "/")}"`;
  }).join(" ");
}

function mergeEnv(...layers: Array<Env | undefined>): Record<string, string> {
  const merged: Env = {};
  for (const layer of layers) {
    Object.assign(merged, layer);
  }
  return Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

class ServiceLog {
  #lines: string[] = [];
  #partial: Record<"out" | "err", string> = { out: "", err: "" };
  #file: WriteStream;
  #onLine: (line: string) => void;
  #closed = false;

  constructor(path: string, onLine: (line: string) => void) {
    this.#file = createWriteStream(path, { flags: "a" });
    this.#file.on("error", () => undefined);
    this.#onLine = onLine;
  }

  write(stream: "out" | "err", chunk: Buffer): void {
    const text = this.#partial[stream] + chunk.toString("utf8");
    const lines = text.split(/\r?\n/);
    this.#partial[stream] = lines.pop() ?? "";
    lines.forEach((line) => this.note(stream === "err" ? `! ${line}` : line));
  }

  note(line: string): void {
    this.#lines.push(line);
    if (this.#lines.length > LOG_LINES_KEPT) {
      this.#lines.splice(0, this.#lines.length - LOG_LINES_KEPT);
    }
    if (!this.#closed) {
      this.#file.write(`${line}\n`);
    }
    this.#onLine(line);
  }

  text(): string {
    return this.#lines.join("\n");
  }

  close(): Promise<void> {
    this.#closed = true;
    return new Promise((resolveClose) => this.#file.end(() => resolveClose()));
  }
}

interface Unit {
  name: ServiceName;
  port: number;
  url: string;
  log: ServiceLog;
  restartEnv: Env;
  child?: BunChild;
  exited?: Promise<void>;
}

export async function startStack(options: StackOptions): Promise<Stack> {
  installExitHook();
  const bun = options.bunExecutable ?? (process.env.BUN_EXECUTABLE_PATH?.trim() || "bun");
  const readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
  const root = mkdtempSync(join(tmpdir(), "fly-desk-e2e-"));
  const appDataDir = join(root, "app-data");
  const home = join(root, "home");
  const privateTmp = join(root, "tmp");
  const emptyChromeProfile = join(root, "chrome-profile-empty");
  const logDir = join(root, "logs");
  for (const dir of [appDataDir, join(home, "AppData", "Local"), join(home, "AppData", "Roaming"), privateTmp, emptyChromeProfile, logDir]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(appDataDir, "agil-identity.json"), JSON.stringify(FAKE_AGIL_IDENTITY));

  const password = options.password ?? randomBytes(12).toString("base64url");
  const apiToken = randomBytes(24).toString("base64url");
  const sessionSecret = randomBytes(32).toString("base64url");
  const taken = new Set<number>();
  const ports = {} as Record<ServiceName, number>;
  for (const name of SERVICE_NAMES) {
    ports[name] = await freeChromiumSafePort(taken);
    taken.add(ports[name]);
  }

  const hostEnv = Object.fromEntries(HOST_ENV.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]));
  const baseEnv: Env = {
    ...hostEnv,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: join(home, "AppData", "Local"),
    APPDATA: join(home, "AppData", "Roaming"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    TEMP: privateTmp,
    TMP: privateTmp,
    TMPDIR: privateTmp,
    NODE_ENV: "test",
    SEARCH_TODAY_OVERRIDE: options.today,
    BUN_OPTIONS: bunOptions(["--no-env-file", `--preload=${PRELOAD_PATH}`]),
    [FAKE_UPSTREAM_ENV]: options.fakeUpstreamUrl,
    FLY_DESK_APP_DATA_DIR: appDataDir,
    FLY_DESK_SESSION_DB_PATH: join(appDataDir, "fly-desk-cache.sqlite"),
    FLY_DESK_LOCATION_SUGGESTION_DB_PATH: join(appDataDir, "location-suggestion-cache.sqlite"),
    FLY_DESK_LOCATION_USAGE_DB_PATH: join(appDataDir, "location-usage.sqlite"),
    FLY_DESK_AIRLINE_MARK_DIR: join(appDataDir, "airline-marks"),
    FLY_DESK_QUOTATION_RATE_CACHE_PATH: join(appDataDir, "fly-desk", "quotation-usd-pen-rate.json"),
    AGIL_IDENTITY_PATH: join(appDataDir, "agil-identity.json"),
    FLY_DESK_WEB_AUTH: "1",
    FLY_DESK_WEB_PASSWORD_HASH: createScryptPasswordHash(password),
    FLY_DESK_WEB_SESSION_SECRET: sessionSecret,
    FLY_DESK_COOKIE_SECURE: "0",
    FLY_DESK_TRUST_LOOPBACK_CLIENT: "0",
    FLY_DESK_API_TOKEN: apiToken,
    FLY_DESK_SEARCH_WORKER_PROCESSES: "1",
    FLY_DESK_SEARCH_WORKER_POOL: "1",
    FLY_DESK_PROVIDER_PREWARM: options.prewarm ? "1" : "0",
    AGIL_APIM_SUBSCRIPTION_KEY: FAKE_AGIL_SUBSCRIPTION_KEY,
    AGIL_BROWSER_URL: `${options.fakeUpstreamUrl}${FAKE_CDP_PATH}`,
    AGIL_CHROME_PROCESS_DISCOVERY: "0",
    AGIL_RAW_CHROME_STORAGE_FILE_SCAN: "0",
    AGIL_TEMP_CHROME_STORAGE_FALLBACK: "0",
    AGIL_CHROME_USER_DATA_DIR: emptyChromeProfile,
    CBPLUS_CHROME_USER_DATA_DIR: emptyChromeProfile,
    CBPLUS_CDP_TAB_SCAN_ENABLED: "0",
    CBPLUS_TERMINAL_ID: FAKE_CBPLUS_TERMINAL_ID,
    CBPLUS_TOKEN: fakeCbplusToken(),
    CBPLUS_SESSION_WARMUP_ENABLED: "0",
    CBPLUS_B2B_AUTOMATION_ENABLED: "0",
    CBPLUS_PROVIDER_B2B_PREWARM_ENABLED: "0",
  };
  const unitEnv: Record<ServiceName, Env> = {
    runner: { HOST: "127.0.0.1", PORT: String(ports.runner), FLY_DESK_SEARCH_SERVICE_URL: "" },
    web: { HOST: "127.0.0.1", PORT: String(ports.web), FLY_DESK_SEARCH_SERVICE_URL: `http://127.0.0.1:${ports.runner}` },
    redirect: { FLY_DESK_REDIRECT_HOST: "127.0.0.1", FLY_DESK_REDIRECT_PORT: String(ports.redirect) },
  };

  const units = Object.fromEntries(SERVICE_NAMES.map((name): [ServiceName, Unit] => [name, {
    name,
    port: ports[name],
    url: `http://127.0.0.1:${ports[name]}`,
    log: new ServiceLog(join(logDir, `${name}.log`), (line) => options.onLog?.(name, line)),
    restartEnv: {},
  }])) as Record<ServiceName, Unit>;

  const launch = async (unit: Unit): Promise<void> => {
    const env = mergeEnv(baseEnv, unitEnv[unit.name], options.env, options.serviceEnv?.[unit.name], unit.restartEnv);
    const child = spawn(bun, ["--no-env-file", ENTRYPOINTS[unit.name]], {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    unit.child = child;
    unit.exited = new Promise((resolveExit) => child.once("exit", () => resolveExit()));
    child.once("error", (error) => unit.log.note(`! spawn failed: ${error.message}`));
    child.stdout.on("data", (chunk: Buffer) => unit.log.write("out", chunk));
    child.stderr.on("data", (chunk: Buffer) => unit.log.write("err", chunk));
    if (child.pid !== undefined) {
      livePids.add(child.pid);
    }
    unit.log.note(`---- ${unit.name} started pid=${child.pid ?? "?"} port=${unit.port}`);

    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
        throw new Error(`${unit.name} exited before becoming ready.\n${unit.log.text()}`);
      }
      try {
        const response = await fetch(`${unit.url}/api/health`, { signal: AbortSignal.timeout(1_000) });
        if (response.ok) {
          return;
        }
      } catch {
        // Not listening yet.
      }
      await sleep(100);
    }
    throw new Error(`${unit.name} did not answer /api/health within ${readyTimeoutMs}ms.\n${unit.log.text()}`);
  };

  const halt = async (unit: Unit): Promise<void> => {
    const { child, exited } = unit;
    unit.child = undefined;
    if (!child || child.pid === undefined || !exited) {
      return;
    }
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === "win32") {
        await sleep(WINDOWS_STOP_SETTLE_MS);
      } else {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          // Already gone.
        }
        await Promise.race([exited, sleep(POSIX_STOP_GRACE_MS)]);
      }
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const report = killTreeSync(child.pid);
        await Promise.race([exited, sleep(3_000)]);
        if (!isAlive(child.pid)) {
          break;
        }
        unit.log.note(`! ${unit.name} pid ${child.pid} survived kill attempt ${attempt}: ${report}`);
      }
    }
    await Promise.race([exited, sleep(3_000)]);
    if (isAlive(child.pid)) {
      console.error(`[e2e-stack] ${unit.name} pid ${child.pid} is still running after stop; see ${join(logDir, `${unit.name}.log`)}`);
    } else {
      livePids.delete(child.pid);
    }
    unit.log.note(`---- ${unit.name} stopped`);
  };

  let proxy: FrontProxy | undefined;
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    await proxy?.close();
    await Promise.all(SERVICE_NAMES.map((name) => halt(units[name])));
    await Promise.all(SERVICE_NAMES.map((name) => units[name].log.close()));
    if (!options.keepData) {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      } catch {
        // SQLite handles on Windows can outlive the process briefly; the OS reclaims %TEMP%.
      }
    }
  };

  try {
    await Promise.all(SERVICE_NAMES.map((name) => launch(units[name])));
    proxy = await startFrontProxy({
      webUrl: units.web.url,
      redirectUrl: units.redirect.url,
      port: await freeChromiumSafePort(taken),
    });
  } catch (error) {
    await stop();
    throw error;
  }

  return {
    baseUrl: proxy.url,
    urls: { runner: units.runner.url, web: units.web.url, redirect: units.redirect.url },
    password,
    apiToken,
    sessionSecret,
    appDataDir,
    root,
    pid: (name) => units[name].child?.pid,
    restart: async (name, restartOptions) => {
      if (stopped) {
        throw new Error("The stack has been stopped.");
      }
      const unit = units[name];
      if (restartOptions?.env) {
        unit.restartEnv = { ...unit.restartEnv, ...restartOptions.env };
      }
      await halt(unit);
      await launch(unit);
    },
    logs: (name) => (name ? [name] : SERVICE_NAMES)
      .map((serviceName) => `==== ${serviceName} (${units[serviceName].url})\n${units[serviceName].log.text()}`)
      .join("\n"),
    stop,
  };
}
