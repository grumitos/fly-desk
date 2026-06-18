import { readdirSync } from "node:fs";
import { join } from "node:path";

export type CoreTestSuite = "core" | "integration" | "unit";

function collectFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(path));
    } else if (entry.isFile()) {
      files.push(path.replaceAll("\\", "/"));
    }
  }

  return files;
}

export function collectCoreTestFiles(
  rootDir = "test",
  suite: CoreTestSuite = "core",
): string[] {
  const suffix = suite === "core" ? /\.(unit|integration)\.test\.ts$/ : new RegExp(`\\.${suite}\\.test\\.ts$`);

  return collectFiles(rootDir)
    .filter((file) => suffix.test(file))
    .map((file) => `./${file}`)
    .sort();
}

export function findUnclassifiedTestFiles(rootDir = "test"): string[] {
  return collectFiles(rootDir)
    .filter((file) => file.endsWith(".test.ts"))
    .filter((file) => !/\.(unit|integration)\.test\.ts$/.test(file))
    .sort();
}
