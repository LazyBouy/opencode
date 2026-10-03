export * as OperatorAgents from "./agents"

import path from "path"
import { count, eq, max } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Glob } from "@opencode-ai/core/util/glob"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { configEntryNameFromPath } from "@/config/entry-name"
import { InstanceState } from "@/effect/instance-state"

export const Source = Schema.Struct({
  kind: Schema.Literals(["builtin", "config", "file"]),
  path: Schema.optional(Schema.String).annotate({ description: "The markdown file that defines the agent" }),
  customized: Schema.Boolean.annotate({ description: "A built-in agent that config or a file changes" }),
}).annotate({ identifier: "OperatorAgentSource" })

export const Info = Schema.Struct({
  ...Agent.Info.fields,
  source: Source,
  sessions: Schema.Struct({ total: Schema.Number, lastUsed: Schema.optional(Schema.Number) }).annotate({
    description: "Sessions in this project that use the agent",
  }),
}).annotate({ identifier: "OperatorAgent" })
export type Info = typeof Info.Type

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorAgents") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const db = (yield* Database.Service).db

    // Same discovery as ConfigAgent.load/loadMode; later directories win, as they do when config merges.
    const files = Effect.fnUntraced(function* () {
      const found = yield* Effect.forEach(yield* config.directories(), (dir) =>
        Effect.promise(async () => {
          const agentFiles = await Glob.scan("{agent,agents}/**/*.md", { cwd: dir, absolute: true, dot: true, symlink: true })
          const modeFiles = await Glob.scan("{mode,modes}/*.md", { cwd: dir, absolute: true, dot: true, symlink: true })
          return [
            ...agentFiles.map((file) => [configEntryNameFromPath(path.relative(dir, file), ["agent/", "agents/"]), file] as const),
            ...modeFiles.map((file) => [configEntryNameFromPath(path.relative(dir, file), ["mode/", "modes/"]), file] as const),
          ]
        }),
      )
      return new Map(found.flat())
    })

    const list = Effect.fn("OperatorAgents.list")(function* () {
      const ctx = yield* InstanceState.context
      const paths = yield* files()
      const configured = new Set(Object.keys({ ...(yield* config.get()).agent }))
      const usage = yield* db
        .select({ agent: SessionTable.agent, total: count(), lastUsed: max(SessionTable.time_updated) })
        .from(SessionTable)
        .where(eq(SessionTable.project_id, ctx.project.id))
        .groupBy(SessionTable.agent)
        .all()
        .pipe(Effect.orDie)
      const byAgent = new Map(usage.map((row) => [row.agent, row]))
      return (yield* agents.list()).map((agent) => {
        const file = paths.get(agent.name)
        const used = byAgent.get(agent.name)
        return {
          ...agent,
          source: {
            kind: agent.native ? ("builtin" as const) : file ? ("file" as const) : ("config" as const),
            path: file,
            customized: !!agent.native && (!!file || configured.has(agent.name)),
          },
          sessions: { total: used?.total ?? 0, lastUsed: used?.lastUsed ?? undefined },
        }
      })
    })

    return Service.of({ list })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Agent.node, Config.node, Database.node] })
