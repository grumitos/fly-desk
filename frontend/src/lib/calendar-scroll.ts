/*
 * 03 §7: the phone's calendar opens with the edited month at the top, below
 * the pinned header rather than behind it; the header's height varies with
 * the summary, so it is measured.
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
