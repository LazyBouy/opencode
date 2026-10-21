import { OperatorHooks } from "@/operator/hooks/hooks"
import { OperatorHookEvents } from "@/operator/hooks/events"
import { OperatorHookManage } from "@/operator/hooks/manage"
import { OperatorHookRuns } from "@/operator/hooks/runs"
import { OperatorHookTemplates } from "@/operator/hooks/templates"
import { ConfigForkV1 } from "@opencode-ai/core/v1/config/fork"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"
import { ApiProjectConfigCopyError, ConfirmCopyField } from "./project-config"

// Hooks (SPEC-0022 §11). Under /operator/hook: the console's hooks live on the Capabilities page, and a GET
// route must not share a page's path.
export const OperatorHookPaths = {
  list: "/operator/hook",
  state: "/operator/hook/state",
  remove: "/operator/hook/remove",
  test: "/operator/hook/test",
  sample: "/operator/hook/sample",
  scripts: "/operator/hook/scripts",
  script: "/operator/hook/script",
  settings: "/operator/hook/settings",
  runs: "/operator/hook/runs",
  run: "/operator/hook/runs/:id",
  events: "/operator/hook/events",
} as const

const Namespace = Schema.optional(Schema.String).annotate({
  description: "Act on this namespace's own layer (Global's id for Global) instead of the project",
})
const Agent = Schema.optional(Schema.String).annotate({
  description: "An agent's own hooks (its definition: hooks, hooksDisabled) instead of the scope's",
})
const WriteQuery = Schema.Struct({ ...WorkspaceRoutingQueryFields, ...ConfirmCopyField })

export class ApiHookInvalidError extends Schema.ErrorClass<{
  readonly name: "OperatorHookInvalidError"
  readonly data: { readonly message: string }
}>("OperatorHookInvalidError")(
  { name: Schema.Literal("OperatorHookInvalidError"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 400 },
) {}

export class ApiHookNotFoundError extends Schema.ErrorClass<{
  readonly name: "OperatorHookNotFoundError"
  readonly data: { readonly message: string }
}>("OperatorHookNotFoundError")(
  { name: Schema.Literal("OperatorHookNotFoundError"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 404 },
) {}

export const HookEvent = Schema.Struct({
  name: Schema.Literals(OperatorHookEvents.NAMES),
  kind: Schema.Literals(["blocking", "watch"]).annotate({
    description: "blocking: the session waits for the answer; watch: it goes on",
  }),
  fields: Schema.Array(Schema.Literals(OperatorHookEvents.FIELDS)).annotate({
    description: "Answer fields the event uses; others are ignored",
  }),
  subject: Schema.optional(Schema.Literals(["tool", "permission", "agent"])).annotate({
    description: "What `match` is checked against",
  }),
  group: Schema.Literals(["session", "prompt", "step", "tool", "permission", "compaction", "watch"]),
}).annotate({ identifier: "OperatorHookEvent" })

const RunsQuery = Schema.Struct({
  ...WorkspaceRoutingQuery.fields,
  session: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  hook: Schema.optional(Schema.String),
  event: Schema.optional(Schema.String),
  outcome: Schema.optional(Schema.String),
  test: Schema.optional(Schema.Literals(["true", "false"])),
  limit: Schema.optional(Schema.String),
  offset: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.Literals(["project", "all"])).annotate({
    description: "project (default): runs in this project; all: every project's",
  }),
})

export const OperatorHookApi = HttpApi.make("operator-hooks")
  .add(
    HttpApiGroup.make("operatorHooks")
      .add(
        HttpApiEndpoint.get("list", OperatorHookPaths.list, {
          query: Schema.Struct({
            ...WorkspaceRoutingQuery.fields,
            agent: Schema.optional(Schema.String).annotate({ description: "Include this agent's own hooks" }),
            namespace: Namespace,
          }),
          success: described(
            Schema.Struct({
              ...OperatorHooks.Effective.fields,
              pluginsOff: Schema.Boolean.annotate({
                description:
                  "The server runs without its built-in plugins (disableDefaultPlugins): every event but the watch events and a failed tool's tool.after never fires",
              }),
            }).annotate({ identifier: "OperatorHooksInForce" }),
            "The hooks in force",
          ),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.hook.list",
            summary: "The hooks in force for a project or agent",
            description:
              "Every level's hooks (Global, namespace, project, and the agent's own), each with its level, state (on, off below, disabled, invalid), lock and problems, in run order.",
          }),
        ),
        HttpApiEndpoint.put("save", OperatorHookPaths.list, {
          query: WriteQuery,
          payload: Schema.Struct({
            namespace: Namespace,
            agent: Agent,
            name: Schema.String.annotate({ description: "Letters, digits, dots, dashes and underscores" }),
            previous: Schema.optional(Schema.String).annotate({ description: "Its name before, when renamed" }),
            hook: ConfigForkV1.HookEntry,
          }),
          success: described(OperatorHooks.HookView, "The hook as saved, in force"),
          error: [ApiHookInvalidError, ApiProjectConfigCopyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.hook.save",
            summary: "Create or edit a hook",
            description:
              "Writes the hook into the scope's config file: a project's is copy-on-write (409 asks for the copy; confirmCopy=true makes it). The same name as an inherited hook replaces it, unless that one is locked.",
          }),
        ),
        HttpApiEndpoint.post("state", OperatorHookPaths.state, {
          query: WriteQuery,
          payload: Schema.Struct({ namespace: Namespace, agent: Agent, name: Schema.String, off: Schema.Boolean }),
          success: described(OperatorHooks.HookView, "The hook"),
          error: [ApiHookInvalidError, ApiProjectConfigCopyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.hook.state",
            summary: "Turn an inherited hook off or on here",
            description: "capabilities.disabled.hooks in the scope's config. Refused for a locked hook.",
          }),
        ),
        HttpApiEndpoint.post("remove", OperatorHookPaths.remove, {
          query: WriteQuery,
          payload: Schema.Struct({
            namespace: Namespace,
            agent: Agent,
            name: Schema.String,
            script: Schema.optional(Schema.Boolean).annotate({
              description: "Its script goes to Trash too (only one in the scope's hooks/ folder)",
            }),
          }),
          success: described(Schema.Boolean, "Moved to Trash"),
          error: [ApiHookInvalidError, ApiProjectConfigCopyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.hook.remove",
            summary: "Delete a hook of the scope",
            description:
              "Moves the scope's own hook (and its script, if asked) to Trash; inherited ones are turned off instead.",
          }),
        ),
        HttpApiEndpoint.post("test", OperatorHookPaths.test, {
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({
            namespace: Namespace,
            name: Schema.String,
            input: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
              description: "The event to send (default: a sample of the hook's event)",
            }),
          }),
          success: described(OperatorHookManage.TestResult, "The run"),
          error: ApiHookInvalidError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.hook.test",
            summary: "Test a hook",
            description:
              "Runs the hook's script on the event as a real run would, in its level's folder, and records it as a Test run. No session is touched.",
          }),
        ),
        HttpApiEndpoint.get("sample", OperatorHookPaths.sample, {
          query: Schema.Struct({
            ...WorkspaceRoutingQuery.fields,
            event: Schema.Literals(OperatorHookEvents.NAMES),
            language: Schema.optional(Schema.Literals(OperatorHookTemplates.LANGUAGES)),
          }),
          success: described(
            Schema.Struct({
              input: Schema.Record(Schema.String, Schema.Unknown).annotate({ description: "What the event sends" }),
              script: Schema.optional(Schema.String).annotate({ description: "A template script in the language" }),
            }).annotate({ identifier: "OperatorHookSample" }),
            "A sample",
          ),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.hook.sample",
            summary: "A sample event and a template script",
            description: "What an event sends (§7.6), and a script that reads it and prints a valid answer.",
          }),
        ),
        HttpApiEndpoint.get("scripts", OperatorHookPaths.scripts, {
          query: Schema.Struct({ ...WorkspaceRoutingQuery.fields, namespace: Namespace }),
          success: described(Schema.Array(Schema.String), "The scripts in the scope's hooks/ folder"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.hook.scripts",
            summary: "The scope's scripts",
            description: "The files in the hooks/ folder beside the scope's config file.",
          }),
        ),
        HttpApiEndpoint.get("script", OperatorHookPaths.script, {
          query: Schema.Struct({ ...WorkspaceRoutingQuery.fields, namespace: Namespace, path: Schema.String }),
          success: described(OperatorHookManage.Script, "The script"),
          error: ApiHookInvalidError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.hook.script",
            summary: "A hook's script",
            description: "One in the scope's hooks/ folder (editable), or the script of a hook in force (read-only).",
          }),
        ),
        HttpApiEndpoint.put("saveScript", OperatorHookPaths.script, {
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({ namespace: Namespace, path: Schema.String, text: Schema.String }),
          success: described(Schema.Boolean, "Saved"),
          error: ApiHookInvalidError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.hook.saveScript",
            summary: "Save a script",
            description: "Only a script in the scope's hooks/ folder.",
          }),
        ),
        HttpApiEndpoint.post("newScript", OperatorHookPaths.script, {
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({
            namespace: Namespace,
            name: Schema.String.annotate({ description: "The file's name; its language's extension is added" }),
            language: Schema.Literals(OperatorHookTemplates.LANGUAGES),
            event: Schema.Literals(OperatorHookEvents.NAMES),
          }),
          success: described(
            Schema.Struct({
              path: Schema.String,
              command: Schema.String.annotate({ description: "As a hook's command: relative to the config file" }),
            }).annotate({ identifier: "OperatorHookNewScript" }),
            "The script written",
          ),
          error: ApiHookInvalidError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.hook.newScript",
            summary: "Write a template script",
            description:
              "A script for the event, in the language, in the scope's hooks/ folder, executable. It reads the event and answers nothing until edited.",
          }),
        ),
        HttpApiEndpoint.get("settings", OperatorHookPaths.settings, {
          query: WorkspaceRoutingQuery,
          success: described(OperatorHooks.Settings, "Settings → Hooks"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.hook.settings",
            summary: "Settings → Hooks",
            description: "The default timeout for hooks without their own, and Pause all hooks. Server-wide.",
          }),
        ),
        HttpApiEndpoint.put("saveSettings", OperatorHookPaths.settings, {
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({
            timeout: Schema.optional(Schema.Finite).annotate({ description: "Seconds, 0.1 to 600" }),
            paused: Schema.optional(Schema.Boolean),
          }),
          success: described(OperatorHooks.Settings, "The settings after the save"),
          error: ApiHookInvalidError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.hook.saveSettings",
            summary: "Change Settings → Hooks",
            description: "Sets the default timeout or Pause all hooks; what isn't given stays.",
          }),
        ),
        HttpApiEndpoint.get("runs", OperatorHookPaths.runs, {
          query: RunsQuery,
          success: described(
            Schema.Struct({ runs: Schema.Array(OperatorHookRuns.Run), total: Schema.Finite }),
            "Runs, newest first",
          ),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.hook.runs",
            summary: "Hook runs",
            description:
              "The run log, newest first: one session's runs, or a project's (or every project's), filtered by agent, hook, event, outcome or Test runs; paged with limit and offset.",
          }),
        ),
        HttpApiEndpoint.get("run", OperatorHookPaths.run, {
          params: { id: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(OperatorHookRuns.Run, "One run"),
          error: ApiHookNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.hook.run",
            summary: "One hook run",
            description: "Everything the run log keeps of one run.",
          }),
        ),
        HttpApiEndpoint.get("events", OperatorHookPaths.events, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(HookEvent), "The events"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.hook.events",
            summary: "The events a hook can be attached to",
            description:
              "Each event, whether the session waits for the answer, the answer fields it uses, and what `match` checks.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "operator hooks", description: "Hook routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode operator hooks HttpApi",
      version: "0.0.1",
      description: "Hooks: scripts that run at points in a session.",
    }),
  )
