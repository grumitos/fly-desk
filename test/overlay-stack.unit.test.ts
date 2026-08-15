import { test } from "bun:test"
import assert from "node:assert/strict"
import {
  hasOpenOverlay,
  isTopOverlay,
  popOverlay,
  pushOverlay,
} from "../frontend/src/lib/overlay-stack"

/*
 * Who owns `Esc`.
 *
 * 01 §8: «`Esc` cierra la hoja o el panel más reciente» — singular. Every modal
 * surface listens on `document`, so one keypress reaches all of them at once
 * and the stack is the only thing that decides which one answers. The bug it
 * exists for is not hypothetical: `Esc` over the quotation panel closed the
 * panel *and* the detail sheet underneath it, and the agent lost the offer they
 * were in the middle of quoting.
 *
 * The Playwright suites press `Esc` at single-layer surfaces, where a stack and
 * a boolean behave identically. Two layers is where they stop.
 *
 * The module holds one process-wide stack, so every case here leaves it empty.
 */

test("only the layer that opened last answers Esc", () => {
  const sheet = pushOverlay("sheet:detalle")
  assert.equal(isTopOverlay(sheet), true)

  const panel = pushOverlay("quotation")
  // The keypress reaches both listeners; exactly one of them acts on it.
  assert.equal(isTopOverlay(panel), true)
  assert.equal(isTopOverlay(sheet), false)

  popOverlay(panel)
  // And the sheet underneath only becomes the owner once the panel is gone —
  // on the next keypress, not on the one that closed the panel.
  assert.equal(isTopOverlay(sheet), true)

  popOverlay(sheet)
  assert.equal(isTopOverlay(sheet), false)
  assert.equal(hasOpenOverlay(), false)
})

test("a layer can leave from the middle without renumbering the ones above it", () => {
  /* Sheets and panels do not always close in the order they opened: a sheet can
     be dismissed by something other than `Esc` while a panel it opened is still
     up. The layer above has to keep the key. */
  const first = pushOverlay("sheet:fechas")
  const second = pushOverlay("sheet:pasajeros")
  const third = pushOverlay("quotation")

  popOverlay(second)

  assert.equal(isTopOverlay(third), true)
  assert.equal(isTopOverlay(first), false)
  assert.equal(hasOpenOverlay(), true)

  popOverlay(third)
  assert.equal(isTopOverlay(first), true)

  popOverlay(first)
  assert.equal(hasOpenOverlay(), false)
})

test("two surfaces opened under the same name stay two layers", () => {
  /* The label is for reading a stack trace, not for identity: `sheet:Fechas`
     can legitimately be open twice — the departure half and the return half of
     the same control — and closing one may not close the other. */
  const first = pushOverlay("sheet:Fechas")
  const second = pushOverlay("sheet:Fechas")

  assert.notEqual(first, second)
  assert.equal(isTopOverlay(second), true)
  assert.equal(isTopOverlay(first), false)

  popOverlay(second)
  assert.equal(isTopOverlay(first), true)
  assert.equal(hasOpenOverlay(), true)

  popOverlay(first)
  assert.equal(hasOpenOverlay(), false)
})

test("closing a layer twice does not close the one below it", () => {
  /* React effect cleanups can run more than once for the same layer. If the
     second `popOverlay` removed whatever was on top, an unmount would silently
     eat the shell's keyboard layer stand-down. */
  const sheet = pushOverlay("sheet:detalle")
  const panel = pushOverlay("quotation")

  popOverlay(panel)
  popOverlay(panel)

  assert.equal(hasOpenOverlay(), true)
  assert.equal(isTopOverlay(sheet), true)

  popOverlay(sheet)
  assert.equal(hasOpenOverlay(), false)
})

test("the shell's keyboard layer stands down for as long as anything modal is open", () => {
  /* 11 §7, column «en un emergente / hoja»: a popover or a sheet answers its
     own keys. `App` asks this one question and it has to stay true under the
     top layer as well as under the first. */
  assert.equal(hasOpenOverlay(), false)

  const sheet = pushOverlay("sheet:filtros")
  assert.equal(hasOpenOverlay(), true)

  const panel = pushOverlay("quotation")
  assert.equal(hasOpenOverlay(), true)

  popOverlay(sheet)
  // The sheet left from underneath; the panel is still modal.
  assert.equal(hasOpenOverlay(), true)

  popOverlay(panel)
  assert.equal(hasOpenOverlay(), false)
})
