/*
 * `false` when the browser blocked the window. `noopener` is left out of the
 * features because with it `window.open` always returns null; the opener is cut
 * here instead, before the new document can run.
 */
export function openInNewTab(url: string): boolean {
  const opened = window.open(url, "_blank")
  if (!opened) return false
  opened.opener = null
  return true
}
