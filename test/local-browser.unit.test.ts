import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildDefaultBrowserLaunchInvocationForTests } from "../src/local-browser";

test("Windows default browser launch keeps the target URL as a single argument", () => {
  const invocation = buildDefaultBrowserLaunchInvocationForTests(
    "https://www.agilsmart.com/home-user/flight-result?origin=LIM&destination=MIA",
    "win32",
  );

  assert.deepEqual(invocation, {
    command: "rundll32.exe",
    args: [
      "url.dll,FileProtocolHandler",
      "https://www.agilsmart.com/home-user/flight-result?origin=LIM&destination=MIA",
    ],
  });
});

test("default browser launch uses the platform-native opener", () => {
  const targetUrl = "https://fly-desk.test/search";

  assert.deepEqual(buildDefaultBrowserLaunchInvocationForTests(targetUrl, "darwin"), {
    command: "open",
    args: [targetUrl],
  });
  assert.deepEqual(buildDefaultBrowserLaunchInvocationForTests(targetUrl, "linux"), {
    command: "xdg-open",
    args: [targetUrl],
  });
});
