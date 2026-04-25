import { useCallback, useRef, useState } from "react"
import type { SearchRequest, SearchJobResponse, SortMode } from "@/types"
import { startSearch, pollSearch } from "@/lib/api"

const POLL_INTERVAL_MS = 900

export function useSearch() {
  const [results, setResults] = useState<SearchJobResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<number | null>(null)
  const abortRef = useRef(false)

  const clearPoll = useCallback(() => {
    if (pollRef.current) {
      window.clearTimeout(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const runSearch = useCallback(
    async (request: SearchRequest, sortMode: SortMode) => {
      clearPoll()
      abortRef.current = false
      setLoading(true)
      setError(null)
      setResults(null)

      try {
        const job = await startSearch(request, sortMode)
        setResults(job)

        if (!job.searchComplete) {
          let lastRevision = job.revision
          const doPoll = async () => {
            if (abortRef.current) return
            try {
              const updated = await pollSearch(job.searchJobId, lastRevision)
              if (abortRef.current) return
              if (!updated.unchanged) {
                lastRevision = updated.revision
                setResults(updated)
              }
              if (!updated.searchComplete) {
                pollRef.current = window.setTimeout(doPoll, POLL_INTERVAL_MS)
              } else if (updated.searchComplete) {
                setLoading(false)
              }
            } catch {
              setLoading(false)
            }
          }
          pollRef.current = window.setTimeout(doPoll, POLL_INTERVAL_MS)
        } else {
          setLoading(false)
        }
      } catch (err) {
        setLoading(false)
        setError(err instanceof Error ? err.message : "Error de búsqueda")
      }
    },
    [clearPoll]
  )

  const cancel = useCallback(() => {
    abortRef.current = true
    clearPoll()
    setLoading(false)
  }, [clearPoll])

  return { results, loading, error, runSearch, cancel }
}
