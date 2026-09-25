import { connect, createServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";

/*
 * A TCP relay on the loopback hop between the web unit and the runner
 * (`FLY_DESK_SEARCH_SERVICE_URL`). It passes every byte through. With
 * `dropReused` set, it drops a connection the moment the web sends another
 * request on it after the runner answered one: what a runner closing an idle
 * connection does to a request sent on it just then, every time.
 */
export interface HopRelay {
  readonly url: string;
  /** Connections the web unit opened to the runner so far. */
  readonly connections: number;
  /** Requests sent on a connection that had carried one already. */
  readonly reused: number;
  dropReused: boolean;
  close: () => Promise<void>;
}

export async function startHopRelay(runnerPort: number): Promise<HopRelay> {
  const sockets = new Set<Socket>();
  let connections = 0;
  let reused = 0;
  let dropReused = false;

  const server = createServer((web) => {
    connections += 1;
    const runner = connect(runnerPort, "127.0.0.1");
    sockets.add(web);
    sockets.add(runner);
    /* Once the runner has answered, what the web sends next is another request. */
    let answered = false;

    web.on("data", (chunk: Buffer) => {
      if (answered) {
        reused += 1;
        answered = false;
        if (dropReused) {
          web.resetAndDestroy();
          runner.destroy();
          return;
        }
      }
      runner.write(chunk);
    });
    runner.on("data", (chunk: Buffer) => {
      answered = true;
      web.write(chunk);
    });
    web.on("end", () => runner.end());
    runner.on("end", () => web.end());
    for (const [socket, other] of [[web, runner], [runner, web]] as const) {
      socket.on("error", () => other.destroy());
      socket.on("close", () => {
        sockets.delete(socket);
        other.destroy();
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    get connections() {
      return connections;
    },
    get reused() {
      return reused;
    },
    get dropReused() {
      return dropReused;
    },
    set dropReused(value: boolean) {
      dropReused = value;
    },
    close: () => new Promise<void>((resolve) => {
      sockets.forEach((socket) => socket.destroy());
      server.close(() => resolve());
    }),
  };
}
