export * as ConfigForkV1 from "./fork"

import { Schema } from "effect"
import { ConfigMergeV1 } from "./merge"

// Top-level config keys this fork adds. ConfigV1.Info spreads these fields once, so new fork
// settings are added here without editing upstream's schema.
export const fields = {
  prompts: Schema.optional(
    Schema.Struct({
      environment: Schema.optional(Schema.Boolean).annotate({
        description:
          "Add the environment block (model, working directory, platform, date) to system prompts (default: true)",
      }),
      skills: Schema.optional(Schema.Boolean).annotate({
        description: "List available skills in system prompts (default: true)",
      }),
      mcp: Schema.optional(Schema.Boolean).annotate({
        description: "Add MCP servers' instructions to system prompts (default: true)",
      }),
    }),
  ).annotate({
    description:
      "No longer used: prompt profiles (the Prompt Profile page) decide which generated sections are sent. Still accepted so existing configs load.",
  }),
  merge: Schema.optional(ConfigMergeV1.Info).annotate({
    description: "Settings for `/merge`, which attaches external agent sessions such as Claude Code",
  }),
  capabilities: Schema.optional(
    Schema.Struct({
      disabled: Schema.optional(
        Schema.Struct({
          commands: Schema.optional(Schema.Array(Schema.String)).annotate({
            description: "Commands hidden here, though a farther scope (the namespace, the global config) defines them",
          }),
          plugins: Schema.optional(Schema.Array(Schema.String)).annotate({
            description: "Plugins (package names or file names) left out here, though a farther scope adds them",
          }),
        }),
      ),
    }),
  ).annotate({
    description:
      "Capabilities a project (or a namespace) turns off; MCP servers, agents, tools and skills use OpenCode's own switches (enabled: false, disable: true, permission deny)",
  }),
  operatorRecordCalls: Schema.optional(Schema.Boolean).annotate({
    description:
      "Record every model call (the exact request and the response) for the session's Transcript view (default: true). Kept as long as the session.",
  }),
}

// Agent keys this fork adds. ConfigAgentV1 spreads these fields into its schema and their names into
// KNOWN_KEYS once; without that, unknown agent keys are folded into `options` and sent to the model
// provider. The fork reads them from config itself, so upstream's agent merge stays unchanged.
export const agentFields = {
  home: Schema.optional(Schema.String).annotate({
    description: "Folder this agent works in: new sessions started as this agent open there",
  }),
  subagentMemory: Schema.optional(Schema.Literals(["incognito", "retentive"])).annotate({
    description:
      "A subagent's Flavor: incognito (default) reads namespace and project memory, has no agent memory and stores nothing; retentive keeps its own agent memory like a usual agent",
  }),
  modelSource: Schema.optional(Schema.Literals(["small", "fixed"])).annotate({
    description:
      "small: the agent runs on its project's small model; `model` holds that model and the console rewrites it when the small model changes (existing sessions keep theirs). fixed or unset: `model` as written.",
  }),
}
export const agentKeys = Object.keys(agentFields)
