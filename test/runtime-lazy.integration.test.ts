import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("runtime opens the search session cache only on explicit access", () => {
  const child = spawnSync(process.execPath, ["--no-env-file", "-e", `
    process.env.NODE_ENV = "test";
    const runtimeModule = await import("./src/runtime.ts");
    const services = runtimeModule.getRuntime();
    const before = runtimeModule.getSessionStoreIfInitialized();
    const sessions = services.sessions;
    const after = runtimeModule.getSessionStoreIfInitialized();
    sessions.close();
    console.log(JSON.stringify({ before: before === undefined, after: after === sessions }));
  `], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      FLY_DESK_APP_DATA_DIR: "",
      FLY_DESK_SESSION_DB_PATH: "",
      FLY_DESK_SEARCH_SESSION_STORE_PATH: "",
    },
    encoding: "utf8",
  });

  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim()), { before: true, after: true });
});

test("session maintenance stays lazy and reaches a store initialized later", () => {
  const child = spawnSync(process.execPath, ["--no-env-file", "-e", `
    process.env.NODE_ENV = "test";
    const runtimeModule = await import("./src/runtime.ts");
    const services = runtimeModule.getRuntime();
    runtimeModule.maintainSessionStoreIfInitialized();
    const stayedLazy = runtimeModule.getSessionStoreIfInitialized() === undefined;
    const sessions = services.sessions;
    let purgeCalls = 0;
    sessions.purgeExpired = () => {
      purgeCalls += 1;
      return { searchJobs: 0, matrixJobs: 0, sessions: 0, purchasePaths: 0 };
    };
    runtimeModule.maintainSessionStoreIfInitialized();
    sessions.close();
    console.log(JSON.stringify({ stayedLazy, purgeCalls }));
  `], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      FLY_DESK_APP_DATA_DIR: "",
      FLY_DESK_SESSION_DB_PATH: "",
      FLY_DESK_SEARCH_SESSION_STORE_PATH: "",
    },
    encoding: "utf8",
  });

  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim()), { stayedLazy: true, purgeCalls: 1 });
});
