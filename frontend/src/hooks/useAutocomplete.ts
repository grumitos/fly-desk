import { useCallback, useEffect, useRef, useState } from "react"
import type { LocationSuggestion } from "@/types"
import { suggestLocations } from "@/lib/api"

export function useAutocomplete(field: "origin" | "destination") {
  void field

  const [query, setQuery] = useState("")
  const [suggestions, setSuggestions] = useState<LocationSuggestion[]>([])
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const debounceRef = useRef<number | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const requestSeqRef = useRef(0)

  const fetchSuggestions = useCallback(async (q: string) => {
    const requestSeq = ++requestSeqRef.current
    if (q.length < 2) {
      setSuggestions([])
      return
    }
    try {
      const items = await suggestLocations(q)
      if (requestSeq === requestSeqRef.current) {
        setSuggestions(items)
      }
    } catch {
      if (requestSeq === requestSeqRef.current) {
        setSuggestions([])
      }
    }
  }, [])

  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => fetchSuggestions(query), 180)
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current)
    }
  }, [query, fetchSuggestions])

  const selectSuggestion = useCallback((s: LocationSuggestion) => {
    setQuery(s.label)
    setOpen(false)
    setActiveIndex(-1)
  }, [])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setOpen(true)
        setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1))
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        setOpen(true)
        setActiveIndex((i) => Math.max(i - 1, -1))
      } else if (e.key === "Enter") {
        e.preventDefault()
        if (activeIndex >= 0 && suggestions[activeIndex]) {
          selectSuggestion(suggestions[activeIndex])
        }
      } else if (e.key === "Escape") {
        setOpen(false)
      }
    },
    [activeIndex, selectSuggestion, suggestions]
  )

  return {
    query,
    setQuery,
    suggestions,
    open,
    setOpen,
    activeIndex,
    setActiveIndex,
    onKeyDown,
    selectSuggestion,
    inputRef,
  }
}
