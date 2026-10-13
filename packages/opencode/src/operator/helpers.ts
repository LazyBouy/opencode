export * as OperatorHelpers from "./helpers"

import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OperatorHelperFiles } from "./helper-files"
import { OperatorHelperTriggerRules } from "./helper-trigger-rules"
import { OperatorProfile } from "./profile"
import { OperatorProfileStore } from "./profile-store"
import { OperatorTrashFiles } from "./trash-files"
import { OperatorNamespaceScope } from "./namespace-scope"
import { OperatorReloadWhenIdle } from "./reload-when-idle"

// Helpers (agent_types_spec.md §4): small jobs the system runs on an agent's behalf. They belong to a namespace
// (helper-files.ts) and every project of it can use them. A helper's text is a helper profile holding one helper
// layer of the namespace's catalog, made with the helper and edited in place (§4.3); deleting the helper takes
// both to Trash with it. Every namespace also lists the built-in helpers (§4.8): OpenCode's title, summary,
// compaction and agent generator, and the fork's purpose and Dynamic generators, each with its role. Their
// definitions are read-only; their text is the namespace's version of their helper profile, edited on the
// Prompts page as before. What a helper does: its actions, the `helper` tool and runs (§4.5–4.7), roles (§4.4),
// and triggers (§4.9: schedules and events that start it on its own, helper-triggers.ts).

export const Role = Schema.Literals([
  "title",
  "compaction",
  "summary",
  "agent-generator",
  "purpose-generator",
  "dynamic-generator",
]).annotate({ identifier: "OperatorHelperRole" })
export type Role = typeof Role.Type

export const STEPS = { default: 5, min: 1, max: 20 } as const

// What a helper may declare (§4.6). System actions are the fork's (helper-tool.ts; memory is the memory tool,
// within the memory permission). Read-only tools are suggested; the form asks before any other. Tools that need
// someone to answer (question), start other agents (task) or helpers (helper) can't be declared: a run is
// unattended and short.
export const SYSTEM_ACTIONS = ["list_sessions", "archive_session", "trash_session", "notify", "memory"] as const
export const READ_ONLY = ["read", "glob", "grep", "webfetch", "list_sessions", "memory"] as const
export const LAYER_ACTIONS = OperatorHelperFiles.LAYER_ACTIONS
// The roles OpenCode's own code calls by these agent names: their models go through config (namespace-scope.ts).
export const CONFIG_ROLES = ["title", "compaction"] as const
export const NOT_DECLARABLE = ["question", "task", "helper", "invalid"] as const
/** Seconds. */
export const TIMEOUT = { default: 120, min: 10, max: 600 } as const

// The model each built-in uses (session/prompt.ts, session/compaction.ts, agent/agent.ts, generate.ts): the small
// model of the chat's provider (title) or of the default provider (the fork's generators), else the model they'd
// use; the chat's model (compaction; summary is never called); the default model (the agent generator).
const BUILTINS: ReadonlyArray<{ name: Role; model: "small" | "default" | "chat" }> = [
  { name: "title", model: "small" },
  { name: "summary", model: "chat" },
  { name: "compaction", model: "chat" },
  { name: "agent-generator", model: "default" },
  { name: "purpose-generator", model: "small" },
  { name: "dynamic-generator", model: "small" },
]
const BUILTIN_NAMES: ReadonlySet<string> = new Set(BUILTINS.map((item) => item.name))
const HELPER_GROUP = `${OperatorProfile.PREFIX}group.helper`

export const Info = Schema.Struct({
  name: Schema.String,
  namespace: Schema.String,
  description: Schema.optional(Schema.String),
  builtin: Schema.Boolean,
  roles: Schema.Array(Role).annotate({ description: "A built-in's role" }),
  model: Schema.Struct({
    source: Schema.Literals(["small", "default", "pick", "chat"]).annotate({
      description: "chat (built-ins only): the model of the chat it works for",
    }),
    model: Schema.optional(Schema.String),
    variant: Schema.optional(Schema.String),
  }),
  profile: Schema.String.annotate({ description: "Its helper profile" }),
  layer: Schema.optional(Schema.String).annotate({ description: "The helper layer holding its text" }),
  text: Schema.String,
  steps: Schema.optional(Schema.Finite).annotate({ description: "Step limit (not for built-ins: one call)" }),
  timeout: Schema.optional(Schema.Finite).annotate({ description: "Time limit in seconds (not for built-ins)" }),
  replacedBy: Schema.optional(Schema.String).annotate({
    description: "A built-in whose role a helper of the namespace has taken over: that helper",
  }),
  callable: Schema.Boolean.annotate({ description: "Agents of its namespace may call it with the helper tool" }),
  usage: Schema.optional(Schema.String).annotate({ description: "What to give it and what you get back" }),
  actions: Schema.Array(Schema.String).annotate({
    description: "Its declared tools and system actions: allowed in its runs; everything else is denied",
  }),
  triggers: Schema.Array(OperatorHelperFiles.Trigger).annotate({
    description: "What starts it on its own: schedules and events (none for built-ins)",
  }),
  file: Schema.optional(Schema.String),
}).annotate({ identifier: "OperatorHelper" })
export type Info = typeof Info.Type

export const Name = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/)).annotate({
  description: "Letters, digits, dots, dashes and underscores; used as the file name",
})

export const Create = Schema.Struct({
  name: Name,
  description: Schema.optional(Schema.String),
  model: OperatorHelperFiles.Model,
  text: Schema.String,
  steps: Schema.optional(Schema.Finite),
  timeout: Schema.optional(Schema.Finite).annotate({ description: "Seconds" }),
  callable: Schema.optional(Schema.Boolean),
  usage: Schema.optional(Schema.String),
  actions: Schema.optional(Schema.Array(Schema.String)),
  roles: Schema.optional(Schema.Array(Role)).annotate({
    description: "The built-in roles it takes over in its namespace (another helper holding one gives it up)",
  }),
  triggers: Schema.optional(Schema.Array(OperatorHelperFiles.Trigger)).annotate({
    description: "Its triggers; an empty id: a new one (its id is made)",
  }),
}).annotate({ identifier: "OperatorHelperCreate" })
export type Create = typeof Create.Type

export const Patch = Schema.Struct({
  description: Schema.optional(Schema.String).annotate({ description: "Empty: none" }),
  model: Schema.optional(OperatorHelperFiles.Model),
  text: Schema.optional(Schema.String),
  steps: Schema.optional(Schema.Finite),
  timeout: Schema.optional(Schema.Finite).annotate({ description: "Seconds" }),
  callable: Schema.optional(Schema.Boolean),
  usage: Schema.optional(Schema.String).annotate({ description: "Empty: none" }),
  actions: Schema.optional(Schema.Array(Schema.String)),
  roles: Schema.optional(Schema.Array(Role)),
  triggers: Schema.optional(Schema.Array(OperatorHelperFiles.Trigger)).annotate({
    description: "All its triggers (replacing them); an empty id: a new one",
  }),
}).annotate({ identifier: "OperatorHelperPatch" })
export type Patch = typeof Patch.Type

export class HelperError extends Schema.TaggedErrorClass<HelperError>()("OperatorHelperError", {
  message: Schema.String,
}) {}

export interface Interface {
  /** A namespace's helpers, built-ins first; without one, every namespace's. */
  readonly list: (ns?: string) => Effect.Effect<Info[], HelperError>
  readonly create: (ns: string, input: Create) => Effect.Effect<Info, HelperError>
  readonly update: (ns: string, name: string, patch: Patch) => Effect.Effect<Info, HelperError>
  /** Moves a helper, with its helper profile and layer, to Trash. */
  readonly remove: (ns: string, name: string) => Effect.Effect<OperatorTrashFiles.Entry, HelperError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorHelpers") {}

const fail = (message: string) => new HelperError({ message })
const limit = (label: string, value: number | undefined, range: { default: number; min: number; max: number }) => {
  if (value === undefined) return range.default
  if (!Number.isInteger(value) || value < range.min || value > range.max)
    throw fail(`${label} is a whole number from ${range.min} to ${range.max}`)
  return value
}
const checkModel = (model: OperatorHelperFiles.Model) => {
  if (model.source === "pick" && !model.model?.includes("/")) throw fail("Pick a model: provider/model")
  return {
    source: model.source,
    ...(model.source === "pick" ? { model: model.model } : {}),
    ...(model.source !== "default" && model.variant ? { variant: model.variant } : {}),
  }
}

export const ROLES: ReadonlyArray<Role> = [
  "title",
  "compaction",
  "summary",
  "agent-generator",
  "purpose-generator",
  "dynamic-generator",
]

// A role helper's output is used directly by OpenCode's code (§4.4): it has no actions.
const checkRoles = (roles: ReadonlyArray<string>, actions: ReadonlyArray<string>) => {
  if (roles.length && actions.length)
    throw fail("A helper that takes over a built-in role has no actions: OpenCode's code uses its output directly")
  return roles
}

const triggerId = () => Math.random().toString(36).slice(2, 8).padEnd(6, "0")
const checkTriggers = (triggers: ReadonlyArray<OperatorHelperFiles.Trigger>) => {
  try {
    return OperatorHelperTriggerRules.check(triggers, triggerId)
  } catch (error) {
    throw fail(error instanceof Error ? error.message : String(error))
  }
}

const checkActions = (actions: ReadonlyArray<string> | undefined) => {
  const list = [...new Set((actions ?? []).map((item) => item.trim()).filter(Boolean))]
  const refused = list.find((item) => (NOT_DECLARABLE as ReadonlyArray<string>).includes(item))
  if (refused) throw fail(`A helper can't declare ${refused}: it runs unattended`)
  const odd = list.find((item) => !/^[A-Za-z0-9_.:-]+$/.test(item))
  if (odd) throw fail(`"${odd}" is not a tool or system action`)
  return list
}

// The helper layer of a helper profile: the namespace's own (a copy or yours), else OpenCode's.
function textOf(catalog: OperatorProfile.Catalog, profile: OperatorProfile.Profile | undefined) {
  const id = profile?.slots[OperatorProfile.HELPER]?.[0]
  const layer = id ? (catalog.layers.find((item) => item.id === id) ?? OperatorProfile.builtinLayerById(id)) : undefined
  return { ...(layer ? { layer: layer.id } : {}), text: layer?.text ?? "" }
}

function builtins(catalog: OperatorProfile.Catalog, helpers: ReadonlyArray<OperatorHelperFiles.Stored>): Info[] {
  return BUILTINS.map((item) => {
    const holder = helpers.find((helper) => helper.roles?.includes(item.name))
    const builtin = OperatorProfile.HELPER_DEFAULTS.get(item.name)!
    const own = OperatorProfile.versionId(catalog, builtin)
    const profile =
      OperatorProfile.profiles(catalog).find((found) => found.id === own) ??
      OperatorProfile.BUILTIN_PROFILES.find((found) => found.id === builtin)
    return {
      name: item.name,
      namespace: catalog.namespace.id,
      builtin: true,
      roles: [item.name],
      model: { source: item.model },
      ...(holder ? { replacedBy: holder.name } : {}),
      callable: false,
      actions: [],
      triggers: [],
      profile: profile?.id ?? builtin,
      ...textOf(catalog, profile),
    }
  })
}

function infoOf(catalog: OperatorProfile.Catalog, stored: OperatorHelperFiles.Stored): Info {
  const layer = catalog.layers.find((item) => item.id === stored.layer)
  return {
    name: stored.name,
    namespace: catalog.namespace.id,
    ...(stored.description ? { description: stored.description } : {}),
    builtin: false,
    roles: (stored.roles ?? []).filter((role): role is Role => (ROLES as ReadonlyArray<string>).includes(role)),
    model: stored.model,
    profile: stored.profile,
    ...(layer ? { layer: layer.id } : {}),
    text: layer?.text ?? "",
    steps: stored.steps,
    timeout: stored.timeout,
    callable: stored.callable === true,
    ...(stored.usage ? { usage: stored.usage } : {}),
    actions: stored.actions ?? [],
    triggers: stored.triggers ?? [],
    file: OperatorHelperFiles.file(catalog.namespace.id, stored.name),
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* OperatorProfileStore.Service
    const reloads = yield* OperatorReloadWhenIdle.Service
    const storeError = (error: { message: string }) => fail(error.message)

    // A helper that writes Dynamic layers (their `writer`) may declare reading only, and isn't deleted while it does.
    const layersWritten = (catalog: OperatorProfile.Catalog, name: string) =>
      catalog.layers.filter((item) => item.writer === name)
    const checkWriter = (catalog: OperatorProfile.Catalog, name: string, actions: ReadonlyArray<string>) => {
      const written = layersWritten(catalog, name)[0]
      const other = actions.find((item) => !LAYER_ACTIONS.includes(item))
      return written && other
        ? fail(`${name} writes the Dynamic layer "${written.name}": it may only declare read actions, not ${other}`)
        : undefined
    }

    // One helper per role in a namespace: the others give up the roles this one takes.
    const takeRoles = Effect.fnUntraced(function* (ns: string, name: string, roles: ReadonlyArray<string>) {
      if (!roles.length) return
      for (const other of yield* Effect.promise(() => OperatorHelperFiles.read(ns))) {
        if (other.name === name || !other.roles?.some((role) => roles.includes(role))) continue
        const kept = other.roles.filter((role) => !roles.includes(role))
        const { roles: _, ...rest } = other
        yield* Effect.promise(() => OperatorHelperFiles.write(ns, { ...rest, ...(kept.length ? { roles: kept } : {}) }))
      }
    })

    // OpenCode's title and compaction get their role helper's model through the namespace's config (namespace-
    // scope.ts): its projects reload when none of their sessions runs.
    const reloadFor = Effect.fnUntraced(function* (ns: string, roles: ReadonlyArray<string>) {
      if (!roles.some((role) => (CONFIG_ROLES as ReadonlyArray<string>).includes(role))) return
      for (const directory of OperatorNamespaceScope.instancesOf({ namespace: ns }))
        yield* reloads.want({ directory }).pipe(Effect.ignore)
    })

    const catalogOf = Effect.fnUntraced(function* (ns: string) {
      // OpenCode's namespace is made on first use, as the prompt store does.
      yield* Effect.promise(() => OperatorProfileStore.ensure())
      const found = yield* Effect.promise(() => OperatorProfileStore.readNamespace(ns))
      if (!found) return yield* fail(`No namespace "${ns}"`)
      return OperatorProfile.migrate(found)
    })

    const storedOf = Effect.fnUntraced(function* (ns: string, name: string) {
      if (BUILTIN_NAMES.has(name)) return yield* fail(`${name} is a built-in helper: its definition is read-only`)
      const found = yield* Effect.promise(() => OperatorHelperFiles.readOne(ns, name))
      if (!found) return yield* fail(`No helper "${name}" in this namespace`)
      return found
    })

    const list = Effect.fn("OperatorHelpers.list")(function* (ns?: string) {
      const ids = ns ? [ns] : (yield* store.namespaces()).map((item) => item.namespace.id)
      const all: Info[] = []
      for (const id of ids) {
        const catalog = yield* catalogOf(id)
        const own = yield* Effect.promise(() => OperatorHelperFiles.read(id))
        all.push(...builtins(catalog, own), ...own.map((item) => infoOf(catalog, item)))
      }
      return all
    })

    // The helper group in this namespace (its version of OpenCode's), else one is made.
    const helperGroup = Effect.fnUntraced(function* (ns: string, catalog: OperatorProfile.Catalog) {
      const groups = OperatorProfile.groups(catalog)
      const found =
        groups.find((item) => item.id === OperatorProfile.versionId(catalog, HELPER_GROUP)) ??
        groups.find((item) => item.types.length === 1 && item.types[0] === OperatorProfile.HELPER)
      if (found) return found.id
      return (yield* store
        .saveGroup(ns, undefined, { name: "Helper", types: [OperatorProfile.HELPER] })
        .pipe(Effect.mapError(storeError))).id
    })

    const create = Effect.fn("OperatorHelpers.create")(function* (ns: string, input: Create) {
      const catalog = yield* catalogOf(ns)
      if (BUILTIN_NAMES.has(input.name)) return yield* fail(`${input.name} is a built-in helper's name`)
      if (yield* Effect.promise(() => OperatorHelperFiles.readOne(ns, input.name)))
        return yield* fail(`This namespace has a helper "${input.name}" already`)
      const checked = yield* Effect.try({
        try: () => ({
          model: checkModel(input.model),
          steps: limit("The step limit", input.steps, STEPS),
          timeout: limit("The time limit", input.timeout, TIMEOUT),
          actions: checkActions(input.actions),
          roles: checkRoles(input.roles ?? [], input.actions ?? []),
          triggers: checkTriggers(input.triggers ?? []),
        }),
        catch: (error) => (error instanceof HelperError ? error : fail(String(error))),
      })
      const group = yield* helperGroup(ns, catalog)
      const text = yield* store
        .saveLayer(ns, undefined, { name: input.name, type: OperatorProfile.HELPER, text: input.text })
        .pipe(Effect.mapError(storeError))
      const profile = yield* store
        .saveProfile(ns, undefined, { name: input.name, group, slots: { [OperatorProfile.HELPER]: [text.id] } })
        .pipe(
          Effect.mapError(storeError),
          // Its text goes too.
          Effect.tapError(() => store.remove(ns, "layer", text.id).pipe(Effect.ignore)),
        )
      const stored: OperatorHelperFiles.Stored = {
        name: input.name,
        ...(input.description?.trim() ? { description: input.description.trim() } : {}),
        model: checked.model,
        profile: profile.id,
        layer: text.id,
        steps: checked.steps,
        timeout: checked.timeout,
        ...(input.callable ? { callable: true } : {}),
        ...(input.usage?.trim() ? { usage: input.usage.trim() } : {}),
        ...(checked.actions.length ? { actions: checked.actions } : {}),
        ...(checked.roles.length ? { roles: [...checked.roles] } : {}),
        ...(checked.triggers.length ? { triggers: checked.triggers } : {}),
      }
      yield* takeRoles(ns, input.name, checked.roles)
      yield* Effect.promise(() => OperatorHelperFiles.write(ns, stored))
      yield* reloadFor(ns, checked.roles)
      return infoOf(yield* catalogOf(ns), stored)
    })

    const update = Effect.fn("OperatorHelpers.update")(function* (ns: string, name: string, patch: Patch) {
      const before = yield* storedOf(ns, name)
      const checked = yield* Effect.try({
        try: () => ({
          ...(patch.model ? { model: checkModel(patch.model) } : {}),
          ...(patch.steps !== undefined ? { steps: limit("The step limit", patch.steps, STEPS) } : {}),
          ...(patch.timeout !== undefined ? { timeout: limit("The time limit", patch.timeout, TIMEOUT) } : {}),
          ...(patch.actions !== undefined ? { actions: checkActions(patch.actions) } : {}),
          ...(patch.triggers !== undefined ? { triggers: checkTriggers(patch.triggers) } : {}),
        }),
        catch: (error) => (error instanceof HelperError ? error : fail(String(error))),
      })
      if (patch.text !== undefined) {
        const catalog = yield* catalogOf(ns)
        const text = catalog.layers.find((item) => item.id === before.layer)
        if (!text) return yield* fail(`The text of "${name}" is missing (its layer ${before.layer} was deleted)`)
        yield* store
          .saveLayer(ns, text.id, { name: text.name, type: text.type, text: patch.text })
          .pipe(Effect.mapError(storeError))
      }
      const {
        description: _,
        usage: __,
        callable: ___,
        actions: ____,
        roles: _____,
        triggers: ______,
        ...rest
      } = before
      const description = patch.description === undefined ? before.description : patch.description.trim()
      const usage = patch.usage === undefined ? before.usage : patch.usage.trim()
      const callable = patch.callable ?? before.callable
      const actions = checked.actions ?? before.actions ?? []
      const roles = yield* Effect.try({
        try: () => checkRoles(patch.roles ?? before.roles ?? [], actions),
        catch: (error) => (error instanceof HelperError ? error : fail(String(error))),
      })
      const writer = checkWriter(yield* catalogOf(ns), name, actions)
      if (writer) return yield* writer
      const { actions: _checked, triggers: _triggers, ...limits } = checked
      const triggers = checked.triggers ?? before.triggers ?? []
      const next: OperatorHelperFiles.Stored = {
        ...rest,
        ...(description ? { description } : {}),
        ...limits,
        ...(callable ? { callable: true } : {}),
        ...(usage ? { usage } : {}),
        ...(actions.length ? { actions } : {}),
        ...(roles.length ? { roles: [...roles] } : {}),
        ...(triggers.length ? { triggers: [...triggers] } : {}),
      }
      yield* takeRoles(ns, name, roles)
      yield* Effect.promise(() => OperatorHelperFiles.write(ns, next))
      // A changed model or role reaches OpenCode's title and compaction after a reload.
      yield* reloadFor(ns, [...roles, ...(before.roles ?? [])])
      return infoOf(yield* catalogOf(ns), next)
    })

    const remove = Effect.fn("OperatorHelpers.remove")(function* (ns: string, name: string) {
      const found = yield* storedOf(ns, name)
      const written = layersWritten(yield* catalogOf(ns), name)[0]
      if (written) return yield* fail(`${name} writes the Dynamic layer "${written.name}": choose another writer first`)
      yield* reloadFor(ns, found.roles ?? [])
      return yield* Effect.promise(() =>
        OperatorTrashFiles.put({
          kind: "helper",
          name,
          namespace: ns,
          paths: [
            OperatorHelperFiles.file(ns, name),
            OperatorProfileStore.itemFile(ns, "profile", found.profile),
            OperatorProfileStore.itemFile(ns, "layer", found.layer),
          ],
        }).finally(OperatorHelperFiles.changed),
      )
    })

    return Service.of({ list, create, update, remove })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [OperatorProfileStore.node, OperatorReloadWhenIdle.node],
})
