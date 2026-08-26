import { rmSync } from "node:fs";

/*
 * Delete a test's temp root, waiting out Windows.
 *
 * Every caller has just closed a `bun:sqlite` database that lives inside the
 * directory it is deleting, and on Windows closing the handle is not the same
 * as the file being free: for a few milliseconds afterwards the delete answers
 * `EBUSY`. Sequentially that was an occasional flake in
 * `redirect-service.integration`. Under `bun test --parallel` the machine is
 * busy enough to widen that window, and the occasional flake became a failure
 * on every run — which is how it was found.
 *
 * `maxRetries` is the wait `rm` already knows how to do, and it backs off on
 * exactly the errors this races with: `EBUSY`, `EMFILE`, `ENFILE`, `ENOTEMPTY`
 * and `EPERM`. Ten attempts at 50ms is half a second before a real failure is
 * reported as one, which is far longer than the handle takes and far shorter
 * than the test that would otherwise hang.
 */
export function removeTempRoot(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
