import { Moon, Plane, Sun } from "lucide-react"
import { useEffect, useState } from "react"

function getInitialTheme(): "light" | "dark" {
  try {
    const saved = localStorage.getItem("flydesk-theme")
    if (saved === "light" || saved === "dark") return saved
  } catch {
    return "light"
  }

  return document.documentElement.classList.contains("dark") ? "dark" : "light"
}

function syncTheme(theme: "light" | "dark") {
  document.documentElement.classList.toggle("dark", theme === "dark")

  try {
    localStorage.setItem("flydesk-theme", theme)
  } catch {
    return
  }
}

export function TopBar() {
  const [theme, setTheme] = useState<"light" | "dark">(getInitialTheme)

  useEffect(() => {
    syncTheme(theme)
  }, [theme])

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-card/95 backdrop-blur">
      <div className="mx-auto flex min-h-12 max-w-[1560px] flex-wrap items-center justify-between gap-2 px-3 py-2 sm:px-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-primary">
            <Plane className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-bold text-foreground">Fly Desk</span>
            </div>
          </div>
        </div>

        <div aria-hidden="true" />

        <div className="flex items-center gap-1.5">
          <div className="inline-flex items-center rounded-lg border border-input bg-secondary p-0.5">
            <button
              type="button"
              onClick={() => setTheme("light")}
              aria-pressed={theme === "light"}
              className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                theme === "light" ? "bg-card text-primary shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
              aria-label="Tema claro"
            >
              <Sun className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setTheme("dark")}
              aria-pressed={theme === "dark"}
              className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                theme === "dark" ? "bg-card text-primary shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
              aria-label="Tema oscuro"
            >
              <Moon className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    </header>
  )
}
