import * as React from "react"
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from "lucide-react"
import { DayPicker } from "react-day-picker"

import { buttonVariants } from "@/components/ui/button-variants"
import { cn } from "@/lib/utils"

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: React.ComponentProps<typeof DayPicker>) {
  return (
    <DayPicker
      data-slot="calendar"
      showOutsideDays={showOutsideDays}
      className={cn("relative w-fit p-1", className)}
      classNames={{
        root: cn("w-fit", classNames?.root),
        months: cn("flex flex-col gap-4", classNames?.months),
        month: cn("space-y-2", classNames?.month),
        month_caption: cn("flex h-8 items-center justify-center px-8", classNames?.month_caption),
        caption_label: cn("text-sm font-bold capitalize", classNames?.caption_label),
        nav: cn("absolute inset-x-1 top-1 flex items-center justify-between", classNames?.nav),
        button_previous: cn(buttonVariants({ variant: "ghost", size: "icon" }), "h-8 w-8 p-0", classNames?.button_previous),
        button_next: cn(buttonVariants({ variant: "ghost", size: "icon" }), "h-8 w-8 p-0", classNames?.button_next),
        month_grid: cn("w-full border-collapse", classNames?.month_grid),
        weekdays: cn("grid grid-cols-7", classNames?.weekdays),
        weekday: cn("fd-label flex h-7 items-center justify-center", classNames?.weekday),
        weeks: cn("grid gap-1", classNames?.weeks),
        week: cn("grid grid-cols-7 gap-1", classNames?.week),
        day: cn("relative h-9 w-9 p-0 text-center text-sm", classNames?.day),
        day_button: cn(
          buttonVariants({ variant: "ghost", size: "icon" }),
          "h-9 w-9 rounded-lg p-0 font-semibold",
          classNames?.day_button
        ),
        selected: cn(
          "[&>button]:bg-primary [&>button]:text-primary-foreground [&>button]:shadow-sm [&>button]:hover:bg-primary [&>button]:hover:text-primary-foreground [&>button]:focus:bg-primary [&>button]:focus:text-primary-foreground",
          classNames?.selected
        ),
        today: cn("[&>button]:ring-1 [&>button]:ring-primary/45", classNames?.today),
        outside: cn("[&>button]:text-muted-foreground/55", classNames?.outside),
        disabled: cn("[&>button]:pointer-events-none [&>button]:text-muted-foreground/35 [&>button]:line-through", classNames?.disabled),
        range_start: cn("[&>button]:rounded-r-none", classNames?.range_start),
        range_middle: cn("[&>button]:rounded-none [&>button]:bg-primary/10 [&>button]:text-primary", classNames?.range_middle),
        range_end: cn("[&>button]:rounded-l-none", classNames?.range_end),
        hidden: cn("invisible", classNames?.hidden),
      }}
      components={{
        Chevron: ({ className, orientation, ...chevronProps }) => {
          const Icon =
            orientation === "left"
              ? ChevronLeft
              : orientation === "right"
                ? ChevronRight
                : orientation === "up"
                  ? ChevronUp
                  : ChevronDown

          return <Icon className={cn("h-4 w-4", className)} {...chevronProps} />
        },
        ...props.components,
      }}
      {...props}
    />
  )
}

export { Calendar }
