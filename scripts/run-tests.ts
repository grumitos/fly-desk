import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function collectTestFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectTestFiles(path));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(`./${path.replaceAll("\\", "/")}`);
    }
  }

  return files;
}

const testFiles = collectTestFiles("test").sort();

if (testFiles.length === 0) {
  console.error("No test files found under test/**/*.test.ts.");
  process.exit(1);
}

const env: Record<string, string> = {};

for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) {
    env[key] = value;
  }
}

env.NODE_ENV = "test";

const result = spawnSync("bun", ["test", "--timeout=600000", ...testFiles], {
  env,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
