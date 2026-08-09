import { useEffect, useState } from "react"
import { motionToken } from "@/lib/reduced-motion"

/*
 * 07 §1 — the two halves of the reposo → activo choreography that CSS cannot do
 * on its own.
 *
 * The table is transcribed in `index.css`, where every piece that merely
 * appears or fades is a cue plus one of the six tokens. Two rows are not that:
 *
 *   60 ms  bloque de campos    `translateY` al tope
 *   60 ms  modo + tipo de viaje  FLIP del formulario a la barra de título
 *
 * Both are elements that end up somewhere else in the document — the segments
 * literally change parent — so nothing in CSS knows where they came from. That
 * is a FLIP: measure before, measure after, play the difference away.
 *
 * Every number still comes from the cascade through `motionToken`, so the
 * `prefers-reduced-motion` block reaches these two rows as it reaches the rest.
 */

/** How long the idle-only furniture stays mounted so it can fade out (07 §1). */
export function idleExitDuration(): number {
  return motionToken("--fd-cue-salida") + motionToken("--fd-dur-salida-reposo")
}

/**
 * The phone's one-line summary going out on the way back to editing (2h,
 * «el resumen se funde»). Rule 1 prices a departure at half of the arrival it
 * belongs to, and the arrival here is the 180ms of the whole return.
 */
export function returnExitDuration(): number {
  return motionToken("--fd-dur-vuelta") / 2
}

/** The 420ms the table lasts: how long the arrival cues stay armed. */
export const ENTERING_WINDOW_MS = 420

export type FlipRect = Pick<DOMRect, "left" | "top" | "width" | "height">

export function measureFlip(node: Element | null | undefined): FlipRect | null {
  if (!node) return null
  const rect = node.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

/**
 * Play `from` → wherever `node` is now.
 *
 * `matchWidth` is for the block of fields, which is 1180px at rest and the full
 * measure once active: without it the FLIP slides a box that is also snapping
 * to a new width, and the snap is what the eye catches. The segments do not
 * take it — 07 §1 is explicit that they keep «mismo tamaño y peso: solo cambia
 * de sitio».
 *
 * `matchHeight` is «el bloque crece a su alto natural» (2h, the mobile return),
 * where the box does not move at all: it stays pinned under the title bar and
 * only gets taller. Hence the bail-out below asks whether *anything* asked for
 * changed, not just the position — measuring position alone is what left that
 * growth as a jump.
 */
export function playFlip(
  node: HTMLElement,
  from: FlipRect,
  {
    delay,
    duration,
    matchWidth = false,
    matchHeight = false,
  }: { delay: number; duration: number; matchWidth?: boolean; matchHeight?: boolean },
): Animation | null {
  if (duration <= 0) return null
  if (typeof node.animate !== "function") return null

  const to = node.getBoundingClientRect()
  const deltaX = from.left - to.left
  const deltaY = from.top - to.top
  const moved = Math.abs(deltaX) >= 0.5 || Math.abs(deltaY) >= 0.5
  const resized = matchHeight && Math.abs(from.height - to.height) >= 0.5
  if (!moved && !resized) return null

  const start: Keyframe = { transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` }
  const end: Keyframe = { transform: "translate3d(0, 0, 0)" }
  if (matchWidth) {
    start.width = `${from.width}px`
    end.width = `${to.width}px`
  }
  if (matchHeight) {
    start.height = `${from.height}px`
    end.height = `${to.height}px`
    start.overflow = "hidden"
    end.overflow = "hidden"
  }

  return node.animate([start, end], {
    delay,
    duration,
    easing: getComputedStyle(node).getPropertyValue("--fd-ease-estructura").trim() || "ease",
    /* The delay is dead time, and dead time in a FLIP means the element is
       already at its destination while the table says it has not moved yet.
       `backwards` holds the first frame through the cue. */
    fill: "backwards",
  })
}

/**
 * Keep something mounted for a while after it stops being wanted.
 *
 * The frequent chips and the provider rail belong to the idle screen and 07 §1
 * gives them an exit; React's answer to "not idle any more" is to unmount them,
 * which is the one thing an exit cannot survive. This holds them for exactly
 * the length of their own row of the table and marks them `leaving` meanwhile.
 *
 * The window is read when the exit starts rather than on every render, because
 * that is the moment `prefers-reduced-motion` has to be honoured: under it the
 * tokens are 0ms and the node is dropped in the same tick.
 */
export function useLeaveWindow(
  present: boolean,
  duration: () => number,
): { mounted: boolean; leaving: boolean } {
  const [leaving, setLeaving] = useState(false)
  const [wasPresent, setWasPresent] = useState(present)

  /* Adjusted while rendering rather than in an effect, which is the one way the
     mark and the disappearance land in the same commit. From an effect the node
     would spend a frame unmarked and blink out before it could fade. */
  if (wasPresent !== present) {
    setWasPresent(present)
    setLeaving(!present)
  }

  /* `duration` is read here rather than captured earlier because this is the
     moment `prefers-reduced-motion` has to be honoured: under it the tokens are
     0ms and the node is dropped on the next tick. Callers pass one of the
     module-level readers, so the identity is stable. */
  useEffect(() => {
    if (!leaving) return
    const timer = window.setTimeout(() => setLeaving(false), duration())
    return () => window.clearTimeout(timer)
  }, [duration, leaving])

  return { mounted: present || leaving, leaving }
}
