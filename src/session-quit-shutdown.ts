import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { deleteSessionFile } from "./session-delete.ts";
import { getErrorMessage } from "./error-utils.ts";
import {
  deleteAgyConversation,
  extractAgyConversationIds,
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

  // Delete all associated Antigravity conversations
  for (const conversationId of agyIds) {
    try {
      await deleteAgyConversation(conversationId);
    } catch (error) {
      ctx.ui.notify(
        `Failed to clean up Antigravity conversation ${conversationId}: ${getErrorMessage(error)}`,
        "warning",
      );
    }
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
