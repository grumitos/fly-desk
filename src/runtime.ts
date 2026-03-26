import { loadRuntimeConfig } from "./config";
import { LocalAgilProvider } from "./core/agil-provider";
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
  const provider = new LocalAgilProvider();
  runtime = {
    orchestrator: new SearchOrchestrator(provider),
    sessions: new SearchSessionStore(),
  };

  return runtime;
}
