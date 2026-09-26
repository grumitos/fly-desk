const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",")

/** The first control a panel opens on. */
export function firstFocusable(panel: HTMLElement | null): HTMLElement | null {
  return panel?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? null
}

/** The controls Tab moves through inside a panel, in order: enabled and drawn. */
export function focusableWithin(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => !element.hasAttribute("disabled") && element.offsetParent !== null)
}
