import { loadRuntimeConfig } from "./config";
import { LocalAgilProvider } from "./core/agil-provider";
import { LocalCostamarProvider } from "./core/costamar-provider";
import { SearchOrchestrator } from "./core/orchestrator";
import { LocationSuggestionCacheStore } from "./location-suggestion-cache";
import { LocationUsageStore } from "./location-usage-store";
import { resolvePersistPath } from "./runtime-paths";
import { SearchAdmissionController } from "./search-admission";
import { SearchSessionStore } from "./session-store";

export interface RuntimeServices {
  orchestrator: SearchOrchestrator;
  locationSuggestions: LocationSuggestionCacheStore;
  locationUsage: LocationUsageStore;
  searchAdmission: SearchAdmissionController;
  sessions: SearchSessionStore;
}

let runtime: RuntimeServices | undefined;

export function getRuntimeIfInitialized(): RuntimeServices | undefined {
  return runtime;
}

export function getRuntime(): RuntimeServices {
  if (runtime) {
    return runtime;
  }

  loadRuntimeConfig();
  runtime = {
    orchestrator: new SearchOrchestrator([
      new LocalAgilProvider(),
      new LocalCostamarProvider(),
    ]),
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
    searchAdmission: new SearchAdmissionController(),
    sessions: new SearchSessionStore({
      dbPath: resolvePersistPath(
        "FLY_DESK_SESSION_DB_PATH",
        "fly-desk-cache.sqlite",
      ),
      legacyPersistPath: resolvePersistPath(
        "FLY_DESK_SEARCH_SESSION_STORE_PATH",
        "search-session-store.json",
      ),
    }),
  };

  return runtime;
}
