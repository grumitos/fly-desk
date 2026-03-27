import { randomUUID } from "node:crypto";
import { CanonicalOffer, MatrixCell, ProviderMeta, PurchasePath, SearchMeta, SearchRequest } from "./core/types";

interface StoredPurchasePath {
  sessionId: string;
  offerId: string;
  path: PurchasePath;
  createdAt: string;
}

export interface SearchSessionRecord {
  id: string;
  request: SearchRequest;
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
    const record: SearchSessionRecord = {
      id: job.id,
      request: job.request,
      offers: job.allOffers.map((offer) => this.rewriteOfferPaths(job.id, offer)),
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
}
