export const BROWSER_CLIENT_SESSION_STORAGE_KEY = "fly-desk:client-session-id"

const CLIENT_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$/

export function normalizeBrowserClientSessionId(value: unknown): string | undefined {
  return typeof value === "string" && CLIENT_SESSION_ID_PATTERN.test(value)
    ? value
    : undefined
}

function generateBrowserClientSessionId(): string | undefined {
  if (typeof crypto === "undefined") {
    return undefined
  }

  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }

  if (typeof crypto.getRandomValues !== "function") {
    return undefined
  }

  const bytes = crypto.getRandomValues(new Uint8Array(18))
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")
}

export function getBrowserClientSessionId(): string | undefined {
  if (typeof window === "undefined") {
    return undefined
  }

  try {
    const stored = normalizeBrowserClientSessionId(
      window.sessionStorage.getItem(BROWSER_CLIENT_SESSION_STORAGE_KEY),
    )
    if (stored) {
      return stored
    }

    const generated = generateBrowserClientSessionId()
    if (!generated) {
      return undefined
    }

    window.sessionStorage.setItem(BROWSER_CLIENT_SESSION_STORAGE_KEY, generated)
    return generated
  } catch {
    return undefined
  }
}
