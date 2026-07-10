import { spawnSync } from "node:child_process";

const result = spawnSync(
  "node",
  [
    "--test",
    "--test-timeout=60000",
    "--test-reporter=spec",
    ...process.argv.slice(2),
    "test/ui.playwright.ts",
  ],
  {
    env: {
      ...process.env,
      BUN_EXECUTABLE_PATH: process.execPath,
      NODE_ENV: "test",
    },
    stdio: "inherit",
  },
);

process.exit(result.status ?? 1);
