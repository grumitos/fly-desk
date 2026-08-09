import { useCallback, useEffect, useRef, useState } from "react"
import type { LocationSuggestion } from "@/types"
import { getCachedLocationSuggestions, suggestLocations } from "@/lib/api"
import { findLocationSuggestionMatch } from "@/lib/locations"

interface UpdateQueryOptions {
  showSuggestions?: boolean
}

/** 11 §2.1 · «Recientes» only becomes «Coincidencias» at two letters. */
export const MIN_MATCH_QUERY = 2

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

  /* 11 §2.1: with two letters or more «se resalta la primera fila» — and the
     row after it, «resaltado ≠ elegido»: the highlight is where `Enter` would
     land, not a value the field has taken. Left at -1 the agent had to press ↓
     before `Enter` did anything, which is the one keystroke the ficha spends a
     whole row saying should not be needed. */
  const showSuggestions = useCallback((available: LocationSuggestion[]) => {
    setOpen(inputHasFocus() && available.length > 0)
    setActiveIndex(available.length > 0 ? 0 : -1)
  }, [inputHasFocus])

  const openSuggestions = useCallback(() => {
    setOpen(true)
  }, [])

  const warmSuggestions = useCallback(async (q: string) => {
    const requestSeq = ++requestSeqRef.current
    /* 11 §2.1 draws the threshold at two: «escribir 1 letra · nada cambia en la
       lista, se sigue viendo Recientes». So one letter clears the matches but
       does **not** close the panel — closing it would take Recientes away, which
       is the very thing that row says stays. */
    if (q.trim().length < MIN_MATCH_QUERY) {
      setSuggestions([])
      setActiveIndex(-1)
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
