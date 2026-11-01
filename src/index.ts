import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadSessionSweepConfig } from "./config-store.ts";
import { DROP_ALIAS_COMMAND, DROP_COMMAND, SWEEP_COMMAND } from "./constants.ts";
import { flushScheduledSessionDeletionForQuit } from "./session-quit-shutdown.ts";
import {
  getMatchedCompletions,
  DROP_ARGUMENT_COMPLETIONS,
  SWEEP_ARGUMENT_COMPLETIONS,
} from "./argument-completions.ts";

type SessionSweepCommandModule = typeof import("./session-sweep-command.ts");
type SessionDropCommandModule = typeof import("./session-drop-command.ts");

function createLazyModuleLoader<TModule>(
  importer: () => Promise<TModule>,
): () => Promise<TModule> {
  let cached: TModule | undefined;
  let pending: Promise<TModule> | undefined;

  return () => {
    if (cached) {
      return Promise.resolve(cached);
    }

    pending ??= importer().then((module) => {
      cached = module;
      return module;
    });
    return pending;
  };
}

const loadSessionSweepCommandModule = createLazyModuleLoader<SessionSweepCommandModule>(
  () => import("./session-sweep-command.ts"),
);
const loadSessionDropCommandModule = createLazyModuleLoader<SessionDropCommandModule>(
  () => import("./session-drop-command.ts"),
);

export default function sessionSweepExtension(pi: ExtensionAPI): void {
  if (!loadSessionSweepConfig().enabled) {
    return;
  }

  pi.on("session_shutdown", async (_event, ctx) => {
    await flushScheduledSessionDeletionForQuit(ctx);
  });

  pi.registerCommand(DROP_COMMAND, {
    description:
      "Drop the current session and start fresh, switch to a target agent, or quit Pi immediately.",
    getArgumentCompletions: (argumentPrefix) =>
      getMatchedCompletions(argumentPrefix, DROP_ARGUMENT_COMPLETIONS),
    handler: async (args, ctx) => {
      const { handleSessionDropCommand } = await loadSessionDropCommandModule();
      await handleSessionDropCommand(args, ctx);
    },
  });

  pi.registerCommand(DROP_ALIAS_COMMAND, {
    description:
      "Alias for /drop: drop the current session and start fresh, switch agent, or quit Pi.",
    getArgumentCompletions: (argumentPrefix) =>
      getMatchedCompletions(argumentPrefix, DROP_ARGUMENT_COMPLETIONS),
    handler: async (args, ctx) => {
      const { handleSessionDropCommand } = await loadSessionDropCommandModule();
      await handleSessionDropCommand(args, ctx);
    },
  });

  pi.registerCommand(SWEEP_COMMAND, {
    description:
      "Batch-select previous sessions (or drop the current session) and delete them with confirmation.",
    getArgumentCompletions: (argumentPrefix) =>
      getMatchedCompletions(argumentPrefix, SWEEP_ARGUMENT_COMPLETIONS),
    handler: async (args, ctx) => {
      const { handleSessionSweepCommand } = await loadSessionSweepCommandModule();
      await handleSessionSweepCommand(args, ctx);
    },
  });
}
