import type {
  ExtensionCommandContext,
  SessionInfo,
} from "@earendil-works/pi-coding-agent";

import { SWEEP_COMMAND } from "./constants.ts";
import {
  getMatchedCompletions,
  SWEEP_ARGUMENT_COMPLETIONS,
  type CommandCompletion,
} from "./argument-completions.ts";
import { getSessionTitle } from "./session-format.ts";
import { getErrorMessage } from "./error-utils.ts";
import { deleteSessionFile } from "./session-delete.ts";
import { cleanupAgyConversationsForSession } from "./session-antigravity.ts";
import { loadSessions } from "./session-source.ts";
import { selectSessionsForSweep } from "./session-selection.ts";
import type {
  BatchDeleteResult,
  SweepSessionInfo,
  SessionScope,
} from "./types.ts";

interface ParsedArgs {
  help: boolean;
  scope: SessionScope;
  delegateToDrop?: string;
  error?: string;
}

function usage(): string {
  return [
    `Usage: /${SWEEP_COMMAND} [current|all]`,
    `       /${SWEEP_COMMAND} quit`,
    `       /${SWEEP_COMMAND} agent [name]`,
  ].join("\n");
}

function parseArgs(args: string): ParsedArgs {
  const trimmed = args.trim();
  const normalized = trimmed.toLowerCase();
  if (!normalized || normalized === "current" || normalized === "list" || normalized === "pick") {
    return { help: false, scope: "current" };
  }

  if (normalized === "help") {
    return { help: true, scope: "current" };
  }

  if (normalized === "all") {
    return { help: false, scope: "all" };
  }

  if (
    normalized === "quit" ||
    normalized === "exit" ||
    normalized === "q" ||
    normalized === "agent" ||
    normalized.startsWith("agent ")
  ) {
    return { help: false, scope: "current", delegateToDrop: trimmed };
  }

  return {
    help: false,
    scope: "current",
    error: `Unknown argument: ${trimmed}`,
  };
}

function buildSelectionSummary(sessions: readonly SessionInfo[]): string {
  const preview = sessions
    .slice(0, 6)
    .map((session) => `- ${getSessionTitle(session)} (${session.id.slice(0, 8)})`)
    .join("\n");
  const hiddenCount = Math.max(0, sessions.length - 6);

  if (hiddenCount > 0) {
    return `${preview}\n- …and ${hiddenCount} more`;
  }

  return preview;
}

function buildConfirmationMessage(sessions: readonly SessionInfo[]): string {
  const noun = sessions.length === 1 ? "session" : "sessions";
  return `Delete ${sessions.length} selected ${noun}?\n\n${buildSelectionSummary(sessions)}\n\nThis action removes session files and any linked Antigravity conversations. Pi will try trash first, then permanent delete if trash is unavailable.`;
}

function summarizeFailures(
  failures: readonly { session: SessionInfo; error: string }[],
): string {
  return failures
    .slice(0, 4)
    .map(
      (failure) =>
        `- ${failure.session.id.slice(0, 8)} (${getSessionTitle(failure.session)}): ${failure.error}`,
    )
    .join("\n");
}

async function deleteSelectedSessions(
  selectedSessions: readonly SessionInfo[],
  currentSessionFile: string | undefined,
): Promise<BatchDeleteResult> {
  const result: BatchDeleteResult = {
    deleted: [],
    failed: [],
    methods: {
      trash: 0,
      unlink: 0,
    },
  };

  for (const session of selectedSessions) {
    if (currentSessionFile && session.path === currentSessionFile) {
      result.failed.push({
        session,
        error: "Refused to delete the currently active session.",
      });
      continue;
    }

    try {
      await cleanupAgyConversationsForSession(undefined, session.path);
      const deleteResult = await deleteSessionFile(session.path);
      if (deleteResult.ok) {
        result.deleted.push(session);
        result.methods[deleteResult.method] += 1;
      } else {
        result.failed.push({
          session,
          error: deleteResult.error,
        });
      }
    } catch (error) {
      result.failed.push({
        session,
        error: getErrorMessage(error),
      });
    }
  }

  return result;
}

function notifyDeleteOutcome(ctx: ExtensionCommandContext, result: BatchDeleteResult): void {
  const deletedCount = result.deleted.length;
  const failedCount = result.failed.length;

  if (deletedCount === 0 && failedCount > 0) {
    ctx.ui.notify(
      `No sessions were deleted.\n${summarizeFailures(result.failed)}`,
      "error",
    );
    return;
  }

  if (failedCount === 0) {
    ctx.ui.notify(
      `Deleted ${deletedCount} session(s) (trash: ${result.methods.trash}, permanent: ${result.methods.unlink}).`,
      "info",
    );
    return;
  }

  ctx.ui.notify(
    `Deleted ${deletedCount} session(s), but ${failedCount} failed.\n${summarizeFailures(result.failed)}`,
    "warning",
  );
}

export function getSessionSweepArgumentCompletions(
  argumentPrefix: string,
): CommandCompletion[] | null {
  return getMatchedCompletions(argumentPrefix, SWEEP_ARGUMENT_COMPLETIONS);
}

export async function handleSessionSweepCommand(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.help) {
    ctx.ui.notify(usage(), "info");
    return;
  }

  if (parsed.delegateToDrop !== undefined) {
    const { handleSessionDropCommand } = await import("./session-drop-command.ts");
    await handleSessionDropCommand(parsed.delegateToDrop, ctx);
    return;
  }

  if (parsed.error) {
    ctx.ui.notify(`${parsed.error}\n${usage()}`, "warning");
    return;
  }

  if (!ctx.hasUI) {
    ctx.ui.notify(`/${SWEEP_COMMAND} requires interactive TUI mode.`, "warning");
    return;
  }

  const currentSessionFile = ctx.sessionManager.getSessionFile();

  while (true) {
    let sessions: SweepSessionInfo[];
    try {
      sessions = await loadSessions(ctx, parsed.scope);
    } catch (error) {
      ctx.ui.notify(`Failed to load sessions: ${getErrorMessage(error)}`, "error");
      return;
    }

    const candidates = sessions.filter(
      (session) => session.path !== currentSessionFile,
    );

    if (candidates.length === 0) {
      ctx.ui.notify(
        "No deletable sessions found for this scope (current active session is excluded).",
        "info",
      );
      return;
    }

    const selection = await selectSessionsForSweep(ctx, candidates);
    if (selection.cancelled) {
      ctx.ui.notify("Session sweep cancelled.", "info");
      return;
    }

    if (selection.refreshRequested) {
      continue;
    }

    const selectedSessions = candidates.filter((session) =>
      selection.selectedPaths.has(session.path),
    );

    if (selectedSessions.length === 0) {
      ctx.ui.notify("No sessions selected. Select one or more sessions first.", "warning");
      continue;
    }

    const confirmed = await ctx.ui.confirm(
      "Delete selected sessions",
      buildConfirmationMessage(selectedSessions),
    );

    if (!confirmed) {
      ctx.ui.notify("Delete cancelled.", "info");
      return;
    }

    const deleteResult = await deleteSelectedSessions(
      selectedSessions,
      currentSessionFile,
    );
    notifyDeleteOutcome(ctx, deleteResult);
    return;
  }
}
