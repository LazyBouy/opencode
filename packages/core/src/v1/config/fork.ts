export * as ConfigForkV1 from "./fork"

import { Schema } from "effect"
import { ConfigMergeV1 } from "./merge"

// One hook (SPEC-0022 §6.1): a script the server runs at a point in a session. The event and the
// strings are checked when the hooks are resolved, not here, so a mistyped entry is skipped with a
// warning instead of stopping the config from loading.
export const HookEntry = Schema.Struct({
  event: Schema.optional(Schema.String).annotate({
    description:
      "When it runs: session.created, prompt.submitted, turn.before, step.before, step.after, tool.before, tool.after, subagent.before, subagent.after, permission.asked, compaction.before, compaction.after, turn.after, session.error, file.edited or session.deleted",
  }),
  command: Schema.optional(Schema.String).annotate({
    description:
      "The script, by its path: relative to the folder of the config file that declares the hook, or `~` and absolute paths. Never parsed by a shell",
  }),
  args: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Extra arguments for the script",
  }),
  match: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description:
      "Tool names (tool.*), permission names (permission.asked) or agent names (subagent.*) it runs for; `*` wildcards allowed (default: all)",
  }),
  timeout: Schema.optional(Schema.Finite).annotate({
    description: "Seconds before the run is stopped, 0.1 to 600 (default: Settings → Hooks, 5 s)",
  }),
  onFailure: Schema.optional(Schema.String).annotate({
    description: "deny (default) or allow: what a failed run means for an event that waits for the answer",
  }),
  locked: Schema.optional(Schema.Boolean).annotate({
    description: "Levels below can't turn this hook off or replace it (default: false)",
  }),
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "false keeps the entry but doesn't run it (default: true)",
  }),
  description: Schema.optional(Schema.String).annotate({ description: "Shown in the console" }),
}).annotate({
  description: "One hook, by its name: the event it runs at, its script and settings",
})

const hooks = Schema.optional(Schema.Record(Schema.String, HookEntry)).annotate({
  description:
    "Hooks: scripts the server runs at points in a session, keyed by name. Every level's run, the highest first; a lower level replaces one by its name unless it is locked",
})

// Top-level config keys this fork adds. ConfigV1.Info spreads these fields once, so new fork
// settings are added here without editing upstream's schema.
export const fields = {
  hooks,
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
          hooks: Schema.optional(Schema.Array(Schema.String)).annotate({
            description: "Hooks turned off here, though a farther scope declares them (not a locked one)",
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
  operatorTelemetry: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean).annotate({
        description:
          "Record telemetry for the Observability page (default: true). Off stops recording; what is kept stays until retention removes it.",
      }),
      eventsDays: Schema.optional(Schema.Finite).annotate({
        description: "Days detailed events (spans, log lines, samples, alert events) are kept: 1 to 365 (default: 30)",
      }),
      totalsDays: Schema.optional(Schema.Finite).annotate({
        description:
          "Days hourly totals are kept: 30 to 1825, never less than eventsDays (default: 400, so a year can be compared with the one before)",
      }),
      logLevel: Schema.optional(Schema.Literals(["error", "warn", "info"])).annotate({
        description: "Server log lines kept for the Logs tab: this level and above (default: warn)",
      }),
      loops: Schema.optional(
        Schema.Struct({
          sameCallSameResult: Schema.optional(Schema.Finite).annotate({
            description:
              "A turn is a possible loop after this many identical tool calls in a row with the same result (default: 3)",
          }),
          sameCall: Schema.optional(Schema.Finite).annotate({
            description: "A turn is a possible loop after this many identical tool calls in a row (default: 5)",
          }),
          toolCalls: Schema.optional(Schema.Finite).annotate({
            description: "A turn is a possible loop with more tool calls than this (default: 50)",
          }),
          modelCalls: Schema.optional(Schema.Finite).annotate({
            description: "A turn is a possible loop with more model calls than this (default: 30)",
          }),
        }),
      ).annotate({ description: "When a turn is flagged as a possible loop" }),
      dailyBudget: Schema.optional(Schema.NullOr(Schema.Finite)).annotate({
        description: "A daily cost budget in dollars, for the Daily cost alert and the Dashboard (default: none)",
      }),
      dashboard: Schema.optional(
        Schema.Struct({
          stuckMinutes: Schema.optional(Schema.Finite).annotate({
            description:
              "A running session with no new activity for this many minutes, and no approval waiting, counts as stuck (default: 10)",
          }),
          queueMinutes: Schema.optional(Schema.Finite).annotate({
            description: "A queue whose oldest message waited this many minutes counts as backed up (default: 10)",
          }),
        }),
      ).annotate({ description: "The Dashboard's thresholds" }),
    }),
  ).annotate({
    description:
      "Observability: what is recorded about sessions, model calls, tools, approvals and the server log, and for how long",
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
  hooks,
  hooksDisabled: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Inherited hooks this agent turns off (not a locked one)",
  }),
  modelSource: Schema.optional(Schema.Literals(["small", "fixed"])).annotate({
    description:
      "small: the agent runs on its project's small model; `model` holds that model and the console rewrites it when the small model changes (existing sessions keep theirs). fixed or unset: `model` as written.",
  }),
}
export const agentKeys = Object.keys(agentFields)
