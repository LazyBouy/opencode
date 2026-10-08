import fs from "fs/promises"
import path from "path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { OperatorProfile } from "@/operator/profile"
import { OperatorProfileStore } from "@/operator/profile-store"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(OperatorProfileStore.node))
const P = OperatorProfile.PREFIX
const model = { providerID: "test", api: { id: "test-model" } }
const parts = { environment: ["<env/>"], instructions: [] }

// A folder for a new namespace, inside the test project.
const folderFor = (name: string) =>
  TestInstance.pipe(Effect.map((instance) => path.join(instance.directory, "namespaces", name.toLowerCase())))

// Points the global config folder inside the test project for the duration of a test.
const withGlobal = <A, E, R>(body: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const dir = path.join((yield* TestInstance).directory, "global-config")
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = { config: Global.Path.config, roots: process.env.OPENCODE_WORKSPACE_ROOTS }
        ;(Global.Path as { config: string }).config = dir
        // Namespace folders must be inside the workspace roots: the test project is one.
        process.env.OPENCODE_WORKSPACE_ROOTS = path.dirname(dir)
        return previous
      }),
      () => body(dir),
      (previous) =>
        Effect.sync(() => {
          ;(Global.Path as { config: string }).config = previous.config
          if (previous.roots === undefined) delete process.env.OPENCODE_WORKSPACE_ROOTS
          else process.env.OPENCODE_WORKSPACE_ROOTS = previous.roots
        }),
    )
  })

const refused = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => (error as { message: string }).message),
  )

// A small set of items in OpenCode: a custom type, layers, a group and a profile using them.
const seed = Effect.fnUntraced(function* () {
  const store = yield* OperatorProfileStore.Service
  const rules = yield* store.saveType("opencode", undefined, { name: "House rules", description: "Team rules" })
  const rule = yield* store.saveLayer("opencode", undefined, { name: "Be kind", type: rules.id, text: "Be kind." })
  const role = yield* store.saveLayer("opencode", undefined, {
    name: "Reviewer",
    type: "role",
    section: "role",
    text: "You review.",
  })
  const group = yield* store.saveGroup("opencode", undefined, {
    name: "With rules",
    types: ["purpose", rules.id, "role", "identity", "dynamic"],
  })
  const profile = yield* store.saveProfile("opencode", undefined, {
    name: "Reviewing",
    group: group.id,
    slots: { [rules.id]: [rule.id], role: [role.id], dynamic: [`${P}slot.agent-or-base`] },
  })
  return { store, rules, rule, role, group, profile }
})

it.instance("the OpenCode namespace exists from the start, and new items are written as files", () =>
  withGlobal((global) =>
    Effect.gen(function* () {
      const items = yield* seed()
      const catalog = yield* items.store.catalog("opencode")
      expect(catalog.namespace).toMatchObject({ id: "opencode", name: "OpenCode", purpose: "" })
      expect(catalog.profiles.map((item) => item.id)).toContain(items.profile.id)
      expect(catalog.profiles.filter((item) => item.builtin)).toHaveLength(OperatorProfile.BUILTIN_PROFILES.length)
      expect(catalog.types.filter((item) => item.builtin)).toHaveLength(OperatorProfile.BUILTIN_TYPES.length)
      const file = path.join(global, "namespaces", "opencode", "layers", `${items.role.id}.md`)
      expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toContain("type: role")
    }),
  ),
)

it.instance("an editable copy keeps the built-in's type and text, and a profile holds one copy of each", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const store = yield* OperatorProfileStore.Service
      const copy = yield* store.copyBuiltin("opencode", `${P}base.gemini`)
      expect(copy).toMatchObject({
        type: "identity",
        section: "base",
        replaces: `${P}base.gemini`,
        name: "base.gemini – copy",
      })
      expect(copy.text.length).toBeGreaterThan(100)
      const tool = yield* store.copyBuiltin("opencode", `${P}tool.bash`, "Run commands.")
      expect(tool).toMatchObject({ type: "capabilities", section: "tool", text: "Run commands." })
      const second = yield* store.copyBuiltin("opencode", `${P}base.gemini`)
      expect(
        yield* refused(
          store.saveProfile("opencode", undefined, {
            name: "Twice",
            group: `${P}group.spec`,
            slots: { identity: [copy.id, second.id] },
          }),
        ),
      ).toContain("one copy of base.gemini")
      expect(yield* refused(store.copyBuiltin("opencode", `${P}slot.base`))).toContain("not one of OpenCode's texts")
    }),
  ),
)

it.instance("a new namespace gets its own copies of OpenCode's built-ins and of OpenCode's own items", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const items = yield* seed()
      yield* items.store.updateNamespace("opencode", { defaultProfile: items.profile.id })
      const team = yield* items.store.createNamespace({
        name: "Team",
        folder: yield* folderFor("Team"),
        purpose: "We build editors.",
      })
      const catalog = yield* items.store.catalog(team.id)
      expect(catalog.namespace).toMatchObject({
        name: "Team",
        purpose: "We build editors.",
        defaultProfile: items.profile.id,
      })
      // Built-ins belong to OpenCode: the namespace has its own copies, as "<id>" for "opencode:<id>".
      expect(catalog.profiles.some((item) => item.builtin)).toBe(false)
      expect(catalog.groups.some((item) => item.builtin)).toBe(false)
      expect(catalog.layers.some((item) => item.origin !== "user")).toBe(false)
      expect(catalog.profiles.map((item) => item.id).toSorted()).toEqual(
        [...OperatorProfile.BUILTIN_PROFILES.map((item) => OperatorProfile.own(item.id)), items.profile.id].toSorted(),
      )
      expect(catalog.layers.find((item) => item.id === "base.default")).toMatchObject({
        replaces: `${P}base.default`,
        origin: "user",
      })
      expect(catalog.profiles.find((item) => item.id === "profile.opencode")?.slots.dynamic?.[0]).toBe(
        "slot.agent-or-base",
      )
      expect(
        catalog.layers
          .filter((item) => !item.replaces)
          .map((item) => item.id)
          .toSorted(),
      ).toEqual([items.rule.id, items.role.id].toSorted())
      expect(catalog.types.filter((item) => !item.builtin).map((item) => item.id)).toEqual([items.rules.id])
      expect(catalog.projects).toEqual([])
      // Changing the copy leaves OpenCode's item alone.
      yield* items.store.saveLayer(team.id, items.role.id, { name: "Reviewer", type: "role", text: "Team review." })
      expect((yield* items.store.catalog("opencode")).layers.find((item) => item.id === items.role.id)?.text).toBe(
        "You review.",
      )
    }),
  ),
)

it.instance("Copy to namespace brings what is missing and renames a clash", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const items = yield* seed()
      const empty = yield* items.store.createNamespace({ name: "Empty", folder: yield* folderFor("Empty") })
      // Empty starts as a copy; remove its items so the copy has to bring them.
      for (const kind of ["profile", "group", "layer", "layer", "type"] as const) {
        const ids = {
          profile: [items.profile.id],
          group: [items.group.id],
          layer: [items.rule.id, items.role.id],
          type: [items.rules.id],
        }[kind]
        for (const id of ids) yield* items.store.remove(empty.id, kind, id).pipe(Effect.ignore)
      }
      const copied = yield* items.store.copyTo("opencode", "profile", items.profile.id, empty.id)
      expect(copied.map((item) => item.kind).toSorted()).toEqual(["group", "layer", "layer", "profile", "type"])
      const again = yield* items.store.copyTo("opencode", "profile", items.profile.id, empty.id)
      expect(again).toEqual([{ kind: "profile", id: `${items.profile.id}-2`, name: "Reviewing (copy)" }])
    }),
  ),
)

it.instance("moving a project copies what it uses and keeps its prompt the same", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const items = yield* seed()
      const key = "/work/app"
      const purpose = yield* items.store.saveLayer("opencode", undefined, {
        name: "App goal",
        type: "purpose",
        section: "purpose",
        text: "Ship the app.",
      })
      yield* items.store.setProject(key, { purpose: purpose.id, defaultProfile: items.profile.id })
      yield* items.store.setAgent(key, "build", { override: { slots: { role: [] } } })
      const before = yield* Effect.promise(() => OperatorProfileStore.forProject(key))
      const prompt = (loaded: typeof before) =>
        OperatorProfile.assemble({
          catalog: loaded.catalog,
          project: loaded.project,
          agent: { name: "build" },
          setting: loaded.agents.build,
          model,
          parts,
        }).system

      const target = yield* items.store.createNamespace({ name: "Moved", folder: yield* folderFor("Moved") })
      // The new namespace starts as a copy; take out what the move has to bring.
      yield* items.store.remove(target.id, "profile", items.profile.id)
      yield* items.store.remove(target.id, "layer", purpose.id)
      const plan = yield* items.store.setProject(key, { namespace: target.id, dryRun: true })
      expect(plan.copied.map((item) => item.name)).toEqual(["App goal", "Reviewing"])
      expect((yield* items.store.projects()).find((item) => item.key === key)?.namespace).toBe("opencode")

      const moved = yield* items.store.setProject(key, { namespace: target.id })
      expect(moved.project).toMatchObject({
        namespace: target.id,
        purpose: purpose.id,
        defaultProfile: items.profile.id,
      })
      const after = yield* Effect.promise(() => OperatorProfileStore.forProject(key))
      expect(after.catalog.namespace.id).toBe(target.id)
      expect(prompt(after)).toEqual(prompt(before))
    }),
  ),
)

it.instance("copying a project gives the new one its prompt settings; another namespace gets copies", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const items = yield* seed()
      const source = "/work/app"
      const purpose = yield* items.store.saveLayer("opencode", undefined, {
        name: "App goal",
        type: "purpose",
        section: "purpose",
        text: "Ship the app.",
      })
      yield* items.store.setProject(source, { purpose: purpose.id, defaultProfile: items.profile.id })
      yield* items.store.setAgent(source, "build", { profile: items.profile.id })

      // Same namespace: the profiles are shared, so the links are the same ids.
      const same = yield* items.store.copyProject(source, "/work/copy", {})
      expect(same.copied).toEqual([])
      expect(same.project).toMatchObject({
        namespace: "opencode",
        purpose: purpose.id,
        defaultProfile: items.profile.id,
      })
      expect((yield* items.store.agent("/work/copy", "build")).profile).toBe(items.profile.id)

      // Another namespace: what the project uses is copied there and the links point at the copies.
      const target = yield* items.store.createNamespace({ name: "Other", folder: yield* folderFor("Other") })
      yield* items.store.remove(target.id, "profile", items.profile.id)
      yield* items.store.remove(target.id, "layer", purpose.id)
      const other = yield* items.store.copyProject(source, "/work/other", { namespace: target.id })
      expect(other.copied.map((item) => item.name)).toEqual(["App goal", "Reviewing"])
      expect(other.project.namespace).toBe(target.id)
      const loaded = yield* Effect.promise(() => OperatorProfileStore.forProject("/work/other"))
      expect(loaded.catalog.profiles.some((profile) => profile.id === other.project.defaultProfile)).toBe(true)
      expect(loaded.agents.build?.profile).toBe(other.project.defaultProfile)

      // The source is unchanged.
      const unchanged = (yield* items.store.projects()).find((item) => item.key === source)
      expect(unchanged).toMatchObject({ namespace: "opencode", purpose: purpose.id, defaultProfile: items.profile.id })
    }),
  ),
)

it.instance("items in use cannot be deleted, and the error says by what", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const items = yield* seed()
      const key = "/work/app"
      yield* items.store.setAgent(key, "build", { profile: items.profile.id })
      expect(yield* refused(items.store.remove("opencode", "type", items.rules.id))).toContain('layer "Be kind"')
      expect(yield* refused(items.store.remove("opencode", "layer", items.role.id))).toContain('profile "Reviewing"')
      expect(yield* refused(items.store.remove("opencode", "group", items.group.id))).toContain('profile "Reviewing"')
      expect(yield* refused(items.store.remove("opencode", "profile", items.profile.id))).toContain("build in app")
      expect(yield* refused(items.store.remove("opencode", "profile", `${P}profile.opencode`))).toContain(
        "OpenCode's own",
      )
      expect(yield* refused(items.store.removeNamespace("opencode"))).toContain("cannot be deleted")

      const team = yield* items.store.createNamespace({ name: "Team", folder: yield* folderFor("Team") })
      yield* items.store.setProject(key, { namespace: team.id })
      expect(yield* refused(items.store.removeNamespace(team.id))).toContain("still has projects")
      yield* items.store.setProject(key, { namespace: "opencode" })
      yield* items.store.removeNamespace(team.id)
      expect((yield* items.store.namespaces()).map((item) => item.namespace.id)).toEqual(["opencode"])
    }),
  ),
)

it.instance("the same agent name in two projects is two agents", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const items = yield* seed()
      yield* items.store.setAgent("/work/a", "build", { profile: items.profile.id })
      yield* items.store.setAgent("/work/b", "build", { profile: `${P}profile.spec` })
      expect(yield* items.store.agent("/work/a", "build")).toEqual({ profile: items.profile.id })
      expect(yield* items.store.agent("/work/b", "build")).toEqual({ profile: `${P}profile.spec` })
      expect(
        yield* refused(
          items.store.setAgent("/work/a", "build", { override: { slots: { identity: [items.role.id] } } }),
        ),
      ).toContain("not Agent identity")
      yield* items.store.setAgent("/work/a", "build", {})
      expect(yield* items.store.agent("/work/a", "build")).toEqual({})
    }),
  ),
)

it.instance("a Dynamic layer of yours holds a prompt, kept in its file", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const store = yield* OperatorProfileStore.Service
      const refused = yield* store
        .saveLayer("opencode", undefined, { name: "Empty", type: "dynamic", text: "ignored" })
        .pipe(Effect.flip)
      expect(refused.message).toContain("needs a prompt")
      const saved = yield* store.saveLayer("opencode", undefined, {
        name: "Release date",
        type: "dynamic",
        text: "ignored",
        prompt: "Say when the release is.",
      })
      expect(saved).toMatchObject({ section: "dynamic", text: "", prompt: "Say when the release is." })
      const catalog = yield* store.catalog("opencode")
      expect(catalog.layers.find((item) => item.id === saved.id)).toMatchObject({
        type: "dynamic",
        text: "",
        prompt: "Say when the release is.",
      })
    }),
  ),
)

it.instance("a namespace made before gets its own copies once, its settings pointed at them", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const store = yield* OperatorProfileStore.Service
      const dir = path.join(OperatorProfileStore.root(), "older")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(dir, "profiles"), { recursive: true })
        await fs.writeFile(
          path.join(dir, "namespace.json"),
          JSON.stringify({
            id: "older",
            name: "Older",
            purpose: "",
            defaultProfile: `${P}profile.spec`,
            createdAt: 1,
            updatedAt: 1,
          }),
        )
        await fs.writeFile(
          path.join(dir, "profiles", "mine.json"),
          JSON.stringify({
            id: "mine",
            name: "Mine",
            group: `${P}group.spec`,
            slots: { dynamic: [`${P}slot.base`, `${P}generated.skills`] },
          }),
        )
      })
      const catalog = yield* store.catalog("older")
      expect(catalog.namespace.defaultProfile).toBe("profile.spec")
      expect(catalog.profiles.find((item) => item.id === "mine")).toMatchObject({
        group: "group.spec",
        slots: { dynamic: ["slot.base", "generated.skills"] },
      })
      // A copy it deletes is not made again.
      yield* store.remove("older", "layer", "notice.max-steps")
      expect((yield* store.catalog("older")).layers.map((item) => item.id)).not.toContain("notice.max-steps")
    }),
  ),
)

it.instance("copies of a built-in OpenCode no longer has: its own copy is not read, an edited copy stays a layer", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const store = yield* OperatorProfileStore.Service
      const team = yield* store.createNamespace({ name: "Team", folder: yield* folderFor("Team") })
      const layers = path.join(OperatorProfileStore.root(), team.id, "layers")
      const copy = (id: string, name: string) =>
        `---\nid: ${id}\nname: ${name}\ntype: identity\nsection: agent\nreplaces: ${P}agent.gone\norigin: user\n---\nOld text.\n`
      yield* Effect.promise(async () => {
        await fs.writeFile(path.join(layers, "agent.gone.md"), copy("agent.gone", "agent.gone"))
        await fs.writeFile(path.join(layers, "gone-copy.md"), copy("gone-copy", "gone – copy"))
      })
      const found = (yield* store.catalog(team.id)).layers
      expect(found.some((item) => item.id === "agent.gone")).toBe(false)
      expect(found.find((item) => item.id === "gone-copy")).toMatchObject({ text: "Old text.", section: "custom" })
      expect(found.find((item) => item.id === "gone-copy")?.replaces).toBeUndefined()
    }),
  ),
)

it.instance("a copy of OpenCode's text whose original changed is marked, and takes the new text", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const store = yield* OperatorProfileStore.Service
      const team = yield* store.createNamespace({ name: "Team", folder: yield* folderFor("Team") })
      const file = path.join(OperatorProfileStore.root(), team.id, "layers", "base.default.md")
      // As if OpenCode's text changed since the copy was made: its fingerprint no longer matches.
      yield* Effect.promise(async () =>
        fs.writeFile(file, (await fs.readFile(file, "utf8")).replace(/basedOn: .*/, "basedOn: old")),
      )
      expect((yield* store.catalog(team.id)).layers.find((item) => item.id === "base.default")?.outdated).toBe(true)
      const synced = yield* store.syncLayer(team.id, "base.default")
      expect(synced.text).toBe(OperatorProfile.BUILTIN_LAYERS.find((item) => item.id === `${P}base.default`)!.text)
      expect(
        (yield* store.catalog(team.id)).layers.find((item) => item.id === "base.default")?.outdated,
      ).toBeUndefined()
    }),
  ),
)

it.instance("a namespace has a folder inside the workspace, created if missing", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const store = yield* OperatorProfileStore.Service
      const folder = yield* folderFor("Acme")
      expect(yield* refused(store.createNamespace({ name: "Acme", folder: "" }))).toBe("A namespace needs a folder")
      expect(yield* refused(store.createNamespace({ name: "Acme", folder: "acme" }))).toContain("absolute path")
      expect(yield* refused(store.createNamespace({ name: "Acme", folder: "/elsewhere/acme" }))).toContain(
        "outside the workspace",
      )
      const acme = yield* store.createNamespace({ name: "Acme", folder })
      expect(acme.folder).toBe(folder)
      expect((yield* Effect.promise(() => fs.stat(folder))).isDirectory()).toBe(true)
      const moved = yield* store.updateNamespace(acme.id, { folder: `${folder}-2` })
      expect(moved.folder).toBe(`${folder}-2`)
      expect(yield* refused(store.updateNamespace(acme.id, { folder: "/elsewhere" }))).toContain(
        "outside the workspace",
      )
    }),
  ),
)

it.instance("a namespace's default project is the chosen one while it is there, else its first project", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const store = yield* OperatorProfileStore.Service
      const team = yield* store.createNamespace({ name: "Team", folder: yield* folderFor("Team") })
      const summary = () =>
        store.namespaces().pipe(Effect.map((list) => list.find((item) => item.namespace.id === team.id)))
      expect((yield* summary())?.defaultProject).toBeUndefined()
      // Folders outside git count in the order they were added.
      yield* store.setProject("/work/zeta", { namespace: team.id })
      yield* store.setProject("/work/alpha", { namespace: team.id })
      expect((yield* summary())?.defaultProject).toBe("/work/zeta")
      expect(yield* store.defaultProject(team.id)).toBe("/work/zeta")
      expect(yield* refused(store.updateNamespace(team.id, { defaultProject: "/work/other" }))).toContain(
        "is not a project of Team",
      )
      yield* store.updateNamespace(team.id, { defaultProject: "/work/alpha" })
      expect(yield* summary()).toMatchObject({ defaultProject: "/work/alpha", firstProject: "/work/zeta" })
      // The chosen project leaves the namespace: the first one is the default again.
      yield* store.setProject("/work/alpha", { namespace: "opencode" })
      expect((yield* summary())?.defaultProject).toBe("/work/zeta")
      yield* store.setProject("/work/alpha", { namespace: team.id })
      expect((yield* summary())?.defaultProject).toBe("/work/alpha")
      yield* store.updateNamespace(team.id, { defaultProject: "" })
      expect((yield* summary())?.defaultProject).toBe("/work/zeta")
    }),
  ),
)

it.instance("OpenCode's folder and default project come from the server's environment on first start", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const env = {
        OPENCODE_OPERATOR_NAMESPACE_FOLDER: "/work",
        OPENCODE_OPERATOR_DEFAULT_PROJECT: "/work/opencode",
      }
      yield* Effect.promise(() => OperatorProfileStore.ensure(env))
      const store = yield* OperatorProfileStore.Service
      const opencode = (yield* store.namespaces())[0]!
      expect(opencode.namespace).toMatchObject({ id: "opencode", folder: "/work", defaultProject: "/work/opencode" })
      // Set once: a later change is kept.
      yield* store.updateNamespace("opencode", { defaultProject: "" })
      yield* Effect.promise(() => OperatorProfileStore.ensure(env))
      expect((yield* store.namespaces())[0]!.namespace.defaultProject).toBeUndefined()
    }),
  ),
)
