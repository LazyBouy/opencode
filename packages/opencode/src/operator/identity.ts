export * as OperatorIdentity from "./identity"

import fs from "fs/promises"
import path from "path"
import matter from "gray-matter"
import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Glob } from "@opencode-ai/core/util/glob"
import { InstanceState } from "@/effect/instance-state"
import { OperatorConfig } from "./config"

// Identity layers are markdown files in `identity/` under the global config folder and the project's
// `.opencode` folder. Together they say who the agents are and how they work, and are added to every
// agent's system prompt (see plugins.ts), ordered org → user → project, then by priority.

export const Kind = Schema.Literals(["org", "user", "project"]).annotate({ identifier: "OperatorIdentityKind" })
export type Kind = typeof Kind.Type

export const Info = Schema.Struct({
  scope: OperatorConfig.Scope,
  file: Schema.String.annotate({ description: "File name inside the scope's identity folder" }),
  path: Schema.String,
  name: Schema.String,
  kind: Kind,
  priority: Schema.Finite.annotate({ description: "Lower comes first within a kind (default 50)" }),
  agents: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "Only these agents; all when unset" }),
  maxLength: Schema.optional(Schema.Finite).annotate({ description: "Characters kept; the rest is cut" }),
  enabled: Schema.Boolean,
  content: Schema.String,
}).annotate({ identifier: "OperatorIdentityLayer" })
export type Info = typeof Info.Type

// Not named in the API document, so the generated client takes these as flat parameters.
export const SaveInput = Schema.Struct({
  scope: OperatorConfig.Scope,
  file: Schema.optional(Schema.String).annotate({
    description: "Existing file to replace; a new one is named after `name`",
  }),
  name: Schema.String,
  kind: Schema.optional(Kind).annotate({
    description: "org or user for global layers; project layers are always project",
  }),
  priority: Schema.optional(Schema.Finite),
  agents: Schema.optional(Schema.Array(Schema.String)),
  maxLength: Schema.optional(Schema.Finite),
  enabled: Schema.optional(Schema.Boolean),
  content: Schema.String,
})
export type SaveInput = typeof SaveInput.Type

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("OperatorIdentityNotFound", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly save: (input: SaveInput) => Effect.Effect<Info>
  readonly remove: (scope: OperatorConfig.Scope, file: string) => Effect.Effect<void, NotFoundError>
  /** Rewrites priorities so the scope's layers run in the given file order. */
  readonly reorder: (scope: OperatorConfig.Scope, files: ReadonlyArray<string>) => Effect.Effect<Info[]>
  /** The text added to `agent`'s system prompt. */
  readonly preview: (agent?: string) => Effect.Effect<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorIdentity") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const folders = Effect.fnUntraced(function* () {
      const ctx = yield* InstanceState.context
      return {
        global: path.join(OperatorConfig.scopeDirectory("global", ctx), "identity"),
        project: path.join(OperatorConfig.scopeDirectory("project", ctx), "identity"),
      }
    })
    const list = Effect.fn("OperatorIdentity.list")(function* () {
      const dirs = yield* folders()
      return yield* Effect.promise(() => readLayers(dirs))
    })

    const save = Effect.fn("OperatorIdentity.save")(function* (input: SaveInput) {
      const dirs = yield* folders()
      const file = input.file ?? `${slug(input.name)}.md`
      const target = path.join(dirs[input.scope], path.basename(file))
      const data = {
        name: input.name,
        ...(input.scope === "global" && input.kind === "org" ? { layer: "org" } : {}),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.agents?.length ? { agents: [...input.agents] } : {}),
        ...(input.maxLength === undefined ? {} : { max_length: input.maxLength }),
        ...(input.enabled === false ? { enabled: false } : {}),
      }
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, matter.stringify(`${input.content.trim()}\n`, data))
      })
      return (yield* list()).find((item) => item.path === target)!
    })

    const remove = Effect.fn("OperatorIdentity.remove")(function* (scope: OperatorConfig.Scope, file: string) {
      const target = path.join((yield* folders())[scope], path.basename(file))
      const exists = yield* Effect.promise(() => Bun.file(target).exists())
      if (!exists) return yield* new NotFoundError({ message: `No identity layer ${file}` })
      yield* Effect.promise(() => fs.rm(target))
    })

    const reorder = Effect.fn("OperatorIdentity.reorder")(function* (
      scope: OperatorConfig.Scope,
      files: ReadonlyArray<string>,
    ) {
      const current = (yield* list()).filter((item) => item.scope === scope)
      yield* Effect.forEach(files, (file, index) => {
        const item = current.find((layer) => layer.file === file)
        if (!item) return Effect.void
        return save({ ...item, scope, file: item.file, priority: (index + 1) * 10 }).pipe(Effect.asVoid)
      })
      return yield* list()
    })

    const preview = Effect.fn("OperatorIdentity.preview")(function* (agent?: string) {
      return render(yield* list(), agent)
    })

    return Service.of({ list, save, remove, reorder, preview })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })

const RANK: Record<Kind, number> = { org: 0, user: 1, project: 2 }

export async function readLayers(dirs: { global: string; project: string }) {
  const read = async (scope: OperatorConfig.Scope, dir: string) => {
    const files = await Glob.scan("*.md", { cwd: dir, absolute: true, dot: false, symlink: true }).catch(() => [])
    const layers = await Promise.all(files.map((file) => readLayer(scope, file)))
    return layers.filter((item): item is Info => item !== undefined)
  }
  // When the project is the global config folder's parent (a project in ~/.config), skip duplicates.
  const layers = [
    ...(await read("global", dirs.global)),
    ...(dirs.project === dirs.global ? [] : await read("project", dirs.project)),
  ]
  return layers.sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.priority - b.priority || a.file.localeCompare(b.file))
}

async function readLayer(scope: OperatorConfig.Scope, file: string): Promise<Info | undefined> {
  const parsed = await fs
    .readFile(file, "utf8")
    .then((text) => matter(text))
    .catch(() => undefined)
  if (!parsed) return
  const data = parsed.data as Record<string, unknown>
  const agents = Array.isArray(data.agents)
    ? data.agents.filter((item): item is string => typeof item === "string")
    : undefined
  return {
    scope,
    file: path.basename(file),
    path: file,
    name: typeof data.name === "string" ? data.name : path.basename(file, ".md"),
    kind: scope === "project" ? "project" : data.layer === "org" ? "org" : "user",
    priority: typeof data.priority === "number" ? data.priority : 50,
    agents: agents?.length ? agents : undefined,
    maxLength: typeof data.max_length === "number" && data.max_length > 0 ? data.max_length : undefined,
    enabled: data.enabled !== false,
    content: parsed.content.trim(),
  }
}

// The identity text for an agent: enabled layers that apply to it, each cut to its length limit.
export function render(layers: ReadonlyArray<Info>, agent?: string) {
  return layers
    .filter(
      (item) => item.enabled && item.content && (!item.agents || (agent !== undefined && item.agents.includes(agent))),
    )
    .map((item) =>
      item.maxLength && item.content.length > item.maxLength ? item.content.slice(0, item.maxLength) : item.content,
    )
    .join("\n\n")
}

function slug(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "layer"
  )
}
