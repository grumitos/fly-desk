import { test } from "bun:test"
import assert from "node:assert/strict"
import { isIsoDate, isIsoMonth } from "../frontend/src/lib/iso-date"

test("civil ISO date validation rejects calendar rollover", () => {
  assert.equal(isIsoDate("2026-06-31"), false)
  assert.equal(isIsoDate("2025-02-29"), false)
  assert.equal(isIsoDate("2026-13-01"), false)
})

test("civil ISO date validation accepts real dates including leap day", () => {
  assert.equal(isIsoDate("2026-06-30"), true)
  assert.equal(isIsoDate("2024-02-29"), true)
})

test("civil ISO month validation rejects values outside the calendar", () => {
  assert.equal(isIsoMonth("2026-00"), false)
  assert.equal(isIsoMonth("2026-13"), false)
  assert.equal(isIsoMonth("2026-12"), true)
})
