import { existsSync, promises as fs, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { toRecord } from "./record-utils.ts";

const AGY_CONVERSATION_STATE_ENTRIES = new Set([
  "pi-agy-conversation-state",
  "pi-antigravity-conversation-state",
]);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Extracts all Antigravity conversation IDs owned by the target Pi session.
 *
 * Forked sessions copy branch entries from their parent session into the new
 * `.jsonl` file, where inherited `pi-agy-conversation-state` entries still
 * carry the parent's `data.sessionId`. This function filters entries against
 * the session's own `sessionId` so dropping/sweeping a forked session never
 * deletes the parent session's Antigravity conversation.
 */
export function extractAgyConversationIds(
  ctx?: ExtensionContext,
  sessionFile?: string,
): string[] {
  const ownedIds = new Set<string>();
  const unscopedIds = new Set<string>();
  let targetSessionId: string | undefined;
  let sawScopedEntry = false;

  if (ctx?.sessionManager) {
    try {
      const sid = ctx.sessionManager.getSessionId?.();
      if (typeof sid === "string" && sid.trim().length > 0) {
        targetSessionId = sid.trim();
      }
    } catch {
      // Ignore sessionId lookup error
    }
  }

  // 1. Extract from persisted session JSONL file first (also discovers header sessionId)
  if (sessionFile && existsSync(sessionFile)) {
    try {
      const content = readFileSync(sessionFile, "utf8");
      const lines = content.split(/\r?\n/);
      let fileHeaderSessionId: string | undefined;

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        try {
          const parsed = toRecord(JSON.parse(line));
          if (!parsed) continue;
          if (parsed.type === "session" && typeof parsed.id === "string" && parsed.id.trim()) {
            fileHeaderSessionId = parsed.id.trim();
            if (!targetSessionId) {
              targetSessionId = fileHeaderSessionId;
            }
            continue;
          }
          if (
            parsed.type === "custom" &&
            typeof parsed.customType === "string" &&
            AGY_CONVERSATION_STATE_ENTRIES.has(parsed.customType)
          ) {
            const data = toRecord(parsed.data);
            const cid = typeof data?.conversationId === "string" ? data.conversationId.trim() : "";
            const entrySessionId =
              typeof data?.sessionId === "string" ? data.sessionId.trim() : undefined;
            if (entrySessionId) {
              sawScopedEntry = true;
            }
            if (cid && UUID_REGEX.test(cid)) {
              const effectiveSessionId = fileHeaderSessionId ?? targetSessionId;
              if (entrySessionId) {
                if (!effectiveSessionId || entrySessionId === effectiveSessionId) {
                  ownedIds.add(cid.toLowerCase());
                }
              } else {
                unscopedIds.add(cid.toLowerCase());
              }
            }
          }
        } catch {
          // Ignore malformed JSON lines
        }
      }

      if (ownedIds.size === 0 && !sawScopedEntry && !fileHeaderSessionId) {
        const regex = /"conversationId"\s*:\s*"([0-9a-fA-F-]{36})"/g;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(content)) !== null) {
          const id = match[1];
          if (id && UUID_REGEX.test(id)) {
            unscopedIds.add(id.toLowerCase());
          }
        }
      }
    } catch {
      // Ignore errors reading session file
    }
  }

  // 2. Extract from in-memory sessionManager entries
  if (ctx?.sessionManager) {
    try {
      const entries = ctx.sessionManager.getEntries?.() ?? [];
      for (const entry of entries) {
        if (
          entry.type === "custom" &&
          typeof entry.customType === "string" &&
          AGY_CONVERSATION_STATE_ENTRIES.has(entry.customType)
        ) {
          const data = toRecord(entry.data);
          const cid = typeof data?.conversationId === "string" ? data.conversationId.trim() : "";
          const entrySessionId =
            typeof data?.sessionId === "string" ? data.sessionId.trim() : undefined;
          if (entrySessionId) {
            sawScopedEntry = true;
          }
          if (cid && UUID_REGEX.test(cid)) {
            if (entrySessionId) {
              if (!targetSessionId || entrySessionId === targetSessionId) {
                ownedIds.add(cid.toLowerCase());
              }
            } else {
              unscopedIds.add(cid.toLowerCase());
            }
          }
        }
      }
    } catch {
      // Ignore errors reading in-memory entries
    }
  }

  return Array.from(ownedIds.size > 0 || sawScopedEntry ? ownedIds : unscopedIds);
}

/**
 * Deletes an Antigravity conversation and all its descendant subagent conversations:
 * - SQLite databases: ~/.gemini/antigravity-cli/conversations/<id>.db*
 * - Metadata annotations: ~/.gemini/antigravity-cli/annotations/<id>.pbtxt
 * - Presence & implicit: ~/.gemini/antigravity-cli/presence/<id>.lock, implicit/<id>.pb
 * - Brain logs & tasks: ~/.gemini/antigravity-cli/brain/<id>
 * - Summary DB & caches: ~/.gemini/antigravity-cli/conversation_summaries.db,
 *   cache/conversation_metadata.json, cache/last_conversations.json
 */
export async function deleteAgyConversation(
  conversationId: string,
  homeDirectory = homedir(),
): Promise<void> {
  if (!conversationId || !UUID_REGEX.test(conversationId)) return;
  const agyCliDir = join(homeDirectory, ".gemini", "antigravity-cli");
  const summariesDbPath = join(agyCliDir, "conversation_summaries.db");

  const idsToDelete = new Set<string>();
  const queue: string[] = [conversationId.toLowerCase()];

  let summaryDb: DatabaseSync | undefined;
  if (existsSync(summariesDbPath)) {
    try {
      summaryDb = new DatabaseSync(summariesDbPath);
      summaryDb.exec("PRAGMA busy_timeout = 2000;");
    } catch {
      summaryDb = undefined;
    }
  }

  try {
    while (queue.length > 0 && idsToDelete.size < 256) {
      const current = queue.shift()!;
      if (idsToDelete.has(current)) continue;
      idsToDelete.add(current);

      const subagentsDir = join(agyCliDir, "brain", current, ".system_generated", "subagents");
      try {
        const files = await fs.readdir(subagentsDir);
        for (const file of files) {
          if (!file.endsWith(".json")) continue;
          const stem = file.slice(0, -5).toLowerCase();
          if (UUID_REGEX.test(stem) && !idsToDelete.has(stem)) {
            queue.push(stem);
          }
          try {
            const raw = await fs.readFile(join(subagentsDir, file), "utf8");
            const parsed = toRecord(JSON.parse(raw));
            const childId =
              typeof parsed?.conversationId === "string"
                ? parsed.conversationId.trim().toLowerCase()
                : undefined;
            if (childId && UUID_REGEX.test(childId) && !idsToDelete.has(childId)) {
              queue.push(childId);
            }
          } catch {
            // Ignore malformed subagent JSON
          }
        }
      } catch {
        // No subagents directory
      }

      if (summaryDb) {
        try {
          const rows = summaryDb
            .prepare(
              "SELECT conversation_id FROM conversation_summaries WHERE LOWER(parent_conversation_id) = ?",
            )
            .all(current) as Array<{ conversation_id?: string }>;
          for (const row of rows) {
            const childId = row.conversation_id?.trim().toLowerCase();
            if (childId && UUID_REGEX.test(childId) && !idsToDelete.has(childId)) {
              queue.push(childId);
            }
          }
        } catch {
          // Best-effort
        }
      }
    }

    if (summaryDb) {
      try {
        const deleteById = summaryDb.prepare(
          "DELETE FROM conversation_summaries WHERE LOWER(conversation_id) = ?",
        );
        for (const cid of idsToDelete) {
          deleteById.run(cid);
        }
      } catch {
        // Best-effort
      }
      try {
        const deleteByParent = summaryDb.prepare(
          "DELETE FROM conversation_summaries WHERE LOWER(parent_conversation_id) = ?",
        );
        for (const cid of idsToDelete) {
          deleteByParent.run(cid);
        }
      } catch {
        // Optional column
      }
    }
  } finally {
    try {
      summaryDb?.close();
    } catch {
      // Ignore close errors
    }
  }

  const removals: string[] = [];
  for (const cid of idsToDelete) {
    removals.push(
      join(agyCliDir, "conversations", `${cid}.db`),
      join(agyCliDir, "conversations", `${cid}.db-wal`),
      join(agyCliDir, "conversations", `${cid}.db-shm`),
      join(agyCliDir, "annotations", `${cid}.pbtxt`),
      join(agyCliDir, "presence", `${cid}.lock`),
      join(agyCliDir, "implicit", `${cid}.pb`),
      join(agyCliDir, "brain", cid),
    );
  }
  await Promise.all(
    removals.map((target) => fs.rm(target, { recursive: true, force: true }).catch(() => {})),
  );

  // Clean cache/conversation_metadata.json
  const metadataPath = join(agyCliDir, "cache", "conversation_metadata.json");
  if (existsSync(metadataPath)) {
    try {
      const parsed = toRecord(JSON.parse(readFileSync(metadataPath, "utf8")));
      const conversations = toRecord(parsed?.conversations);
      if (parsed && conversations) {
        let changed = false;
        for (const key of Object.keys(conversations)) {
          if (idsToDelete.has(key.toLowerCase())) {
            delete conversations[key];
            changed = true;
          }
        }
        if (changed) {
          writeFileSync(metadataPath, JSON.stringify(parsed), "utf8");
        }
      }
    } catch {
      // Ignore cache update errors
    }
  }

  // Clean cache/last_conversations.json
  const lastConversationsPath = join(agyCliDir, "cache", "last_conversations.json");
  if (existsSync(lastConversationsPath)) {
    try {
      const parsed = toRecord(JSON.parse(readFileSync(lastConversationsPath, "utf8")));
      if (parsed) {
        let changed = false;
        for (const [workspaceKey, mappedId] of Object.entries(parsed)) {
          const idLower = typeof mappedId === "string" ? mappedId.toLowerCase() : "";
          if (idLower && idsToDelete.has(idLower)) {
            delete parsed[workspaceKey];
            changed = true;
          }
        }
        if (changed) {
          writeFileSync(lastConversationsPath, JSON.stringify(parsed, null, 2), "utf8");
        }
      }
    } catch {
      // Ignore last_conversations update errors
    }
  }
}

/**
 * Convenience helper to clean up all Antigravity conversations linked to a Pi session.
 */
export async function cleanupAgyConversationsForSession(
  ctx?: ExtensionContext,
  sessionFile?: string,
  homeDirectory = homedir(),
): Promise<string[]> {
  const ids = extractAgyConversationIds(ctx, sessionFile);
  for (const id of ids) {
    await deleteAgyConversation(id, homeDirectory);
  }
  return ids;
}
