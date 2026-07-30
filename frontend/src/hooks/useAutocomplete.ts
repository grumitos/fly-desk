import { useCallback, useEffect, useRef, useState } from "react"
import type { LocationSuggestion } from "@/types"
import { getCachedLocationSuggestions, suggestLocations } from "@/lib/api"
import { findLocationSuggestionMatch } from "@/lib/locations"

interface UpdateQueryOptions {
  showSuggestions?: boolean
}

export function useAutocomplete(onResolved?: (suggestion: LocationSuggestion) => void) {
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
  const shouldWarmQueryRef = useRef(false)

  useEffect(() => {
    onResolvedRef.current = onResolved
  }, [onResolved])

  const inputHasFocus = useCallback(() => inputRef.current === document.activeElement, [])

  const closeSuggestions = useCallback(() => {
    setSuggestions([])
    setOpen(false)
    setActiveIndex(-1)
  }, [])

  const updateQuery = useCallback((value: string, options: UpdateQueryOptions = {}) => {
    requestSeqRef.current += 1
    queryRef.current = value
    shouldWarmQueryRef.current = Boolean(options.showSuggestions)
    setQuery(value)
    if (!options.showSuggestions) {
      closeSuggestions()
    }
  }, [closeSuggestions])

  const showSuggestions = useCallback((available: LocationSuggestion[]) => {
    setOpen(inputHasFocus() && available.length > 0)
    setActiveIndex(-1)
  }, [inputHasFocus])

  const openSuggestions = useCallback(() => {
    setOpen(true)
  }, [])

  const warmSuggestions = useCallback(async (q: string) => {
    const requestSeq = ++requestSeqRef.current
    if (q.trim().length < 1) {
      closeSuggestions()
      return
    }

    const cached = getCachedLocationSuggestions(q)
    setSuggestions(cached)
    showSuggestions(cached)
    if (cached.length > 0) {
      return
    }

    try {
      const fresh = await suggestLocations(q)
      if (requestSeq === requestSeqRef.current && queryRef.current === q) {
        setSuggestions(fresh)
        showSuggestions(fresh)
      }
    } catch {
      if (requestSeq === requestSeqRef.current) {
        closeSuggestions()
      }
    }
  }, [closeSuggestions, showSuggestions])

  useEffect(() => {
    if (query && query === resolvedLabelRef.current) {
      closeSuggestions()
      return
    }

    if (!shouldWarmQueryRef.current || !inputHasFocus()) {
      closeSuggestions()
      return
    }

    if (debounceRef.current) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => warmSuggestions(query), 180)
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current)
    }
  }, [closeSuggestions, inputHasFocus, query, warmSuggestions])

  const selectSuggestion = useCallback((s: LocationSuggestion) => {
    resolvedLabelRef.current = s.label
    queryRef.current = s.label
    setQuery(s.label)
    closeSuggestions()
    onResolvedRef.current?.(s)
  }, [closeSuggestions])

  const resolveCurrentQuery = useCallback(async (): Promise<LocationSuggestion | undefined> => {
    const value = queryRef.current.trim()
    const requestSeq = ++requestSeqRef.current
    if (debounceRef.current) window.clearTimeout(debounceRef.current)

    if (!value || value === resolvedLabelRef.current) {
      closeSuggestions()
      return undefined
    }

    const cached = getCachedLocationSuggestions(value)
    let exactMatch = findLocationSuggestionMatch(value, cached)

    if (!exactMatch && value.length >= 1) {
      try {
        const fresh = await suggestLocations(value)
        if (requestSeq !== requestSeqRef.current || queryRef.current.trim() !== value) {
          return undefined
        }
        exactMatch = findLocationSuggestionMatch(value, fresh)
      } catch {
        if (requestSeq !== requestSeqRef.current || queryRef.current.trim() !== value) {
          return undefined
        }
        exactMatch = undefined
      }
    }

    if (requestSeq !== requestSeqRef.current || queryRef.current.trim() !== value) {
      return undefined
    }

    if (exactMatch) {
      resolvedLabelRef.current = exactMatch.label
      queryRef.current = exactMatch.label
      setQuery(exactMatch.label)
      onResolvedRef.current?.(exactMatch)
    }

    closeSuggestions()
    return exactMatch
  }, [closeSuggestions])

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
    openSuggestions,
    activeIndex,
    setActiveIndex,
    onKeyDown,
    resolveCurrentQuery,
    selectSuggestion,
    inputRef,
  }
}
