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
      "Turn generated system prompt sections on or off. Prompt texts are overridden with prompts/<id>.md files",
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
  promptProfile: Schema.optional(
    Schema.Struct({
      mode: Schema.Literals(["profile", "layers", "custom"]).annotate({
        description:
          "profile: the prompt profile as it is; layers: the profile plus `layers`; custom: no profile, only Purpose, the agent's prompt and the `generated` sections",
      }),
      profile: Schema.optional(Schema.String).annotate({
        description: "Prompt profile id; the project's, then the global default when unset",
      }),
      layers: Schema.optional(
        Schema.mutable(Schema.Array(Schema.Struct({ layer: Schema.String, group: Schema.String }))),
      ).annotate({
        description: "layers mode: layers added to the end of the named group of the profile",
      }),
      generated: Schema.optional(
        Schema.mutable(Schema.Array(Schema.Literals(["environment", "references", "instructions", "mcp", "skills"]))),
      ).annotate({ description: "custom mode: the generated sections to include (default: all)" }),
    }),
  ).annotate({ description: "How this agent's system prompt is built from prompt profiles" }),
}
export const agentKeys = Object.keys(agentFields)
