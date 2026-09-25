import { useEffect, useState } from "react"
import { motionToken } from "@/lib/reduced-motion"

/* The idle-to-active moves CSS cannot do alone (the segments change parent),
   played as transform-only FLIPs on the motion tokens, so reduced motion stops
   them with everything else. */

/** How long the idle-only furniture stays mounted so it can fade out. */
export function idleExitDuration(): number {
  return motionToken("--fd-cue-salida") + motionToken("--fd-dur-salida-reposo")
}

/** The phone's one-line summary leaving on the way back to editing. */
export function returnExitDuration(): number {
  return motionToken("--fd-dur-vuelta") / 2
}

/** How long the arrival cues stay armed: the last cue plus its movement. */
export function enteringWindow(): number {
  return motionToken("--fd-cue-esqueleto") + motionToken("--fd-dur-estructura")
}

export type FlipRect = Pick<DOMRect, "left" | "top" | "width" | "height">

export function measureFlip(node: Element | null | undefined): FlipRect | null {
  if (!node) return null
  const rect = node.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

/**
 * Move `node` so `anchor` (default: the node) starts at `from` and eases home.
 * `centered` travels centre to centre and fades up from half opacity, so a new
 * width does not jump; `reveal` unclips a box that grew in place.
 */
export function playFlip(
  node: HTMLElement,
  from: FlipRect,
  {
    delay,
    duration,
    anchor = node,
    centered = false,
    reveal = false,
  }: { delay: number; duration: number; anchor?: Element; centered?: boolean; reveal?: boolean },
): Animation | null {
  if (duration <= 0) return null
  if (typeof node.animate !== "function") return null

  const to = anchor.getBoundingClientRect()
  const deltaX = centered ? from.left + from.width / 2 - (to.left + to.width / 2) : from.left - to.left
  const deltaY = from.top - to.top
  const hidden = reveal ? Math.max(0, to.height - from.height) : 0
  if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5 && hidden < 0.5) return null

  const start: Keyframe = { transform: `translate(${deltaX}px, ${deltaY}px)` }
  const end: Keyframe = { transform: "none" }
  if (centered && Math.abs(from.width - to.width) >= 1) {
    start.opacity = 0.5
    end.opacity = 1
  }
  if (hidden >= 0.5) {
    start.clipPath = `inset(0 0 ${hidden}px 0)`
    end.clipPath = "inset(0 0 0 0)"
  }

  return node.animate([start, end], {
    delay,
    duration,
    easing: getComputedStyle(node).getPropertyValue("--fd-ease-estructura").trim() || "ease",
    /* Hold the first frame through the delay, or the node would sit at its
       destination before it has started to move. */
    fill: "backwards",
  })
}

/**
 * Keep something mounted for `duration()` after it stops being wanted, marked
 * `leaving`, so it can play an exit. The duration is read when the exit starts,
 * which is when reduced motion (0ms) has to be honoured.
 */
export function useLeaveWindow(
  present: boolean,
  duration: () => number,
): { mounted: boolean; leaving: boolean } {
  const [leaving, setLeaving] = useState(false)
  const [wasPresent, setWasPresent] = useState(present)

  /* Adjusted while rendering so the mark and the disappearance land in the
     same commit; from an effect the node would blink out for a frame. */
  if (wasPresent !== present) {
    setWasPresent(present)
    setLeaving(!present)
  }

  useEffect(() => {
    if (!leaving) return
    const timer = window.setTimeout(() => setLeaving(false), duration())
    return () => window.clearTimeout(timer)
  }, [duration, leaving])

  return { mounted: present || leaving, leaving }
}
