import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const outfile = resolve(
  process.env.FLY_DESK_EXE_OUTFILE?.trim() || join(process.cwd(), "bin", "fly-desk.exe"),
);
mkdirSync(dirname(outfile), { recursive: true });

const result = Bun.spawnSync([
  process.execPath,
  "build",
  "./src/index.ts",
  "--compile",
  "--target=bun-windows-x64",
  "--external",
  "electron",
  "--external",
  "chromium-bidi/*",
  "--outfile",
  outfile,
], {
  cwd: process.cwd(),
  stdout: "pipe",
  stderr: "pipe",
});

const stdout = result.stdout.toString();
const stderr = result.stderr.toString();
if (stdout) {
  process.stdout.write(stdout);
}
if (stderr) {
  process.stderr.write(stderr);
}

if (result.exitCode !== 0) {
  process.exit(result.exitCode);
}
