export interface CommandCompletion {
  value: string;
  label: string;
  description?: string;
}

export const DROP_ARGUMENT_COMPLETIONS = [
  {
    value: "quit",
    label: "quit",
    description: "Delete the current session and quit Pi immediately",
  },
  {
    value: "agent",
    label: "agent",
    description: "Start a fresh session with a selected target agent",
  },
  {
    value: "list",
    label: "list",
    description: "Open interactive batch session sweep for the current directory",
  },
  {
    value: "all",
    label: "all",
    description: "Open interactive batch session sweep across all directories",
  },
  {
    value: "help",
    label: "help",
    description: "Show usage",
  },
] as const satisfies readonly CommandCompletion[];

export const SWEEP_ARGUMENT_COMPLETIONS = [
  {
    value: "current",
    label: "current",
    description: "Batch-sweep sessions from the current working directory only",
  },
  {
    value: "all",
    label: "all",
    description: "Batch-sweep sessions across every working directory",
  },
  {
    value: "quit",
    label: "quit",
    description: "Delete the current session and quit Pi immediately",
  },
  {
    value: "agent",
    label: "agent",
    description: "Drop the current session and start a fresh one with a target agent",
  },
  {
    value: "help",
    label: "help",
    description: "Show usage",
  },
] as const satisfies readonly CommandCompletion[];

export function getMatchedCompletions(
  argumentPrefix: string,
  completions: readonly CommandCompletion[],
): CommandCompletion[] | null {
  const normalizedPrefix = argumentPrefix.trim().toLowerCase();
  if (!normalizedPrefix) {
    return completions.map((completion) => ({ ...completion }));
  }

  const matched = completions.filter((completion) =>
    completion.value.startsWith(normalizedPrefix),
  );
  if (matched.length === 0) {
    return null;
  }

  return matched.map((completion) => ({ ...completion }));
}
