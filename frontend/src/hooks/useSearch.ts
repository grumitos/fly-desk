import { useCallback, useRef, useState } from "react"
import type { SearchRequest, SearchJobResponse, SortMode } from "@/types"
import { diagnosticLogFromError, startSearch, pollSearch, startMatrix, pollMatrix, startMigrationSearch, userMessageFromError } from "@/lib/api"

const POLL_INTERVAL_MS = 900

export function useSearch() {
  const [results, setResults] = useState<SearchJobResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [diagnosticLog, setDiagnosticLog] = useState<string[]>([])
  const pollRef = useRef<number | null>(null)
  const abortRef = useRef(false)

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

  const runSearch = useCallback(
    async (
      request: SearchRequest,
      sortMode: SortMode,
      options: { keepPreviousResults?: boolean } = {}
    ): Promise<boolean> => {
      clearPoll()
      abortRef.current = false
      setLoading(true)
      setError(null)
      if (!options.keepPreviousResults) {
        setDiagnosticLog(buildSearchLogHeader(request, sortMode))
      } else {
        appendDiagnosticLog(`Reconsulta ${request.origin} -> ${request.destination} (${sortMode})`)
      }
      if (!options.keepPreviousResults) {
        setResults(null)
      }

      try {
        if (request.searchMode === "month-view") {
          const job = await startMigrationSearch(request, sortMode)
          if (abortRef.current) return false
          setResults(job)
          appendDiagnosticLog(`Migratorio finalizado: ${job.offers.length} oferta${job.offers.length === 1 ? "" : "s"}`, job.diagnosticLog)
          setLoading(false)
          return true
        }

        const flexibleMatrix = request.searchMode === "roundtrip-grid"
        const job = flexibleMatrix
          ? await startMatrix(request, sortMode)
          : await startSearch(request, sortMode)
        setResults(job)
        appendDiagnosticLog(`Respuesta inicial ${job.searchJobId}: ${job.searchStatus}`, job.diagnosticLog)

        if (!job.searchComplete) {
          let lastRevision = job.revision
          const doPoll = async () => {
            if (abortRef.current) return
            try {
              const updated = flexibleMatrix
                ? await pollMatrix(job.searchJobId, sortMode, lastRevision)
                : await pollSearch(job.searchJobId, lastRevision)
              if (abortRef.current) return
              if (!updated.unchanged) {
                lastRevision = updated.revision
                setResults(updated)
                appendDiagnosticLog(`Actualización ${updated.searchJobId}: revisión ${updated.revision}`, updated.diagnosticLog)
              }
              if (!updated.searchComplete) {
                pollRef.current = window.setTimeout(doPoll, POLL_INTERVAL_MS)
              } else if (updated.searchComplete) {
                setLoading(false)
              }
            } catch (err) {
              appendDiagnosticLog("Error durante actualización", diagnosticLogFromError(err))
              setLoading(false)
            }
          }
          pollRef.current = window.setTimeout(doPoll, POLL_INTERVAL_MS)
        } else {
          setLoading(false)
        }
        return true
      } catch (err) {
        setLoading(false)
        appendDiagnosticLog("Error de búsqueda", diagnosticLogFromError(err))
        setError(userMessageFromError(err))
        return false
      }
    },
    [appendDiagnosticLog, clearPoll]
  )

  const cancel = useCallback(() => {
    abortRef.current = true
    clearPoll()
    setLoading(false)
  }, [clearPoll])

  return { results, loading, error, diagnosticLog, runSearch, cancel }
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
