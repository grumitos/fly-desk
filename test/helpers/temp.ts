import { rmSync } from "node:fs";

/*
 * Delete a test's temp root, waiting out Windows, and never failing the test
 * over it.
 *
 * Every caller has just closed a `bun:sqlite` database that lived inside the
 * directory it is deleting — properly closed, with a `wal_checkpoint(TRUNCATE)`
 * before `close(true)`. On Windows that still is not the same as the file being
 * free: for a while afterwards the delete answers `EBUSY`, and how long is
 * whatever the machine and its file scanner decide. Sequentially it was an
 * occasional flake in `redirect-service.integration`; under
 * `bun test --parallel` the machine is busy enough that it became a failure on
 * nearly every run, in a different suite each time.
 *
 * So two things. `maxRetries` is the wait `rm` already knows how to do and it
 * backs off on exactly this — `EBUSY`, `EMFILE`, `ENFILE`, `ENOTEMPTY`,
 * `EPERM`. And if it still loses, the directory is left behind rather than
 * thrown over: this runs from `finally` and `afterEach`, where a throw fails a
 * test that already passed and reports an operating system's timing as a defect
 * in the code under test. `src/temp-artifacts.ts` answers the same race the
 * same way in production, for the same reason.
 *
 * What is given up is a directory under `%TEMP%` on a developer machine, which
 * the OS reclaims. What is kept is a suite that only goes red for its own
 * reasons.
 */
export function removeTempRoot(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  } catch {
    // Deliberately swallowed; see above. Cleanup is not one of the assertions.
  }
}
