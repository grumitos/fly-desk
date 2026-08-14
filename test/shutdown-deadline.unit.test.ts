import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE_ROOT = join(import.meta.dir, "..", "src");

function readSource(name: string): string {
  return readFileSync(join(SOURCE_ROOT, name), "utf8");
}

/*
 * The 2026-08-14 outage, as a property of the source.
 *
 * A bare `server.stop()` is Bun's graceful stop: it resolves only once in-flight
 * requests and their connections have drained. Under a migratory sweep the
 * frontend polls without pause, so "drained" was a minute away — every stop took
 * the full 45s `TimeoutStopSec` and ended in SIGKILL, five times in eight
 * minutes, while Caddy had no upstream and the site served 503.
 *
 * These entrypoints run under systemd with a stop timeout they do not control,
 * and there is no way to exercise a real SIGTERM path in this suite. So the
 * check is structural, on the two things whose absence caused the incident: a
 * forced close after the drain window, and a deadline that exits on our own
 * terms before the unit's timeout turns into a kill.
 */
for (const entrypoint of ["index.ts", "redirect-index.ts"]) {
  test(`${entrypoint} bounds its shutdown instead of waiting for connections to drain`, () => {
    const source = readSource(entrypoint);

    // The drain gets a window, and then the connections are closed under it.
    assert.match(
      source,
      /server\.stop\(true\)/,
      `${entrypoint} never forces active connections closed, so a poller decides when it stops.`,
    );
    assert.match(source, /SHUTDOWN_DRAIN_MS/, entrypoint);

    // And the whole shutdown answers to a deadline, armed by the signal so it
    // also covers a hang before the first await.
    assert.match(source, /SHUTDOWN_DEADLINE_MS/, entrypoint);
    assert.match(
      source,
      /setTimeout\([\s\S]*?process\.exit\(0\)[\s\S]*?SHUTDOWN_DEADLINE_MS\)/,
      `${entrypoint} has no hard exit, so a hung shutdown still ends in SIGKILL.`,
    );
  });

  test(`${entrypoint} leaves on time for the tightest unit stop timeout`, () => {
    const source = readSource(entrypoint);
    const drain = Number(/SHUTDOWN_DRAIN_MS = ([\d_]+)/.exec(source)?.[1]?.replace(/_/g, ""));
    const deadline = Number(/SHUTDOWN_DEADLINE_MS = ([\d_]+)/.exec(source)?.[1]?.replace(/_/g, ""));

    assert.ok(Number.isFinite(drain) && Number.isFinite(deadline), `${entrypoint} sizes are unreadable`);
    assert.ok(drain < deadline, `${entrypoint}: the drain window must fit inside the deadline`);
    /* The search runner's TimeoutStopSec is the tightest at 15s
       (vps-platform/systemd/fly-desk-search.service). Exiting at 8s runs the
       cleanup; being killed at 15 skips every `finally`, which is how the
       provider paths close the CDP tabs they opened. */
    assert.ok(deadline <= 12_000, `${entrypoint}: ${deadline}ms leaves no room before a 15s SIGKILL`);
  });
}
