const LOCAL_RESULTS_LAYOUT_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])

export function isLocalResultsLayoutHost(hostname: string) {
  return LOCAL_RESULTS_LAYOUT_HOSTS.has(hostname.trim().toLowerCase())
}

export function resultsLayoutPersistenceEnabled(hostname?: string) {
  const currentHostname = hostname ?? (typeof window === "undefined" ? "" : window.location.hostname)
  return isLocalResultsLayoutHost(currentHostname)
}

export function resultsLayoutEditorEnabledFromUrl(url?: string) {
  const currentUrl = url ?? (typeof window === "undefined" ? "" : window.location.href)
  if (!currentUrl) return false

  let parsedUrl: URL
  try {
    const baseUrl = typeof window === "undefined" ? "http://127.0.0.1" : window.location.origin
    parsedUrl = new URL(currentUrl, baseUrl)
  } catch {
    return false
  }

  if (!isLocalResultsLayoutHost(parsedUrl.hostname)) return false

  const raw = String(parsedUrl.searchParams.get("layoutEditor") || parsedUrl.searchParams.get("layout") || "")
    .trim()
    .toLowerCase()
  return raw === "1" || raw === "true" || raw === "editor"
}
