export * as OperatorDynamicLayers from "./dynamic-layers"

import { stat } from "fs/promises"
import path from "path"
import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Flag } from "@opencode-ai/core/flag/flag"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Reference } from "@opencode-ai/core/reference"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import type { InstanceContext } from "@/project/instance-context"
import { MCP as McpService } from "@/mcp"
import { Permission } from "@/permission"
import type { Provider } from "@/provider/provider"
import { Skill } from "@/skill"
import { OperatorFileCache } from "./file-cache"
import { OperatorHelperTexts } from "./helper-texts"
import { OperatorInstructionScope } from "./instruction-scope"
import { OperatorMemoryFolders } from "./memory-folders"
import { OperatorMemoryFormat } from "./memory-format"
import { OperatorMemoryService } from "./memory-service"
import { OperatorMemoryStore } from "./memory-store"
import { OperatorPermissionEffective } from "./permission-effective"
import type { OperatorProfile } from "./profile"
import { OperatorRegistry } from "./registry"
import { OperatorResolver } from "./resolver"
import { OperatorResolutions } from "./resolutions"
import { OperatorResolverBuiltins as B } from "./resolver-builtins"

// Reads the sources of OpenCode's per-request Dynamic layers and resolves them through the pipeline
// (resolver.ts, resolver-builtins.ts): Environment, References, Instructions, MCP instructions, Skills.
// The reads mirror upstream's (session/system.ts, session/instruction.ts) so the texts are the same;
// each candidate it found or didn't is in the trace. Layers with rules of their own (yours; a copy of
// one of OpenCode's with edited rules) are read source by source (`readSource`): files and globs, config
// values, URLs, live values, the registries, the agent's fields, texts and the helper. The prompt plugin
// (through OperatorRegistry) and the agent page's preview both use it.

export type Resolution = { readonly text: string; readonly trace: OperatorResolver.Trace }
export type Resolved = ReadonlyMap<string, Resolution>

// A layer resolved by its own rules: yours (a helper source writes from its prompt), or a copy of one of
// OpenCode's per-request layers with edited rules.
export type Custom = { readonly layer: OperatorProfile.Layer; readonly resolver: OperatorResolver.Resolver }

export type Input = {
  readonly agent: Agent.Info
  readonly model: Provider.Model
  /** Layers with rules of their own, resolved by their id. */
  readonly custom?: ReadonlyArray<Custom>
  /** The request's session: its effective permissions decide the skills and MCP servers listed. */
  readonly sessionID?: string
  /** The session's own rules (MCP instructions follow them, as upstream's do). */
  readonly sessionPermission?: PermissionV1.Ruleset
  /** Upstream's instruction texts for this request: URLs are not fetched again. */
  readonly instructions?: ReadonlyArray<string>
  /** Only these of OpenCode's layers (default: all of them). */
  readonly layers?: ReadonlyArray<string>
  /** Helper sources: written (the default), or a placeholder (the agent page's preview calls no model). */
  readonly helper?: "write" | "placeholder"
  /** The memory layers too (the agent's profile holds one): each level's index, by its READ decision. */
  readonly memory?: boolean
}

export interface Interface {
  readonly resolve: (input: Input) => Effect.Effect<Map<string, Resolution>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorDynamicLayers") {}

const ALL = [B.ENVIRONMENT, B.REFERENCES, B.INSTRUCTIONS, B.MCP, B.SKILLS]
const isURL = (value: string) => value.startsWith("https://") || value.startsWith("http://")
const GLOB = /[*?[\]{}]/
const URL_TIMEOUT = 5000

// A config value by its dotted key (`instructions`, `experimental.foo`).
const valueAt = (config: unknown, key: string) =>
  key
    .split(".")
    .reduce<unknown>((value, part) => (value && typeof value === "object" ? (value as any)[part] : undefined), config)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const skill = yield* Skill.Service
    const mcp = yield* McpService.Service
    const locations = yield* LocationServiceMap.Service
    const agents = yield* Agent.Service
    const helpers = yield* OperatorHelperTexts.Service
    const memory = yield* OperatorMemoryService.Service

    // A memory level's index lines as candidates (newest first by their files' times), read again only
    // when MEMORY.md changed: a save rewrites it, so the next call sees the memory and an unchanged index
    // gives the same text (the prompt stays cached).
    const indexes = new Map<string, { stamp: string; candidates: OperatorResolver.Candidate[] }>()
    const memoryCandidates = (folder: string) =>
      Effect.promise(async (): Promise<OperatorResolver.Candidate[]> => {
        const index = path.join(folder, OperatorMemoryFormat.INDEX)
        const stamp = await OperatorFileCache.stamp(index)
        const known = indexes.get(folder)
        if (known && known.stamp === stamp) return known.candidates
        const listed = await OperatorMemoryStore.list(folder)
        const candidates: OperatorResolver.Candidate[] = listed.exists
          ? await Promise.all(
              listed.entries.map(async (entry) => {
                const file = path.join(folder, entry.file)
                const info = await stat(file).catch(() => undefined)
                return {
                  source: 0,
                  location: file,
                  text: OperatorMemoryFormat.formatLine(entry),
                  attributes: { name: entry.title, file: entry.file, updated: info?.mtimeMs ?? 0 },
                }
              }),
            )
          : [{ source: 0, location: index, reason: "missing" }]
        if (indexes.size > 500) indexes.clear()
        indexes.set(folder, { stamp, candidates })
        return candidates
      })

    // The memory layers (memory_spec.md §4.1, §7): allow shows the index, ask one line saying it is
    // there, deny nothing; an incognito session has no agent memory.
    const memoryLayers = Effect.fnUntraced(function* (input: Input) {
      const found = yield* memory.context({
        ...(input.sessionID ? { sessionID: input.sessionID } : {}),
        agent: input.agent.name,
      })
      const limits = OperatorMemoryFolders.limitsOf(
        yield* Effect.promise(() => OperatorMemoryFolders.settings()),
        found.namespace,
      )
      const result = new Map<string, Resolution>()
      for (const [id, level] of Object.entries(B.MEMORY_LEVEL)) {
        const folder = found.folders[level]
        const resolver = B.memoryResolver(level, {
          folder: folder ?? "",
          lines: limits.indexLines,
          chars: limits.indexChars,
        })
        const decision = found.read[level]
        if (!folder || decision === "deny") {
          const off = !folder ? "this session runs incognito: no agent memory" : `READ(${level}/*) is denied`
          result.set(id, OperatorResolver.run(resolver, [], { off }))
          continue
        }
        const candidates = yield* memoryCandidates(folder)
        if (decision === "ask") {
          const any = candidates.some((item) => item.text)
          const notice: OperatorResolver.Resolver = {
            sources: [{ kind: "memory", location: level, name: `${level} memory` }],
            filter: [{ kind: "available", need: "text" }],
            score: [],
            select: { policy: "one" },
            template: { item: "{text}", separator: "\n" },
          }
          result.set(
            id,
            OperatorResolver.run(
              notice,
              any
                ? [
                    {
                      source: 0,
                      location: path.join(folder, OperatorMemoryFormat.INDEX),
                      text: B.memoryAvailable(level),
                      attributes: { name: `READ(${level}/*) asks: one line in place of the index` },
                    },
                  ]
                : [],
            ),
          )
          continue
        }
        result.set(id, OperatorResolver.run(resolver, candidates))
      }
      return result
    })

    // `~/.config/opencode/` is the global config folder (wherever it is), `~/` the home folder.
    const expand = (location: string) =>
      location.startsWith("~/.config/opencode/")
        ? path.join(global.config, location.slice("~/.config/opencode/".length))
        : location.startsWith("~/")
          ? path.join(global.home, location.slice(2))
          : location

    // The agent's rules as a request of this session applies them (permission-effective.ts), as upstream's
    // skills and MCP lists get them in the session loop.
    const effective = (agent: Agent.Info, sessionID?: string, session?: PermissionV1.Ruleset) => {
      const fallback = [...agent.permission, ...(session ?? [])]
      const handler = OperatorPermissionEffective.handlers.effective
      if (!handler) return Effect.succeed(fallback)
      return handler({
        ...(sessionID ? { sessionID } : {}),
        agent: agent.name,
        ...(session ? { session } : {}),
      }).pipe(
        Effect.map((found) => [...found.rules]),
        Effect.catchCause(() => Effect.succeed(fallback)),
      )
    }

    const read = (file: string) =>
      Effect.promise(() => OperatorFileCache.text(file)).pipe(Effect.map((text) => text ?? ""))

    const environment = Effect.fnUntraced(function* (model: Provider.Model) {
      const ctx = yield* InstanceState.context
      return B.environment({
        model: model.api.id,
        provider: model.providerID,
        directory: ctx.directory,
        worktree: ctx.worktree,
        git: ctx.project.vcs === "git",
        platform: process.platform,
        date: new Date().toDateString(),
      })
    })

    const references = Effect.fnUntraced(function* () {
      const ctx = yield* InstanceState.context
      const list = yield* Effect.gen(function* () {
        return yield* (yield* Reference.Service).list()
      }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))))
      return B.references(list.map((item) => ({ name: item.name, path: item.path, description: item.description })))
    })

    // As session/instruction.ts finds them (systemPaths, system).
    const instructions = Effect.fnUntraced(function* (fetched: ReadonlyArray<string> | undefined) {
      const ctx = yield* InstanceState.context
      // Only the OpenCode namespace's projects (and Global's) read instruction files, as upstream's seam says.
      if (!(yield* OperatorInstructionScope.here())) return undefined
      const config = yield* cfg.get()
      const names = B.INSTRUCTION_NAMES.filter((name) => name !== "CLAUDE.md" || !flags.disableClaudeCodePrompt)
      const globalFiles = [
        { name: "AGENTS.md" as const, path: path.resolve(path.join(global.config, "AGENTS.md")) },
        ...(!flags.disableClaudeCodePrompt
          ? [{ name: "CLAUDE.md" as const, path: path.resolve(path.join(global.home, ".claude", "CLAUDE.md")) }]
          : []),
      ]
      const globalFound = yield* Effect.forEach(globalFiles, (item) =>
        fs.existsSafe(item.path).pipe(
          Effect.flatMap((exists) => (exists ? read(item.path) : Effect.succeed(undefined))),
          Effect.map((text) => ({ ...item, ...(text === undefined ? {} : { text }) })),
        ),
      )
      const project = Flag.OPENCODE_DISABLE_PROJECT_CONFIG
        ? []
        : (yield* Effect.forEach(names, (name) =>
            fs.findUp(name, ctx.directory, ctx.worktree).pipe(
              Effect.catch(() => Effect.succeed([] as string[])),
              Effect.flatMap((matches) =>
                Effect.forEach(matches, (match) =>
                  read(path.resolve(match)).pipe(Effect.map((text) => ({ name, path: path.resolve(match), text }))),
                ),
              ),
            ),
          )).flat()
      return B.instructions({ global: globalFound, project, config: yield* configInstructions(fetched) })
    })

    // Config's `instructions`: its files (globs from the folder up), then its URLs, as upstream reads them.
    const configInstructions = Effect.fnUntraced(function* (fetched: ReadonlyArray<string> | undefined) {
      const ctx = yield* InstanceState.context
      const config = yield* cfg.get()
      const relative = (instruction: string) =>
        (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG
          ? fs.globUp(instruction, ctx.directory, ctx.worktree)
          : fs.globUp(instruction, global.config, global.config)
        ).pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const configured = config.instructions ?? []
      const files = yield* Effect.forEach(
        configured.filter((raw) => !isURL(raw)),
        (raw) => {
          const instruction = raw.startsWith("~/") ? path.join(global.home, raw.slice(2)) : raw
          return (
            path.isAbsolute(instruction)
              ? fs.glob(path.basename(instruction), {
                  cwd: path.dirname(instruction),
                  absolute: true,
                  include: "file",
                })
              : relative(instruction)
          ).pipe(Effect.catch(() => Effect.succeed([] as string[])))
        },
      )
      const configFiles = yield* Effect.forEach(files.flat(), (match) =>
        read(path.resolve(match)).pipe(Effect.map((text) => ({ path: path.resolve(match), text }))),
      )
      // URLs: what upstream fetched for this request (not fetched twice); else fetched here.
      const urls = yield* Effect.forEach(configured.filter(isURL), (url) => {
        const prefix = `Instructions from: ${url}\n`
        const entry = fetched?.find((item) => item.startsWith(prefix))
        if (entry || fetched)
          return Effect.succeed({ path: url, text: entry ? entry.slice(prefix.length) : "", url: true })
        return fetchURL(url, undefined).pipe(Effect.map((text) => ({ path: url, text: text ?? "", url: true })))
      })
      return [...configFiles, ...urls]
    })

    // A URL's text, fetched once per session (resolutions.ts; a failed fetch is not kept); undefined when it
    // can't be fetched.
    const fetchURL = (url: string, sessionID: string | undefined) =>
      Effect.promise(() =>
        OperatorResolutions.reuse(sessionID, `url:${url}`, url, async () => {
          const response = await fetch(url, { signal: AbortSignal.timeout(URL_TIMEOUT) })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const text = await response.text()
          return { text, trace: { policy: "one" as const, candidates: [], chars: text.length, overBudget: 0 } }
        }).then(
          (done) => done.text as string | undefined,
          () => undefined,
        ),
      )

    const mcpServers = Effect.fnUntraced(function* (
      agent: Agent.Info,
      sessionID?: string,
      permission?: PermissionV1.Ruleset,
    ) {
      const ruleset = yield* effective(agent, sessionID, permission)
      const list = yield* mcp.instructions()
      return B.mcp(
        list.map((item) => ({
          name: item.name,
          instructions: item.instructions,
          usable: item.tools.length === 0 || Permission.disabled(item.tools, ruleset).size < item.tools.length,
        })),
      )
    })

    const skills = Effect.fnUntraced(function* (agent: Agent.Info, sessionID?: string) {
      const rules = yield* effective(agent, sessionID)
      const off = Permission.disabled(["skill"], rules).has("skill")
      const list = off ? [] : yield* skill.available()
      return {
        candidates: B.skills(list),
        context: {
          ...(off ? { off: "the agent may not use the skill tool" } : {}),
          decide: (permission: string, input: string) => Permission.evaluate(permission, input, rules).action,
        } satisfies OperatorResolver.Context,
      }
    })

    // One source of a layer with rules of its own: its candidates (`source` is its index), and why the
    // whole source adds nothing when it can't be used (the skill tool is denied).
    type Read = { candidates: OperatorResolver.Candidate[]; off?: string }
    const readSource = Effect.fnUntraced(function* (
      source: OperatorResolver.Source,
      index: number,
      input: Input,
      layer: OperatorProfile.Layer,
    ) {
      const at = (list: ReadonlyArray<OperatorResolver.Candidate>): Read => ({
        candidates: list.map((item) => ({ ...item, source: index })),
      })
      const none = (reason: string): Read => at([{ source: index, location: source.location, reason }])
      const ctx = yield* InstanceState.context
      switch (source.kind) {
        case "file": {
          const where = expand(source.location)
          const found = yield* (
            path.isAbsolute(where)
              ? GLOB.test(where)
                ? fs.glob(path.basename(where), { cwd: path.dirname(where), absolute: true, include: "file" })
                : fs.existsSafe(where).pipe(Effect.map((exists) => (exists ? [where] : [])))
              : Flag.OPENCODE_DISABLE_PROJECT_CONFIG
                ? Effect.succeed([] as string[])
                : GLOB.test(where)
                  ? fs.globUp(where, ctx.directory, ctx.worktree)
                  : fs.findUp(where, ctx.directory, ctx.worktree)
          ).pipe(Effect.catch(() => Effect.succeed([] as string[])))
          if (!found.length)
            return path.isAbsolute(where) && !GLOB.test(where)
              ? at([{ source: index, location: where, reason: "missing" }])
              : none("missing")
          return at(
            yield* Effect.forEach(found, (match) =>
              Effect.promise(async () => {
                const file = path.resolve(match)
                const info = await stat(file).catch(() => undefined)
                return {
                  source: index,
                  location: file,
                  // As upstream reads instruction files: one that can't be read is empty.
                  text: (await OperatorFileCache.text(file)) ?? "",
                  attributes: {
                    path: file,
                    name: path.basename(file),
                    ...(info ? { updated: info.mtimeMs, size: info.size } : {}),
                  },
                }
              }),
            ),
          )
        }
        case "config": {
          if (source.location === "instructions") {
            const list = yield* configInstructions(input.instructions)
            return at(B.instructions({ global: [], project: [], config: list }))
          }
          if (source.location === "references") return at(yield* references())
          const value = valueAt(yield* cfg.get(), source.location)
          if (value === undefined) return none("missing")
          const text = typeof value === "string" ? value : JSON.stringify(value, null, 2)
          return at([{ source: index, location: source.location, text, attributes: { name: source.location } }])
        }
        case "url": {
          const text = yield* fetchURL(source.location, input.sessionID)
          if (text === undefined) return none("unreadable")
          return at([{ source: index, location: source.location, text, attributes: { path: source.location } }])
        }
        case "live":
          if (source.location === "environment") return at(yield* environment(input.model))
          return none(`no live value "${source.location}"`)
        case "registry": {
          if (source.location === "mcp")
            return at(yield* mcpServers(input.agent, input.sessionID, input.sessionPermission))
          if (source.location !== "skills") return none(`no registry "${source.location}"`)
          const found = yield* skills(input.agent, input.sessionID)
          return {
            candidates: at(found.candidates).candidates,
            ...(found.context.off ? { off: found.context.off } : {}),
          }
        }
        case "agent-field": {
          const field = source.location === "description" ? input.agent.description : input.agent.prompt
          if (!field) return none("missing")
          return at([{ source: index, location: source.location, text: field, attributes: { name: input.agent.name } }])
        }
        case "text":
          return at([
            {
              source: index,
              location: source.location,
              text: source.text ?? "",
              attributes: { name: source.name ?? source.location },
            },
          ])
        case "helper": {
          // Written once per session from the layer's prompt; without a session, a sample now.
          if (input.helper === "placeholder")
            return at([
              {
                source: index,
                location: layer.name,
                text: `‹${layer.name}: written for each session by the dynamic generator›`,
                attributes: { name: layer.name },
              },
            ])
          const text = input.sessionID
            ? (yield* helpers.dynamic({ sessionID: input.sessionID, layers: [layer.id] }))[layer.id]
            : yield* helpers.sample(layer).pipe(Effect.orElseSucceed(() => undefined))
          if (text === undefined) return none("unreadable")
          return at([{ source: index, location: layer.name, text, attributes: { name: layer.name } }])
        }
        case "memory":
          return none("memory layers are not read yet")
      }
    })

    // A layer with rules of its own, read source by source and resolved.
    const resolveCustom = Effect.fnUntraced(function* (input: Input, custom: Custom) {
      const reads = yield* Effect.forEach(custom.resolver.sources, (source, index) =>
        readSource(source, index, input, custom.layer),
      )
      const offs = reads.flatMap((read) => (read.off ? [read.off] : []))
      const rules = custom.resolver.filter.some((filter) => filter.kind === "permission")
        ? yield* effective(input.agent, input.sessionID)
        : []
      const candidates = reads.flatMap((read) => read.candidates)
      const context: OperatorResolver.Context = {
        values: { agent: input.agent.name, model: input.model.api.id, provider: input.model.providerID },
        ...(offs.length === reads.length && offs.length ? { off: offs[0] } : {}),
        decide: (permission: string, value: string) => Permission.evaluate(permission, value, rules).action,
      }
      // A helper judge scores what the filter kept (once per session and change; the preview asks no model).
      const judge = custom.resolver.judge
      if (!judge || context.off !== undefined) return OperatorResolver.run(custom.resolver, candidates, context)
      if (input.helper === "placeholder")
        return OperatorResolver.run(custom.resolver, candidates, {
          ...context,
          judge: { helper: judge.helper, status: "preview" },
        })
      const judged = OperatorResolver.toJudge(custom.resolver, candidates, context).map((index) => ({
        index,
        location: candidates[index]!.location,
        text: candidates[index]!.text ?? "",
        ...(candidates[index]!.attributes?.name !== undefined
          ? { name: String(candidates[index]!.attributes!.name) }
          : {}),
      }))
      if (!judged.length) return OperatorResolver.run(custom.resolver, candidates, context)
      const scored = yield* helpers.judge({
        ...(input.sessionID ? { sessionID: input.sessionID } : {}),
        layer: custom.layer,
        judge,
        candidates: judged,
      })
      return OperatorResolver.run(custom.resolver, candidates, {
        ...context,
        judged: scored.scores,
        judge: scored.trace,
      })
    })

    const resolve = Effect.fn("OperatorDynamicLayers.resolve")(function* (input: Input) {
      const wanted = input.layers ? ALL.filter((id) => input.layers!.includes(id)) : ALL
      const result = new Map<string, Resolution>()
      for (const id of wanted) {
        const resolver = B.RESOLVERS[id]!
        if (id === B.ENVIRONMENT) result.set(id, OperatorResolver.run(resolver, yield* environment(input.model)))
        if (id === B.REFERENCES) result.set(id, OperatorResolver.run(resolver, yield* references()))
        if (id === B.INSTRUCTIONS) {
          const found = yield* instructions(input.instructions)
          result.set(
            id,
            found
              ? OperatorResolver.run(resolver, found)
              : OperatorResolver.run(resolver, [], { off: OperatorInstructionScope.NOT_HERE }),
          )
        }
        if (id === B.MCP)
          result.set(
            id,
            OperatorResolver.run(resolver, yield* mcpServers(input.agent, input.sessionID, input.sessionPermission)),
          )
        if (id === B.SKILLS) {
          const found = yield* skills(input.agent, input.sessionID)
          result.set(id, OperatorResolver.run(resolver, found.candidates, found.context))
        }
      }
      for (const custom of input.custom ?? []) result.set(custom.layer.id, yield* resolveCustom(input, custom))
      if (input.memory) for (const [id, done] of yield* memoryLayers(input)) result.set(id, done)
      return result
    })

    // The prompt plugin runs outside Effect: it reaches this through the registry, in the request's instance.
    const register: NonNullable<typeof OperatorRegistry.dynamicLayers.resolve> = (request) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const agent = yield* agents.get(request.agent).pipe(Effect.orElseSucceed(() => undefined))
          if (!agent) return new Map<string, Resolution>()
          return yield* resolve({
            agent,
            model: request.model as Provider.Model,
            ...(request.sessionID ? { sessionID: request.sessionID } : {}),
            ...(request.sessionPermission
              ? { sessionPermission: request.sessionPermission as PermissionV1.Ruleset }
              : {}),
            ...(request.instructions ? { instructions: request.instructions } : {}),
            ...(request.custom ? { custom: request.custom as ReadonlyArray<Custom> } : {}),
            ...(request.memory ? { memory: true } : {}),
          })
        }).pipe(Effect.provideService(InstanceRef, request.instance as InstanceContext)),
      )
    OperatorRegistry.dynamicLayers.resolve = register
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (OperatorRegistry.dynamicLayers.resolve === register) OperatorRegistry.dynamicLayers.resolve = undefined
      }),
    )

    return Service.of({ resolve })
  }),
)

const locationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: locationServiceMapLayer,
  deps: [],
})

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Agent.node,
    Config.node,
    FSUtil.node,
    Global.node,
    RuntimeFlags.node,
    Skill.node,
    McpService.node,
    OperatorHelperTexts.node,
    OperatorMemoryService.node,
    locationServiceMapNode,
  ],
})
