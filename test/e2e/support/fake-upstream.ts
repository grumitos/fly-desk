import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  agilGeoTreePayload,
  agilSearchGroup,
  cbplusAutocompletePayload,
  cbplusEngineMetadata,
  cbplusPricedItinerary,
  defaultLocations,
  FAKE_AGIL_IDENTITY,
  FAKE_AGIL_SUBSCRIPTION_KEY,
  fakeJwt,
  matchLocations,
  offersForQuery,
  validateOffer,
  type FakeProvider,
  type LocationFixture,
  type OfferSource,
  type OfferSpec,
  type RouteMatch,
  type SearchQuery,
} from "./fixtures.ts";
import {
  BLOCKED_EGRESS_PATH,
  CALLER_HEADER,
  FAKE_CDP_PATH,
  ORIGIN_HEADER,
  parseCaller,
  PROVIDER_ORIGIN_TAGS,
  type Caller,
} from "./provider-origins.ts";

export type FakeOp =
  | "agil.token"
  | "agil.startSearch"
  | "agil.search"
  | "agil.locations"
  | "agil.web"
  | "cbplus.engine"
  | "cbplus.search"
  | "cbplus.locations"
  | "cbplus.brand"
  | "cbplus.b2b"
  | "cbplus.markup"
  | "rate"
  | "airlineMark"
  | "cdp"
  | "unknown";

export interface RecordedRequest {
  seq: number;
  receivedAt: number;
  respondedAt?: number;
  op: FakeOp;
  origin: string;
  method: string;
  /** Path and query as the production code addressed them at the provider. */
  path: string;
  headers: Record<string, string>;
  body: unknown;
  query?: SearchQuery;
  caller?: Caller;
  status?: number;
  /** The caller hung up before the fake answered (cancellation, timeout, killed worker). */
  aborted: boolean;
  error?: string;
}

export interface BlockedEgress {
  at: number;
  kind: string;
  origin: string;
  path: string;
  caller?: Caller;
}

/**
 * A failure the fake answers with instead of the scenario: an HTTP status, a
 * logical error inside a 200 (`{ status: 200, body }`), a request that never
 * answers (`hang`) or a dropped connection (`reset`).
 */
export interface Fault {
  status?: number;
  body?: unknown;
  hang?: boolean;
  reset?: boolean;
}

/** `op` names one operation, a provider (`"agil"` matches every `agil.*`) or `"*"`. */
export interface ResponseRule {
  op: FakeOp | FakeProvider | "*";
  where?: (request: RecordedRequest) => boolean;
  delayMs?: number;
  /** Held until the promise settles, then answered as the scenario says. */
  gate?: Promise<void>;
  fault?: Fault;
  /** Applies to the next N matching requests only. */
  times?: number;
}

/** Requests a test holds open until it decides the provider has answered. */
export interface Gate {
  /** Answers every held request, and every later one the gate matches. */
  release: () => void;
  /** Stops matching new requests; held ones stay held until `release`. */
  remove: () => void;
  /** Matching requests received so far. */
  readonly seen: number;
}

export type RequestFilter = FakeOp | FakeProvider | ((request: RecordedRequest) => boolean);

interface FlightRule {
  providers: ReadonlySet<FakeProvider>;
  match: RouteMatch;
  source: OfferSource;
}

interface Reply {
  status: number;
  body?: unknown;
  contentType?: string;
}

function classify(tag: string, method: string, pathname: string): FakeOp {
  if (tag === "agil") {
    if (method === "POST" && pathname === "/auth/api/auth/token") return "agil.token";
    if (method === "POST" && pathname === "/mv/start-search") return "agil.startSearch";
    if (method === "POST" && pathname === "/mv/search") return "agil.search";
    if (method === "GET" && pathname.startsWith("/mv/ubigeo/geotree/")) return "agil.locations";
  }
  if (tag === "agil-web") return "agil.web";
  if (tag === "cbplus-search" && method === "POST" && /\/searchFlights$/.test(pathname)) return "cbplus.search";
  if (tag === "cbplus-api" && method === "GET" && /\/engines\/[^/]+$/.test(pathname)) return "cbplus.engine";
  if (tag === "cbplus-api" && method === "GET" && pathname.endsWith("/autocomplete/airports/search")) return "cbplus.locations";
  if (tag === "cbplus-brand" && method === "GET") return "cbplus.brand";
  if (tag === "cbplus-b2b") return "cbplus.b2b";
  if (tag === "cbplus-markup") return "cbplus.markup";
  if (tag === "exchange-rate") return "rate";
  if (tag === "airline-marks") return "airlineMark";
  if (`/${tag}` === FAKE_CDP_PATH || tag === "json") return "cdp";
  return "unknown";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function compactDateToIso(value: unknown): string {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(value ?? ""));
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
}

function parseQuery(op: FakeOp, body: unknown): SearchQuery | undefined {
  const payload = record(body);
  if (op === "agil.search" || op === "agil.startSearch") {
    return {
      provider: "agil",
      tripType: payload.flightType === 1 ? "one-way" : "round-trip",
      origin: String(payload.departureLocation ?? ""),
      destination: String(payload.arrivalLocation ?? ""),
      departureDate: String(payload.departureDate ?? ""),
      returnDate: payload.flightType === 1 ? undefined : String(payload.arrivalDate ?? "") || undefined,
      adults: Number(payload.adults ?? 1),
      children: Number(payload.children ?? 0),
      infants: Number(payload.infants ?? 0),
      gds: typeof payload.gds === "number" ? payload.gds : undefined,
    };
  }

  if (op === "cbplus.search") {
    const legs = Array.isArray(payload.originDestinationInformation) ? payload.originDestinationInformation.map(record) : [];
    const travellers = Array.isArray(record(payload.travelerInfoSummary).airTravelerAvail)
      ? (record(payload.travelerInfoSummary).airTravelerAvail as unknown[]).map((entry) => record(record(record(entry).airTraveler).passengerTypeQuantity))
      : [];
    const count = (code: string) => Number(travellers.find((entry) => entry.code === code)?.quantity ?? 0);
    const oneWay = record(payload.processingInfo).searchType === "OW";
    return {
      provider: "cbplus",
      tripType: oneWay ? "one-way" : "round-trip",
      origin: String(record(legs[0]?.originLocation).locationCode ?? ""),
      destination: String(record(legs[0]?.destinationLocation).locationCode ?? ""),
      departureDate: compactDateToIso(record(legs[0]?.departureDateTime).value),
      returnDate: oneWay ? undefined : compactDateToIso(record(legs[1]?.departureDateTime).value) || undefined,
      adults: count("ADT"),
      children: count("CHD"),
      infants: count("INF"),
      flexible: payload.flexible === true,
    };
  }

  return undefined;
}

function flattenHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      flat[name] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return flat;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function parseJson(text: string): unknown {
  if (!text.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function matchesOp(rule: ResponseRule["op"], op: FakeOp): boolean {
  return rule === "*" || rule === op || op.startsWith(`${rule}.`);
}

function toPredicate(filter: RequestFilter | undefined): (request: RecordedRequest) => boolean {
  if (filter === undefined) {
    return () => true;
  }
  return typeof filter === "function" ? filter : (request) => matchesOp(filter, request.op);
}

function waitUnlessClosed(delayMs: number, response: ServerResponse): Promise<boolean> {
  return new Promise((resolve) => {
    const onClose = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      response.off("close", onClose);
      resolve(true);
    }, delayMs);
    response.once("close", onClose);
  });
}

/* Resolves true once the gate opens, false if the caller hung up first. */
function waitForGateUnlessClosed(gate: Promise<void>, response: ServerResponse): Promise<boolean> {
  return new Promise((resolve) => {
    const onClose = () => resolve(false);
    response.once("close", onClose);
    void gate.then(() => {
      response.off("close", onClose);
      resolve(!response.destroyed);
    });
  });
}

function limaDay(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date());
}

/**
 * The provider side of the stack: every Agil, Click and Book Plus, exchange
 * rate and airline-mark request the preload rewrites lands here, is recorded,
 * and is answered from the scenario unless a rule says otherwise.
 */
export class FakeUpstream {
  readonly url: string;
  /** USD to PEN rate the fake publishes (Agil `tipoCambio`, exchange-rate endpoint). */
  usdToPen = 3.742;
  #server: Server;
  #requests: RecordedRequest[] = [];
  #blocked: BlockedEgress[] = [];
  #flightRules: FlightRule[] = [];
  #rules: ResponseRule[] = [];
  #locations: Record<FakeProvider, LocationFixture[]> = { agil: defaultLocations("agil"), cbplus: defaultLocations("cbplus") };
  #agilTokens = new Set<string>();
  #waiters = new Set<(request: RecordedRequest) => void>();
  #hung = new Set<ServerResponse>();
  #gates = new Set<() => void>();
  #seq = 0;

  constructor(server: Server, url: string) {
    this.#server = server;
    this.url = url;
    server.on("request", (request: IncomingMessage, response: ServerResponse) => {
      this.#handle(request, response).catch((error: unknown) => {
        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "application/json" });
        }
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
    });
  }

  /** The offers `provider` answers for a route; the most recent matching call wins. */
  setFlights(provider: FakeProvider | "both", match: RouteMatch, source: OfferSource): void {
    if (Array.isArray(source)) {
      (source as readonly OfferSpec[]).forEach(validateOffer);
    }
    this.#flightRules.push({
      providers: new Set<FakeProvider>(provider === "both" ? ["agil", "cbplus"] : [provider]),
      match,
      source,
    });
  }

  setLocations(provider: FakeProvider, entries: readonly LocationFixture[]): void {
    this.#locations[provider] = [...entries];
  }

  /** Newest matching rule applies. Returns a function that removes it. */
  addRule(rule: ResponseRule): () => void {
    const entry = { ...rule };
    this.#rules.push(entry);
    return () => {
      this.#rules = this.#rules.filter((candidate) => candidate !== entry);
    };
  }

  delay(op: ResponseRule["op"], delayMs: number, where?: ResponseRule["where"]): () => void {
    return this.addRule({ op, delayMs, where });
  }

  fail(op: ResponseRule["op"], fault: Fault, options: Pick<ResponseRule, "times" | "where" | "delayMs"> = {}): () => void {
    return this.addRule({ op, fault, ...options });
  }

  /**
   * Holds every matching request open until `release()`: the provider is
   * "thinking" for exactly as long as the test needs, with no clock involved.
   * `reset()` and `close()` release whatever is still held.
   */
  hold(op: ResponseRule["op"], where?: ResponseRule["where"]): Gate {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let seen = 0;
    const remove = this.addRule({
      op,
      gate,
      where: (request) => {
        const matches = !where || where(request);
        if (matches) seen += 1;
        return matches;
      },
    });
    this.#gates.add(open);
    return {
      release: () => {
        this.#gates.delete(open);
        open();
      },
      remove,
      get seen() {
        return seen;
      },
    };
  }

  /** Every Agil bearer minted so far answers 401 from now on, as an expired one does. */
  expireAgilTokens(): void {
    this.#agilTokens.clear();
  }

  requests(filter?: RequestFilter): RecordedRequest[] {
    const predicate = toPredicate(filter);
    return this.#requests.filter(predicate);
  }

  get blocked(): readonly BlockedEgress[] {
    return [...this.#blocked];
  }

  /** Resolves with the first matching request, including one already received. */
  waitForRequest(filter: RequestFilter, timeoutMs = 10_000): Promise<RecordedRequest> {
    const predicate = toPredicate(filter);
    const existing = this.#requests.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }

    return new Promise((resolve, reject) => {
      const waiter = (request: RecordedRequest) => {
        if (predicate(request)) {
          clearTimeout(timer);
          this.#waiters.delete(waiter);
          resolve(request);
        }
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        const seen = this.#requests.slice(-10).map((request) => `${request.op} ${request.path}`).join("; ");
        reject(new Error(`No matching fake upstream request within ${timeoutMs}ms. Last seen: ${seen || "none"}`));
      }, timeoutMs);
      this.#waiters.add(waiter);
    });
  }

  clearRequests(): void {
    this.#requests = [];
    this.#blocked = [];
  }

  /** Back to an empty scenario. Minted Agil bearers stay valid, as they would upstream. */
  reset(): void {
    this.#releaseGates();
    this.clearRequests();
    this.#flightRules = [];
    this.#rules = [];
    this.#locations = { agil: defaultLocations("agil"), cbplus: defaultLocations("cbplus") };
    this.usdToPen = 3.742;
  }

  async close(): Promise<void> {
    this.#releaseGates();
    this.#hung.forEach((response) => response.destroy());
    this.#hung.clear();
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
      this.#server.closeAllConnections();
    });
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://fake.invalid");
    const method = (request.method ?? "GET").toUpperCase();
    const bodyText = await readBody(request);

    if (url.pathname === BLOCKED_EGRESS_PATH) {
      const payload = record(parseJson(bodyText));
      this.#blocked.push({
        at: Date.now(),
        kind: String(payload.kind ?? "fetch"),
        origin: String(payload.origin ?? ""),
        path: String(payload.path ?? ""),
        caller: parseCaller(request.headers[CALLER_HEADER] as string | undefined),
      });
      response.writeHead(204).end();
      return;
    }

    const [, tag = "", ...rest] = url.pathname.split("/");
    const pathname = `/${rest.join("/")}`;
    const op = classify(tag, method, pathname);
    const body = parseJson(bodyText);
    const entry: RecordedRequest = {
      seq: ++this.#seq,
      receivedAt: Date.now(),
      op,
      origin: String(request.headers[ORIGIN_HEADER] ?? Object.entries(PROVIDER_ORIGIN_TAGS).find(([, value]) => value === tag)?.[0] ?? tag),
      method,
      path: `${pathname}${url.search}`,
      headers: flattenHeaders(request.headers),
      body,
      query: parseQuery(op, body),
      caller: parseCaller(request.headers[CALLER_HEADER] as string | undefined),
      aborted: false,
    };
    this.#requests.push(entry);
    this.#waiters.forEach((waiter) => waiter(entry));
    response.on("close", () => {
      this.#hung.delete(response);
      if (!response.writableFinished) {
        entry.aborted = true;
      }
    });

    const rule = this.#takeRule(entry);
    if (rule?.gate && !(await waitForGateUnlessClosed(rule.gate, response))) {
      return;
    }
    if (rule?.delayMs && !(await waitUnlessClosed(rule.delayMs, response))) {
      return;
    }
    if (rule?.fault?.reset) {
      entry.status = 0;
      request.socket.destroy();
      return;
    }
    if (rule?.fault?.hang) {
      this.#hung.add(response);
      return;
    }

    let reply: Reply;
    try {
      reply = rule?.fault
        ? { status: rule.fault.status ?? 200, body: rule.fault.body ?? {} }
        : this.#answer(entry, url);
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
      console.error(`[fake-upstream] ${entry.op} failed: ${entry.error}`);
      reply = { status: 500, body: { error: entry.error } };
    }

    if (response.destroyed) {
      return;
    }
    const payload = typeof reply.body === "string" || reply.body === undefined
      ? reply.body ?? ""
      : JSON.stringify(reply.body);
    response.writeHead(reply.status, { "content-type": reply.contentType ?? "application/json; charset=utf-8" });
    response.end(payload);
    entry.status = reply.status;
    entry.respondedAt = Date.now();
  }

  #releaseGates(): void {
    this.#gates.forEach((open) => open());
    this.#gates.clear();
  }

  #takeRule(entry: RecordedRequest): ResponseRule | undefined {
    for (let index = this.#rules.length - 1; index >= 0; index -= 1) {
      const rule = this.#rules[index]!;
      if (!matchesOp(rule.op, entry.op) || (rule.where && !rule.where(entry))) {
        continue;
      }
      if (rule.times !== undefined) {
        rule.times -= 1;
        if (rule.times <= 0) {
          this.#rules.splice(index, 1);
        }
      }
      return rule;
    }
    return undefined;
  }

  #offers(query: SearchQuery): OfferSpec[] {
    for (let index = this.#flightRules.length - 1; index >= 0; index -= 1) {
      const rule = this.#flightRules[index]!;
      const { match } = rule;
      if (
        rule.providers.has(query.provider)
        && match.origin === query.origin
        && match.destination === query.destination
        && (!match.departureDate || match.departureDate === query.departureDate)
        && (!match.returnDate || match.returnDate === query.returnDate)
      ) {
        const specs = typeof rule.source === "function" ? rule.source(query) : rule.source;
        return offersForQuery(specs, query);
      }
    }
    return [];
  }

  #agilAuthorized(entry: RecordedRequest): boolean {
    const bearer = /^Bearer\s+(.+)$/i.exec(entry.headers.authorization ?? "")?.[1];
    return entry.headers["ocp-apim-subscription-key"] === FAKE_AGIL_SUBSCRIPTION_KEY
      && Boolean(bearer && this.#agilTokens.has(bearer));
  }

  #answer(entry: RecordedRequest, url: URL): Reply {
    const unauthorized: Reply = { status: 401, body: { statusCode: 401, message: "Unauthorized" } };

    switch (entry.op) {
      case "agil.token": {
        const payload = record(entry.body);
        if (
          entry.headers["ocp-apim-subscription-key"] !== FAKE_AGIL_SUBSCRIPTION_KEY
          || payload.userCode !== FAKE_AGIL_IDENTITY.userCode
          || payload.internalCode !== FAKE_AGIL_IDENTITY.internalCode
        ) {
          return unauthorized;
        }
        const token = fakeJwt({ sub: String(payload.userCode), exp: Math.floor(Date.now() / 1000) + 3600 });
        this.#agilTokens.add(token);
        return { status: 200, body: { token } };
      }
      case "agil.startSearch":
        return this.#agilAuthorized(entry)
          ? { status: 200, body: { searchTrackingCode: record(entry.body).searchTrackingCode ?? null } }
          : unauthorized;
      case "agil.search": {
        if (!this.#agilAuthorized(entry) || !entry.query) {
          return unauthorized;
        }
        const query = entry.query;
        return {
          status: 200,
          body: { groups: this.#offers(query).map((offer, index) => agilSearchGroup(offer, query, index, this.usdToPen)) },
        };
      }
      case "agil.locations": {
        const term = decodeURIComponent(entry.path.split("?")[0]!.slice("/mv/ubigeo/geotree/".length));
        return { status: 200, body: agilGeoTreePayload(matchLocations(this.#locations.agil, term)) };
      }
      case "cbplus.engine":
        return { status: 200, body: cbplusEngineMetadata(decodeURIComponent(url.pathname.split("/").pop() ?? "")) };
      case "cbplus.search": {
        const payload = record(entry.body);
        const claims = record(parseJson(Buffer.from(String(payload.token ?? "").split(".")[1] ?? "", "base64url").toString("utf8")));
        if (!entry.query || claims.terminalId !== payload.terminalId) {
          return { status: 200, body: { status: 401, message: "Token invalido para el terminal." } };
        }
        const query = entry.query;
        return {
          status: 200,
          body: {
            status: 200,
            pricedItineraries: {
              pricedItinerary: this.#offers(query).map((offer, index) => cbplusPricedItinerary(offer, query, index, "USD")),
            },
          },
        };
      }
      case "cbplus.locations":
        return { status: 200, body: cbplusAutocompletePayload(matchLocations(this.#locations.cbplus, url.searchParams.get("query") ?? "")) };
      case "cbplus.brand":
        return {
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: "<!doctype html><html lang=\"es\"><head><title>Click and Book Plus - Vuelos</title></head><body><main id=\"app\">Resultados de vuelos</main></body></html>",
        };
      case "rate":
        return { status: 200, body: { fecha: limaDay(), sunat: this.usdToPen, compra: this.usdToPen - 0.006, venta: this.usdToPen } };
      case "airlineMark":
        return { status: 403, contentType: "text/plain; charset=utf-8", body: "Forbidden" };
      default:
        return { status: 404, body: { error: `The fake upstream does not serve ${entry.origin}${entry.path}.` } };
    }
  }
}

export async function startFakeUpstream(): Promise<FakeUpstream> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return new FakeUpstream(server, `http://127.0.0.1:${port}`);
}
