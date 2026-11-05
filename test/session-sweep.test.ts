import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier === "@earendil-works/pi-tui") {
        return {
          url:
            "data:text/javascript," +
            encodeURIComponent(
              "export const matchesKey = (d, k) => d === k;" +
                "export const truncateToWidth = (t, w) => String(t).slice(0, w);" +
                "export const visibleWidth = (t) => String(t).length;",
            ),
          shortCircuit: true,
        };
      }
      throw error;
    }
  },
});

const {
  deleteAgyConversation,
  extractAgyConversationIds,
  purgeAgyConversationIndexesSync,
} = await import("../src/session-antigravity.ts");
const {
  flushScheduledSessionDeletionForQuit,
  scheduleSessionDeletionForQuit,
} = await import("../src/session-quit-shutdown.ts");
const {
  DROP_ARGUMENT_COMPLETIONS,
  SWEEP_ARGUMENT_COMPLETIONS,
  getMatchedCompletions,
} = await import("../src/argument-completions.ts");
const { sortSessionsNewestFirst } = await import("../src/session-sort.ts");
const { shortenPath } = await import("../src/session-format.ts");
const { ListPicker } = await import("../src/tui/list-picker-base.ts");
import type { KeybindingsLike } from "../src/tui/frame-helpers.ts";

test("extractAgyConversationIds respects sessionId ownership on forked sessions", async (t) => {
  const tmp = await mkdtemp(path.join(tmpdir(), "pi-session-sweep-fork-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));

  const parentSessionFile = path.join(tmp, "parent.jsonl");
  const forkedSessionFile = path.join(tmp, "forked.jsonl");
  const parentCid = "11111111-1111-4111-8111-111111111111";
  const forkedCid = "22222222-2222-4222-8222-222222222222";

  await writeFile(
    parentSessionFile,
    [
      JSON.stringify({ type: "session", version: 3, id: "parent-session-id" }),
      JSON.stringify({
        type: "custom",
        customType: "pi-agy-conversation-state",
        data: { sessionId: "parent-session-id", conversationId: parentCid },
      }),
    ].join("\n"),
    "utf8",
  );

  // Forked session right after /fork: contains copied parent entry with parent-session-id
  await writeFile(
    forkedSessionFile,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "forked-session-id",
        parentSession: parentSessionFile,
      }),
      JSON.stringify({
        type: "custom",
        customType: "pi-agy-conversation-state",
        data: { sessionId: "parent-session-id", conversationId: parentCid },
      }),
    ].join("\n"),
    "utf8",
  );

  assert.deepEqual(extractAgyConversationIds(undefined, parentSessionFile), [parentCid]);
  assert.deepEqual(extractAgyConversationIds(undefined, forkedSessionFile), []);

  // Also test with in-memory ctx.sessionManager for forked session before any new agy turn
  const fakeForkedCtx = {
    sessionManager: {
      getSessionId: () => "forked-session-id",
      getEntries: () => [
        {
          type: "custom",
          customType: "pi-agy-conversation-state",
          data: { sessionId: "parent-session-id", conversationId: parentCid },
        },
      ],
    },
  } as unknown as Parameters<typeof extractAgyConversationIds>[0];

  assert.deepEqual(extractAgyConversationIds(fakeForkedCtx, forkedSessionFile), []);

  // Once forked session runs its own turn, only forkedCid is returned
  await writeFile(
    forkedSessionFile,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "forked-session-id",
        parentSession: parentSessionFile,
      }),
      JSON.stringify({
        type: "custom",
        customType: "pi-agy-conversation-state",
        data: { sessionId: "parent-session-id", conversationId: parentCid },
      }),
      JSON.stringify({
        type: "custom",
        customType: "pi-agy-conversation-state",
        data: { sessionId: "forked-session-id", conversationId: forkedCid },
      }),
    ].join("\n"),
    "utf8",
  );

  assert.deepEqual(extractAgyConversationIds(undefined, forkedSessionFile), [forkedCid]);
});

test("deleteAgyConversation removes conversation files, subagent trees, SQLite summary rows, and caches", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "pi-session-sweep-agy-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const agyBase = path.join(home, ".gemini", "antigravity-cli");
  await mkdir(path.join(agyBase, "conversations"), { recursive: true });
  await mkdir(path.join(agyBase, "annotations"), { recursive: true });
  await mkdir(path.join(agyBase, "cache"), { recursive: true });

  const rootCid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const subCid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const keepCid = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  for (const cid of [rootCid, subCid, keepCid]) {
    await writeFile(path.join(agyBase, "conversations", `${cid}.db`), "db", "utf8");
    await writeFile(path.join(agyBase, "annotations", `${cid}.pbtxt`), `title:"${cid}"`, "utf8");
    await mkdir(path.join(agyBase, "brain", cid), { recursive: true });
  }

  const subDir = path.join(agyBase, "brain", rootCid, ".system_generated", "subagents");
  await mkdir(subDir, { recursive: true });
  await writeFile(
    path.join(subDir, `${subCid}.json`),
    JSON.stringify({ conversationId: subCid }),
    "utf8",
  );

  const dbPath = path.join(agyBase, "conversation_summaries.db");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, parent_conversation_id TEXT, title TEXT)",
  );
  db.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?)").run(rootCid, null, "Root");
  db.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?)").run(subCid, rootCid, "Sub");
  db.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?)").run(keepCid, null, "Keep");
  db.close();

  await writeFile(
    path.join(agyBase, "cache", "conversation_metadata.json"),
    JSON.stringify({
      conversations: {
        [rootCid]: { summary: { Title: "Root" } },
        [subCid]: { summary: { Title: "Sub" } },
        [keepCid]: { summary: { Title: "Keep" } },
      },
    }),
    "utf8",
  );

  await deleteAgyConversation(rootCid, home);

  await assert.rejects(stat(path.join(agyBase, "conversations", `${rootCid}.db`)));
  await assert.rejects(stat(path.join(agyBase, "conversations", `${subCid}.db`)));
  assert.ok(await stat(path.join(agyBase, "conversations", `${keepCid}.db`)));

  const checkDb = new DatabaseSync(dbPath, { readOnly: true });
  const rows = checkDb
    .prepare("SELECT conversation_id FROM conversation_summaries")
    .all() as Array<{ conversation_id: string }>;
  checkDb.close();
  assert.deepEqual(rows.map((r) => r.conversation_id), [keepCid]);

  const meta = JSON.parse(
    await readFile(path.join(agyBase, "cache", "conversation_metadata.json"), "utf8"),
  ) as { conversations: Record<string, unknown> };
  assert.deepEqual(Object.keys(meta.conversations), [keepCid]);
});

test("argument completions and session sorting work as expected", () => {
  assert.equal(getMatchedCompletions("qu", DROP_ARGUMENT_COMPLETIONS)?.[0]?.value, "quit");
  assert.equal(getMatchedCompletions("al", SWEEP_ARGUMENT_COMPLETIONS)?.[0]?.value, "all");
  assert.equal(getMatchedCompletions("nonexistent", DROP_ARGUMENT_COMPLETIONS), null);

  const older = {
    id: "1",
    path: "/tmp/a.jsonl",
    cwd: "/tmp",
    created: new Date(1000),
    modified: new Date(1000),
    messageCount: 1,
    firstMessage: "older",
    allMessagesText: "older",
  };
  const newer = {
    id: "2",
    path: "/tmp/b.jsonl",
    cwd: "/tmp",
    created: new Date(2000),
    modified: new Date(2000),
    messageCount: 2,
    firstMessage: "newer",
    allMessagesText: "newer",
  };
  const sorted = sortSessionsNewestFirst([older, newer]);
  assert.equal(sorted[0]?.id, "2");
  assert.equal(sorted[1]?.id, "1");
});

test("shortenPath respects home directory boundaries and ListPicker honors Pi 1.5.0 viewport & keybindings", () => {
  assert.equal(shortenPath("/Users/alice", "/Users/alice"), "~");
  assert.equal(shortenPath("/Users/alice/work/repo", "/Users/alice"), "~/work/repo");
  assert.equal(shortenPath("/Users/alice2/work/repo", "/Users/alice"), "/Users/alice2/work/repo");

  class DummyPicker extends ListPicker {
    cancelled = false;
    confirmed = false;
    constructor(kb?: KeybindingsLike) {
      super({}, 20, () => {}, kb);
      this.prepareViewport(5);
    }
    get cursor(): number {
      return this.cursorIndex;
    }
    protected get itemCount(): number {
      return 12;
    }
    protected get minRenderHeight(): number {
      return 6;
    }
    protected onCancel(): void {
      this.cancelled = true;
    }
    protected handlePickerAction(data: string): void {
      if (this.keybindings?.matches(data, "tui.select.confirm")) {
        this.confirmed = true;
      }
    }
    render(): string[] {
      return [];
    }
  }

  const kb: KeybindingsLike = {
    matches: (data, action) =>
      (data === "CUSTOM_PGDN" && action === "tui.select.pageDown") ||
      (data === "CUSTOM_OK" && action === "tui.select.confirm") ||
      (data === "CUSTOM_ESC" && action === "tui.select.cancel"),
  };
  const picker = new DummyPicker(kb);
  assert.equal(picker.capturesViewportInput, true);
  picker.handleInput("CUSTOM_PGDN");
  assert.equal(picker.cursor, 4);
  picker.handleInput("CUSTOM_OK");
  assert.equal(picker.confirmed, true);
  picker.handleInput("CUSTOM_ESC");
  assert.equal(picker.cancelled, true);
});

test("flushScheduledSessionDeletionForQuit + purgeAgyConversationIndexesSync sweep ACP ghost summary rows independently", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "pi-session-sweep-quit-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const agyBase = path.join(home, ".gemini", "antigravity-cli");
  await mkdir(path.join(agyBase, "conversations"), { recursive: true });
  await mkdir(path.join(agyBase, "cache"), { recursive: true });

  const cid = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const keepCid = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  await writeFile(path.join(agyBase, "conversations", `${cid}.db`), "db", "utf8");

  const dbPath = path.join(agyBase, "conversation_summaries.db");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, parent_conversation_id TEXT, title TEXT)",
  );
  db.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?)").run(cid, null, "DropMe");
  db.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?)").run(keepCid, null, "KeepMe");
  db.close();

  const beforeListeners = new Set(process.listeners("exit"));
  scheduleSessionDeletionForQuit(undefined, [cid]);
  await flushScheduledSessionDeletionForQuit(
    { ui: { notify: () => {} } } as unknown as Parameters<typeof flushScheduledSessionDeletionForQuit>[0],
    { homeDirectory: home, registerProcessExitSweep: true },
  );

  const addedListeners = process
    .listeners("exit")
    .filter((fn) => !beforeListeners.has(fn));
  assert.equal(addedListeners.length, 1);

  // Simulate a later extension killing warm `agy acp`, which re-inserts a ghost summary row on SIGTERM
  const ghostDb = new DatabaseSync(dbPath);
  ghostDb.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?)").run(cid, null, "Ghost");
  ghostDb.close();

  // Trigger the registered exit listener (and remove it so test runner exit stays clean)
  process.removeListener("exit", addedListeners[0]!);
  addedListeners[0]!(0);

  const checkDb = new DatabaseSync(dbPath, { readOnly: true });
  const rows = checkDb
    .prepare("SELECT conversation_id FROM conversation_summaries")
    .all() as Array<{ conversation_id: string }>;
  checkDb.close();
  assert.deepEqual(rows.map((r) => r.conversation_id), [keepCid]);

  // Direct sync helper is also idempotent on empty/already-deleted sets
  purgeAgyConversationIndexesSync([cid], home);
});

