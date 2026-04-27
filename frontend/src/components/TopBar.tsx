import { useEffect, useState } from "react"
import { AppIcon } from "@/components/ui/app-icon"

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

function ThemeToggle({
  theme,
  setTheme,
}: {
  theme: "light" | "dark"
  setTheme: (theme: "light" | "dark") => void
}) {
  const nextTheme = theme === "dark" ? "light" : "dark"

  return (
    <button
      type="button"
      onClick={() => setTheme(nextTheme)}
      aria-label="Cambiar tema"
      aria-pressed={theme === "dark"}
      className="inline-flex size-7 items-center justify-center rounded-md border border-transparent text-foreground transition-[background-color,border-color,color,box-shadow,transform] duration-150 hover:border-border hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 active:scale-95"
    >
      <AppIcon name={theme === "dark" ? "sun" : "moon"} />
    </button>
  )
}

export function TopBar() {
  const [theme, setTheme] = useState<"light" | "dark">(getInitialTheme)

  useEffect(() => {
    syncTheme(theme)
  }, [theme])

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-card/95 backdrop-blur">
      <div className="mx-auto flex min-h-11 max-w-[1560px] flex-wrap items-center justify-between gap-2 px-3 py-1.5 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center text-primary">
            <AppIcon name="brandPlane" className="h-6 w-6" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-bold text-foreground">Fly Desk</span>
            </div>
          </div>
        </div>

        <div aria-hidden="true" />

        <div className="flex items-center gap-1.5">
          <div className="inline-flex items-center rounded-lg border border-input bg-secondary p-0.5 text-muted-foreground">
            <ThemeToggle theme={theme} setTheme={setTheme} />
          </div>
        </div>
      </div>
    </header>
  )
}
