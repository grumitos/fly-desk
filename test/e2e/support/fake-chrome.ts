import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { runInNewContext } from "node:vm";

/*
 * The platform Chrome (`fly-desk-chrome.service`) as far as the runtime asks
 * it anything: `/json/version`, then a DevTools socket on which it opens a tab,
 * sends it to a provider page, reads that page's localStorage and closes the
 * tab. The fake upstream serves both; until a test opens this browser, the
 * version probe gets the 404 of a host where no Chrome listens.
 *
 * What a page holds is per origin, and the runtime's own expression is run
 * against it. As in Chrome, `Page.navigate` is answered only once the page has
 * responded, so a slow page is a slow reply.
 */

export const FAKE_CHROME_SOCKET_PATH = "/__cdp/devtools/browser/e2e";
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

/** localStorage by origin: `{ "https://www.agilsmart.com": { user_data: "…" } }`. */
export type OriginStorage = Readonly<Record<string, Readonly<Record<string, string>>>>;

export interface FakeChromeOptions {
  /** How long every page takes to respond. */
  pageDelayMs?: number;
  /** Pages never respond: a tab stays on its navigation until it is closed. */
  hangPages?: boolean;
}

export interface ChromeTab {
  targetId: string;
  /** Every URL the tab was sent to, in order. */
  urls: string[];
  closed: boolean;
}

interface CdpCommand {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

/** Client frames, which arrive masked and may span or share TCP chunks. */
class FrameReader {
  #buffer = Buffer.alloc(0);
  #fragments: Buffer[] = [];
  #fragmentOpcode = OPCODE_TEXT;
  readonly #onMessage: (opcode: number, payload: Buffer) => void;

  constructor(onMessage: (opcode: number, payload: Buffer) => void) {
    this.#onMessage = onMessage;
  }

  push(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      if (this.#buffer.length < 2) return;
      const fin = (this.#buffer[0]! & 0x80) !== 0;
      const opcode = this.#buffer[0]! & 0x0f;
      const masked = (this.#buffer[1]! & 0x80) !== 0;
      let length = this.#buffer[1]! & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.#buffer.length < 4) return;
        length = this.#buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.#buffer.length < 10) return;
        length = Number(this.#buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskAt = offset;
      if (masked) offset += 4;
      if (this.#buffer.length < offset + length) return;

      const payload = Buffer.from(this.#buffer.subarray(offset, offset + length));
      if (masked) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] = payload[index]! ^ this.#buffer[maskAt + (index % 4)]!;
        }
      }
      this.#buffer = this.#buffer.subarray(offset + length);

      if (opcode >= OPCODE_CLOSE) {
        this.#onMessage(opcode, payload);
      } else if (opcode === OPCODE_CONTINUATION) {
        this.#fragments.push(payload);
        if (fin) {
          this.#onMessage(this.#fragmentOpcode, Buffer.concat(this.#fragments));
          this.#fragments = [];
        }
      } else if (!fin) {
        this.#fragmentOpcode = opcode;
        this.#fragments = [payload];
      } else {
        this.#onMessage(opcode, payload);
      }
    }
  }
}

export class FakeChrome {
  #open = false;
  #storage: OriginStorage = {};
  #options: FakeChromeOptions = {};
  #tabs = new Map<string, ChromeTab>();
  #sessions = new Map<string, string>();
  #sockets = new Set<Duplex>();
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #created = 0;

  get isOpen(): boolean {
    return this.#open;
  }

  /** Starts listening, with each origin's pages holding `storage`. */
  open(storage: OriginStorage, options: FakeChromeOptions = {}): void {
    this.reset();
    this.#open = true;
    this.#storage = storage;
    this.#options = options;
  }

  /** Every tab the runtime opened, in order. */
  tabs(): ChromeTab[] {
    return [...this.#tabs.values()].map((tab) => ({ ...tab, urls: [...tab.urls] }));
  }

  /** What `/json/version` answers: where the browser's DevTools socket is. */
  version(upstreamUrl: string): Record<string, string> {
    return {
      Browser: "HeadlessChrome/E2E",
      "Protocol-Version": "1.3",
      webSocketDebuggerUrl: `${upstreamUrl.replace(/^http/, "ws")}${FAKE_CHROME_SOCKET_PATH}`,
    };
  }

  /** Stops listening and forgets every tab. */
  reset(): void {
    this.#open = false;
    this.#storage = {};
    this.#options = {};
    this.#timers.forEach((timer) => clearTimeout(timer));
    this.#timers.clear();
    this.#sockets.forEach((socket) => socket.destroy());
    this.#sockets.clear();
    this.#tabs.clear();
    this.#sessions.clear();
    this.#created = 0;
  }

  /** The fake upstream's `upgrade` listener. */
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const key = request.headers["sec-websocket-key"];
    const pathname = new URL(request.url ?? "/", "http://fake.invalid").pathname;
    socket.on("error", () => undefined);
    if (!this.#open || pathname !== FAKE_CHROME_SOCKET_PATH || typeof key !== "string") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }

    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64")}`,
      "",
      "",
    ].join("\r\n"));
    this.#sockets.add(socket);
    socket.on("close", () => this.#sockets.delete(socket));
    const reader = new FrameReader((opcode, payload) => this.#onFrame(socket, opcode, payload));
    socket.on("data", (chunk: Buffer) => reader.push(chunk));
    if (head.length > 0) {
      reader.push(head);
    }
  }

  #onFrame(socket: Duplex, opcode: number, payload: Buffer): void {
    if (opcode === OPCODE_CLOSE) {
      socket.end(frame(OPCODE_CLOSE, payload.subarray(0, 2)));
      return;
    }
    if (opcode === OPCODE_PING) {
      socket.write(frame(OPCODE_PONG, payload));
      return;
    }
    if (opcode === OPCODE_TEXT) {
      this.#command(socket, JSON.parse(payload.toString("utf8")) as CdpCommand);
    }
  }

  #send(socket: Duplex, message: Record<string, unknown>): void {
    if (!socket.destroyed) {
      socket.write(frame(OPCODE_TEXT, Buffer.from(JSON.stringify(message), "utf8")));
    }
  }

  #later(delayMs: number, run: () => void): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      run();
    }, delayMs);
    this.#timers.add(timer);
  }

  #command(socket: Duplex, command: CdpCommand): void {
    const { id, method, params = {}, sessionId } = command;
    const scope = sessionId ? { sessionId } : {};
    const reply = (result: unknown) => this.#send(socket, { id, result, ...scope });
    const fail = (message: string) => this.#send(socket, { id, error: { code: -32000, message }, ...scope });
    const tab = sessionId ? this.#tabs.get(this.#sessions.get(sessionId) ?? "") : undefined;

    switch (method) {
      case "Target.createTarget": {
        this.#created += 1;
        const targetId = `tab-${this.#created}`;
        this.#tabs.set(targetId, { targetId, urls: [], closed: false });
        reply({ targetId });
        return;
      }
      case "Target.attachToTarget": {
        const target = this.#tabs.get(String(params.targetId));
        if (!target || target.closed) {
          fail("No target with given id found");
          return;
        }
        const attached = `session-${target.targetId}`;
        this.#sessions.set(attached, target.targetId);
        reply({ sessionId: attached });
        return;
      }
      case "Page.enable":
      case "Runtime.enable":
        reply({});
        return;
      case "Page.navigate": {
        if (!tab || tab.closed) {
          fail("Session with given id not found.");
          return;
        }
        tab.urls.push(String(params.url));
        if (this.#options.hangPages) {
          return;
        }
        this.#later(this.#options.pageDelayMs ?? 0, () => {
          if (tab.closed) return;
          reply({ frameId: tab.targetId, loaderId: `loader-${tab.urls.length}` });
          this.#send(socket, { method: "Page.domContentEventFired", params: { timestamp: Date.now() / 1000 }, ...scope });
        });
        return;
      }
      case "Runtime.evaluate": {
        if (!tab || tab.closed) {
          fail("Session with given id not found.");
          return;
        }
        const page = tab.urls.at(-1);
        const storage = page ? this.#storage[new URL(page).origin] ?? {} : {};
        const value: unknown = runInNewContext(String(params.expression), {
          localStorage: { getItem: (key: string) => storage[key] ?? null },
        });
        reply({ result: { type: typeof value, value } });
        return;
      }
      case "Target.closeTarget": {
        const target = this.#tabs.get(String(params.targetId));
        if (!target) {
          fail("No target with given id found");
          return;
        }
        target.closed = true;
        reply({ success: true });
        return;
      }
      default:
        fail(`'${method}' wasn't found`);
    }
  }
}
