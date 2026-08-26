/*
 * The one place JavaScript is allowed to ask about motion.
 *
 * 07 §0 rule 5 applies to WAAPI and to any timer that keeps a node alive for an
 * exit animation: neither is CSS, so neither is covered by the
 * `prefers-reduced-motion` block in `design-system.css`.
 *
 * Nothing here asks `matchMedia` any more, and that is the point rather than an
 * omission: `motionToken` reads the duration out of the cascade, where the
 * `prefers-reduced-motion` block has already zeroed it, so the setting reaches
 * JavaScript without JavaScript having a second opinion about it. A
 * `prefersReducedMotion()` helper sat here with no caller for exactly that
 * reason and is gone.
 */

/**
 * Read one of the `--fd-dur-*` / `--fd-cue-*` tokens, in milliseconds.
 *
 * The choreography of 07 §1 has two pieces JavaScript has to drive — the FLIP
 * of the field block and the FLIP of the mode + trip segments — and the rest is
 * CSS. Asking the cascade for the number keeps one copy of the table: the
 * `prefers-reduced-motion` block already zeroes these properties, so a FLIP
 * that reads them stops travelling without a second media query of its own.
 *
 * Returns 0 for an unknown or malformed token, which is the safe answer: no
 * delay, no movement.
 */
export function motionToken(name: string, element?: Element | null): number {
  if (typeof window === "undefined" || typeof getComputedStyle !== "function") return 0

  const scope = element ?? document.documentElement
  const raw = getComputedStyle(scope).getPropertyValue(name).trim()
  if (!raw) return 0

  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value)) return 0
  return raw.endsWith("ms") ? value : raw.endsWith("s") ? value * 1000 : 0
}

/**
 * The class `design-system.css` watches for while a theme swap is in flight.
 * Exported so a test can assert the contract instead of retyping the string.
 */
export const THEME_SWAP_CLASS = "fd-theme-swap"

/**
 * 07 §5 from the other side: the theme swap is on the list of things that never
 * animate, and CSS alone cannot enforce it — a `background-color` transition
 * looks identical whether a hover or a new palette caused it. So the root is
 * marked, the palette changes with transitions silenced, and the mark comes off
 * on the next frame.
 *
 * The forced reflow is the whole trick. Without it the browser folds "add
 * class, change theme, remove class" into a single style pass, sees only the
 * old colour and the new one, and transitions between them anyway.
 *
 * Wrap the toggle, do not call this before it:
 *
 *     withoutThemeTransition(() => syncTheme(next))
 */
export function withoutThemeTransition(applyTheme: () => void): void {
  if (typeof document === "undefined") {
    applyTheme()
    return
  }

  const root = document.documentElement
  root.classList.add(THEME_SWAP_CLASS)
  applyTheme()
  /* Read a layout property to flush the new palette without transitions. */
  void root.offsetHeight

  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    root.classList.remove(THEME_SWAP_CLASS)
    return
  }
  window.requestAnimationFrame(() => root.classList.remove(THEME_SWAP_CLASS))
}
