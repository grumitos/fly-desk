import test from "node:test";
import assert from "node:assert/strict";
import {
  createProviderDiagnostics,
  recordProviderDiagnosticEvent,
  recordProviderFirstHttpRequest,
  withProviderDiagnostics,
} from "../src/provider-diagnostics";

test("provider diagnostics isolates concurrent async executions", async () => {
  const agil = createProviderDiagnostics("agil-local", "exact");
  const costamar = createProviderDiagnostics("costamar", "exact");
  const agilEvents: string[] = [];
  const costamarEvents: string[] = [];

  await Promise.all([
    withProviderDiagnostics(agil, (event) => agilEvents.push(event.name), async () => {
      recordProviderDiagnosticEvent("provider_started");
      await new Promise((resolve) => setTimeout(resolve, 5));
      recordProviderDiagnosticEvent("completed");
    }),
    withProviderDiagnostics(costamar, (event) => costamarEvents.push(event.name), async () => {
      recordProviderDiagnosticEvent("provider_started");
      recordProviderDiagnosticEvent("failed");
    }),
  ]);

  assert.deepEqual(agilEvents, ["provider_started", "completed"]);
  assert.deepEqual(costamarEvents, ["provider_started", "failed"]);
  assert.deepEqual(agil.events.map((event) => event.name), ["queued", "provider_started", "completed"]);
  assert.deepEqual(costamar.events.map((event) => event.name), ["queued", "provider_started", "failed"]);
});

test("provider diagnostics records only the first HTTP request and redacts sensitive detail", async () => {
  const diagnostics = createProviderDiagnostics("costamar", "exact");

  await withProviderDiagnostics(diagnostics, undefined, async () => {
    recordProviderFirstHttpRequest("Costamar flight search ?token=secret-value");
    recordProviderFirstHttpRequest("Costamar markup");
  });

  const firstHttpEvents = diagnostics.events.filter((event) => event.name === "first_http_request");
  assert.equal(firstHttpEvents.length, 1);
  assert.match(firstHttpEvents[0]?.detail ?? "", /token=\[redacted\]/);
  assert.doesNotMatch(firstHttpEvents[0]?.detail ?? "", /secret-value/);
});
