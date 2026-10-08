export * as OperatorToolPrompt from "./tool-prompt"

import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Shell } from "@opencode-ai/core/shell"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { OperatorModels } from "./models"
import { OperatorPermissionEffective } from "./permission-effective"
import { OperatorPermissionLive } from "./permission-live"
import { OperatorPermissionReach } from "./permission-reach"
import { OperatorPermissionRules } from "./permission-rules"
import { OperatorProfile } from "./profile"
import { OperatorProfileStore } from "./profile-store"
import { OperatorProjects } from "./projects"
import { OperatorSessionPermissions } from "./session-permissions"
import { OperatorTools } from "./tools"

// The tool prompt: the tools list a request of an agent sends, with each tool's description and
// schema as sent, the version of its description and why, its size, and the tools not sent with the
// reason. It is built with the functions a request uses (ToolRegistry.tools, which runs the
// `tool.definition` hook; ToolJsonSchema.fromTool; ProviderTransform.schema; Permission.disabled),
// and mirrors the steps upstream does not export (session/tools.ts: the MCP resource tools and MCP
// tools; session/llm/request.ts: resolveTools, `strict`, `_noop`, the sort; session/llm.ts: `invalid`
// is never offered). test/operator/tool-prompt.test.ts checks it against what a request sends.

export const RunsAs = Schema.Literals(["primary", "subagent", "session"]).annotate({
  identifier: "OperatorToolRunsAs",
  description:
    "primary: run directly; subagent: started by `task` (with the rules a subagent session gets); session: in one of the agent's sessions (with that session's own rules)",
})
export type RunsAs = typeof RunsAs.Type

export const Source = Schema.Struct({
  kind: Schema.Literals(["builtin", "file", "plugin", "mcp", "mcp-resources", "noop"]),
  path: Schema.optional(Schema.String).annotate({ description: "A project tool file" }),
  server: Schema.optional(Schema.String).annotate({ description: "The MCP server" }),
}).annotate({ identifier: "OperatorToolSource" })

export const Version = Schema.Struct({
  kind: Schema.Literals(["opencode", "namespace", "copy", "none"]).annotate({
    description:
      "opencode: OpenCode's text; namespace: the namespace's own version; copy: an edited copy in the agent's profile; none: not a versioned text (MCP and other tools)",
  }),
  layer: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  profile: Schema.optional(Schema.String),
  override: Schema.optional(Schema.Boolean).annotate({ description: "copy: from the agent's override of the slot" }),
  file: Schema.optional(Schema.String).annotate({ description: "opencode: the file in OpenCode's code" }),
  template: Schema.optional(
    Schema.Struct({ file: Schema.String, values: Schema.Record(Schema.String, Schema.String) }).annotate({
      identifier: "OperatorToolTemplate",
    }),
  ).annotate({ description: "A description filled in from a template, with the values used" }),
  fixedTemplate: Schema.optional(Schema.Boolean).annotate({
    description: "A copy of a templated description: it keeps the values it was made with",
  }),
}).annotate({ identifier: "OperatorToolVersion" })
type VersionInfo = typeof Version.Type

export const Subagent = Schema.Struct({
  name: Schema.String,
  kept: Schema.Boolean,
  rule: Schema.optional(Schema.Finite).annotate({ description: "The index of the `task` rule that decides" }),
}).annotate({ identifier: "OperatorToolSubagent" })

export const Appended = Schema.Struct({
  kind: Schema.Literals(["subagents", "mcp-catalog"]),
  text: Schema.String,
  subagents: Schema.optional(Schema.Array(Subagent)),
}).annotate({ identifier: "OperatorToolAppended" })

export const Sizes = Schema.Struct({
  description: Schema.Finite,
  schema: Schema.Finite,
  total: Schema.Finite,
  tokens: Schema.Finite.annotate({ description: "Estimated: characters ÷ 4" }),
}).annotate({ identifier: "OperatorToolSizes" })

export const Sent = Schema.Struct({
  name: Schema.String,
  permission: Schema.String.annotate({ description: "The permission the tool is checked by" }),
  source: Source,
  version: Version,
  versionText: Schema.String.annotate({ description: "The description's own text, before OpenCode's additions" }),
  appended: Schema.optional(Appended),
  description: Schema.String.annotate({ description: "The description as sent" }),
  schema: Schema.Unknown.annotate({ description: "The input schema as sent (after the provider's rewrite)" }),
  rewrite: Schema.optional(Schema.String).annotate({ description: "The provider rewrite that changed the schema" }),
  strict: Schema.optional(Schema.Boolean),
  sizes: Sizes,
  rules: Schema.Array(Schema.Finite).annotate({ description: "Indexes of the rules for this tool's permission" }),
}).annotate({ identifier: "OperatorToolSent" })
export type Sent = typeof Sent.Type

export const NotSent = Schema.Struct({
  name: Schema.String,
  permission: Schema.optional(Schema.String),
  reason: Schema.Literals(["permission", "session", "subagent", "model", "flag", "internal"]),
  rule: Schema.optional(Schema.Finite).annotate({ description: "The index of the rule that removes it" }),
  code: Schema.optional(Schema.String).annotate({
    description: "Which model or flag reason it is (model.apply_patch, model.gpt, flag.<tool>, internal.invalid)",
  }),
  detail: Schema.optional(Schema.String),
  source: Schema.optional(Source),
}).annotate({ identifier: "OperatorToolNotSent" })
export type NotSent = typeof NotSent.Type

export const Entry = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  input_schema: Schema.Unknown,
  strict: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "OperatorToolEntry" })

export const ToolPrompt = Schema.Struct({
  agent: Schema.String,
  model: Schema.String.annotate({ description: "provider/model the list is built for" }),
  modelSource: Schema.optional(OperatorModels.Source),
  runsAs: RunsAs,
  sessionID: Schema.optional(Schema.String),
  parentSessionID: Schema.optional(Schema.String).annotate({
    description: "Runs as Subagent: the session that starts it",
  }),
  rows: Schema.Array(OperatorPermissionRules.Row).annotate({
    description:
      "The effective list R, in evaluation order: the agent's rules as loaded, its rules saved since, the session's (or those `task` gives a subagent), then the locked rules",
  }),
  sent: Schema.Array(Sent),
  notSent: Schema.Array(NotSent),
  sizes: Schema.Struct({
    description: Schema.Finite,
    schema: Schema.Finite,
    total: Schema.Finite,
    tokens: Schema.Finite,
  }),
  list: Schema.Array(Entry).annotate({
    description: "The list as OpenCode hands it to the AI SDK, sorted as sent: { name, description, input_schema }",
  }),
}).annotate({ identifier: "OperatorToolPrompt" })
export type ToolPrompt = typeof ToolPrompt.Type

export const Diff = Schema.Struct({
  added: Schema.Array(Schema.Struct({ name: Schema.String, rule: Schema.optional(Schema.Finite) })),
  removed: Schema.Array(Schema.Struct({ name: Schema.String, rule: Schema.optional(Schema.Finite) })),
  changed: Schema.Array(Schema.Struct({ name: Schema.String, before: Schema.String, after: Schema.String })),
  before: Schema.Finite.annotate({ description: "Total characters, saved" }),
  after: Schema.Finite.annotate({ description: "Total characters, with the draft" }),
}).annotate({ identifier: "OperatorToolPromptDiff" })

export const Drafted = Schema.Struct({ ...ToolPrompt.fields, diff: Diff }).annotate({
  identifier: "OperatorToolPromptDraft",
})

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("OperatorToolPromptNotFound", {
  message: Schema.String,
}) {}

type Rule = PermissionV1.Rule
export type Input = {
  agent: string
  /** provider/model; the agent's model by default */
  model?: string
  runsAs?: RunsAs
  sessionID?: string
  /** Runs as Subagent: the session that starts it (its rules pass to the subagent, as `task` passes them). */
  parentSessionID?: string
  /** Replaces the agent's own rules (as saving them would). */
  agentRules?: ReadonlyArray<Rule>
  /** Replaces the session's own rules. */
  sessionRules?: ReadonlyArray<Rule>
}

export interface Interface {
  readonly build: (input: Input) => Effect.Effect<ToolPrompt, NotFoundError>
  /** The tool prompt with draft rules, and what changes against the saved rules. */
  readonly draft: (input: Input) => Effect.Effect<typeof Drafted.Type, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorToolPrompt") {}

// OpenCode's text of each built-in tool (packages/opencode/src/tool/…).
const TOOL_FILES: Record<string, string> = {
  read: "read.txt",
  edit: "edit.txt",
  write: "write.txt",
  apply_patch: "apply_patch.txt",
  glob: "glob.txt",
  grep: "grep.txt",
  lsp: "lsp.txt",
  plan_exit: "plan-exit.txt",
  question: "question.txt",
  skill: "skill.txt",
  task: "task.txt",
  todowrite: "todowrite.txt",
  webfetch: "webfetch.txt",
  websearch: "websearch.txt",
  bash: "shell/shell.txt",
  execute: "code-mode.ts",
  invalid: "invalid.ts",
}
const toolFile = (id: string) => (TOOL_FILES[id] ? `packages/opencode/src/tool/${TOOL_FILES[id]}` : undefined)

// The MCP resource tools (session/tools.ts), offered when a connected server has resources.
const MCP_RESOURCE_TOOLS = [
  {
    name: "list_mcp_resources",
    description:
      "Lists resources provided by connected MCP servers. Resources provide context such as files, database schemas, or application-specific information.",
    schema: {
      type: "object",
      properties: {
        server: {
          type: "string",
          description: "Optional MCP server name. When omitted, lists resources from every connected server.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_mcp_resource_templates",
    description:
      "Lists resource templates provided by connected MCP servers. Resource templates are parameterized resources that can be read after filling in their URI template.",
    schema: {
      type: "object",
      properties: {
        server: {
          type: "string",
          description: "Optional MCP server name. When omitted, lists resource templates from every connected server.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_mcp_resource",
    description:
      "Read a specific resource from an MCP server using the server name and resource URI. The URI is an MCP identifier and does not need to be a file URL.",
    schema: {
      type: "object",
      properties: {
        server: { type: "string", description: "MCP server name exactly as returned by list_mcp_resources." },
        uri: {
          type: "string",
          description: "Resource URI to read. Use the exact URI string returned by list_mcp_resources.",
        },
      },
      required: ["server", "uri"],
      additionalProperties: false,
    },
  },
] as const

// session/llm/request.ts: the Copilot placeholder when no tools are left but earlier tool calls exist.
const NOOP = {
  description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
  schema: { type: "object", properties: { reason: { type: "string", description: "Unused" } } },
}

const STRICT_NPM = ["@ai-sdk/openai", "@ai-sdk/azure", "@ai-sdk/amazon-bedrock/mantle"]

// Which provider family rewrites schemas (provider/transform.ts `schema`).
function rewriteOf(model: Provider.Model) {
  if (model.api.npm === "@ai-sdk/openai" || model.api.npm === "@ai-sdk/azure") return "openai"
  const id = `${model.providerID}/${model.api.id}`.toLowerCase()
  if (id.includes("moonshot") || id.includes("kimi")) return "kimi"
  if (model.api.npm === "@ai-sdk/google" || model.api.npm === "@ai-sdk/google-vertex" || id.includes("gemini"))
    return "gemini"
  return "provider"
}

const chars = (value: unknown) => (typeof value === "string" ? value.length : JSON.stringify(value ?? {}).length)
const sizes = (description: string, schema: unknown) => {
  const total = description.length + chars(schema)
  return { description: description.length, schema: chars(schema), total, tokens: Math.ceil(total / 4) }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const registry = yield* ToolRegistry.Service
    const mcp = yield* MCP.Service
    const flags = yield* RuntimeFlags.Service
    const sessions = yield* Session.Service
    const config = yield* Config.Service
    const rules = yield* OperatorPermissionRules.Service
    const tools = yield* OperatorTools.Service
    const models = yield* OperatorModels.Service
    const live = yield* OperatorPermissionLive.Service

    const missing = (message: string) => new NotFoundError({ message })

    const build = Effect.fn("OperatorToolPrompt.build")(function* (input: Input) {
      const agent = yield* agents.get(input.agent)
      if (!agent) return yield* missing(`No agent named "${input.agent}"`)
      const cfg = yield* config.get()
      const primaryTools = cfg.experimental?.primary_tools ?? []

      // The model: the one asked for, else the agent's (its own, else the default model).
      const listed = yield* tools.list()
      const modelSource = input.model ? undefined : yield* models.resolve(agent, undefined)
      const modelName = input.model ?? modelSource?.model
      if (!modelName) return yield* missing("No model is available")
      const ref = Provider.parseModel(modelName)
      const model = yield* provider
        .getModel(ProviderV2.ID.make(ref.providerID), ModelV2.ID.make(ref.modelID))
        .pipe(Effect.mapError(() => missing(`No model ${modelName}`)))

      // The rules: the agent's (with draft rules in place of its own), then the session's.
      const runsAs: RunsAs = input.sessionID
        ? "session"
        : (input.runsAs ?? (agent.mode === "subagent" ? "subagent" : "primary"))
      const labelled = yield* rules.agent(agent.name, input.agentRules)
      const session =
        runsAs === "session" && input.sessionID
          ? yield* sessions
              .get(SessionID.make(input.sessionID))
              .pipe(Effect.mapError(() => missing(`No session ${input.sessionID}`)))
          : undefined
      // A subagent started from a session gets that session's deny and external_directory rules.
      const parent =
        runsAs === "subagent" && input.parentSessionID
          ? yield* sessions
              .get(SessionID.make(input.parentSessionID))
              .pipe(Effect.mapError(() => missing(`No session ${input.parentSessionID}`)))
          : undefined
      const sessionRules: Rule[] =
        runsAs === "session"
          ? [...(input.sessionRules ?? session?.permission ?? [])]
          : runsAs === "subagent"
            ? OperatorPermissionRules.subagentRules({ agent, primaryTools, parent: parent?.permission ?? [] })
            : []
      // R (permission-effective.ts): the agent's loaded rules, its rules saved since load (unless a draft
      // stands in for them), the session's, then the locked rules, applied last.
      const ctx = yield* InstanceState.context
      const pending = input.agentRules ? [] : live.pending(ctx.directory, agent.name)
      const locked = OperatorPermissionLive.locks.of
        ? yield* OperatorPermissionLive.locks.of({
            directory: session?.directory ?? ctx.directory,
            agent: agent.name,
            ...((session?.parentID ?? parent?.id) ? { parentID: session?.parentID ?? parent!.id } : {}),
          })
        : []
      const base = [
        ...labelled.rows,
        ...pending.map((rule, index) => ({
          ...rule,
          index: labelled.rows.length + index + 1,
          part: "agent" as const,
          from: { kind: "agent-written" as const },
        })),
      ]
      const sessionPart = [
        ...(runsAs === "subagent"
          ? sessionRules.map((rule, index) => ({
              ...rule,
              index: base.length + index + 1,
              part: "session" as const,
              from: { kind: "session-task" as const },
            }))
          : OperatorPermissionRules.sessionRows({
              rules: sessionRules,
              start: base.length,
              parent: !!session?.parentID,
              primaryTools,
              recorded: session ? yield* Effect.promise(() => OperatorSessionPermissions.recorded(session.id)) : [],
            })),
      ]
      const rows = [
        ...base,
        ...sessionPart,
        ...locked.map((rule, index) => ({
          permission: rule.permission,
          pattern: rule.pattern,
          action: rule.action,
          index: base.length + sessionPart.length + index + 1,
          part: "agent" as const,
          from: { kind: "lock" as const },
        })),
      ]
      const agentList: Rule[] = labelled.rows.map(({ permission, pattern, action }) => ({
        permission,
        pattern,
        action,
      }))
      const ruleset: Rule[] = rows.map(({ permission, pattern, action }) => ({ permission, pattern, action }))
      const drafted: Agent.Info = { ...agent, permission: agentList }

      // Candidates, as the registry gives them for this model (with the `tool.definition` hook).
      const all = (yield* registry.all()).filter((tool) => tool.id !== "invalid")
      const given = yield* registry.tools({
        providerID: ProviderV2.ID.make(model.providerID),
        modelID: ModelV2.ID.make(model.api.id),
        agent: drafted,
        permission: sessionRules,
      })
      const rewrite = rewriteOf(model)
      const transform = (schema: Record<string, unknown>) => {
        const sent = ProviderTransform.schema(model, schema as never) as Record<string, unknown>
        return { sent, rewritten: JSON.stringify(sent) !== JSON.stringify(schema) }
      }

      // Versions: the profile's copy, the namespace's version, else OpenCode's text.
      const key = yield* Effect.promise(() => OperatorProjects.keyOf(ctx))
      const loaded = yield* Effect.promise(() => OperatorProfileStore.forProject(key))
      const shellName = Shell.name(Shell.acceptable(cfg.shell))
      const versionOf = (id: string, own: string): { version: VersionInfo; text: string } => {
        const found = OperatorProfile.textVersion({
          catalog: loaded.catalog,
          agent: agent.name,
          setting: loaded.agents[agent.name],
          project: loaded.project,
          builtin: `${OperatorProfile.PREFIX}tool.${id}`,
        })
        const templated: { file: string; values: Record<string, string> } | undefined =
          id === "bash"
            ? {
                file: "packages/opencode/src/tool/shell/shell.txt",
                values: { os: process.platform, shell: shellName, tmp: Global.Path.tmp },
              }
            : id === "websearch"
              ? { file: "packages/opencode/src/tool/websearch.txt", values: { year: String(new Date().getFullYear()) } }
              : undefined
        if (found.kind === "copy")
          return {
            version: {
              kind: "copy" as const,
              layer: found.layer.id,
              name: found.layer.name,
              profile: found.profile.name,
              override: found.override,
              ...(templated ? { fixedTemplate: true } : {}),
            },
            text: found.layer.text,
          }
        if (found.kind === "namespace")
          return {
            version: {
              kind: "namespace" as const,
              layer: found.layer.id,
              name: found.layer.name,
              ...(templated ? { fixedTemplate: true } : {}),
            },
            text: found.layer.text,
          }
        const file = toolFile(id)
        return {
          version: {
            kind: "opencode" as const,
            ...(file ? { file } : {}),
            ...(templated ? { template: templated } : {}),
          },
          text: own,
        }
      }

      // `task`'s subagent list: the non-primary agents, minus those R's `task` rules deny (registry.ts).
      const subagents = (yield* agents.list())
        .filter((item) => item.mode !== "primary")
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .map((item) => {
          const decisive = rows.findLast(
            (row) => Wildcard.match("task", row.permission) && Wildcard.match(item.name, row.pattern),
          )
          return {
            name: item.name,
            kept: Permission.evaluate("task", item.name, ruleset).action !== "deny",
            ...(decisive ? { rule: decisive.index } : {}),
          }
        })

      const sourceOf = (id: string) => {
        const found = listed.find((item) => item.id === id)
        if (!found) return { kind: "builtin" as const }
        if (found.origin === "custom") return { kind: "file" as const, ...(found.source ? { path: found.source } : {}) }
        if (found.origin === "plugin") return { kind: "plugin" as const }
        if (found.origin === "mcp") return { kind: "mcp" as const, ...(found.source ? { server: found.source } : {}) }
        return { kind: "builtin" as const }
      }
      const rulesOf = (name: string) => {
        const permission = OperatorPermissionRules.permissionOf(name)
        return rows.filter((row) => Wildcard.match(permission, row.permission)).map((row) => row.index)
      }

      type Candidate = Omit<Sent, "sizes" | "rules" | "strict" | "permission">
      const candidates: Candidate[] = []
      for (const tool of given) {
        if (tool.id === "invalid") continue
        const original = all.find((item) => item.id === tool.id)?.description ?? tool.description
        const found = versionOf(tool.id, original)
        const own = found.text
        const extra = tool.description.startsWith(own) ? tool.description.slice(own.length).replace(/^\n/, "") : ""
        const schema = transform(ToolJsonSchema.fromTool(tool) as Record<string, unknown>)
        candidates.push({
          name: tool.id,
          source: sourceOf(tool.id),
          version: found.version,
          versionText: own,
          ...(extra
            ? {
                appended:
                  tool.id === "task"
                    ? { kind: "subagents" as const, text: extra, subagents }
                    : { kind: "mcp-catalog" as const, text: extra },
              }
            : {}),
          description: tool.description,
          schema: schema.sent,
          ...(schema.rewritten ? { rewrite } : {}),
        })
      }
      const clients = yield* mcp.clients()
      if (Object.values(clients).some((client) => !!client.getServerCapabilities()?.resources))
        for (const tool of MCP_RESOURCE_TOOLS) {
          const schema = transform(tool.schema as unknown as Record<string, unknown>)
          candidates.push({
            name: tool.name,
            source: { kind: "mcp-resources" },
            version: { kind: "none" },
            versionText: tool.description,
            description: tool.description,
            schema: schema.sent,
            ...(schema.rewritten ? { rewrite } : {}),
          })
        }
      if (!flags.experimentalCodeMode)
        for (const [name, entry] of Object.entries(yield* mcp.tools())) {
          const input = (entry.def.inputSchema ?? {}) as Record<string, unknown>
          const base = {
            ...input,
            type: "object",
            properties: (input.properties ?? {}) as Record<string, unknown>,
            additionalProperties: false,
          }
          const schema = transform(base)
          const description = entry.def.description ?? ""
          candidates.push({
            name,
            source: { kind: "mcp", server: listed.find((item) => item.id === name)?.source },
            version: { kind: "none" },
            versionText: description,
            description,
            schema: schema.sent,
            ...(schema.rewritten ? { rewrite } : {}),
          })
        }

      // The permission filter (resolveTools on R): a tool is offered only if some call to it could be
      // allowed or asked (permission-reach.ts). The rule named is the last one that still decides an
      // input: a deny that comes after every allow.
      const disabled = OperatorPermissionEffective.unreachable(
        candidates.map((item) => item.name),
        ruleset,
      )
      const notSent: NotSent[] = []
      for (const item of candidates) {
        if (!disabled.has(item.name)) continue
        const permission = OperatorPermissionRules.permissionOf(item.name)
        const deciding = OperatorPermissionReach.reach(permission, ruleset).live.find(
          (found) => found.index !== undefined,
        )
        const decisive =
          deciding?.index !== undefined
            ? rows[deciding.index]
            : rows.findLast((row) => Wildcard.match(permission, row.permission))
        notSent.push({
          name: item.name,
          permission,
          reason: decisive?.part === "session" ? (runsAs === "subagent" ? "subagent" : "session") : "permission",
          ...(decisive ? { rule: decisive.index } : {}),
          source: item.source,
        })
      }
      // The model and flags.
      const offered = new Set(given.map((tool) => tool.id))
      for (const tool of all) {
        if (offered.has(tool.id)) continue
        const usePatch =
          model.api.id.includes("gpt-") && !model.api.id.includes("oss") && !model.api.id.includes("gpt-4")
        if (tool.id === "apply_patch")
          notSent.push({
            name: tool.id,
            reason: "model",
            code: "model.apply_patch",
            detail: "Used instead of edit and write only for GPT models",
          })
        else if ((tool.id === "edit" || tool.id === "write") && usePatch)
          notSent.push({
            name: tool.id,
            reason: "model",
            code: "model.gpt",
            detail: "GPT models get apply_patch instead",
          })
        else if (tool.id === "websearch")
          notSent.push({
            name: tool.id,
            reason: "flag",
            code: "flag.websearch",
            detail: "Only for the opencode providers, or with Exa or Parallel search turned on",
          })
        else if (tool.id === "execute")
          notSent.push({
            name: tool.id,
            reason: "flag",
            code: "flag.execute-mcp",
            detail: "No connected MCP tool can be used by it",
          })
        else notSent.push({ name: tool.id, reason: "flag", code: "flag.other" })
      }
      const ids = new Set(all.map((tool) => tool.id))
      const gated: Array<[string, boolean, string]> = [
        [
          "question",
          ids.has("question"),
          "Only for the app, CLI and desktop clients, or with OPENCODE_ENABLE_QUESTION_TOOL",
        ],
        ["execute", ids.has("execute"), "Code mode is off (OPENCODE_EXPERIMENTAL_CODE_MODE)"],
        ["lsp", ids.has("lsp"), "The LSP tool is off (OPENCODE_EXPERIMENTAL_LSP_TOOL)"],
        [
          "plan_exit",
          ids.has("plan_exit"),
          "Only in experimental plan mode, in the CLI (OPENCODE_EXPERIMENTAL_PLAN_MODE)",
        ],
      ]
      for (const [name, present, detail] of gated)
        if (!present) notSent.push({ name, reason: "flag", code: `flag.${name}`, detail })
      notSent.push({
        name: "invalid",
        reason: "internal",
        code: "internal.invalid",
        detail: "Never offered; it repairs malformed tool calls",
      })

      // What is sent: `strict: false` for OpenAI-family providers, Copilot's `_noop`, sorted by name.
      const strict = STRICT_NPM.includes(model.api.npm)
      const kept = candidates.filter((item) => !disabled.has(item.name))
      const sent: Sent[] = kept.map((item) => ({
        ...item,
        permission: OperatorPermissionRules.permissionOf(item.name),
        ...(strict ? { strict: false } : {}),
        sizes: sizes(item.description, item.schema),
        rules: rulesOf(item.name),
      }))
      if (model.providerID.includes("github-copilot") && sent.length === 0 && session) {
        const messages = yield* sessions
          .messages({ sessionID: session.id })
          .pipe(Effect.orElseSucceed(() => [] as Array<{ parts: Array<{ type: string }> }>))
        if (messages.some((message) => message.parts.some((part) => part.type === "tool")))
          sent.push({
            name: "_noop",
            permission: "_noop",
            source: { kind: "noop" },
            version: { kind: "none" },
            versionText: NOOP.description,
            description: NOOP.description,
            schema: NOOP.schema,
            sizes: sizes(NOOP.description, NOOP.schema),
            rules: [],
          })
      }
      sent.sort((a, b) => a.name.localeCompare(b.name))
      const totals = sent.reduce(
        (sum, item) => ({
          description: sum.description + item.sizes.description,
          schema: sum.schema + item.sizes.schema,
          total: sum.total + item.sizes.total,
          tokens: 0,
        }),
        { description: 0, schema: 0, total: 0, tokens: 0 },
      )
      return {
        agent: agent.name,
        model: `${model.providerID}/${model.id}`,
        ...(modelSource ? { modelSource } : {}),
        runsAs,
        ...(session ? { sessionID: session.id } : {}),
        ...(parent ? { parentSessionID: parent.id } : {}),
        rows,
        sent,
        notSent,
        sizes: { ...totals, tokens: Math.ceil(totals.total / 4) },
        list: sent.map((item) => ({
          name: item.name,
          description: item.description,
          input_schema: item.schema,
          ...(item.strict === false ? { strict: false } : {}),
        })),
      }
    })

    const draft = Effect.fn("OperatorToolPrompt.draft")(function* (input: Input) {
      const saved = yield* build({ ...input, agentRules: undefined, sessionRules: undefined })
      const next = yield* build(input)
      const before = new Map(saved.sent.map((item) => [item.name, item]))
      const after = new Map(next.sent.map((item) => [item.name, item]))
      const decisive = (prompt: ToolPrompt, name: string) => {
        const permission = OperatorPermissionRules.permissionOf(name)
        return prompt.rows.findLast((row) => Wildcard.match(permission, row.permission))?.index
      }
      const ruleOf = (prompt: ToolPrompt, name: string) => {
        const index = decisive(prompt, name)
        return index === undefined ? {} : { rule: index }
      }
      return {
        ...next,
        diff: {
          added: next.sent
            .filter((item) => !before.has(item.name))
            .map((item) => ({ name: item.name, ...ruleOf(next, item.name) })),
          removed: saved.sent
            .filter((item) => !after.has(item.name))
            .map((item) => ({ name: item.name, ...ruleOf(next, item.name) })),
          changed: next.sent
            .filter((item) => before.has(item.name) && before.get(item.name)!.description !== item.description)
            .map((item) => ({ name: item.name, before: before.get(item.name)!.description, after: item.description })),
          before: saved.sizes.total,
          after: next.sizes.total,
        },
      }
    })

    return Service.of({ build, draft })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Agent.node,
    Provider.node,
    ToolRegistry.node,
    MCP.node,
    RuntimeFlags.node,
    Session.node,
    Config.node,
    OperatorPermissionRules.node,
    OperatorTools.node,
    OperatorModels.node,
    OperatorPermissionLive.node,
  ],
})
