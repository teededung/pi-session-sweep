import {
  SessionManager,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { enrichSessionWithResponsibleAgent } from "./session-agent.ts";
import { sortSessionsNewestFirst } from "./session-sort.ts";
import type { SweepSessionInfo, SessionScope } from "./types.ts";

function ensureSessionArray(value: unknown): SweepSessionInfo[] {
  if (!Array.isArray(value)) {
    throw new Error("Session manager returned a non-array response.");
  }

  return value as SweepSessionInfo[];
}

export async function loadSessions(
  ctx: ExtensionCommandContext,
  scope: SessionScope,
): Promise<SweepSessionInfo[]> {
  const loaded =
    scope === "all"
      ? await SessionManager.listAll()
      : await SessionManager.list(
          ctx.sessionManager.getCwd(),
          ctx.sessionManager.getSessionDir(),
        );

  const sortedSessions = sortSessionsNewestFirst(ensureSessionArray(loaded));
  return Promise.all(sortedSessions.map((session) => enrichSessionWithResponsibleAgent(session)));
}
