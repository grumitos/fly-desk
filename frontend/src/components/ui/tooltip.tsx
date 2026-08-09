import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"

import { cn } from "@/lib/utils"

/*
 * 01 §7: tooltips exist only on icons with no label. Ink background, page
 * colour for the text, 12px, radius 8, no arrow, 300ms of delay, and they enter
 * with `emergente`. Nothing about them is decorative — a tooltip over text that
 * is already on screen is noise, so those call sites are the bug, not this
 * component.
 */
function TooltipProvider({
  delayDuration = 300,
  skipDelayDuration = 150,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      {...props}
    />
  )
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn("fd-tooltip fd-motion-emergente", className)}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

/**
 * 6b closes the keyboard map with one rule: «cada atajo aparece en el tooltip
 * de su control». That is not the repetition 01 §7 forbids — the key is the one
 * thing about the control that is *not* on screen — so a labelled button may
 * carry a tooltip as long as the tooltip is the shortcut.
 *
 * A disabled control still explains itself: the trigger is a span around it, so
 * the reason arrives even where the button itself no longer takes a pointer.
 */
function ShortcutTooltip({
  children,
  label,
  shortcut,
  disabled = false,
}: {
  children: React.ReactElement
  label: string
  shortcut: React.ReactNode
  disabled?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {disabled ? <span className="fd-tooltip-trigger-shim">{children}</span> : children}
      </TooltipTrigger>
      <TooltipContent className="fd-tooltip-shortcut">
        {label}
        {shortcut}
      </TooltipContent>
    </Tooltip>
  )
}

export { ShortcutTooltip, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
