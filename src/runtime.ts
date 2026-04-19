import { loadRuntimeConfig } from "./config";
import { LocalAgilProvider } from "./core/agil-provider";
import { LocalCostamarProvider } from "./core/costamar-provider";
import { SearchOrchestrator } from "./core/orchestrator";
import { LocationSuggestionCacheStore } from "./location-suggestion-cache";
import { SearchSessionStore } from "./session-store";

export interface RuntimeServices {
  orchestrator: SearchOrchestrator;
  locationSuggestions: LocationSuggestionCacheStore;
  sessions: SearchSessionStore;
}

let runtime: RuntimeServices | undefined;

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
    locationSuggestions: new LocationSuggestionCacheStore(),
    sessions: new SearchSessionStore(),
  };

  return runtime;
}

export function resetRuntimeForTests(): void {
  runtime = undefined;
}
