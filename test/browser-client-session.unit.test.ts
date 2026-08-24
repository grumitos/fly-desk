import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  BROWSER_CLIENT_SESSION_STORAGE_KEY,
  getBrowserClientSessionId,
} from "../frontend/src/lib/browser-client-session";

function memoryStorage(initial?: Record<string, string>): Storage {
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

test("browser client session is generated once and persisted in localStorage", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const localStorage = memoryStorage();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage },
  });

  try {
    const first = getBrowserClientSessionId();
    const second = getBrowserClientSessionId();

    assert.match(first ?? "", /^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$/);
    assert.equal(second, first);
    assert.equal(localStorage.getItem(BROWSER_CLIENT_SESSION_STORAGE_KEY), first);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete (globalThis as typeof globalThis & { window?: Window }).window;
  }
});

test("browser client session replaces invalid persisted values", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const localStorage = memoryStorage({
    [BROWSER_CLIENT_SESSION_STORAGE_KEY]: "invalid/id",
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage },
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

test("browser client session survives closing the tab", () => {
  /* The id keys «Recientes». It used to live in sessionStorage, which dies with
     the tab, so every new tab minted a new id and the panel opened empty for
     everyone - no server-side retention could rescue a history the client threw
     away. A second visit must find the first visit's id. */
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const localStorage = memoryStorage();

  const openTab = () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      // A fresh tab: same origin storage, brand-new per-tab storage.
      value: { localStorage, sessionStorage: memoryStorage() },
    });
    return getBrowserClientSessionId();
  };

  try {
    const firstTab = openTab();
    const secondTab = openTab();

    assert.match(firstTab ?? "", /^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$/);
    assert.equal(secondTab, firstTab);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete (globalThis as typeof globalThis & { window?: Window }).window;
  }
});
