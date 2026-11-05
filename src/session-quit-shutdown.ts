import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { deleteSessionFile } from "./session-delete.ts";
import { getErrorMessage } from "./error-utils.ts";
import {
  deleteAgyConversation,
  extractAgyConversationIds,
  purgeAgyConversationIndexesSync,
} from "./session-antigravity.ts";

let pendingSessionFileForQuitDeletion: string | undefined;
let pendingAgyConversationIds: string[] = [];

export function scheduleSessionDeletionForQuit(
  sessionFile: string | undefined,
  agyConversationIds: string[] = [],
): void {
  pendingSessionFileForQuitDeletion = sessionFile;
  pendingAgyConversationIds = [...agyConversationIds];
}

export function clearScheduledSessionDeletionForQuit(): void {
  pendingSessionFileForQuitDeletion = undefined;
  pendingAgyConversationIds = [];
}

export async function flushScheduledSessionDeletionForQuit(
  ctx: ExtensionContext,
  options?: { homeDirectory?: string; registerProcessExitSweep?: boolean },
): Promise<void> {
  const sessionFile = pendingSessionFileForQuitDeletion;
  const agyIds = new Set(pendingAgyConversationIds);
  pendingSessionFileForQuitDeletion = undefined;
  pendingAgyConversationIds = [];

  // Only run when `/drop quit` explicitly scheduled a deletion.
  if (!sessionFile && agyIds.size === 0) {
    return;
  }

  // Also extract any Antigravity conversation IDs directly from ctx/file
  try {
    for (const cid of extractAgyConversationIds(ctx, sessionFile)) {
      agyIds.add(cid);
    }
  } catch {
    // Ignore extraction errors
  }

  // Delete all associated Antigravity conversations (including descendant subagents)
  const allDeletedAgyIds = new Set<string>(agyIds);
  for (const conversationId of agyIds) {
    try {
      const removed = await deleteAgyConversation(conversationId, options?.homeDirectory);
      for (const id of removed) allDeletedAgyIds.add(id);
    } catch (error) {
      ctx.ui.notify(
        `Failed to clean up Antigravity conversation ${conversationId}: ${getErrorMessage(error)}`,
        "warning",
      );
    }
  }

  // Extension load order independence: if another extension loaded AFTER
  // `pi-session-sweep` terminates a warm `agy acp` process later in
  // `session_shutdown`, `agy acp` flushes an in-memory summary row back into
  // `conversation_summaries.db` on SIGTERM. Re-purge indexes on `process.exit`
  // (after all `session_shutdown` handlers have completed) without needing any
  // coordination with the ACP provider extension.
  if (allDeletedAgyIds.size > 0 && options?.registerProcessExitSweep !== false) {
    const homeDir = options?.homeDirectory;
    process.once("exit", () => {
      purgeAgyConversationIndexesSync(allDeletedAgyIds, homeDir);
    });
  }

  if (!sessionFile) {
    return;
  }

  try {
    const deleteResult = await deleteSessionFile(sessionFile);
    if (!deleteResult.ok) {
      ctx.ui.notify(
        `Failed to delete the current session during shutdown: ${deleteResult.error}`,
        "warning",
      );
    }
  } catch (error) {
    ctx.ui.notify(
      `Failed to delete the current session during shutdown: ${getErrorMessage(error)}`,
      "warning",
    );
  }
}
