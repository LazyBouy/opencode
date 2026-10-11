export * as OperatorSmallAgents from "./small-agents"

import fs from "fs/promises"
import path from "path"
import matter from "gray-matter"
import { parse } from "jsonc-parser"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { InstanceState } from "@/effect/instance-state"
import { Provider } from "@/provider/provider"
import { OperatorConfig } from "./config"
import { OperatorModels } from "./models"
import { OperatorNamespaceScope } from "./namespace-scope"
import { OperatorSmallAgentNotes } from "./small-agent-notes"

// Agents that run on the small model (agent_form_spec.md §2.2): `modelSource: "small"`, with the model it
// resolves to written in `model`, so upstream starts their sessions on it. When the small model in effect
// changes (a write on Settings → Models or Providers & Models), their `model` is rewritten; sessions that exist
// keep the model they have. A project's agents follow the project's small model; Global's agents follow
// Settings'. A saved variant the new model doesn't have is cleared and recorded, for the agent page to say so.

// Global's config files, in the order upstream merges them.
const GLOBAL_FILES = () =>
  ["config.json", "opencode.json", "opencode.jsonc"].map((name) => path.join(Global.Path.config, name))

const isSmall = (value: unknown) =>
  !!value && typeof value === "object" && (value as { modelSource?: unknown }).modelSource === "small"

/** Whether Global, and which of these projects, hold agents on the small model (read from files: no instance). */
export async function holders(projects: ReadonlyArray<string>) {
  const global = (await smallAt("global", Global.Path.config, GLOBAL_FILES())).length > 0
  const found: string[] = []
  for (const project of projects) {
    const files = await OperatorNamespaceScope.ownConfigFiles(project, OperatorNamespaceScope.MERGE_ORDER)
    if ((await smallAt("project", path.join(project, ".opencode"), files)).length) found.push(project)
  }
  return { global, projects: found }
}

/** The small model an agent saved at this scope runs on: the project's, or Settings' for Global. */
export const modelFor = Effect.fnUntraced(function* (scope: OperatorConfig.Scope) {
  const models = yield* OperatorModels.Service
  if (scope === "project") return (yield* models.defaults()).chain.small.effective.model
  const settings = yield* Effect.promise(() => OperatorModels.namespaceSources())
  return (yield* models.chains(settings.sources, settings.targets)).small.effective.model
})

/** A new or edited agent on the small model gets the model it resolves to. */
export const fill = Effect.fnUntraced(function* <T extends { modelSource?: string; model?: string }>(
  scope: OperatorConfig.Scope,
  patch: T,
) {
  if (patch.modelSource !== "small") return patch as T & { model?: string }
  const model = yield* modelFor(scope)
  return (model ? { ...patch, model } : patch) as T & { model?: string }
})

type Found =
  | { name: string; scope: OperatorConfig.Scope; file: string; data: Record<string, unknown>; body: string }
  | { name: string; scope: OperatorConfig.Scope; entry: Record<string, unknown> }

// The agents on the small model at a scope: agent files in its config folder, and entries in its config files.
async function smallAt(scope: OperatorConfig.Scope, dir: string, configFiles: ReadonlyArray<string>) {
  const found: Found[] = []
  for (const sub of ["agents", "agent"]) {
    const entries = await fs.readdir(path.join(dir, sub)).catch(() => [] as string[])
    for (const name of entries.filter((item) => item.endsWith(".md"))) {
      const file = path.join(dir, sub, name)
      const parsed = matter(await fs.readFile(file, "utf8").catch(() => ""))
      if (isSmall(parsed.data))
        found.push({ name: name.slice(0, -3), scope, file, data: parsed.data, body: parsed.content })
    }
  }
  for (const file of configFiles) {
    const value = parse((await fs.readFile(file, "utf8").catch(() => "")) || "{}") as
      | { agent?: Record<string, Record<string, unknown>> }
      | undefined
    for (const [name, entry] of Object.entries(value?.agent ?? {}))
      if (isSmall(entry)) found.push({ name, scope, entry })
  }
  return found
}

/**
 * Rewrites the `model` of the agents on the small model, the project's (the instance's) and Global's, to the small
 * model in effect for them, and clears a variant the new model doesn't have. Read from their files, not from the
 * loaded agents, so an agent made since the project loaded is included. Returns the agents changed.
 */
export const sync = Effect.fn("OperatorSmallAgents.sync")(function* () {
  const operatorConfig = yield* OperatorConfig.Service
  const provider = yield* Provider.Service
  const project = OperatorConfig.projectRoot(yield* InstanceState.context)
  const found = yield* Effect.promise(async () => [
    ...(await smallAt(
      "project",
      path.join(project, ".opencode"),
      await OperatorNamespaceScope.ownConfigFiles(project, OperatorNamespaceScope.MERGE_ORDER),
    )),
    ...(await smallAt("global", Global.Path.config, GLOBAL_FILES())),
  ])
  if (!found.length) return []
  const hasVariant = (model: string, variant: string) => {
    const ref = Provider.parseModel(model)
    return provider.getModel(ProviderV2.ID.make(ref.providerID), ModelV2.ID.make(ref.modelID)).pipe(
      Effect.map((item) => !!item.variants?.[variant]),
      Effect.catch(() => Effect.succeed(false)),
    )
  }
  const changed: string[] = []
  for (const agent of found) {
    const model = yield* modelFor(agent.scope)
    const settings = "file" in agent ? agent.data : agent.entry
    if (!model || settings.model === model) continue
    const variant = typeof settings.variant === "string" ? settings.variant : undefined
    const keep = !variant || (yield* hasVariant(model, variant))
    if ("file" in agent) {
      const { variant: _, ...rest } = agent.data
      const data = { ...(keep ? agent.data : rest), model }
      yield* Effect.promise(() => fs.writeFile(agent.file, matter.stringify(agent.body, data)))
    } else
      yield* operatorConfig
        .update(agent.scope, { agent: { [agent.name]: { model, ...(keep ? {} : { variant: null }) } } })
        .pipe(Effect.catch(() => Effect.void))
    yield* Effect.promise(() =>
      OperatorSmallAgentNotes.record(
        project,
        agent.name,
        keep ? undefined : { variant: variant!, model, at: Date.now() },
      ),
    )
    changed.push(agent.name)
  }
  return changed
})
