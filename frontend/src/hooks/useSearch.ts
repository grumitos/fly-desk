import { useCallback, useEffect, useRef, useState } from "react"
import type { SearchRequest, SearchJobResponse, SortMode } from "@/types"
import {
  cancelSearchJob,
  diagnosticLogFromError,
  FlyDeskSearchCancelledError,
  pollMatrix,
  pollSearch,
  startMatrix,
  startMigrationSearch,
  startSearch,
  userMessageFromError,
} from "@/lib/api"
import {
  nextPollDelayMs,
  POLL_FAST_MS,
  POLL_MAX_CONSECUTIVE_FAILURES,
  POLL_RETRY_DELAY_MS,
} from "@/lib/poll-schedule"

const CANCELLED_SEARCH_MESSAGE = "Búsqueda detenida. Puedes ajustar los campos y buscar de nuevo."
type ActiveJob = { id: string; type: "search" | "matrix" }

export function useSearch() {
  const [results, setResults] = useState<SearchJobResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [diagnosticLog, setDiagnosticLog] = useState<string[]>([])
  const pollRef = useRef<number | null>(null)
  const abortRef = useRef(false)
  const abortControllerRef = useRef<AbortController | null>(null)
  const activeJobsRef = useRef<Map<string, ActiveJob>>(new Map())
  const latestResultsRef = useRef<SearchJobResponse | null>(null)
  const runIdRef = useRef(0)
  const pendingCancellationRef = useRef<Promise<void>>(Promise.resolve())

  const clearPoll = useCallback(() => {
    if (pollRef.current) {
      window.clearTimeout(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const appendDiagnosticLog = useCallback((title: string, lines: string[] = []) => {
    setDiagnosticLog((current) => [
      ...current,
      `[${new Date().toLocaleString("es-PE")}] ${title}`,
      ...lines.map((line) => line.trim()).filter(Boolean),
    ])
  }, [])

  const registerActiveJob = useCallback((job: ActiveJob) => {
    activeJobsRef.current.set(`${job.type}:${job.id}`, job)
  }, [])

  const finishActiveJob = useCallback((job: ActiveJob) => {
    activeJobsRef.current.delete(`${job.type}:${job.id}`)
  }, [])

  const cancelActiveJobs = useCallback((options: {
    cachePartial?: boolean
    keepalive?: boolean
    showFeedback?: boolean
    setIdle?: boolean
  } = {}) => {
    const cachePartial = options.cachePartial ?? false
    const keepalive = options.keepalive ?? false
    const showFeedback = options.showFeedback ?? false
    const setIdle = options.setIdle ?? false
    const jobs = [...activeJobsRef.current.values()]

    runIdRef.current += 1
    abortRef.current = true
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    activeJobsRef.current.clear()
    clearPoll()

    if (setIdle) {
      setLoading(false)
    }

    if (showFeedback) {
      setError(null)
      setStatusMessage(CANCELLED_SEARCH_MESSAGE)
      setResults((current) => {
        const next = finalizeCancelledResults(current ?? latestResultsRef.current)
        latestResultsRef.current = next
        return next
      })
      appendDiagnosticLog("Búsqueda detenida por el usuario")
    }

    if (jobs.length > 0) {
      const cancellation = Promise.allSettled(
        jobs.map((job) => cancelSearchJob(job, { cachePartial, keepalive })),
      ).then(() => undefined)
      pendingCancellationRef.current = cancellation
      return cancellation
    }

    return Promise.resolve()
  }, [appendDiagnosticLog, clearPoll])

  useEffect(() => {
    let sent = false
    const cancelForPageExit = () => {
      if (sent) return
      sent = true
      cancelActiveJobs({ cachePartial: true, keepalive: true, showFeedback: false, setIdle: false })
    }

    window.addEventListener("pagehide", cancelForPageExit)
    window.addEventListener("beforeunload", cancelForPageExit)
    return () => {
      window.removeEventListener("pagehide", cancelForPageExit)
      window.removeEventListener("beforeunload", cancelForPageExit)
    }
  }, [cancelActiveJobs])

  const runSearch = useCallback(
    async (
      request: SearchRequest,
      sortMode: SortMode,
      options: { keepPreviousResults?: boolean } = {}
    ): Promise<boolean> => {
      await pendingCancellationRef.current
      cancelActiveJobs({ showFeedback: false, setIdle: false })
      const runId = runIdRef.current + 1
      runIdRef.current = runId
      const abortController = new AbortController()
      abortControllerRef.current = abortController
      abortRef.current = false
      setLoading(true)
      setError(null)
      setStatusMessage(null)
      if (!options.keepPreviousResults) {
        setDiagnosticLog(buildSearchLogHeader(request, sortMode))
      } else {
        appendDiagnosticLog(`Reconsulta ${request.origin} -> ${request.destination} (${sortMode})`)
      }
      if (!options.keepPreviousResults) {
        latestResultsRef.current = null
        setResults(null)
      }

      const isCurrentRun = () => runIdRef.current === runId && !abortRef.current
      const requestOptions = {
        signal: abortController.signal,
        onJobStart: registerActiveJob,
      }

      try {
        if (request.searchMode === "month-view") {
          const job = await startMigrationSearch(request, sortMode, {
            ...requestOptions,
            onMigrationProgress: (progressJob) => {
              if (!isCurrentRun()) return
              latestResultsRef.current = progressJob
              setResults(progressJob)
            },
          })
          if (!isCurrentRun()) return false
          latestResultsRef.current = job
          setResults(job)
          appendDiagnosticLog(`Migratorio finalizado: ${job.offers.length} oferta${job.offers.length === 1 ? "" : "s"}`, job.diagnosticLog)
          setLoading(false)
          activeJobsRef.current.clear()
          abortControllerRef.current = null
          return true
        }

        const flexibleMatrix = request.searchMode === "roundtrip-grid"
        const job = flexibleMatrix
          ? await startMatrix(request, sortMode, requestOptions)
          : await startSearch(request, sortMode, requestOptions)
        if (!isCurrentRun()) return false
        latestResultsRef.current = job
        setResults(job)
        appendDiagnosticLog(`Respuesta inicial ${job.searchJobId}: ${job.searchStatus}`, job.diagnosticLog)

        if (!job.searchComplete) {
          let lastRevision = job.revision
          /*
           * A poll that fails does not end a search that is still running.
           *
           * The job lives on the server and keeps working; this loop is only
           * the window onto it, and one lost answer — a hop that timed out, a
           * network blip while the agent's laptop changed wifi — used to close
           * that window for good and report a failure the search had not had.
           * Two more tries, then the error is real and is shown.
           */
          let consecutiveFailures = 0
          const doPoll = async () => {
            if (!isCurrentRun()) return
            const startedAt = Date.now()
            try {
              const updated = flexibleMatrix
                ? await pollMatrix(job.searchJobId, sortMode, lastRevision, { signal: abortController.signal })
                : await pollSearch(job.searchJobId, lastRevision, { signal: abortController.signal })
              if (!isCurrentRun()) return
              if (!updated.unchanged) {
                const hydratedUpdate = hydrateSearchJobUpdate(updated, latestResultsRef.current)
                lastRevision = hydratedUpdate.revision
                latestResultsRef.current = hydratedUpdate
                setResults(hydratedUpdate)
                appendDiagnosticLog(`Actualización ${hydratedUpdate.searchJobId}: revisión ${hydratedUpdate.revision}`, hydratedUpdate.diagnosticLog)
              }
              consecutiveFailures = 0
              if (!updated.searchComplete) {
                pollRef.current = window.setTimeout(doPoll, nextPollDelayMs({
                  unchanged: Boolean(updated.unchanged),
                  elapsedMs: Date.now() - startedAt,
                }))
              } else if (updated.searchComplete) {
                finishActiveJob({ id: job.searchJobId, type: flexibleMatrix ? "matrix" : "search" })
                setLoading(false)
                abortControllerRef.current = null
              }
            } catch (err) {
              if (!isCurrentRun() || err instanceof FlyDeskSearchCancelledError) {
                return
              }

              consecutiveFailures += 1
              appendDiagnosticLog(
                `Error durante actualización (intento ${consecutiveFailures} de ${POLL_MAX_CONSECUTIVE_FAILURES})`,
                diagnosticLogFromError(err),
              )
              if (consecutiveFailures < POLL_MAX_CONSECUTIVE_FAILURES) {
                pollRef.current = window.setTimeout(doPoll, POLL_RETRY_DELAY_MS)
                return
              }

              setStatusMessage(userMessageFromError(err))
              setLoading(false)
              abortControllerRef.current = null
            }
          }
          pollRef.current = window.setTimeout(doPoll, POLL_FAST_MS)
        } else {
          finishActiveJob({ id: job.searchJobId, type: flexibleMatrix ? "matrix" : "search" })
          setLoading(false)
          abortControllerRef.current = null
        }
        return true
      } catch (err) {
        if (!isCurrentRun() || err instanceof FlyDeskSearchCancelledError) {
          return false
        }

        setLoading(false)
        abortControllerRef.current = null
        appendDiagnosticLog("Error de búsqueda", diagnosticLogFromError(err))
        setError(userMessageFromError(err))
        return false
      }
    },
    [appendDiagnosticLog, cancelActiveJobs, finishActiveJob, registerActiveJob]
  )

  /**
   * Open a job that already exists instead of asking for it again.
   *
   * A migratory sweep is a search per month, and each of those months keeps its
   * own job on the server. Opening one used to re-run it from scratch — the
   * agent watched a spinner for work that had already been paid for. Here the
   * first response is whatever the job holds right now, which is why the list
   * appears at once, and an unfinished job keeps polling exactly like a search
   * this tab had started itself.
   */
  const restoreJob = useCallback(async (jobId: string): Promise<boolean> => {
    await pendingCancellationRef.current
    cancelActiveJobs({ showFeedback: false, setIdle: false })
    const runId = runIdRef.current + 1
    runIdRef.current = runId
    const abortController = new AbortController()
    abortControllerRef.current = abortController
    abortRef.current = false
    setLoading(true)
    setError(null)
    setStatusMessage(null)
    setDiagnosticLog([`Recuperando la búsqueda ${jobId}`])

    const isCurrentRun = () => runIdRef.current === runId && !abortRef.current

    try {
      const job = await pollSearch(jobId, undefined, { signal: abortController.signal })
      if (!isCurrentRun()) return false

      latestResultsRef.current = job
      setResults(job)
      appendDiagnosticLog(`Búsqueda recuperada ${job.searchJobId}: ${job.searchStatus}`, job.diagnosticLog)

      if (job.searchComplete) {
        setLoading(false)
        abortControllerRef.current = null
        return true
      }

      registerActiveJob({ id: job.searchJobId, type: "search" })
      let lastRevision = job.revision
      /* Same rule as the search loop above: the job runs on the server, and one
         lost answer is a hop that timed out, not a search that stopped. */
      let consecutiveFailures = 0
      const doPoll = async () => {
        if (!isCurrentRun()) return
        const startedAt = Date.now()
        try {
          const updated = await pollSearch(job.searchJobId, lastRevision, { signal: abortController.signal })
          if (!isCurrentRun()) return
          consecutiveFailures = 0
          if (!updated.unchanged) {
            const hydrated = hydrateSearchJobUpdate(updated, latestResultsRef.current)
            lastRevision = hydrated.revision
            latestResultsRef.current = hydrated
            setResults(hydrated)
          }
          if (!updated.searchComplete) {
            pollRef.current = window.setTimeout(doPoll, nextPollDelayMs({
              unchanged: Boolean(updated.unchanged),
              elapsedMs: Date.now() - startedAt,
            }))
            return
          }
          finishActiveJob({ id: job.searchJobId, type: "search" })
          setLoading(false)
          abortControllerRef.current = null
        } catch (err) {
          if (!isCurrentRun() || err instanceof FlyDeskSearchCancelledError) return
          consecutiveFailures += 1
          appendDiagnosticLog(
            `Error durante actualización (intento ${consecutiveFailures} de ${POLL_MAX_CONSECUTIVE_FAILURES})`,
            diagnosticLogFromError(err),
          )
          if (consecutiveFailures < POLL_MAX_CONSECUTIVE_FAILURES) {
            pollRef.current = window.setTimeout(doPoll, POLL_RETRY_DELAY_MS)
            return
          }

          setStatusMessage(userMessageFromError(err))
          setLoading(false)
          abortControllerRef.current = null
        }
      }
      pollRef.current = window.setTimeout(doPoll, POLL_FAST_MS)
      return true
    } catch (err) {
      if (!isCurrentRun() || err instanceof FlyDeskSearchCancelledError) return false

      setLoading(false)
      abortControllerRef.current = null
      appendDiagnosticLog("No se pudo recuperar la búsqueda", diagnosticLogFromError(err))
      setError(userMessageFromError(err))
      return false
    }
  }, [appendDiagnosticLog, cancelActiveJobs, finishActiveJob, registerActiveJob])

  const cancel = useCallback(() => {
    cancelActiveJobs({ cachePartial: true, showFeedback: true, setIdle: true })
  }, [cancelActiveJobs])

  const reset = useCallback(() => {
    cancelActiveJobs({ showFeedback: false, setIdle: true })
    latestResultsRef.current = null
    setResults(null)
    setError(null)
    setStatusMessage(null)
    setDiagnosticLog([])
  }, [cancelActiveJobs])

  return { results, loading, error, statusMessage, diagnosticLog, runSearch, restoreJob, cancel, reset }
}

function hydrateSearchJobUpdate(
  next: SearchJobResponse,
  previous: SearchJobResponse | null,
): SearchJobResponse {
  if (!previous) return next

  return {
    ...next,
    request: isPlaceholderRequest(next.request) ? previous.request : next.request,
    searchMeta: next.searchMeta ?? previous.searchMeta,
    providerMeta: next.providerMeta ?? previous.providerMeta,
  }
}

function isPlaceholderRequest(request: SearchRequest) {
  return request.origin === ""
    && request.destination === ""
    && request.searchMode === "exact"
    && request.tripType === "round-trip"
    && !request.departureDate
    && !request.departureStart
    && !request.returnDate
    && !request.returnStart
}

function finalizeCancelledResults(current: SearchJobResponse | null): SearchJobResponse | null {
  if (!current) return current

  const hasOffers = current.offers.length > 0
  const hasMigrationMonths = Boolean(current.migrationMonths?.length)
  const cancelledWarnings = hasMigrationMonths
    ? [
        ...current.warnings,
        hasOffers
          ? "Búsqueda migratoria detenida. Se conservan los meses consultados con tarifa."
          : "Búsqueda migratoria detenida antes de encontrar tarifas.",
      ]
    : [...current.warnings, "Búsqueda detenida por el usuario."]

  return {
    ...current,
    searchComplete: true,
    searchStatus: "cancelled",
    migrationMonths: current.migrationMonths?.map((month) => {
      if (month.status !== "loading" && month.status !== "partial") return month
      if (month.offer) {
        return {
          ...month,
          status: "available" as const,
          warnings: uniqueStrings([...(month.warnings ?? []), "Mes conservado tras detener la búsqueda."]),
        }
      }

      return {
        ...month,
        status: "cancelled" as const,
        warnings: uniqueStrings([...(month.warnings ?? []), "Búsqueda detenida antes de consultar este mes."]),
      }
    }),
    searchMeta: {
      ...current.searchMeta,
      completedAt: new Date().toISOString(),
      partial: hasOffers || hasMigrationMonths,
      searchState: "search_cancelled",
      warnings: uniqueStrings([
        ...current.searchMeta.warnings,
        hasMigrationMonths
          ? "Búsqueda migratoria detenida por el usuario."
          : "Búsqueda detenida por el usuario.",
      ]),
    },
    warnings: uniqueStrings(cancelledWarnings),
  }
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))))
}

function buildSearchLogHeader(request: SearchRequest, sortMode: SortMode): string[] {
  return [
    `[${new Date().toLocaleString("es-PE")}] Nueva búsqueda`,
    `Ruta: ${request.origin} -> ${request.destination}`,
    `Modo: ${request.searchMode}`,
    `Orden: ${sortMode}`,
    `Salida: ${request.departureDate ?? request.departureStart ?? "-"}`,
    `Regreso: ${request.returnDate ?? request.returnStart ?? "-"}`,
    `Pasajeros: ${request.adults} adulto${request.adults === 1 ? "" : "s"}, ${request.children} niño${request.children === 1 ? "" : "s"}, ${request.infants} bebé${request.infants === 1 ? "" : "s"}`,
  ]
}
