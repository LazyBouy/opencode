export * as OperatorHelperTexts from "./helper-texts"

import fs from "fs/promises"
import path from "path"
import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { OperatorGenerate } from "./generate"
import { OperatorProfile } from "./profile"
import { OperatorProfileStore } from "./profile-store"
import { OperatorProjects } from "./projects"
import { OperatorRegistry } from "./registry"

// Texts the fork's helper agents write:
// - Your Dynamic layers: the dynamic generator writes each one's text from its prompt, the project
//   and the session's first message, once per session (subagents' sessions use their root session's
//   text). The text is kept with the session and written again when the prompt changes.
// - Purpose drafts: the purpose generator drafts an org or project purpose from the project's files
//   (or the namespace's projects) and an optional brief, for the user to edit before saving.

export interface Interface {
  /** The texts of your Dynamic layers (by id) for a request of a session of this project. */
  readonly dynamic: (input: {
    sessionID?: string
    layers: ReadonlyArray<string>
  }) => Effect.Effect<Record<string, string>>
  /** What one of your Dynamic layers would write for this project now, without a session. */
  readonly sample: (layer: OperatorProfile.Layer) => Effect.Effect<string, OperatorGenerate.GenerateError>
  /** A draft org purpose (of `ns`, else the project's namespace) or project purpose. */
  readonly purpose: (input: {
    kind: "org" | "project"
    ns?: string
    brief?: string
  }) => Effect.Effect<string, OperatorGenerate.GenerateError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorHelperTexts") {}

// Files that say what a project is, and how much of each the helpers read.
const PROJECT_FILES = ["README.md", "readme.md", "AGENTS.md", "package.json", "pyproject.toml", "Cargo.toml", "go.mod"]
const FILE_LIMIT = 3000

const cacheFile = (session: string) => path.join(Global.Path.data, "operator", "dynamic", `${session}.json`)
const hashOf = (text: string) => Bun.hash(text).toString(36)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const generate = yield* OperatorGenerate.Service
    const sessions = yield* Session.Service

    // The project of this instance: its folder, name, prompt settings and the files that describe it.
    const project = Effect.fnUntraced(function* () {
      const ctx = yield* InstanceState.context
      const key = yield* Effect.promise(() => OperatorProjects.keyOf(ctx))
      const loaded = yield* Effect.promise(() => OperatorProfileStore.forProject(key))
      const files = yield* Effect.promise(() => readFiles(key))
      const purpose = loaded.project?.purpose
        ? loaded.catalog.layers.find((item) => item.id === loaded.project!.purpose)?.text
        : undefined
      return { key, name: path.basename(key), loaded, files, purpose }
    })

    const describe = (found: {
      key: string
      name: string
      loaded: { catalog: OperatorProfile.Catalog }
      files: ReadonlyArray<{ name: string; text: string }>
      purpose?: string
    }) =>
      [
        `<project name="${found.name}" folder="${found.key}">`,
        ...(found.loaded.catalog.namespace.purpose
          ? [`<org-purpose>\n${found.loaded.catalog.namespace.purpose}\n</org-purpose>`]
          : []),
        ...(found.purpose ? [`<project-purpose>\n${found.purpose}\n</project-purpose>`] : []),
        ...found.files.map((file) => `<file path="${file.name}">\n${file.text}\n</file>`),
        "</project>",
      ].join("\n")

    // The session a session descends from (subagents' sessions share their root's texts).
    const rootOf = Effect.fnUntraced(function* (sessionID: string) {
      let current = sessionID
      for (let depth = 0; depth < 20; depth++) {
        const found = yield* sessions.get(SessionID.make(current)).pipe(Effect.option)
        if (found._tag === "None" || !found.value.parentID) return current
        current = found.value.parentID
      }
      return current
    })

    const firstMessage = Effect.fnUntraced(function* (sessionID: string) {
      const messages = yield* sessions
        .messages({ sessionID: SessionID.make(sessionID) })
        .pipe(Effect.catch(() => Effect.succeed([])))
      const first = messages.find((message) => message.info.role === "user")
      return (first?.parts ?? [])
        .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))
        .join("\n")
        .slice(0, FILE_LIMIT)
    })

    const write = (layer: OperatorProfile.Layer, context: string, message: string | undefined, sessionID?: string) =>
      generate.text({
        agent: OperatorProfile.DYNAMIC_GENERATOR,
        sessionID,
        prompt: [
          `<instructions>\n${layer.prompt ?? ""}\n</instructions>`,
          context,
          ...(message ? [`<session>\n<first-message>\n${message}\n</first-message>\n</session>`] : []),
        ].join("\n"),
      })

    const dynamic = Effect.fn("OperatorHelperTexts.dynamic")(function* (input: {
      sessionID?: string
      layers: ReadonlyArray<string>
    }) {
      const found = yield* project()
      const layers = input.layers
        .map((id) => OperatorProfile.findLayer(found.loaded.catalog, id))
        .filter((item): item is OperatorProfile.Layer => OperatorProfile.isWrittenDynamic(item))
      if (!layers.length) return {}
      const root = input.sessionID ? yield* rootOf(input.sessionID) : undefined
      const cached: Record<string, { hash: string; text: string }> = root
        ? yield* Effect.promise(() =>
            Bun.file(cacheFile(root))
              .json()
              .catch(() => ({})),
          )
        : {}
      const message = root ? yield* firstMessage(root) : undefined
      const context = describe(found)
      const texts: Record<string, string> = {}
      let changed = false
      for (const item of layers) {
        const hash = hashOf(item.prompt ?? "")
        const known = cached[item.id]
        if (known && known.hash === hash) {
          texts[item.id] = known.text
          continue
        }
        const text = yield* write(item, context, message, root).pipe(
          Effect.tapError((error) => Effect.logWarning("dynamic layer not written", { layer: item.id, error })),
          Effect.option,
        )
        if (text._tag === "None") continue
        texts[item.id] = text.value
        cached[item.id] = { hash, text: text.value }
        changed = true
      }
      if (root && changed)
        yield* Effect.promise(async () => {
          await fs.mkdir(path.dirname(cacheFile(root)), { recursive: true })
          await Bun.write(cacheFile(root), JSON.stringify(cached, null, 2))
        })
      return texts
    })

    const sample = Effect.fn("OperatorHelperTexts.sample")(function* (layer: OperatorProfile.Layer) {
      const found = yield* project()
      return yield* write(layer, describe(found), undefined)
    })

    const purpose = Effect.fn("OperatorHelperTexts.purpose")(function* (input: {
      kind: "org" | "project"
      ns?: string
      brief?: string
    }) {
      const found = yield* project()
      const brief = input.brief?.trim() ? `<brief>\n${input.brief.trim()}\n</brief>` : ""
      if (input.kind === "project")
        return yield* generate.text({
          agent: OperatorProfile.PURPOSE_GENERATOR,
          prompt: ["Write the purpose of this project.", brief, describe(found)].filter(Boolean).join("\n"),
        })
      const catalog =
        (input.ns ? yield* Effect.promise(() => OperatorProfileStore.readNamespace(input.ns!)) : undefined) ??
        found.loaded.catalog
      const settings = yield* Effect.promise(OperatorProfileStore.readProjects)
      const members = Object.entries(settings)
        .filter((pair) => pair[1].namespace === catalog.namespace.id)
        .map((pair) => {
          const linked = pair[1].purpose ? catalog.layers.find((item) => item.id === pair[1].purpose) : undefined
          return `<project name="${path.basename(pair[0])}">${linked ? `\n${linked.text}\n` : ""}</project>`
        })
      return yield* generate.text({
        agent: OperatorProfile.PURPOSE_GENERATOR,
        prompt: [
          `Write the purpose of the organisation "${catalog.namespace.name}".`,
          brief,
          members.length ? `<projects>\n${members.join("\n")}\n</projects>` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      })
    })

    // The prompt plugin writes your Dynamic layers through this, in the request's project.
    const register: NonNullable<typeof OperatorRegistry.helperTexts.dynamic> = (input) =>
      Effect.runPromise(dynamic(input).pipe(Effect.provideService(InstanceRef, input.instance as InstanceContext)))
    OperatorRegistry.helperTexts.dynamic = register
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (OperatorRegistry.helperTexts.dynamic === register) OperatorRegistry.helperTexts.dynamic = undefined
      }),
    )

    return Service.of({ dynamic, sample, purpose })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [OperatorGenerate.node, Session.node],
})

async function readFiles(folder: string) {
  const found = await Promise.all(
    PROJECT_FILES.map(async (name) => {
      const text = await Bun.file(path.join(folder, name))
        .text()
        .catch(() => undefined)
      return text?.trim() ? [{ name, text: text.slice(0, FILE_LIMIT) }] : []
    }),
  )
  // README.md and readme.md are the same file on case-insensitive disks.
  return found.flat().filter((file, index, all) => all.findIndex((item) => item.text === file.text) === index)
}
