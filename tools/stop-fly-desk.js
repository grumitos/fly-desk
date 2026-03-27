const { spawnSync } = require("node:child_process");
const path = require("node:path");

const scriptPath = path.join(__dirname, "stop-fly-desk.ps1");

const result = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
  {
    cwd: path.resolve(__dirname, ".."),
    stdio: "inherit",
    windowsHide: false,
  },
);

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
