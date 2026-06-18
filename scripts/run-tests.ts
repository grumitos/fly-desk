import { spawnSync } from "node:child_process";
import {
  collectCoreTestFiles,
  findUnclassifiedTestFiles,
  type CoreTestSuite,
} from "./test-files.ts";

const requestedSuite = process.argv[2] ?? "core";
const coverage = requestedSuite === "coverage";
const suite = (coverage ? "core" : requestedSuite) as CoreTestSuite;

if (!["core", "integration", "unit"].includes(suite)) {
  console.error(`Unknown test suite: ${requestedSuite}`);
  process.exit(1);
}

const unclassifiedFiles = findUnclassifiedTestFiles("test");
if (unclassifiedFiles.length > 0) {
  console.error(`Unclassified test files:\n${unclassifiedFiles.join("\n")}`);
  process.exit(1);
}

const testFiles = collectCoreTestFiles("test", suite);

if (testFiles.length === 0) {
  console.error(`No ${suite} test files found under test/.`);
  process.exit(1);
}

const env: Record<string, string> = {};

for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) {
    env[key] = value;
  }
}

env.NODE_ENV = "test";

const args = ["test", "--timeout=600000"];
if (coverage) {
  args.push("--coverage");
}
args.push(...testFiles);

const result = spawnSync("bun", args, {
  env,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
