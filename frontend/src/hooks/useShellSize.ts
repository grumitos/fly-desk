import { useLayoutEffect, useState, type RefObject } from "react"

export type ShellSize = "A" | "B" | "C"

function shellSizeForWidth(width: number): ShellSize {
  if (width >= 1100) return "A"
  if (width >= 720) return "B"
  return "C"
}

export function useShellSize(shellRef: RefObject<HTMLElement | null>): ShellSize {
  const [shellSize, setShellSize] = useState<ShellSize>("A")

  useLayoutEffect(() => {
    const shell = shellRef.current
    if (!shell) return

    const update = (width: number) => {
      setShellSize((current) => {
        const next = shellSizeForWidth(width)
        return current === next ? current : next
      })
    }

    update(shell.getBoundingClientRect().width)
    const observer = new ResizeObserver(([entry]) => {
      if (entry) update(entry.contentRect.width)
    })
    observer.observe(shell)
    return () => observer.disconnect()
  }, [shellRef])

  return shellSize
}
