export * as OperatorDynamicLayers from "./dynamic-layers"

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
import { OperatorPermissionEffective } from "./permission-effective"
import { OperatorRegistry } from "./registry"
import { OperatorResolver } from "./resolver"
import { OperatorResolverBuiltins as B } from "./resolver-builtins"

// Reads the sources of OpenCode's per-request Dynamic layers and resolves them through the pipeline
// (resolver.ts, resolver-builtins.ts): Environment, References, Instructions, MCP instructions, Skills.
// The reads mirror upstream's (session/system.ts, session/instruction.ts) so the texts are the same;
// each candidate it found or didn't is in the trace. The prompt plugin (through OperatorRegistry) and the
// agent page's preview both use it.

export type Resolution = { readonly text: string; readonly trace: OperatorResolver.Trace }
export type Resolved = ReadonlyMap<string, Resolution>

export type Input = {
  readonly agent: Agent.Info
  readonly model: Provider.Model
  /** The request's session: its effective permissions decide the skills and MCP servers listed. */
  readonly sessionID?: string
  /** The session's own rules (MCP instructions follow them, as upstream's do). */
  readonly sessionPermission?: PermissionV1.Ruleset
  /** Upstream's instruction texts for this request: URLs are not fetched again. */
  readonly instructions?: ReadonlyArray<string>
  /** Only these layers (default: all of them). */
  readonly layers?: ReadonlyArray<string>
}

export interface Interface {
  readonly resolve: (input: Input) => Effect.Effect<Map<string, Resolution>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorDynamicLayers") {}

const ALL = [B.ENVIRONMENT, B.REFERENCES, B.INSTRUCTIONS, B.MCP, B.SKILLS]
const isURL = (value: string) => value.startsWith("https://") || value.startsWith("http://")

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
      // URLs: what upstream fetched for this request (not fetched twice).
      const urls = configured.filter(isURL).map((url) => {
        const prefix = `Instructions from: ${url}\n`
        const entry = fetched?.find((item) => item.startsWith(prefix))
        return { path: url, text: entry ? entry.slice(prefix.length) : "", url: true }
      })
      return B.instructions({ global: globalFound, project, config: [...configFiles, ...urls] })
    })

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

    const resolve = Effect.fn("OperatorDynamicLayers.resolve")(function* (input: Input) {
      const wanted = input.layers ? ALL.filter((id) => input.layers!.includes(id)) : ALL
      const result = new Map<string, Resolution>()
      for (const id of wanted) {
        const resolver = B.RESOLVERS[id]!
        if (id === B.ENVIRONMENT) result.set(id, OperatorResolver.run(resolver, yield* environment(input.model)))
        if (id === B.REFERENCES) result.set(id, OperatorResolver.run(resolver, yield* references()))
        if (id === B.INSTRUCTIONS)
          result.set(id, OperatorResolver.run(resolver, yield* instructions(input.instructions)))
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
    locationServiceMapNode,
  ],
})
