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
}

// Agent keys this fork adds. ConfigAgentV1 spreads these fields into its schema and their names into
// KNOWN_KEYS once; without that, unknown agent keys are folded into `options` and sent to the model
// provider. The fork reads them from config itself, so upstream's agent merge stays unchanged.
export const agentFields = {
  home: Schema.optional(Schema.String).annotate({
    description: "Folder this agent works in: new sessions started as this agent open there",
  }),
}
export const agentKeys = Object.keys(agentFields)
