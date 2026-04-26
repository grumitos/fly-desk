import { useCallback, useEffect, useRef, useState } from "react"
import type { LocationSuggestion } from "@/types"
import { getCachedLocationSuggestions, suggestLocations } from "@/lib/api"
import { findLocationSuggestionMatch } from "@/lib/locations"

export function useAutocomplete(
  field: "origin" | "destination",
  onResolved?: (suggestion: LocationSuggestion) => void
) {
  void field

  const [query, setQuery] = useState("")
  const [suggestions, setSuggestions] = useState<LocationSuggestion[]>([])
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const debounceRef = useRef<number | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const requestSeqRef = useRef(0)
  const resolvedLabelRef = useRef("")
  const queryRef = useRef("")
  const onResolvedRef = useRef(onResolved)

  useEffect(() => {
    onResolvedRef.current = onResolved
  }, [onResolved])

  const updateQuery = useCallback((value: string) => {
    queryRef.current = value
    setQuery(value)
  }, [])

  const warmSuggestions = useCallback(async (q: string) => {
    const requestSeq = ++requestSeqRef.current
    if (q.length < 2) {
      setSuggestions([])
      setOpen(false)
      return
    }

    const cached = getCachedLocationSuggestions(q)
    setSuggestions(cached)
    setOpen(cached.length > 0)
    setActiveIndex(-1)

    try {
      await suggestLocations(q)
    } catch {
      if (requestSeq === requestSeqRef.current) {
        setSuggestions([])
        setOpen(false)
      }
    }
  }, [])

  useEffect(() => {
    if (query && query === resolvedLabelRef.current) {
      setSuggestions([])
      setOpen(false)
      return
    }

    if (debounceRef.current) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => warmSuggestions(query), 180)
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current)
    }
  }, [query, warmSuggestions])

  const selectSuggestion = useCallback((s: LocationSuggestion) => {
    resolvedLabelRef.current = s.label
    queryRef.current = s.label
    setQuery(s.label)
    setOpen(false)
    setActiveIndex(-1)
    onResolvedRef.current?.(s)
  }, [])

  const resolveCurrentQuery = useCallback(async (): Promise<LocationSuggestion | undefined> => {
    const value = queryRef.current.trim()
    requestSeqRef.current += 1
    if (debounceRef.current) window.clearTimeout(debounceRef.current)

    if (!value || value === resolvedLabelRef.current) {
      setSuggestions([])
      setOpen(false)
      setActiveIndex(-1)
      return undefined
    }

    const cached = getCachedLocationSuggestions(value)
    let exactMatch = findLocationSuggestionMatch(value, cached)

    if (!exactMatch && value.length >= 2) {
      try {
        exactMatch = findLocationSuggestionMatch(value, await suggestLocations(value))
      } catch {
        exactMatch = undefined
      }
    }

    if (exactMatch) {
      resolvedLabelRef.current = exactMatch.label
      queryRef.current = exactMatch.label
      setQuery(exactMatch.label)
      onResolvedRef.current?.(exactMatch)
    }

    setSuggestions([])
    setOpen(false)
    setActiveIndex(-1)
    return exactMatch
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
    setQuery: updateQuery,
    suggestions,
    open,
    setOpen,
    activeIndex,
    setActiveIndex,
    onKeyDown,
    resolveCurrentQuery,
    selectSuggestion,
    inputRef,
  }
}
