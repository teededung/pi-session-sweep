import { basename } from "node:path";

import type { ExtensionCommandContext, SessionManager } from "@earendil-works/pi-coding-agent";

import { DROP_COMMAND, DROP_ALIAS_COMMAND } from "./constants.ts";
import {
  getMatchedCompletions,
  DROP_ARGUMENT_COMPLETIONS,
  type CommandCompletion,
} from "./argument-completions.ts";
import {
  resolveTargetAgentForDrop,
  type SelectableAgent,
} from "./agent-target.ts";
import { extractPersistedActiveAgentNameFromEntries } from "./session-agent.ts";
import { deleteSessionFile } from "./session-delete.ts";
import { appendActiveAgentSessionEntry } from "./session-entry.ts";
import { getErrorMessage } from "./error-utils.ts";
import {
  clearScheduledSessionDeletionForQuit,
  scheduleSessionDeletionForQuit,
} from "./session-quit-shutdown.ts";
import {
  deleteAgyConversation,
  extractAgyConversationIds,
} from "./session-antigravity.ts";

type DropMode = "fresh" | "quit" | "agent" | "sweep";

interface ParsedArgs {
  help: boolean;
  mode: DropMode;
  targetAgentName?: string;
  sweepScope?: "current" | "all";
  error?: string;
}

type DeleteSessionFileFn = typeof deleteSessionFile;

export interface SessionDropCommandOptions {
  deleteSessionFile?: DeleteSessionFileFn;
}

function dropUsage(): string {
  return [
    `Usage: /${DROP_COMMAND} (alias: /${DROP_ALIAS_COMMAND})`,
    `       /${DROP_COMMAND} quit`,
    `       /${DROP_COMMAND} agent [name]`,
    `       /${DROP_COMMAND} list | all`,
    `       /${DROP_COMMAND} help`,
  ].join("\n");
}

function getSessionLabel(sessionPath: string): string {
  const fileName = basename(sessionPath).trim();
  return fileName.length > 0 ? fileName : sessionPath;
}

function parseDropArgs(args: string): ParsedArgs {
  const trimmed = args.trim();
  if (!trimmed) {
    return { help: false, mode: "fresh" };
  }

  const parts = trimmed.split(/\s+/);
  const command = parts[0]?.toLowerCase();
  if (!command) {
    return { help: false, mode: "fresh" };
  }

  if (command === "help") {
    return { help: true, mode: "fresh" };
  }

  if (command === "quit" || command === "exit" || command === "q") {
    return parts.length === 1
      ? { help: false, mode: "quit" }
      : {
          help: false,
          mode: "quit",
          error: `/${DROP_COMMAND} quit does not accept additional arguments.`,
        };
  }

  if (command === "agent") {
    return {
      help: false,
      mode: "agent",
      targetAgentName: parts.length > 1 ? parts.slice(1).join(" ") : undefined,
    };
  }

  if (command === "list" || command === "pick" || command === "current") {
    return { help: false, mode: "sweep", sweepScope: "current" };
  }

  if (command === "all") {
    return { help: false, mode: "sweep", sweepScope: "all" };
  }

  return {
    help: false,
    mode: "fresh",
    error: `Unknown argument: ${trimmed}`,
  };
}

function buildFreshConfirmationMessage(
  previousSessionFile: string | undefined,
  agyIds: string[] = [],
): string {
  if (!previousSessionFile && agyIds.length === 0) {
    return "This will start a new session. The current session is not persisted yet, so there is no session file to delete.";
  }

  const parts = [
    "This will start a new session and permanently remove the current session from your session history.",
  ];

  if (previousSessionFile) {
    parts.push("", `Current session: ${getSessionLabel(previousSessionFile)}`);
  }

  if (agyIds.length > 0) {
    parts.push(`Antigravity conversation: ${agyIds.join(", ")}`);
  }

  parts.push(
    "",
    "Pi will try moving files to trash first, then permanently delete them if trash is unavailable.",
  );

  return parts.join("\n");
}

function buildQuitConfirmationMessage(
  previousSessionFile: string | undefined,
  agyIds: string[] = [],
): string {
  if (!previousSessionFile && agyIds.length === 0) {
    return "This will quit Pi immediately. The current session is not persisted yet, so there is no session file to delete first.";
  }

  const parts = [
    "This will permanently remove the current session and then quit Pi immediately.",
  ];

  if (previousSessionFile) {
    parts.push("", `Current session: ${getSessionLabel(previousSessionFile)}`);
  }

  if (agyIds.length > 0) {
    parts.push(`Antigravity conversation: ${agyIds.join(", ")}`);
  }

  parts.push(
    "",
    "Pi will try moving files to trash first, then permanently delete them if trash is unavailable.",
  );

  return parts.join("\n");
}

function buildAgentConfirmationMessage(
  previousSessionFile: string | undefined,
  targetAgent: SelectableAgent,
  agyIds: string[] = [],
): string {
  if (!previousSessionFile && agyIds.length === 0) {
    return [
      `This will start a new session with agent '${targetAgent.name}'.`,
      "",
      "The current session is not persisted yet, so there is no session file to delete.",
    ].join("\n");
  }

  const parts = [
    `This will start a new session with agent '${targetAgent.name}' and remove the current session from history.`,
    "",
  ];

  if (previousSessionFile) {
    parts.push(`Current session: ${getSessionLabel(previousSessionFile)}`);
  }

  if (agyIds.length > 0) {
    parts.push(`Antigravity conversation: ${agyIds.join(", ")}`);
  }

  parts.push(
    `Target agent: ${targetAgent.name}`,
    "",
    "Pi will try moving the old session to trash first, then permanently delete it if trash is unavailable.",
  );

  return parts.join("\n");
}

async function deletePreviousSessionAfterSwitch(
  ctx: ExtensionCommandContext,
  previousSessionFile: string | undefined,
  deleteSessionFileFn: DeleteSessionFileFn,
): Promise<void> {
  if (!previousSessionFile) {
    ctx.ui.notify(
      "Started a new session. Previous session was not persisted, so nothing was deleted.",
      "info",
    );
    return;
  }

  const currentSessionFile = ctx.sessionManager.getSessionFile();
  if (currentSessionFile && currentSessionFile === previousSessionFile) {
    ctx.ui.notify(
      "Started session appears to match the previous session path; skipped deleting it for safety.",
      "warning",
    );
    return;
  }

  try {
    const deleteResult = await deleteSessionFileFn(previousSessionFile);
    if (!deleteResult.ok) {
      ctx.ui.notify(
        `Started a new session, but failed to delete the previous session: ${deleteResult.error}`,
        "warning",
      );
      return;
    }

    const methodLabel = deleteResult.method === "trash" ? "moved to trash" : "permanently deleted";
    ctx.ui.notify(
      `Started a new session and ${methodLabel} the previous session (${getSessionLabel(previousSessionFile)}).`,
      "info",
    );
  } catch (error) {
    ctx.ui.notify(
      `Started a new session, but failed to delete the previous session: ${getErrorMessage(error)}`,
      "warning",
    );
  }
}

async function startNewSession(
  ctx: ExtensionCommandContext,
  setup: ((sessionManager: SessionManager) => Promise<void>) | undefined,
  failureMessagePrefix: string,
): Promise<{ cancelled: boolean }> {
  try {
    const newSessionResult = await ctx.newSession(
      setup ? { setup } : undefined,
    );
    if (newSessionResult.cancelled) {
      ctx.ui.notify("New session cancelled.", "info");
      return { cancelled: true };
    }
    return { cancelled: false };
  } catch (error) {
    ctx.ui.notify(`${failureMessagePrefix}: ${getErrorMessage(error)}`, "error");
    return { cancelled: true };
  }
}

async function startFreshSession(
  ctx: ExtensionCommandContext,
  previousSessionFile: string | undefined,
  agyIds: string[],
  deleteSessionFileFn: DeleteSessionFileFn,
): Promise<void> {
  const result = await startNewSession(ctx, undefined, "Failed to start a new session");
  if (result.cancelled) {
    return;
  }

  await deletePreviousSessionAfterSwitch(ctx, previousSessionFile, deleteSessionFileFn);
  for (const cid of agyIds) {
    await deleteAgyConversation(cid);
  }
}

async function startAgentTargetSession(
  ctx: ExtensionCommandContext,
  previousSessionFile: string | undefined,
  targetAgent: SelectableAgent,
  agyIds: string[],
  deleteSessionFileFn: DeleteSessionFileFn,
): Promise<void> {
  const result = await startNewSession(
    ctx,
    async (sessionManager) => appendActiveAgentSessionEntry(sessionManager, targetAgent.name),
    `Failed to start a new session for agent '${targetAgent.name}'`,
  );
  if (result.cancelled) {
    return;
  }

  await deletePreviousSessionAfterSwitch(ctx, previousSessionFile, deleteSessionFileFn);
  for (const cid of agyIds) {
    await deleteAgyConversation(cid);
  }
}

async function requestGracefulQuit(
  ctx: ExtensionCommandContext,
  previousSessionFile: string | undefined,
  agyIds: string[] = [],
): Promise<void> {
  const shutdown = (ctx as ExtensionCommandContext & {
    shutdown?: () => Promise<void> | void;
  }).shutdown;

  if (typeof shutdown !== "function") {
    ctx.ui.notify(
      `Graceful shutdown is unavailable in this Pi build. Update Pi to use /${DROP_COMMAND} quit safely.`,
      "warning",
    );
    return;
  }

  scheduleSessionDeletionForQuit(previousSessionFile, agyIds);

  try {
    await Promise.resolve(shutdown.call(ctx));
  } catch (error) {
    clearScheduledSessionDeletionForQuit();
    ctx.ui.notify(`Failed to quit Pi gracefully: ${getErrorMessage(error)}`, "error");
  }
}

export function getSessionDropArgumentCompletions(
  argumentPrefix: string,
): CommandCompletion[] | null {
  return getMatchedCompletions(argumentPrefix, DROP_ARGUMENT_COMPLETIONS);
}

export async function handleSessionDropCommand(
  args: string,
  ctx: ExtensionCommandContext,
  options: SessionDropCommandOptions = {},
): Promise<void> {
  const parsed = parseDropArgs(args);
  if (parsed.help) {
    ctx.ui.notify(dropUsage(), "info");
    return;
  }

  if (parsed.error) {
    ctx.ui.notify(`${parsed.error}\n${dropUsage()}`, "warning");
    return;
  }

  if (parsed.mode === "sweep") {
    const { handleSessionSweepCommand } = await import("./session-sweep-command.ts");
    await handleSessionSweepCommand(parsed.sweepScope ?? "current", ctx);
    return;
  }

  if (!ctx.hasUI) {
    ctx.ui.notify(`/${DROP_COMMAND} requires interactive TUI mode.`, "warning");
    return;
  }

  const previousSessionFile = ctx.sessionManager.getSessionFile();
  const deleteSessionFileFn = options.deleteSessionFile ?? deleteSessionFile;
  const agyIds = extractAgyConversationIds(ctx, previousSessionFile);

  if (parsed.mode === "fresh") {
    const confirmed = await ctx.ui.confirm(
      "Drop current session and start fresh",
      buildFreshConfirmationMessage(previousSessionFile, agyIds),
    );

    if (!confirmed) {
      ctx.ui.notify(`/${DROP_COMMAND} cancelled.`, "info");
      return;
    }

    await startFreshSession(ctx, previousSessionFile, agyIds, deleteSessionFileFn);
    return;
  }

  if (parsed.mode === "quit") {
    const confirmed = await ctx.ui.confirm(
      "Drop current session and quit Pi",
      buildQuitConfirmationMessage(previousSessionFile, agyIds),
    );

    if (!confirmed) {
      ctx.ui.notify(`/${DROP_COMMAND} quit cancelled.`, "info");
      return;
    }

    await requestGracefulQuit(ctx, previousSessionFile, agyIds);
    return;
  }

  const currentAgentName =
    extractPersistedActiveAgentNameFromEntries(ctx.sessionManager.getEntries()) ?? null;
  const targetAgent = await resolveTargetAgentForDrop(
    ctx,
    parsed.targetAgentName,
    currentAgentName,
  );

  if (targetAgent === null) {
    ctx.ui.notify(`/${DROP_COMMAND} agent cancelled.`, "info");
    return;
  }

  if (!targetAgent) {
    return;
  }

  const confirmed = await ctx.ui.confirm(
    `Start a new '${targetAgent.name}' session`,
    buildAgentConfirmationMessage(previousSessionFile, targetAgent, agyIds),
  );

  if (!confirmed) {
    ctx.ui.notify(`/${DROP_COMMAND} agent cancelled.`, "info");
    return;
  }

  await startAgentTargetSession(ctx, previousSessionFile, targetAgent, agyIds, deleteSessionFileFn);
}
