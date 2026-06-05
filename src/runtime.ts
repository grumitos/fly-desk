import { join } from "node:path";
import { loadRuntimeConfig } from "./config";
import { LocalAgilProvider } from "./core/agil-provider";
import { LocalCostamarProvider } from "./core/costamar-provider";
import { SearchOrchestrator } from "./core/orchestrator";
import { LocationSuggestionCacheStore } from "./location-suggestion-cache";
import { SearchAdmissionController } from "./search-admission";
import { SearchSessionStore } from "./session-store";

export interface RuntimeServices {
  orchestrator: SearchOrchestrator;
  locationSuggestions: LocationSuggestionCacheStore;
  searchAdmission: SearchAdmissionController;
  sessions: SearchSessionStore;
}

let runtime: RuntimeServices | undefined;

function isTestProcess(): boolean {
  return process.env.NODE_ENV === "test";
}

function resolvePersistPath(envKey: string, defaultFileName: string): string | undefined {
  const explicit = process.env[envKey]?.trim();
  if (explicit) {
    return explicit;
  }

  if (isTestProcess()) {
    return undefined;
  }

  return join(process.cwd(), "output", "cache", defaultFileName);
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
      legacyPersistPath: resolvePersistPath(
        "FLY_DESK_LOCATION_SUGGESTION_CACHE_PATH",
        "location-suggestion-cache.json",
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
