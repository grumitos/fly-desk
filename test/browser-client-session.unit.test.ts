import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  BROWSER_CLIENT_SESSION_STORAGE_KEY,
  getBrowserClientSessionId,
} from "../frontend/src/lib/browser-client-session";

function memorySessionStorage(initial?: Record<string, string>): Storage {
  const values = new Map(Object.entries(initial ?? {}));
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

test("browser client session is generated once and persisted in sessionStorage", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const sessionStorage = memorySessionStorage();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { sessionStorage },
  });

  try {
    const first = getBrowserClientSessionId();
    const second = getBrowserClientSessionId();

    assert.match(first ?? "", /^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$/);
    assert.equal(second, first);
    assert.equal(sessionStorage.getItem(BROWSER_CLIENT_SESSION_STORAGE_KEY), first);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete (globalThis as typeof globalThis & { window?: Window }).window;
  }
});

test("browser client session replaces invalid persisted values", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const sessionStorage = memorySessionStorage({
    [BROWSER_CLIENT_SESSION_STORAGE_KEY]: "invalid/id",
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { sessionStorage },
  });

  try {
    const sessionId = getBrowserClientSessionId();
    assert.notEqual(sessionId, "invalid/id");
    assert.match(sessionId ?? "", /^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$/);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete (globalThis as typeof globalThis & { window?: Window }).window;
  }
});
