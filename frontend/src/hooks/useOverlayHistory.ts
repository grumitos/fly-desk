import { useCallback, useEffect, useId, useRef } from "react"

/*
 * The system back, for any layer that opens over the view.
 *
 * On a phone this application is one page: there is nothing behind it, so
 * Android's back button — and the edge gesture that drives it, and the
 * browser's own back — took the agent out of the application with the layer
 * still open. The platform convention says something else: back undoes the last
 * step, and opening a sheet is a step.
 *
 * There is one rule. On opening, a layer pushes a history entry marked with a
 * token of its own; going back over it closes the layer. And the cross, the
 * scrim and `Esc` do not close by hand — they ask for the traversal, so they
 * leave down the same road as the gesture. One way out is what keeps the tap
 * and the gesture from drifting apart.
 *
 * Three things this owes that a copy of it in each component did not give:
 *
 *   · closing by a layer's own control *consumes* the entry, so opening and
 *     closing n times leaves the history where it started instead of n steps of
 *     rubbish behind it;
 *   · a layer never goes back twice — `pendingBack` covers the window between
 *     asking for the traversal and receiving the `popstate`, which is
 *     asynchronous and during which the component can unmount for any other
 *     reason;
 *   · a layer only ever consumes *its own* entry. If another opened on top, or
 *     something rewrote the state underneath it, this one leaves without
 *     touching the history at all.
 *
 * On that last one: `lib/search-share.ts` calls `replaceState(null, …)` every
 * time a search writes itself onto the address bar, and that clears the whole
 * state object. When it happens with a layer open the mark disappears, so the
 * layer stops claiming the entry and closes by hand instead. That is the right
 * way out — an orphan entry costs less than a traversal that eats somebody
 * else's step.
 */

/**
 * The key inside `history.state`. It has been `fdSheet` since only sheets
 * pushed history, and it stays that on purpose: the name is a contract written
 * down in `lib/search-share.ts` and read by the interface tests.
 */
export const OVERLAY_HISTORY_KEY = "fdSheet"

function currentMark(): unknown {
  if (typeof window === "undefined") return undefined
  return (window.history.state as Record<string, unknown> | null)?.[OVERLAY_HISTORY_KEY]
}

/**
 * Give a layer its history entry, and hand back the only way to close it.
 *
 * `label` goes into the mark so a history read in the inspector says which
 * surface put it there; the identity itself comes from this instance's `useId`.
 */
export function useOverlayHistory(
  open: boolean,
  onClose: () => void,
  label: string,
): { requestClose: () => void } {
  const instanceId = useId()
  const historyToken = `${label}-${instanceId}`
  const onCloseRef = useRef(onClose)
  /* The asynchronous window between `history.back()` and its `popstate`:
     without this an unmount in the middle would go back a second time and take
     the agent out of the application. */
  const pendingBackRef = useRef(false)
  /* Whether this instance owns an entry right now. */
  const ownedRef = useRef(false)
  /* The timer that gives it back — see the note below on why the release is
     deferred by a tick rather than done in the cleanup itself. */
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

    /*
     * Pushing and releasing are idempotent on purpose, and not as a concession
     * to a test: `StrictMode` mounts, unmounts and mounts every effect again
     * inside one commit, and a history entry is not a subscription that can be
     * thrown away and remade unnoticed. Without `ownedRef` that cycle left two
     * entries and a pending traversal, which is exactly the rubbish this module
     * exists not to leave.
     *
     * The release is deferred by a tick for the same reason: a cleanup followed
     * by a mount in the same tick cancels itself and the entry never moves. When
     * the unmount is real the tick changes nothing — the layer is already gone
     * from the screen.
     */
    if (releaseRef.current !== null) {
      window.clearTimeout(releaseRef.current)
      releaseRef.current = null
    }
    if (!ownedRef.current) {
      pendingBackRef.current = false
      window.history.pushState({ ...window.history.state, [OVERLAY_HISTORY_KEY]: token }, "")
      ownedRef.current = true
    }

    /*
     * A traversal is heard by every open layer, not only by the top one, and
     * with two stacked — the quotation over the detail sheet — one back closed
     * both: the agent lost the offer they were quoting instead of returning to
     * it. The same question `lib/overlay-stack.ts` answers for `Esc`, answered
     * here with what is already at hand: **close the layer whose mark has
     * stopped being the current one**. Going back from the top one leaves the
     * mark of the one below, so the one below recognises itself and stays.
     */
    const handlePopState = () => {
      pendingBackRef.current = false
      if (currentMark() === token) return
      /* The entry is gone — the traversal spent it, so there is nothing left to
         give back. */
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
        /* The entry is consumed on the way out, wherever the close came from.
           If the traversal is already asked for, or the mark is no longer ours,
           there is nothing to consume. */
        if (!pendingBackRef.current && currentMark() === token) window.history.back()
        pendingBackRef.current = false
      }, 0)
    }
  }, [close, historyToken, open])

  return { requestClose }
}
