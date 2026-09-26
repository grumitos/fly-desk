import { LocationSuggestionCacheStore } from "./location-suggestion-cache";
import { LocationUsageStore } from "./location-usage-store";
import { resolvePersistPath } from "./runtime-paths";
import { SearchAdmissionController } from "./search-admission";
import { SearchSessionStore } from "./session-store";
import {
  createProviderStatusTracker,
  providerStatusTtlMsFor,
  type ProviderStatusTracker,
} from "./provider-status";
import { providerPrewarmEnabled, providerPrewarmIntervalMs } from "./provider-prewarm";

export interface RuntimeServices {
  locationSuggestions: LocationSuggestionCacheStore;
  locationUsage: LocationUsageStore;
  providerStatus: ProviderStatusTracker;
  searchAdmission: SearchAdmissionController;
  sessions: SearchSessionStore;
}

let runtime: RuntimeServices | undefined;
let sessionStore: SearchSessionStore | undefined;

export function getRuntimeIfInitialized(): RuntimeServices | undefined {
  return runtime;
}

export function getSessionStoreIfInitialized(): SearchSessionStore | undefined {
  return sessionStore;
}

export function maintainSessionStoreIfInitialized(): void {
  sessionStore?.purgeExpired();
  sessionStore?.reclaimFreePages();
}

export function getRuntime(): RuntimeServices {
  if (runtime) {
    return runtime;
  }

  runtime = {
    locationSuggestions: new LocationSuggestionCacheStore({
      dbPath: resolvePersistPath(
        "FLY_DESK_LOCATION_SUGGESTION_DB_PATH",
        "location-suggestion-cache.sqlite",
      ),
    }),
    locationUsage: new LocationUsageStore({
      dbPath: resolvePersistPath(
        "FLY_DESK_LOCATION_USAGE_DB_PATH",
        "location-usage.sqlite",
      ),
    }),
    /* An observation must not expire before the prewarm that renews it comes
       round again. */
    providerStatus: createProviderStatusTracker({
      ttlMs: providerPrewarmEnabled()
        ? providerStatusTtlMsFor(providerPrewarmIntervalMs())
        : undefined,
    }),
    searchAdmission: new SearchAdmissionController(),
    get sessions() {
      sessionStore ??= new SearchSessionStore({
        dbPath: resolvePersistPath(
          "FLY_DESK_SESSION_DB_PATH",
          "fly-desk-cache.sqlite",
        ),
      });
      return sessionStore;
    },
  };

  return runtime;
}
