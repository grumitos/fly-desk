/*
 * Aiming the sheet's calendar at a month.
 *
 * 03 §7: on a phone the calendar does not page, it scrolls, and opening it puts
 * the month being edited at the top. «At the top» has to mean under the pinned
 * block and not behind it — `scrollIntoView` aligns with the top of the
 * scroller, which is exactly where the header and the weekday row are standing,
 * so the caption and the first week of the month the agent asked for arrived
 * already covered.
 *
 * The block measures itself. Its height is not a constant — the summary line is
 * one row or two depending on what is chosen — which is the same reason the
 * weekday row stopped carrying the header's height as a number.
 *
 * It lives here rather than in `range-calendar.tsx` because both date fields
 * call it and a module of components should export components.
 */
export function scrollCalendarMonthIntoView(root: HTMLElement | null, calendarKey: string): void {
  const target = root?.querySelector<HTMLElement>(`[data-calendar-key="${calendarKey}"]`)
  if (!target) return

  target.scrollIntoView({ block: "start" })

  const scroller = target.closest<HTMLElement>(".fd-sheet-body")
  const pinned = root?.querySelector<HTMLElement>(".fd-cal-sticky")
  if (!scroller || !pinned) return

  scroller.scrollTop += target.getBoundingClientRect().top - pinned.getBoundingClientRect().bottom
}
