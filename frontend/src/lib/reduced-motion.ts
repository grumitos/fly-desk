/*
 * JavaScript reads motion from the cascade: the reduced-motion block in
 * design-system.css zeroes the duration tokens, so animations and exit timers
 * driven from here honour the setting without a media query of their own.
 */

/** A `--fd-dur-*` or `--fd-cue-*` token in milliseconds; 0 when unknown. */
export function motionToken(name: string, element?: Element | null): number {
  if (typeof window === "undefined" || typeof getComputedStyle !== "function") return 0

  const scope = element ?? document.documentElement
  const raw = getComputedStyle(scope).getPropertyValue(name).trim()
  if (!raw) return 0

  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value)) return 0
  return raw.endsWith("ms") ? value : raw.endsWith("s") ? value * 1000 : 0
}

/* Watched by design-system.css while a theme swap is in flight. */
const THEME_SWAP_CLASS = "fd-theme-swap"

/**
 * Apply a theme with transitions silenced, since a colour transition cannot
 * tell a hover from a new palette. The forced reflow matters: without it the
 * browser folds add, apply and remove into one style pass and animates anyway.
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
