export * as OperatorHelperTool from "./helper-tool"

import { tool, type ToolContext } from "@opencode-ai/plugin"
import { Context, Fiber } from "effect"
import { InstanceRef } from "@/effect/instance-ref"
import { OperatorRegistry } from "./registry"

// The fork's helper tools, registered through the prompt plugin (plugins.ts), each offered only where
// helper-runs.ts says (they are opt-in tools):
// - `helper` (agent_types_spec.md §4.5): an agent runs one of its namespace's callable helpers. It asks the `helper`
//   permission with the helper's name; its description lists the helpers (written per agent: plugins.ts);
// - the system actions a helper may declare (§4.6): list_sessions, archive_session, trash_session, notify, offered
//   only to a run whose helper declares them. They work on the helper's namespace's projects only.

// The request's project instance, taken before anything is awaited.
const instanceOf = () => {
  const fiber = Fiber.getCurrent()
  return fiber ? Context.getReferenceUnsafe(fiber.context, InstanceRef) : undefined
}

export const DESCRIPTION =
  "Runs one of this namespace's helpers: a small job done for you, unattended, that returns its output. Give it `name` and `input`."

export const helperTool = tool({
  description: DESCRIPTION,
  args: {
    name: tool.schema.string().describe("The helper's name, as listed"),
    input: tool.schema.string().describe("What to give it"),
  },
  async execute(args, ctx) {
    const instance = instanceOf()
    const call = OperatorRegistry.helpers.call
    if (!call || !instance) throw new Error("Helpers are not available in this session")
    await ctx.ask({ permission: "helper", patterns: [args.name], always: ["*"], metadata: { input: args.input } })
    const result = await call({
      instance,
      sessionID: ctx.sessionID,
      agent: ctx.agent,
      name: args.name,
      input: args.input,
      abort: ctx.abort,
    })
    return {
      title: args.name,
      output: result.output,
      metadata: { run: result.run, ...(result.sessionID ? { sessionId: result.sessionID } : {}) },
    }
  },
})

const action =
  (name: string, patterns: (args: Record<string, unknown>) => string[]) =>
  async (args: Record<string, unknown>, ctx: ToolContext) => {
    const instance = instanceOf()
    const run = OperatorRegistry.helpers.action
    if (!run || !instance) throw new Error(`${name} is not available in this session`)
    await ctx.ask({ permission: name, patterns: patterns(args), always: ["*"], metadata: args })
    return run({ instance, sessionID: ctx.sessionID, action: name, args })
  }

export const actionTools = {
  list_sessions: tool({
    description:
      "Lists sessions of this namespace's projects (not archived, not subagents'), most recently used first: id · title · agent · folder · last used.",
    args: {
      project: tool.schema.string().optional().describe("Only this project (its folder or folder name)"),
      agent: tool.schema.string().optional().describe("Only this agent's sessions"),
      before: tool.schema.string().optional().describe("Only sessions last used before this date (2026-01-31)"),
      limit: tool.schema.number().optional().describe("At most this many (1-200, default 50)"),
    },
    execute: action("list_sessions", () => ["*"]),
  }),
  archive_session: tool({
    description: "Archives a session of this namespace's projects (it leaves the session lists; it can be unarchived).",
    args: { sessionID: tool.schema.string().describe("The session's id") },
    execute: action("archive_session", (args) => [String(args.sessionID ?? "")]),
  }),
  trash_session: tool({
    description: "Moves a session of this namespace's projects, with its subagents' sessions, to Trash.",
    args: { sessionID: tool.schema.string().describe("The session's id") },
    execute: action("trash_session", (args) => [String(args.sessionID ?? "")]),
  }),
  notify: tool({
    description: "Posts a note to the Permission Inbox, for the user to read.",
    args: {
      message: tool.schema.string().describe("The note"),
      project: tool.schema.boolean().optional().describe("About this project (else the namespace)"),
    },
    execute: action("notify", () => ["*"]),
  }),
}
