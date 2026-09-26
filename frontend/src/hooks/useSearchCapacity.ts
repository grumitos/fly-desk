import { useEffect, useState } from "react"
import { readSearchCapacity, type SearchCapacity } from "@/lib/api"

/* The server holds a read this long when nothing changes. */
const CAPACITY_WAIT_MS = 25_000
/* After a failed read, the next waits this long, doubling up to the ceiling. */
const RETRY_FIRST_MS = 2_000
const RETRY_CEILING_MS = 30_000

/**
 * The runner's shared search capacity, followed as it changes: each read is
 * held by the server until the capacity moves, and the next one leaves as soon
 * as it answers. The reading stops while the tab is hidden, and a tab shown
 * again reads at once. A read that fails leaves no reading, `null`, and is
 * tried again later: the top bar goes blank rather than reporting anything.
 */
export function useSearchCapacity(): SearchCapacity | null {
  const [capacity, setCapacity] = useState<SearchCapacity | null>(null)

  useEffect(() => {
    let reading: AbortController | null = null
    let retryTimer: number | undefined
    let generation = 0

    const pause = () => {
      generation += 1
      reading?.abort()
      reading = null
      window.clearTimeout(retryTimer)
    }

    const follow = async (own: number) => {
      let version: string | undefined
      let failures = 0
      while (own === generation) {
        const controller = new AbortController()
        reading = controller
        try {
          const next = await readSearchCapacity(version, CAPACITY_WAIT_MS, controller.signal)
          if (own !== generation) return
          failures = 0
          version = next.version
          setCapacity(next)
        } catch {
          if (own !== generation) return
          failures += 1
          version = undefined
          setCapacity(null)
          await new Promise<void>((resolve) => {
            retryTimer = window.setTimeout(resolve, Math.min(RETRY_CEILING_MS, RETRY_FIRST_MS * 2 ** (failures - 1)))
          })
        }
      }
    }

    const resume = () => {
      pause()
      void follow(generation)
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        pause()
      } else {
        resume()
      }
    }

    if (document.visibilityState !== "hidden") resume()
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange)
      pause()
    }
  }, [])

  return capacity
}
