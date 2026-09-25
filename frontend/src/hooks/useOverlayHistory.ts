import { useCallback, useEffect, useId, useRef } from "react"

/*
 * The system back closes the layer on top. Opening a layer pushes a history
 * entry marked with its own token; its cross, scrim and `Esc` ask for the
 * traversal instead of closing by hand, so tap and gesture leave the same way.
 * A layer consumes only its own entry, and never goes back twice: `pendingBack`
 * covers the gap between `history.back()` and its `popstate`.
 */

const OVERLAY_HISTORY_KEY = "fdSheet"

function currentMark(): unknown {
  if (typeof window === "undefined") return undefined
  return (window.history.state as Record<string, unknown> | null)?.[OVERLAY_HISTORY_KEY]
}

/** Gives a layer its history entry and returns the only way to close it. */
export function useOverlayHistory(
  open: boolean,
  onClose: () => void,
  label: string,
): { requestClose: () => void } {
  const instanceId = useId()
  const historyToken = `${label}-${instanceId}`
  const onCloseRef = useRef(onClose)
  const pendingBackRef = useRef(false)
  const ownedRef = useRef(false)
  const releaseRef = useRef<number | null>(null)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  const close = useCallback(() => onCloseRef.current(), [])

  const requestClose = useCallback(() => {
    if (pendingBackRef.current) return
    if (currentMark() === historyToken) {
      pendingBackRef.current = true
      window.history.back()
      return
    }
    close()
  }, [close, historyToken])

  useEffect(() => {
    if (!open) return

    const token = historyToken

    /* Idempotent, because `StrictMode` unmounts and remounts inside one commit
       and a history entry cannot be thrown away and remade unnoticed. The
       release waits a tick so that cycle cancels itself. */
    if (releaseRef.current !== null) {
      window.clearTimeout(releaseRef.current)
      releaseRef.current = null
    }
    if (!ownedRef.current) {
      pendingBackRef.current = false
      window.history.pushState({ ...window.history.state, [OVERLAY_HISTORY_KEY]: token }, "")
      ownedRef.current = true
    }

    /* Every open layer hears a traversal. Going back from the top one leaves
       the mark of the one below, so only the layer whose mark stopped being
       current closes. */
    const handlePopState = () => {
      pendingBackRef.current = false
      if (currentMark() === token) return
      ownedRef.current = false
      close()
    }
    window.addEventListener("popstate", handlePopState)

    return () => {
      window.removeEventListener("popstate", handlePopState)
      releaseRef.current = window.setTimeout(() => {
        releaseRef.current = null
        if (!ownedRef.current) return
        ownedRef.current = false
        if (!pendingBackRef.current && currentMark() === token) window.history.back()
        pendingBackRef.current = false
      }, 0)
    }
  }, [close, historyToken, open])

  return { requestClose }
}
