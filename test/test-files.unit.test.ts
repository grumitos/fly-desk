import { expect, test } from "bun:test";
import {
  collectCoreTestFiles,
  findUnclassifiedTestFiles,
} from "../scripts/test-files.ts";

test("all Bun test files are classified as unit or integration", () => {
  expect(findUnclassifiedTestFiles("test")).toEqual([]);
});

test("unit and integration suites are non-empty and disjoint", () => {
  const unitFiles = collectCoreTestFiles("test", "unit");
  const integrationFiles = collectCoreTestFiles("test", "integration");

  expect(unitFiles.length).toBeGreaterThan(0);
  expect(integrationFiles.length).toBeGreaterThan(0);
  expect(unitFiles.filter((file) => integrationFiles.includes(file))).toEqual([]);
});
