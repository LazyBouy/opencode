// Texts OpenCode adds to an agent's requests from its own code that are not layers of the Prompt
// Profile: routing them through the profile would need changes to OpenCode's core, which upstream
// merges would fight. The agent page declares them with their files (FORK.md: keep this list in line
// with those files after a merge). `agents`: only for these agents; every agent otherwise.
export type PromptException = {
  id: "title-request" | "compaction-request" | "read-reminder" | "tool-texts" | "tool-descriptions" | "message-system"
  agents?: ReadonlyArray<string>
  files: ReadonlyArray<string>
}

export const PROMPT_EXCEPTIONS: ReadonlyArray<PromptException> = [
  { id: "title-request", agents: ["title"], files: ["packages/opencode/src/session/prompt.ts"] },
  { id: "compaction-request", agents: ["compaction"], files: ["packages/core/src/session/compaction.ts"] },
  {
    id: "read-reminder",
    files: ["packages/opencode/src/tool/read.ts", "packages/opencode/src/session/instruction.ts"],
  },
  {
    id: "tool-texts",
    files: [
      "packages/opencode/src/session/prompt.ts",
      "packages/opencode/src/session/message-v2.ts",
      "packages/opencode/src/tool/truncate.ts",
      "packages/opencode/src/tool/skill.ts",
    ],
  },
  {
    id: "tool-descriptions",
    files: ["packages/opencode/src/session/tools.ts", "packages/opencode/src/session/prompt.ts"],
  },
  { id: "message-system", files: ["packages/opencode/src/session/llm/request.ts"] },
]

export function exceptionsFor(agent: string) {
  return PROMPT_EXCEPTIONS.filter((item) => !item.agents || item.agents.includes(agent))
}
