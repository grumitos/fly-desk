/*
 * Which modal surface owns `Esc`.
 *
 * 01 §8: «`Esc` cierra la hoja o el panel **más reciente**». Every modal
 * surface listens on `document`, so without somewhere to agree on order a
 * single keypress reached the quotation panel *and* the detail sheet under it
 * and closed both — the agent lost the offer they were quoting.
 *
 * A stack rather than a counter: sheets and panels do not always close in the
 * order they opened, and `lastIndexOf` lets a layer leave from the middle
 * without renumbering the ones above it.
 */
const stack: symbol[] = []

export function pushOverlay(label: string): symbol {
  const token = Symbol(label)
  stack.push(token)
  return token
}

export function popOverlay(token: symbol): void {
  const index = stack.lastIndexOf(token)
  if (index >= 0) stack.splice(index, 1)
}

/** True only for the layer that opened last and is still open. */
export function isTopOverlay(token: symbol): boolean {
  return stack.length > 0 && stack[stack.length - 1] === token
}

/**
 * Whether anything modal is open. The shell's keyboard layer stands down when
 * it is: a popover or a sheet traps focus and answers its own keys (11 §7,
 * column «en un emergente / hoja»).
 */
export function hasOpenOverlay(): boolean {
  return stack.length > 0
}
