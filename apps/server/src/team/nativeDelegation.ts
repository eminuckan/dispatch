/** Managed IDs are minted by the scheduler. This prefix only removes capability; it grants none. */
export const isManagedTeamThread = (threadId: string) => /^team-[a-f0-9-]+-/.test(threadId);
export const managedCodexConfig = {
  "features.multi_agent": false,
  "features.multi_agent_v2": false,
} as const;
export const managedClaudeDisallowedTools = [
  "Agent",
  "Task",
  "TeamCreate",
  "TeamDelete",
  "SendMessage",
];
