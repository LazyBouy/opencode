export * as OperatorHelperFiles from "./helper-files"

import fs from "fs/promises"
import path from "path"
import { Schema } from "effect"
import { Global } from "@opencode-ai/core/global"

// Helpers on disk (agent_types_spec.md §4.2): one file per helper, `<config>/namespaces/<ns>/helpers/<name>.json`.
// Kept free of service imports: the prompt store reads them to refuse deleting a helper's profile.

export const ModelSource = Schema.Literals(["small", "default", "pick"]).annotate({
  identifier: "OperatorHelperModelSource",
})

export const Model = Schema.Struct({
  source: ModelSource.annotate({
    description:
      "small: the small model of the project it serves (the namespace's default project); default: its default model; pick: `model`",
  }),
  model: Schema.optional(Schema.String).annotate({ description: "provider/model, for pick" }),
  variant: Schema.optional(Schema.String),
}).annotate({ identifier: "OperatorHelperModel" })
export type Model = typeof Model.Type

export const Stored = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  model: Model,
  profile: Schema.String.annotate({ description: "Its helper profile: one helper layer, its text" }),
  layer: Schema.String.annotate({ description: "The helper layer holding its text" }),
  steps: Schema.Finite,
  timeout: Schema.Finite.annotate({ description: "Seconds" }),
  callable: Schema.optional(Schema.Boolean).annotate({ description: "Agents may call it with the helper tool" }),
  usage: Schema.optional(Schema.String).annotate({
    description: "What to give it and what you get back, in one line, for the helper tool",
  }),
  actions: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "What it may do: tools and system actions; everything else is denied",
  }),
}).annotate({ identifier: "OperatorHelperStored" })
export type Stored = typeof Stored.Type

const decode = Schema.decodeUnknownOption(Stored)

export const folder = (ns: string) => path.join(Global.Path.config, "namespaces", ns, "helpers")
export const file = (ns: string, name: string) => path.join(folder(ns), `${name}.json`)

export async function read(ns: string): Promise<Stored[]> {
  const names = await fs.readdir(folder(ns)).catch(() => [] as string[])
  const found = await Promise.all(
    names.filter((name) => name.endsWith(".json")).map((name) => readOne(ns, name.slice(0, -".json".length))),
  )
  return found.filter((item) => item !== undefined).toSorted((a, b) => a.name.localeCompare(b.name))
}

export async function readOne(ns: string, name: string): Promise<Stored | undefined> {
  const data = await Bun.file(file(ns, name))
    .json()
    .catch(() => undefined)
  const found = decode(data)
  // The file's name is the helper's name.
  return found._tag === "Some" ? { ...found.value, name } : undefined
}

export async function write(ns: string, helper: Stored) {
  await fs.mkdir(folder(ns), { recursive: true })
  await Bun.write(file(ns, helper.name), JSON.stringify(helper, null, 2) + "\n")
  revision++
}

// Bumped on every write and removal here, so readers that keep a read (helper-runs.ts) see a change at once.
let revision = 0
export const helperRevision = () => revision
export const changed = () => {
  revision++
}
