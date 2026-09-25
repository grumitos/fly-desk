import { useCallback, useEffect, useRef, useState } from "react"
import type { SearchRequest, SearchJobResponse, SortMode } from "@/types"
import {
  cancelSearchJob,
  diagnosticLogFromError,
  followJob,
  FlyDeskSearchCancelledError,
  pollMatrix,
  pollSearch,
  startMatrix,
  startMigrationSearch,
  startSearch,
  uniqueStrings,
  userMessageFromError,
} from "@/lib/api"
import { POLL_MAX_CONSECUTIVE_FAILURES } from "@/lib/poll-schedule"

const CANCELLED_SEARCH_MESSAGE = "Búsqueda detenida. Puedes ajustar los campos y buscar de nuevo."

type ActiveJob = { id: string; type: "search" | "matrix" }
type CancelOptions = { cachePartial?: boolean; keepalive?: boolean }

/* One search from its first request to its last poll. A job id that arrives
   after the run was stopped is cancelled on arrival: the POST cannot be
   aborted without losing the id of the job the server already created. */
type Run = {
  controller: AbortController
  jobs: Map<string, ActiveJob>
  stopped: CancelOptions | null
}

export function useSearch() {
  const [results, setResults] = useState<SearchJobResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [diagnosticLog, setDiagnosticLog] = useState<string[]>([])
  const runRef = useRef<Run | null>(null)
  const latestResultsRef = useRef<SearchJobResponse | null>(null)
  const pendingCancellationRef = useRef<Promise<unknown>>(Promise.resolve())

  const appendDiagnosticLog = useCallback((title: string, lines: string[] = []) => {
    setDiagnosticLog((current) => [
      ...current,
      `[${new Date().toLocaleString("es-PE")}] ${title}`,
      ...lines.map((line) => line.trim()).filter(Boolean),
    ])
  }, [])

  const publish = useCallback((job: SearchJobResponse | null) => {
    latestResultsRef.current = job
    setResults(job)
  }, [])

  const cancelJobs = useCallback((jobs: ActiveJob[], options: CancelOptions) => {
    if (jobs.length === 0) return
    pendingCancellationRef.current = Promise.allSettled([
      pendingCancellationRef.current,
      ...jobs.map((job) => cancelSearchJob(job, options)),
    ])
  }, [])

  const stopRun = useCallback((options: CancelOptions = {}) => {
    const run = runRef.current
    runRef.current = null
    if (!run) return
    run.stopped = options
    run.controller.abort()
    cancelJobs([...run.jobs.values()], options)
    run.jobs.clear()
  }, [cancelJobs])

  const beginRun = useCallback((): Run => {
    stopRun()
    const run: Run = { controller: new AbortController(), jobs: new Map(), stopped: null }
    runRef.current = run
    setLoading(true)
    setError(null)
    setStatusMessage(null)
    return run
  }, [stopRun])

  const jobStarter = useCallback((run: Run) => (job: ActiveJob) => {
    if (run.stopped) {
      cancelJobs([job], run.stopped)
      return
    }
    run.jobs.set(`${job.type}:${job.id}`, job)
  }, [cancelJobs])

  const endRun = useCallback((run: Run) => {
    if (runRef.current !== run) return
    runRef.current = null
    setLoading(false)
  }, [])

  const failRun = useCallback((run: Run, err: unknown, title: string) => {
    if (runRef.current !== run || err instanceof FlyDeskSearchCancelledError) return
    appendDiagnosticLog(title, diagnosticLogFromError(err))
    setError(userMessageFromError(err))
    endRun(run)
  }, [appendDiagnosticLog, endRun])

  const follow = useCallback(async (run: Run, first: SearchJobResponse, type: ActiveJob["type"]) => {
    const isCurrent = () => runRef.current === run
    try {
      await followJob(first, (since, signal) => (
        type === "matrix"
          ? pollMatrix(first.searchJobId, first.sortMode, since, signal)
          : pollSearch(first.searchJobId, since, signal)
      ), {
        signal: run.controller.signal,
        onUpdate: (job) => {
          if (!isCurrent()) return
          publish(job)
          appendDiagnosticLog(`Actualización ${job.searchJobId}: revisión ${job.revision}`, job.diagnosticLog)
        },
        onRetry: (err, attempt) => {
          if (!isCurrent()) return
          appendDiagnosticLog(
            `Error durante actualización (intento ${attempt} de ${POLL_MAX_CONSECUTIVE_FAILURES})`,
            diagnosticLogFromError(err),
          )
        },
      })
      run.jobs.delete(`${type}:${first.searchJobId}`)
      endRun(run)
    } catch (err) {
      if (!isCurrent() || err instanceof FlyDeskSearchCancelledError) return
      /* The job may still be running on the server; the run stays registered
         so the next search or leaving the page cancels it. */
      setError(userMessageFromError(err))
      setLoading(false)
    }
  }, [appendDiagnosticLog, endRun, publish])

  useEffect(() => {
    const cancelForPageExit = () => stopRun({ cachePartial: true, keepalive: true })
    window.addEventListener("pagehide", cancelForPageExit)
    return () => window.removeEventListener("pagehide", cancelForPageExit)
  }, [stopRun])

  /** Resolves `true` once the search has a first answer to draw. */
  const runSearch = useCallback(async (request: SearchRequest, sortMode: SortMode): Promise<boolean> => {
    const run = beginRun()
    const isCurrent = () => runRef.current === run
    publish(null)
    setDiagnosticLog(buildSearchLogHeader(request, sortMode))
    const onJobStart = jobStarter(run)

    /* The previous search's cancellation frees its admission units first. */
    await pendingCancellationRef.current
    if (!isCurrent()) return false

    try {
      if (request.searchMode === "month-view") {
        const job = await startMigrationSearch(request, sortMode, {
          signal: run.controller.signal,
          onJobStart,
          onMigrationProgress: (progress) => {
            if (isCurrent()) publish(progress)
          },
        })
        if (!isCurrent()) return false
        publish(job)
        appendDiagnosticLog(
          `Migratorio finalizado: ${job.migrationMonths?.filter((month) => month.offer).length ?? 0} meses con tarifa`,
          job.diagnosticLog,
        )
        endRun(run)
        return true
      }

      const type: ActiveJob["type"] = request.searchMode === "roundtrip-grid" ? "matrix" : "search"
      const first = type === "matrix"
        ? await startMatrix(request, sortMode, { onJobStart })
        : await startSearch(request, sortMode, { onJobStart })
      if (!isCurrent()) return false
      publish(first)
      appendDiagnosticLog(`Respuesta inicial ${first.searchJobId}: ${first.searchStatus}`, first.diagnosticLog)
      void follow(run, first, type)
      return true
    } catch (err) {
      failRun(run, err, "Error de búsqueda")
      return false
    }
  }, [appendDiagnosticLog, beginRun, endRun, failRun, follow, jobStarter, publish])

  /** Reads a job that already exists instead of paying for it again (a month of a sweep in its own tab). */
  const restoreJob = useCallback(async (jobId: string): Promise<boolean> => {
    const run = beginRun()
    const isCurrent = () => runRef.current === run
    setDiagnosticLog([`Recuperando la búsqueda ${jobId}`])

    await pendingCancellationRef.current
    if (!isCurrent()) return false

    try {
      const first = await pollSearch(jobId, undefined, run.controller.signal)
      if (!isCurrent()) return false
      publish(first)
      appendDiagnosticLog(`Búsqueda recuperada ${first.searchJobId}: ${first.searchStatus}`, first.diagnosticLog)
      if (!first.searchComplete) run.jobs.set(`search:${first.searchJobId}`, { id: first.searchJobId, type: "search" })
      void follow(run, first, "search")
      return true
    } catch (err) {
      failRun(run, err, "No se pudo recuperar la búsqueda")
      return false
    }
  }, [appendDiagnosticLog, beginRun, failRun, follow, publish])

  const cancel = useCallback(() => {
    stopRun({ cachePartial: true })
    setLoading(false)
    setError(null)
    setStatusMessage(CANCELLED_SEARCH_MESSAGE)
    publish(finalizeCancelledResults(latestResultsRef.current))
    appendDiagnosticLog("Búsqueda detenida por el usuario")
  }, [appendDiagnosticLog, publish, stopRun])

  return { results, loading, error, statusMessage, diagnosticLog, runSearch, restoreJob, cancel }
}

function finalizeCancelledResults(current: SearchJobResponse | null): SearchJobResponse | null {
  if (!current) return current

  const hasOffers = current.allOffers.length > 0
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
