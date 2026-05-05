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

const POLL_INTERVAL_MS = 900
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
  const runIdRef = useRef(0)

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
      setResults((current) => current
        ? {
            ...current,
            searchComplete: true,
            searchStatus: "cancelled",
            searchMeta: {
              ...current.searchMeta,
              completedAt: new Date().toISOString(),
              partial: current.offers.length > 0,
              searchState: "search_cancelled",
              warnings: uniqueStrings([...current.searchMeta.warnings, "Búsqueda detenida por el usuario."]),
            },
            warnings: uniqueStrings([...current.warnings, "Búsqueda detenida por el usuario."]),
          }
        : current)
      appendDiagnosticLog("Búsqueda detenida por el usuario")
    }

    if (jobs.length > 0) {
      void Promise.allSettled(jobs.map((job) => cancelSearchJob(job, { cachePartial, keepalive })))
    }
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
              setResults(progressJob)
            },
          })
          if (!isCurrentRun()) return false
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
        setResults(job)
        appendDiagnosticLog(`Respuesta inicial ${job.searchJobId}: ${job.searchStatus}`, job.diagnosticLog)

        if (!job.searchComplete) {
          let lastRevision = job.revision
          const doPoll = async () => {
            if (!isCurrentRun()) return
            try {
              const updated = flexibleMatrix
                ? await pollMatrix(job.searchJobId, sortMode, lastRevision, { signal: abortController.signal })
                : await pollSearch(job.searchJobId, lastRevision, { signal: abortController.signal })
              if (!isCurrentRun()) return
              if (!updated.unchanged) {
                lastRevision = updated.revision
                setResults(updated)
                appendDiagnosticLog(`Actualización ${updated.searchJobId}: revisión ${updated.revision}`, updated.diagnosticLog)
              }
              if (!updated.searchComplete) {
                pollRef.current = window.setTimeout(doPoll, POLL_INTERVAL_MS)
              } else if (updated.searchComplete) {
                finishActiveJob({ id: job.searchJobId, type: flexibleMatrix ? "matrix" : "search" })
                setLoading(false)
                abortControllerRef.current = null
              }
            } catch (err) {
              if (!isCurrentRun() || err instanceof FlyDeskSearchCancelledError) {
                return
              }

              appendDiagnosticLog("Error durante actualización", diagnosticLogFromError(err))
              setLoading(false)
              abortControllerRef.current = null
            }
          }
          pollRef.current = window.setTimeout(doPoll, POLL_INTERVAL_MS)
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

  const cancel = useCallback(() => {
    cancelActiveJobs({ showFeedback: true, setIdle: true })
  }, [cancelActiveJobs])

  const reset = useCallback(() => {
    cancelActiveJobs({ showFeedback: false, setIdle: true })
    setResults(null)
    setError(null)
    setStatusMessage(null)
    setDiagnosticLog([])
  }, [cancelActiveJobs])

  return { results, loading, error, statusMessage, diagnosticLog, runSearch, cancel, reset }
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
