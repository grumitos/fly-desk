const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const runtimeDir = path.join(projectRoot, ".launcher");
const stateFile = path.join(runtimeDir, "state.json");
const launcherLog = path.join(runtimeDir, "launcher.log");
const portRange = Array.from({ length: 11 }, (_, index) => 3000 + index);

function ensureRuntimeDir() {
  fs.mkdirSync(runtimeDir, { recursive: true });
}

function log(message) {
  ensureRuntimeDir();
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  fs.appendFileSync(launcherLog, `[${timestamp}] ${message}\n`, "utf8");
}

function createRunLogs() {
  ensureRuntimeDir();
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19).replace(/\..*/, "");
  const stdoutLog = path.join(runtimeDir, `server-${stamp}.out.log`);
  const stderrLog = path.join(runtimeDir, `server-${stamp}.err.log`);
  fs.writeFileSync(stdoutLog, "", "utf8");
  fs.writeFileSync(stderrLog, "", "utf8");
  return { stdoutLog, stderrLog };
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

function saveState(state) {
  ensureRuntimeDir();
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
}

function latestWriteTime(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return 0;
  }

  const stats = fs.statSync(targetPath);
  if (stats.isFile()) {
    return stats.mtimeMs;
  }

  let latest = stats.mtimeMs;
  for (const entry of fs.readdirSync(targetPath)) {
    latest = Math.max(latest, latestWriteTime(path.join(targetPath, entry)));
  }

  return latest;
}

function needsBuild() {
  const distEntry = path.join(projectRoot, "dist", "index.js");
  if (!fs.existsSync(distEntry)) {
    return true;
  }

  const distTime = latestWriteTime(distEntry);
  const sourceTime = Math.max(
    latestWriteTime(path.join(projectRoot, "src")),
    latestWriteTime(path.join(projectRoot, "public")),
    latestWriteTime(path.join(projectRoot, "api")),
    latestWriteTime(path.join(projectRoot, "package.json")),
    latestWriteTime(path.join(projectRoot, "package-lock.json")),
    latestWriteTime(path.join(projectRoot, "tsconfig.json")),
    latestWriteTime(path.join(projectRoot, "tsconfig.build.json")),
  );

  return sourceTime > distTime;
}

function runStep(command, args, stdoutLog, stderrLog, label) {
  log(`${label}: ${command} ${args.join(" ")}`);
  const outFd = fs.openSync(stdoutLog, "a");
  const errFd = fs.openSync(stderrLog, "a");

  try {
    const result = spawnSync(command, args, {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ["ignore", outFd, errFd],
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      throw new Error(`${label} fallo con codigo ${result.status}.`);
    }
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
}

function ensureBuild(stdoutLog, stderrLog) {
  if (!needsBuild()) {
    return;
  }

  runStep("npm.cmd", ["run", "build"], stdoutLog, stderrLog, "npm run build");
}

function isHealthy(port) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: "localhost",
        port,
        path: "/api/health",
        timeout: 1500,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );

    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function getListeningPids(port) {
  const result = spawnSync("netstat", ["-ano", "-p", "tcp"], {
    cwd: projectRoot,
    windowsHide: true,
    encoding: "utf8",
  });

  if (result.error || !result.stdout) {
    return [];
  }

  const regex = new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`, "i");
  const pids = [];

  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(regex);
    if (match) {
      pids.push(Number(match[1]));
    }
  }

  return [...new Set(pids.filter((pid) => Number.isFinite(pid) && pid > 0))];
}

function killPid(pid) {
  const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: "ignore",
  });

  return result.status === 0;
}

async function releaseBlockedPorts() {
  for (const port of portRange) {
    if (await isHealthy(port)) {
      return port;
    }

    for (const pid of getListeningPids(port)) {
      log(`Puerto ${port} ocupado por PID ${pid}. Se cerrara.`);
      killPid(pid);
    }
  }

  return null;
}

function findFreePort() {
  for (const port of portRange) {
    if (getListeningPids(port).length === 0) {
      return port;
    }
  }

  throw new Error("No se encontro un puerto libre entre 3000 y 3010.");
}

async function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy(port)) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  return false;
}

function getChromePath() {
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate));
}

function openBrowser(port) {
  const url = `http://localhost:${port}/`;
  const chromePath = getChromePath();

  if (chromePath) {
    spawn(chromePath, ["--new-tab", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    }).unref();
    log(`Chrome abierto en ${url}`);
    return;
  }

  spawn("cmd.exe", ["/c", "start", "", url], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
  log(`Navegador predeterminado abierto en ${url}`);
}

function startServer(port, stdoutLog, stderrLog) {
  const distEntry = path.join(projectRoot, "dist", "index.js");
  const outFd = fs.openSync(stdoutLog, "a");
  const errFd = fs.openSync(stderrLog, "a");

  const child = spawn(process.execPath, [distEntry], {
    cwd: projectRoot,
    detached: true,
    windowsHide: true,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", outFd, errFd],
  });

  child.unref();
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  log(`Servidor iniciado con PID ${child.pid} en puerto ${port}`);
  return child.pid;
}

async function main() {
  ensureRuntimeDir();
  log("Inicio de launcher Node.");

  const existingState = readState();
  if (existingState?.port && await isHealthy(existingState.port)) {
    log(`Instancia registrada detectada en puerto ${existingState.port}.`);
    openBrowser(existingState.port);
    return;
  }

  const healthyPort = await releaseBlockedPorts();
  if (healthyPort) {
    log(`Instancia sana detectada en puerto ${healthyPort}.`);
    saveState({ port: healthyPort, pid: 0, updatedAt: new Date().toISOString() });
    openBrowser(healthyPort);
    return;
  }

  const { stdoutLog, stderrLog } = createRunLogs();
  log(`Logs de esta ejecucion: ${stdoutLog} | ${stderrLog}`);

  ensureBuild(stdoutLog, stderrLog);

  const port = findFreePort();
  const pid = startServer(port, stdoutLog, stderrLog);
  const ok = await waitForHealth(port, 30000);
  if (!ok) {
    throw new Error(`El servidor no respondio correctamente en http://localhost:${port}/`);
  }

  saveState({
    port,
    pid,
    stdoutLog,
    stderrLog,
    updatedAt: new Date().toISOString(),
  });
  openBrowser(port);
  log("Launcher completado.");
}

main().catch((error) => {
  log(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
