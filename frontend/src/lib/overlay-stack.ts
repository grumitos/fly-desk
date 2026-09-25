/*
 * Which modal surface owns `Esc` (01 §8: the most recent one). Every surface
 * listens on `document`, so they agree on order here; a stack, because layers
 * do not always close in the order they opened.
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

/** Whether anything modal is open; the shell's keyboard layer then stands down (11 §7). */
export function hasOpenOverlay(): boolean {
  return stack.length > 0
}
