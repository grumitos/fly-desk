import { test } from "bun:test"
import assert from "node:assert/strict"
import {
  describeSearchOutcome,
  failureSentences,
  stillSearchingBody,
} from "../frontend/src/lib/search-outcome"
import type { SearchJobResponse } from "../frontend/src/types"

/*
 * What happened to the providers, as the three surfaces have to agree on it.
 *
 * The notice above the list, the empty column and the still-searching copy all
 * read this one module, so a search where a provider fell over cannot be
 * described one way in the notice and another in the column — which is what
 * produced «Sin resultados para esta consulta» for a search that never ran.
 *
 * `test/ui/search-shell.playwright.ts` drives the case where both providers
 * fail and the job is over. The interesting boundary is the one before that:
 * one provider down while the other is still out is a *partial* search, and
 * saying «ningún proveedor» there is a lie the agent would act on.
 */

type Diagnostic = {
  providerId: string
  status: "queued" | "running" | "completed" | "failed"
  error?: string
}

function job(diagnostics: Diagnostic[], overrides: Record<string, unknown> = {}): SearchJobResponse {
  return {
    searchStatus: "running",
    providerDiagnostics: diagnostics,
    ...overrides,
  } as unknown as SearchJobResponse
}

test("nothing to report is reported as nothing", () => {
  assert.deepEqual(describeSearchOutcome(null), {
    failed: [],
    waitingLabels: [],
    allFailed: false,
    jobFailed: false,
    notice: "",
  })

  const healthy = describeSearchOutcome(job([
    { providerId: "agil-local", status: "completed" },
    { providerId: "costamar", status: "completed" },
  ]))
  assert.equal(healthy.notice, "")
  assert.equal(healthy.allFailed, false)
  assert.deepEqual(healthy.failed, [])
})

test("one provider down while the other is still out is an incomplete search, not a dead one", () => {
  const outcome = describeSearchOutcome(job([
    { providerId: "agil-local", status: "failed", error: "Agilsmart is temporarily unavailable." },
    { providerId: "costamar", status: "running" },
  ]))

  assert.equal(outcome.allFailed, false)
  assert.deepEqual(outcome.waitingLabels, ["Click and Book Plus"])
  assert.equal(outcome.notice, "Resultados incompletos\nAgilsmart no disponible")
})

test("every provider down, and nobody still out, is the whole search", () => {
  const outcome = describeSearchOutcome(job([
    { providerId: "agil-local", status: "failed", error: "Agilsmart is temporarily unavailable." },
    { providerId: "costamar", status: "failed", error: "Click and Book Plus request timed out." },
  ], { searchStatus: "completed" }))

  assert.equal(outcome.allFailed, true)
  assert.deepEqual(outcome.waitingLabels, [])
  // 04 §8: one line — a headline and the reasons behind it, no instruction
  // repeated once per provider.
  assert.equal(
    outcome.notice,
    "No se pudo consultar a ningún proveedor\nAgilsmart no disponible\nClick and Book Plus sin respuesta a tiempo",
  )
})

test("a provider that finished beside one that failed keeps the search partial", () => {
  const outcome = describeSearchOutcome(job([
    { providerId: "agil-local", status: "failed", error: "Agilsmart request failed." },
    { providerId: "costamar", status: "completed" },
  ], { searchStatus: "completed" }))

  assert.equal(outcome.allFailed, false)
  assert.match(outcome.notice, /^Resultados incompletos\n/)
})

test("the reason is read off the code the backend built the message from", () => {
  const outcome = describeSearchOutcome(job([
    { providerId: "agil-local", status: "failed", error: "Unable to extract Agil session from Chrome profiles at C:\\Users\\x." },
    { providerId: "costamar", status: "failed", error: "Click and Book Plus returned an invalid response." },
  ], { searchStatus: "completed" }))

  // The path in the raw error is a technical detail and never reaches a surface.
  assert.doesNotMatch(outcome.notice, /Chrome|C:\\/)
  assert.deepEqual(outcome.failed.map((entry) => entry.short), [
    "Agilsmart sin sesión local",
    "Click and Book Plus respuesta ilegible",
  ])
  assert.deepEqual(failureSentences(outcome), [
    "Agilsmart no tiene una sesión local abierta.",
    "Click and Book Plus devolvió una respuesta que no se pudo leer.",
  ])
})

test("an error nobody has a phrase for still names the provider", () => {
  const outcome = describeSearchOutcome(job([
    { providerId: "agil-local", status: "failed", error: "Something nobody wrote a pattern for." },
  ], { searchStatus: "completed" }))

  assert.equal(outcome.failed[0].short, "Agilsmart no respondió")
  assert.equal(outcome.failed[0].sentence, "Agilsmart no respondió.")
})

test("a job that died on admission says that once, instead of once per provider", () => {
  const outcome = describeSearchOutcome(job([
    { providerId: "agil-local", status: "failed", error: "Agilsmart is temporarily unavailable." },
  ], { searchStatus: "failed", error: "La búsqueda no pudo iniciarse." }))

  assert.equal(outcome.jobFailed, true)
  assert.equal(outcome.notice, "La búsqueda no pudo iniciarse.")
})

test("a job the meta calls failed is failed even when the status has not caught up", () => {
  const outcome = describeSearchOutcome(job([], {
    searchStatus: "running",
    searchMeta: { searchState: "search_failed" },
  }))

  assert.equal(outcome.jobFailed, true)
})

test("the still-searching copy names who is late instead of accusing everyone", () => {
  /* The old line claimed, in the plural and as a diagnosis, that «los
     proveedores están tardando». With one of them already down at two seconds
     that was simply wrong. */
  const oneWaiting = describeSearchOutcome(job([
    { providerId: "agil-local", status: "failed", error: "Agilsmart is temporarily unavailable." },
    { providerId: "costamar", status: "running" },
  ]))
  assert.equal(
    stillSearchingBody(oneWaiting),
    "Agilsmart no está disponible. Click and Book Plus está tardando más de lo habitual."
      + " Los vuelos aparecen aquí en cuanto llega el primero.",
  )

  const bothWaiting = describeSearchOutcome(job([
    { providerId: "agil-local", status: "running" },
    { providerId: "costamar", status: "queued" },
  ]))
  assert.equal(
    stillSearchingBody(bothWaiting),
    "Agilsmart y Click and Book Plus están tardando más de lo habitual."
      + " Los vuelos aparecen aquí en cuanto llega el primero.",
  )

  const nobodyKnown = describeSearchOutcome(job([]))
  assert.equal(
    stillSearchingBody(nobodyKnown),
    "La consulta está tardando más de lo habitual. Los vuelos aparecen aquí en cuanto llega el primero.",
  )
})

test("two providers failing the same way are one line, not two identical ones", () => {
  const outcome = describeSearchOutcome(job([
    { providerId: "agil-local", status: "failed", error: "Agilsmart request timed out." },
    { providerId: "agil-local", status: "failed", error: "Agilsmart request timed out." },
  ], { searchStatus: "completed" }))

  assert.equal(outcome.notice, "No se pudo consultar a ningún proveedor\nAgilsmart sin respuesta a tiempo")
  assert.deepEqual(failureSentences(outcome), ["Agilsmart no respondió a tiempo."])
})
