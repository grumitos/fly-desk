import { providerDisplayName } from "@/lib/providers"
import type { SearchJobResponse } from "@/types"

/**
 * What actually happened to the providers this search was sent to.
 *
 * The backend has always said it — `providerDiagnostics[].status` per provider,
 * `providerPublicFailureMessage` as the reason, `error` on the job — and none of
 * it reached the screen. A search where both providers fell over came back
 * `completed` with zero offers and was drawn as «Sin resultados para esta
 * consulta», which asks the agent to widen a search that never ran.
 *
 * This is the one place that reads those three sources, so the notice, the
 * empty column and the still-searching copy cannot disagree about them.
 */
export type ProviderFailure = {
  providerId: string
  label: string
  /**
   * What the provider did, in one sentence and with no instruction attached.
   * Each surface closes with its own single line, so a list of two failures
   * does not end up repeating «Intenta nuevamente» once per provider.
   */
  sentence: string
  /** «Agilsmart no disponible» — for the one line of 04 §8. */
  short: string
}

export type SearchOutcome = {
  /** Providers whose search ended in failure. */
  failed: ProviderFailure[]
  /** Providers still queued or running, by display name. */
  waitingLabels: string[]
  /** Every provider that was asked ended in failure — nothing was searched. */
  allFailed: boolean
  /** The job itself failed (admission, restart), independent of the providers. */
  jobFailed: boolean
  /**
   * The notice, as `SearchNotice` wants it: the first line is the headline and
   * the rest become the detail after the middot. "" when there is nothing to
   * report.
   */
  notice: string
}

const EMPTY_OUTCOME: SearchOutcome = {
  failed: [],
  waitingLabels: [],
  allFailed: false,
  jobFailed: false,
  notice: "",
}

/**
 * The reason in two or three words. `providerPublicFailureMessage` builds the
 * English from a fixed set of reason codes, so this reads the code back off it
 * rather than trying to shorten arbitrary prose.
 */
const REASONS: Array<readonly [RegExp, string, string]> = [
  [/Unable to extract Agil session from Chrome profiles/i, "sin sesión local", "no tiene una sesión local abierta"],
  [/authentication or session is unavailable/i, "sin sesión activa", "no tiene una sesión activa"],
  [/is temporarily unavailable/i, "no disponible", "no está disponible"],
  [/request timed out/i, "sin respuesta a tiempo", "no respondió a tiempo"],
  [/returned an invalid response/i, "respuesta ilegible", "devolvió una respuesta que no se pudo leer"],
  [/request failed/i, "no respondió", "no respondió"],
]

export function describeSearchOutcome(results: SearchJobResponse | null | undefined): SearchOutcome {
  if (!results) return EMPTY_OUTCOME

  const diagnostics = results.providerDiagnostics ?? []
  const failed: ProviderFailure[] = diagnostics
    .filter((entry) => entry.status === "failed")
    .map((entry) => {
      const label = providerDisplayName(entry.providerId)
      const raw = entry.error ? String(entry.error) : ""
      const reason = REASONS.find(([pattern]) => pattern.test(raw))

      return {
        providerId: String(entry.providerId),
        label,
        sentence: `${label} ${reason?.[2] ?? "no respondió"}.`,
        short: `${label} ${reason?.[1] ?? "no respondió"}`,
      }
    })
  const waitingLabels = diagnostics
    .filter((entry) => entry.status === "queued" || entry.status === "running")
    .map((entry) => providerDisplayName(entry.providerId))

  const jobFailed = results.searchStatus === "failed"
    || results.searchMeta?.searchState === "search_failed"
  /* «Everything failed» only counts once nobody is still out. A provider that
     falls at 2s while the other is still running is a partial search, not a
     dead one. */
  const allFailed = failed.length > 0
    && waitingLabels.length === 0
    && diagnostics.every((entry) => entry.status === "failed")

  return {
    failed,
    waitingLabels,
    allFailed,
    jobFailed,
    notice: buildNotice({ results, failed, allFailed, jobFailed }),
  }
}

function buildNotice({
  results,
  failed,
  allFailed,
  jobFailed,
}: {
  results: SearchJobResponse
  failed: ProviderFailure[]
  allFailed: boolean
  jobFailed: boolean
}): string {
  /* A job that died on admission has one reason and it is the whole story; the
     per-provider lines below would only repeat it. */
  if (jobFailed && results.error) return results.error

  if (failed.length === 0) return ""

  /* One headline and the reasons behind the middot — `SearchNotice` splits on
     the newline, so this stays the single line 04 §8 asks for. The headline is
     the part that changes the decision: «incompletos» means the list is real
     but short, «ningún proveedor» means there is no list at all. */
  const headline = allFailed
    ? "No se pudo consultar a ningún proveedor"
    : "Resultados incompletos"

  return [headline, ...uniqueLines(failed.map((entry) => entry.short))].join("\n")
}

/** The reasons as prose, for the surfaces with room for a sentence each. */
export function failureSentences(outcome: SearchOutcome): string[] {
  return uniqueLines(outcome.failed.map((entry) => entry.sentence))
}

function uniqueLines(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}
