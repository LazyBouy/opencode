export * as OperatorHookManage from "./manage"

import fs from "fs/promises"
import path from "path"
import { parse } from "jsonc-parser"
import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { ConfigForkV1 } from "@opencode-ai/core/v1/config/fork"
import { InstanceState } from "@/effect/instance-state"
import { OperatorConfig } from "../config"
import { OperatorLayout } from "../layout"
import { OperatorProjectConfig } from "../project-config"
import { OperatorTrashFiles } from "../trash-files"
import { OperatorHookEvents } from "./events"
import { OperatorHooks } from "./hooks"
import { OperatorHookResolve } from "./resolve"
import { OperatorHookRuns } from "./runs"
import { OperatorHookTemplates } from "./templates"

// The console's changes to hooks (SPEC-0022 §10.1, §10.2, §10.4), at the Capabilities page's scope: Global, a
// namespace (its own layer) or a project. A hook is saved into the scope's config file (a project's is
// copy-on-write: the usual copy question), turned off or on there (`capabilities.disabled.hooks`), deleted to Trash
// with its script if asked, or run on a sample event (Test). Scripts are written in the scope's hooks/ folder. A
// locked inherited hook can't be replaced or turned off; a hand-edited file that does so still loads, and the list
// shows the conflict.

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("OperatorHookManageInvalid", {
  message: Schema.String,
}) {}

type Entry = typeof ConfigForkV1.HookEntry.Type
type Hook = OperatorHooks.Effective["hooks"][number]
type Failure = InvalidError | OperatorConfig.InvalidError | OperatorProjectConfig.CopyNeededError

export const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

export const TestResult = Schema.Struct({
  run: OperatorHookRuns.Run,
  outcome: OperatorHookRuns.Outcome,
  answer: Schema.Record(Schema.String, Schema.Unknown).annotate({ description: "The answer the event uses" }),
  cause: Schema.optional(Schema.String).annotate({ description: "Why the run failed" }),
}).annotate({ identifier: "OperatorHookTestResult" })

export const Script = Schema.Struct({
  path: Schema.String,
  text: Schema.String,
  editable: Schema.Boolean.annotate({ description: "It's in the scope's hooks/ folder" }),
}).annotate({ identifier: "OperatorHookScript" })

export interface Interface {
  /** Creates or replaces the scope's hook `name` (renaming `previous`, when given). */
  readonly save: (input: {
    namespace?: string
    name: string
    previous?: string
    hook: Entry
  }) => Effect.Effect<Hook, Failure>
  /** Turns an inherited hook off at the scope, or on again. */
  readonly setState: (input: { namespace?: string; name: string; off: boolean }) => Effect.Effect<Hook, Failure>
  /** Moves the scope's hook to Trash, and its script when asked (only one in the scope's hooks/ folder). */
  readonly remove: (input: { namespace?: string; name: string; script?: boolean }) => Effect.Effect<void, Failure>
  /** Runs a hook of the scope on an event (a sample of its event when none is given); no session is touched. */
  readonly test: (input: {
    namespace?: string
    name: string
    input?: Record<string, unknown>
  }) => Effect.Effect<typeof TestResult.Type, InvalidError>
  /** The scripts in the scope's hooks/ folder. */
  readonly scripts: (namespace?: string) => Effect.Effect<ReadonlyArray<string>>
  /** A script of the scope: one in its hooks/ folder, or a hook's. */
  readonly readScript: (input: { namespace?: string; path: string }) => Effect.Effect<typeof Script.Type, InvalidError>
  readonly writeScript: (input: { namespace?: string; path: string; text: string }) => Effect.Effect<void, InvalidError>
  /** Writes a template script for the event in the scope's hooks/ folder; gives its path and `command`. */
  readonly newScript: (input: {
    namespace?: string
    name: string
    language: OperatorHookTemplates.Language
    event: OperatorHookEvents.Name
  }) => Effect.Effect<{ path: string; command: string }, InvalidError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorHookManage") {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
const inside = (folder: string, file: string) =>
  OperatorLayout.contains(folder, file) && path.resolve(file) !== path.resolve(folder)
const fail = (message: string) => new InvalidError({ message })

// An entry as it's saved: what's set, nothing empty.
function tidy(hook: Entry): Entry {
  return Object.fromEntries(
    Object.entries(hook).filter(
      ([, value]) => value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0),
    ),
  ) as Entry
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const hooks = yield* OperatorHooks.Service
    const operatorConfig = yield* OperatorConfig.Service

    // The scope's config as it is now (a project without its own: its namespace's, which a first write copies).
    const configOf = Effect.fnUntraced(function* (namespace?: string) {
      if (namespace) {
        const own = yield* Effect.promise(() => OperatorProjectConfig.namespaceConfig(namespace))
        const value = parse(own.text ?? "{}") as unknown
        return isRecord(value) ? value : {}
      }
      const ctx = yield* InstanceState.context
      const value = parse((yield* Effect.promise(() => OperatorProjectConfig.resolved(ctx))).text) as unknown
      return isRecord(value) ? value : {}
    })
    const patch = (namespace: string | undefined, body: Record<string, unknown>) =>
      namespace ? operatorConfig.update("namespace", body, namespace) : operatorConfig.update("project", body)

    const find = Effect.fnUntraced(function* (namespace: string | undefined, name: string) {
      const view = yield* hooks.effective(undefined, namespace)
      return { view, hook: view.hooks.find((item) => item.name === name) }
    })

    const save = Effect.fn("OperatorHookManage.save")(function* (input: {
      namespace?: string
      name: string
      previous?: string
      hook: Entry
    }) {
      if (!NAME.test(input.name))
        return yield* fail("A hook's name is letters, digits, dots, dashes and underscores (up to 64)")
      const { hook: existing } = yield* find(input.namespace, input.name)
      const scope = yield* hooks.scopeOf(input.namespace)
      const checked = OperatorHookResolve.entry(input.name, input.hook, {
        level: scope.level,
        file: scope.file ?? "",
        base: path.dirname(scope.file ?? ""),
        hooks: {},
        disabled: [],
      })
      if (checked.problems.length) return yield* fail(`${input.name}: ${checked.problems.join("; ")}`)
      // A locked hook from a higher level can't be replaced here (it stays in force over any override).
      if (existing && existing.level !== scope.level && existing.locked)
        return yield* fail(`${input.name} is locked at ${existing.level}: it can't be replaced here`)
      if (input.previous && input.previous !== input.name && existing?.level === scope.level)
        return yield* fail(`There's a hook named ${input.name} here already`)
      yield* patch(input.namespace, {
        hooks: {
          [input.name]: OperatorConfig.whole(tidy(input.hook)),
          ...(input.previous && input.previous !== input.name ? { [input.previous]: null } : {}),
        },
      })
      const saved = (yield* find(input.namespace, input.name)).hook
      if (!saved) return yield* fail(`${input.name} wasn't saved`)
      return saved
    })

    const setState = Effect.fn("OperatorHookManage.setState")(function* (input: {
      namespace?: string
      name: string
      off: boolean
    }) {
      const { hook } = yield* find(input.namespace, input.name)
      const scope = yield* hooks.scopeOf(input.namespace)
      if (!hook) return yield* fail(`No hook named ${input.name}`)
      if (hook.level === scope.level) return yield* fail(`${input.name} is this level's own: edit or delete it instead`)
      if (hook.locked) return yield* fail(`${input.name} is locked at ${hook.level}: it can't be turned off below`)
      const current = yield* configOf(input.namespace)
      const capabilities = isRecord(current.capabilities) ? current.capabilities : {}
      const disabled =
        isRecord(capabilities.disabled) && Array.isArray(capabilities.disabled.hooks)
          ? capabilities.disabled.hooks.filter((item): item is string => typeof item === "string")
          : []
      const next = input.off ? [...new Set([...disabled, input.name])] : disabled.filter((item) => item !== input.name)
      yield* patch(input.namespace, {
        capabilities: { disabled: { hooks: next.length ? OperatorConfig.whole(next) : null } },
      })
      const changed = (yield* find(input.namespace, input.name)).hook
      return changed ?? hook
    })

    const remove = Effect.fn("OperatorHookManage.remove")(function* (input: {
      namespace?: string
      name: string
      script?: boolean
    }) {
      const scope = yield* hooks.scopeOf(input.namespace)
      const current = yield* configOf(input.namespace)
      const value = isRecord(current.hooks) ? current.hooks[input.name] : undefined
      if (value === undefined) return yield* fail(`${input.name} isn't this level's own hook: turn it off instead`)
      const { hook } = yield* find(input.namespace, input.name)
      const script =
        input.script && hook?.command && scope.folder && inside(scope.folder, hook.command) ? [hook.command] : []
      const ctx = input.namespace ? undefined : yield* InstanceState.context
      yield* patch(input.namespace, { hooks: { [input.name]: null } })
      yield* Effect.promise(() =>
        OperatorTrashFiles.put({
          kind: "hook",
          name: input.name,
          ...(ctx ? { project: ctx.directory } : {}),
          namespace: scope.namespace,
          ...(script.length ? { paths: script } : {}),
          config: input.namespace
            ? { scope: "namespace", namespace: input.namespace, key: ["hooks", input.name], value }
            : { scope: "project", key: ["hooks", input.name], value },
        }),
      )
    })

    const test = Effect.fn("OperatorHookManage.test")(function* (input: {
      namespace?: string
      name: string
      input?: Record<string, unknown>
    }) {
      const resolved = yield* find(input.namespace, input.name)
      const hook = resolved.hook
      if (!hook) return yield* fail(`No hook named ${input.name}`)
      if (hook.state === "invalid") return yield* fail(`${input.name}: ${hook.problems.join("; ")}`)
      if (!OperatorHookEvents.isName(hook.event)) return yield* fail(`${input.name}: unknown event ${hook.event}`)
      const event = { ...OperatorHookTemplates.sample(hook.event), ...input.input, event: hook.event }
      const run = yield* hooks.execute(
        { ...hook, args: [...hook.args], match: [...hook.match], problems: [...hook.problems] },
        { ...(event as OperatorHooks.EventInput), hook: hook.name, level: hook.level },
        { cwd: path.dirname(hook.file), test: true },
      )
      if (!run) return yield* fail("Hooks are paused: turn Pause all off in Settings → Hooks to test")
      return {
        run: run.record,
        outcome: run.outcome,
        answer: run.answer as Record<string, unknown>,
        ...(run.cause ? { cause: run.cause } : {}),
      }
    })

    const scripts = Effect.fn("OperatorHookManage.scripts")(function* (namespace?: string) {
      const scope = yield* hooks.scopeOf(namespace)
      if (!scope.folder) return []
      const folder = scope.folder
      return yield* Effect.promise(async () =>
        (await fs.readdir(folder, { withFileTypes: true }).catch(() => []))
          .filter((item) => item.isFile())
          .map((item) => path.join(folder, item.name))
          .toSorted(),
      )
    })

    const readScript = Effect.fn("OperatorHookManage.readScript")(function* (input: {
      namespace?: string
      path: string
    }) {
      const scope = yield* hooks.scopeOf(input.namespace)
      const file = path.resolve(input.path)
      const editable = !!scope.folder && inside(scope.folder, file)
      // Readable: a script of the scope's folder, or one a hook in force runs.
      if (!editable) {
        const view = yield* hooks.effective(undefined, input.namespace)
        if (!view.hooks.some((item) => path.resolve(item.command) === file))
          return yield* fail(`${file} isn't a hook's script`)
      }
      const text = yield* Effect.promise(() => fs.readFile(file, "utf8").catch(() => undefined))
      if (text === undefined) return yield* fail(`${file} can't be read`)
      return { path: file, text, editable }
    })

    const writeScript = Effect.fn("OperatorHookManage.writeScript")(function* (input: {
      namespace?: string
      path: string
      text: string
    }) {
      const scope = yield* hooks.scopeOf(input.namespace)
      const file = path.resolve(input.path)
      if (!scope.folder || !inside(scope.folder, file))
        return yield* fail(`Only scripts in ${scope.folder ?? "this level's hooks/ folder"} can be edited here`)
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, input.text)
      })
    })

    const newScript = Effect.fn("OperatorHookManage.newScript")(function* (input: {
      namespace?: string
      name: string
      language: OperatorHookTemplates.Language
      event: OperatorHookEvents.Name
    }) {
      const scope = yield* hooks.scopeOf(input.namespace)
      if (!scope.folder) return yield* fail("This level has no folder for scripts")
      const base = input.name.trim()
      if (!NAME.test(base)) return yield* fail("A script's name is letters, digits, dots, dashes and underscores")
      const extension = OperatorHookTemplates.EXTENSIONS[input.language]
      const name = base.endsWith(extension) ? base : base + extension
      const file = path.join(scope.folder, name)
      const exists = yield* Effect.promise(() =>
        fs.stat(file).then(
          () => true,
          () => false,
        ),
      )
      if (exists) return yield* fail(`${name} exists already in ${scope.folder}`)
      const folder = scope.folder
      yield* Effect.promise(async () => {
        await fs.mkdir(folder, { recursive: true })
        await fs.writeFile(file, OperatorHookTemplates.script(input.event, input.language), { mode: 0o755 })
      })
      // Relative to the config file's folder, as a hook's command resolves.
      return { path: file, command: path.relative(path.dirname(scope.file ?? folder), file) }
    })

    return Service.of({ save, setState, remove, test, scripts, readScript, writeScript, newScript })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [OperatorHooks.node, OperatorConfig.node] })
