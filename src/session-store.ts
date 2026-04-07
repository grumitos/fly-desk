import { randomUUID } from "node:crypto";
import {
  CanonicalOffer,
  MatrixCell,
  ProviderContext,
  ProviderMeta,
  PurchasePath,
  SearchMeta,
  SearchRequest,
} from "./core/types";

interface StoredPurchasePath {
  sessionId: string;
  offerId: string;
  path: PurchasePath;
  createdAt: string;
}

export interface SearchSessionRecord {
  id: string;
  request: SearchRequest;
  providerContext?: ProviderContext;
  offers: CanonicalOffer[];
  matrix?: MatrixCell[];
  searchMeta: SearchMeta;
  providerMeta: ProviderMeta;
  warnings: string[];
  createdAt: string;
}

export interface MatrixJobRecord {
  id: string;
  request: SearchRequest;
  providerContext?: ProviderContext;
  cells: MatrixCell[];
  axes: {
    departureDates: string[];
    returnDates: string[];
  };
  confidenceSummary: Record<string, number>;
  recommendations: string[];
  providerMeta: ProviderMeta;
  searchMeta: SearchMeta;
  warnings: string[];
  status: "running" | "completed" | "failed";
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SearchJobRecord {
  id: string;
  request: SearchRequest;
  providerContext?: ProviderContext;
  offers: CanonicalOffer[];
  allOffers: CanonicalOffer[];
  searchMeta: SearchMeta;
  providerMeta: ProviderMeta;
  warnings: string[];
  sortMode: "cheapest" | "fastest" | "best-value";
  status: "running" | "completed" | "failed";
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export class SearchSessionStore {
  private readonly sessions = new Map<string, SearchSessionRecord>();
  private readonly purchasePaths = new Map<string, StoredPurchasePath>();
  private readonly sessionPurchasePathIds = new Map<string, Set<string>>();
  private readonly matrixJobs = new Map<string, MatrixJobRecord>();
  private readonly searchJobs = new Map<string, SearchJobRecord>();
  private readonly offerValidationTasks = new Map<string, Promise<CanonicalOffer | undefined>>();

  getSession(sessionId: string): SearchSessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  getOffer(sessionId: string, offerId: string): CanonicalOffer | undefined {
    return this.sessions.get(sessionId)?.offers.find((offer) => offer.id === offerId);
  }

  updateOffer(sessionId: string, updatedOffer: CanonicalOffer): CanonicalOffer | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    const previous = session.offers.find((offer) => offer.id === updatedOffer.id);
    if (previous) {
      this.forgetOfferPurchasePaths(sessionId, previous.purchasePaths);
    }

    const rewritten = this.rewriteOfferPaths(sessionId, updatedOffer);
    session.offers = session.offers.map((offer) => offer.id === updatedOffer.id ? rewritten : offer);
    return rewritten;
  }

  ensureValidatedOffer(
    sessionId: string,
    offerId: string,
    resolver: (offer: CanonicalOffer, session: SearchSessionRecord) => Promise<CanonicalOffer | undefined>,
  ): Promise<CanonicalOffer | undefined> {
    const session = this.sessions.get(sessionId);
    const offer = session?.offers.find((current) => current.id === offerId);

    if (!session || !offer) {
      return Promise.resolve(undefined);
    }

    if (offer.priceConfidence === "validated") {
      return Promise.resolve(offer);
    }

    const taskKey = this.offerValidationTaskKey(sessionId, offerId);
    const existingTask = this.offerValidationTasks.get(taskKey);
    if (existingTask) {
      return existingTask;
    }

    const task = (async () => {
      try {
        const latestSession = this.sessions.get(sessionId);
        const latestOffer = latestSession?.offers.find((current) => current.id === offerId);

        if (!latestSession || !latestOffer) {
          return undefined;
        }

        if (latestOffer.priceConfidence === "validated") {
          return latestOffer;
        }

        const validatedOffer = await resolver(latestOffer, latestSession);
        if (!validatedOffer) {
          return this.getOffer(sessionId, offerId);
        }

        return this.updateOffer(sessionId, validatedOffer)
          ?? this.getOffer(sessionId, offerId)
          ?? validatedOffer;
      } finally {
        this.offerValidationTasks.delete(taskKey);
      }
    })();

    this.offerValidationTasks.set(taskKey, task);
    return task;
  }

  createSearchJob(input: Omit<SearchJobRecord, "id" | "createdAt" | "updatedAt">): SearchJobRecord {
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const record: SearchJobRecord = {
      ...input,
      id,
      createdAt: timestamp,
      updatedAt: timestamp,
      searchMeta: {
        ...input.searchMeta,
        searchSessionId: id,
      },
    };

    this.searchJobs.set(id, record);
    this.syncSessionFromSearchJob(record);
    return record;
  }

  getSearchJob(jobId: string): SearchJobRecord | undefined {
    return this.searchJobs.get(jobId);
  }

  updateSearchJob(
    jobId: string,
    updater: (current: SearchJobRecord) => SearchJobRecord,
  ): SearchJobRecord | undefined {
    const current = this.searchJobs.get(jobId);
    if (!current) {
      return undefined;
    }

    const updated = updater(current);
    const next = {
      ...updated,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
      searchMeta: {
        ...updated.searchMeta,
        searchSessionId: current.id,
      },
    };

    this.searchJobs.set(jobId, next);
    this.syncSessionFromSearchJob(next);
    return next;
  }

  resolvePurchasePath(purchasePathId: string): StoredPurchasePath | undefined {
    return this.purchasePaths.get(purchasePathId);
  }

  createMatrixJob(input: Omit<MatrixJobRecord, "id" | "createdAt" | "updatedAt">): MatrixJobRecord {
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const record: MatrixJobRecord = {
      ...input,
      id,
      createdAt: timestamp,
      updatedAt: timestamp,
      searchMeta: {
        ...input.searchMeta,
        searchSessionId: id,
      },
    };

    this.matrixJobs.set(id, record);
    return record;
  }

  getMatrixJob(jobId: string): MatrixJobRecord | undefined {
    return this.matrixJobs.get(jobId);
  }

  updateMatrixJob(
    jobId: string,
    updater: (current: MatrixJobRecord) => MatrixJobRecord,
  ): MatrixJobRecord | undefined {
    const current = this.matrixJobs.get(jobId);
    if (!current) {
      return undefined;
    }

    const next = {
      ...updater(current),
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };

    this.matrixJobs.set(jobId, next);
    return next;
  }

  private rewriteOfferPaths(sessionId: string, offer: CanonicalOffer): CanonicalOffer {
    const trackedIds = this.sessionPurchasePathIds.get(sessionId) ?? new Set<string>();
    this.sessionPurchasePathIds.set(sessionId, trackedIds);
    const rewrittenPaths = offer.purchasePaths.map((path) => {
      const purchasePathId = randomUUID();
      const createdAt = new Date().toISOString();

      const rewritten: PurchasePath = {
        ...path,
        id: purchasePathId,
        url: `/r/${purchasePathId}`,
      };

      this.purchasePaths.set(purchasePathId, {
        sessionId,
        offerId: offer.id,
        path,
        createdAt,
      });
      trackedIds.add(purchasePathId);

      return rewritten;
    });

    return {
      ...offer,
      purchasePaths: rewrittenPaths,
    };
  }

  private syncSessionFromSearchJob(job: SearchJobRecord): void {
    this.forgetSessionPurchasePaths(job.id);
    const previousOffersById = new Map(
      (this.sessions.get(job.id)?.offers ?? []).map((offer) => [offer.id, offer] as const),
    );
    const record: SearchSessionRecord = {
      id: job.id,
      request: job.request,
      providerContext: job.providerContext,
      offers: job.allOffers.map((offer) =>
        this.rewriteOfferPaths(job.id, this.preferSessionOffer(previousOffersById.get(offer.id), offer))
      ),
      matrix: undefined,
      searchMeta: {
        ...job.searchMeta,
        searchSessionId: job.id,
      },
      providerMeta: job.providerMeta,
      warnings: job.warnings,
      createdAt: job.createdAt,
    };

    this.sessions.set(job.id, record);
  }

  private forgetSessionPurchasePaths(sessionId: string): void {
    const trackedIds = this.sessionPurchasePathIds.get(sessionId);
    if (!trackedIds) {
      return;
    }

    trackedIds.forEach((purchasePathId) => {
      this.purchasePaths.delete(purchasePathId);
    });
    this.sessionPurchasePathIds.delete(sessionId);
  }

  private forgetOfferPurchasePaths(sessionId: string, paths: PurchasePath[]): void {
    const trackedIds = this.sessionPurchasePathIds.get(sessionId);
    if (!trackedIds) {
      return;
    }

    paths.forEach((path) => {
      this.purchasePaths.delete(path.id);
      trackedIds.delete(path.id);
    });

    if (trackedIds.size === 0) {
      this.sessionPurchasePathIds.delete(sessionId);
    }
  }

  private offerValidationTaskKey(sessionId: string, offerId: string): string {
    return `${sessionId}:${offerId}`;
  }

  private preferSessionOffer(
    previousOffer: CanonicalOffer | undefined,
    nextOffer: CanonicalOffer,
  ): CanonicalOffer {
    if (!previousOffer || previousOffer.priceConfidence !== "validated" || nextOffer.priceConfidence === "validated") {
      return nextOffer;
    }

    return {
      ...nextOffer,
      ...previousOffer,
      purchasePaths: nextOffer.purchasePaths,
    };
  }
}
