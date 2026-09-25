import { useEffect, useState } from "react"
import { motionToken } from "@/lib/reduced-motion"

/*
 * The part of the idle to active choreography CSS cannot do alone: the fields
 * rise to the top and the mode segments move into the title bar (they change
 * parent). Both are FLIPs — measure before, measure after, play the difference
 * away — in transforms only, so no frame relayouts. Durations come from the
 * motion tokens, so reduced motion stops them with everything else.
 */

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
 * Move `node` so that `anchor` (by default the node itself) starts at `from`
 * and eases to where it is now.
 *
 * `centered`: the box changes width around a shared centre (the idle form is
 * narrower than the active one), so it travels from centre to centre and takes
 * its new width at once, fading up from half opacity so the change of width
 * does not read as a jump. `reveal`: the box grew in place (the phone form
 * reopening) and is unclipped from its old height.
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
