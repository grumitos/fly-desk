import { loadRuntimeConfig } from "./config";
import { LocalAgilProvider } from "./core/agil-provider";
import { LocalCostamarProvider } from "./core/costamar-provider";
import { SearchOrchestrator } from "./core/orchestrator";
import { SearchSessionStore } from "./session-store";

export interface RuntimeServices {
  orchestrator: SearchOrchestrator;
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
    sessions: new SearchSessionStore(),
  };

  return runtime;
}
