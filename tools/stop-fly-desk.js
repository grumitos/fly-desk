const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const runtimeDir = path.join(projectRoot, ".launcher");
const stateFile = path.join(runtimeDir, "state.json");
const portRange = Array.from({ length: 11 }, (_, index) => 3000 + index);

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
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: "ignore",
  });
}

try {
  if (fs.existsSync(stateFile)) {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (state.pid) {
      killPid(state.pid);
    }
  }
} catch {
}

for (const port of portRange) {
  for (const pid of getListeningPids(port)) {
    killPid(pid);
  }
}

try {
  fs.rmSync(stateFile, { force: true });
} catch {
}
