import { Plane } from "lucide-react"
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

function SunIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </svg>
  )
}

function MoonIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20.99 12.42A8.5 8.5 0 1 1 11.58 3.01 6.5 6.5 0 0 0 20.99 12.42Z" />
    </svg>
  )
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
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
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
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary text-primary">
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
          <div className="inline-flex items-center rounded-lg border border-input bg-secondary p-0.5 text-muted-foreground">
            <ThemeToggle theme={theme} setTheme={setTheme} />
          </div>
        </div>
      </div>
    </header>
  )
}
