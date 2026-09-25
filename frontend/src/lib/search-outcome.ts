import { uniqueStrings } from "@/lib/api"
import { providerDisplayName } from "@/lib/providers"
import type { SearchJobResponse } from "@/types"

/*
 * What happened to the providers a search was sent to, read in one place from
 * `providerDiagnostics`, their public failure messages and the job's `error`,
 * so the notice and the empty column cannot disagree.
 */
type ProviderFailure = {
  providerId: string
  label: string
  /** One sentence with no instruction: each surface adds its own once. */
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
  /** The headline, then the reasons on following lines; "" when there is nothing to say. */
  notice: string
}

const EMPTY_OUTCOME: SearchOutcome = {
  failed: [],
  waitingLabels: [],
  allFailed: false,
  jobFailed: false,
  notice: "",
}

/* `providerPublicFailureMessage` writes a fixed set of reasons; each is read
   back as a short form and a sentence. */
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
  /* Only once nobody is still out: one provider down while the other runs is partial. */
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
  /* A job that died on admission has one reason, and it is the whole story. */
  if (jobFailed && results.error) return results.error

  if (failed.length === 0) return ""

  /* 04 §8's single line: «incompletos» means a real but short list, «ningún
     proveedor» means no list at all. */
  const headline = allFailed
    ? "No se pudo consultar a ningún proveedor"
    : "Resultados incompletos"

  return [headline, ...uniqueStrings(failed.map((entry) => entry.short))].join("\n")
}

/** The reasons as prose, for the surfaces with room for a sentence each. */
export function failureSentences(outcome: SearchOutcome): string[] {
  return uniqueStrings(outcome.failed.map((entry) => entry.sentence))
}
