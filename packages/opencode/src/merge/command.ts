import path from "path"
import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { NamedError } from "@opencode-ai/core/util/error"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { SessionMerge } from "@opencode-ai/schema/session-merge"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { Env } from "@/env"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { SessionRunState } from "@/session/run-state"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import type { MergeAdapter } from "./adapter/adapter"
import { MergeAdapterRegistry } from "./adapter/registry"
import { MergeBinding } from "./binding"

export interface RunInput {
  readonly sessionID: SessionID
  readonly arguments: string
  readonly agent: string
  readonly model: SessionV1.User["model"]
}

export interface Interface {
  readonly run: (input: RunInput) => Effect.Effect<SessionV1.WithParts>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MergeCommand") {}

export type Parsed =
  | { readonly kind: "status" }
  | { readonly kind: "detach" }
  | {
      readonly kind: "bind"
      readonly adapter: string
      readonly dir?: string
      readonly resume?: string
      readonly list: boolean
      readonly args: ReadonlyArray<string>
    }
  | { readonly kind: "invalid"; readonly message: string }

const TOKEN = /"[^"]*"|'[^']*'|[^\s"']+/g

export function parse(input: string): Parsed {
  const tokens = (input.match(TOKEN) ?? []).map((token) => token.replace(/^(["'])(.*)\1$/, "$2"))
  const split = tokens.indexOf("--")
  const head = split === -1 ? tokens : tokens.slice(0, split)
  const args = split === -1 ? [] : tokens.slice(split + 1)
  const [name, ...rest] = head
  if (name === undefined || name === "status") return rest.length ? unknown(rest[0]) : { kind: "status" }
  if (name === "detach") return rest.length ? unknown(rest[0]) : { kind: "detach" }
  if (name.startsWith("-"))
    return { kind: "invalid", message: `Name an adapter first, for example "/merge claude ${name}"` }
  const found = options(rest, { list: false })
  if ("message" in found) return { kind: "invalid", message: found.message }
  return { kind: "bind", adapter: name, args, ...found }
}

type Options = { dir?: string; resume?: string; list: boolean }

function options(tokens: ReadonlyArray<string>, found: Options): Options | { message: string } {
  const [token, ...rest] = tokens
  if (token === undefined) return found
  if (token === "--list") return options(rest, { ...found, list: true })
  const equals = token.indexOf("=")
  const flag = token.startsWith("--") && equals !== -1 ? token.slice(0, equals) : token
  const inline = flag === token ? undefined : token.slice(equals + 1)
  if (flag !== "--dir" && flag !== "--resume") return { message: unknown(token).message }
  const value = inline ?? rest[0]
  if (!value || (inline === undefined && value.startsWith("-"))) return { message: `${flag} needs a value` }
  return options(inline === undefined ? rest.slice(1) : rest, { ...found, [flag.slice(2)]: value })
}

function unknown(token: string) {
  return {
    kind: "invalid" as const,
    message: `Unknown /merge option "${token}". Options are --dir, --resume and --list; pass adapter flags after "--"`,
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bindings = yield* MergeBinding.Service
    const registry = yield* MergeAdapterRegistry.Service
    const sessions = yield* Session.Service
    const state = yield* SessionRunState.Service
    const agents = yield* Agent.Service
    const env = yield* Env.Service
    const fs = yield* FSUtil.Service
    const events = yield* EventV2Bridge.Service

    const fail = Effect.fnUntraced(function* (sessionID: SessionID, message: string) {
      const error = new NamedError.Unknown({ message })
      yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
      return yield* Effect.die(error)
    })

    const reply = Effect.fnUntraced(function* (input: RunInput, text: string, binding?: SessionMerge.Binding) {
      const ctx = yield* InstanceState.context
      const now = Date.now()
      const user: SessionV1.User = {
        id: MessageID.ascending(),
        sessionID: input.sessionID,
        role: "user",
        time: { created: now },
        agent: input.agent,
        model: input.model,
      }
      yield* sessions.updateMessage(user)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: user.id,
        sessionID: input.sessionID,
        type: "text",
        text: `/merge ${input.arguments}`.trim(),
        synthetic: true,
        ignored: true,
      } satisfies SessionV1.TextPart)
      const info: SessionV1.Assistant = {
        id: MessageID.ascending(),
        parentID: user.id,
        role: "assistant",
        mode: input.agent,
        agent: input.agent,
        path: { cwd: ctx.directory, root: ctx.worktree },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: input.model.modelID,
        providerID: input.model.providerID,
        time: { created: now, completed: now },
        finish: "stop",
        sessionID: input.sessionID,
      }
      yield* sessions.updateMessage(info)
      const part = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: info.id,
        sessionID: input.sessionID,
        type: "text",
        text,
        ...(binding
          ? {
              origin: {
                type: "merge",
                bindingID: binding.id,
                adapter: binding.adapter,
                externalSessionID: binding.externalSessionID,
                role: "notice",
              } satisfies SessionMerge.Origin,
            }
          : {}),
      } satisfies SessionV1.TextPart)
      return { info, parts: [part] } satisfies SessionV1.WithParts
    })

    const posture = Effect.fnUntraced(function* (input: RunInput) {
      const agent = yield* agents.get(input.agent)
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      const ruleset = Permission.merge(agent?.permission ?? [], session.permission ?? [])
      return Permission.evaluate("edit", "*", ruleset).action === "deny" ? ("plan" as const) : ("build" as const)
    })

    const directory = Effect.fnUntraced(function* (input: RunInput, dir: string | undefined) {
      const ctx = yield* InstanceState.context
      if (!dir) return ctx.directory
      const absolute = path.resolve(ctx.directory, dir)
      if (!(yield* fs.isDir(absolute))) return yield* fail(input.sessionID, `--dir ${dir} is not a directory`)
      return yield* fs.realPath(absolute).pipe(Effect.orElseSucceed(() => absolute))
    })

    const status = Effect.fnUntraced(function* (input: RunInput) {
      const binding = yield* bindings.latest(input.sessionID)
      if (!binding) return yield* reply(input, "This session is not merged. Start one with `/merge claude`.")
      const lines = [
        `merged: ${binding.adapter} · ${binding.externalSessionID ?? "pending"} · ${binding.status}`,
        `transport: ${binding.transport}`,
        `cwd: ${binding.cwd}`,
        `process: ${binding.process ? `running (pid ${binding.process.pid})` : "not running"}`,
        `args: ${binding.args.length ? binding.args.join(" ") : "(none)"}`,
        `since: ${new Date(binding.time.created).toISOString()}`,
        binding.time.lastEvent ? `last event: ${new Date(binding.time.lastEvent).toISOString()}` : undefined,
        binding.error ? `error: ${binding.error}` : undefined,
      ].filter((line) => line !== undefined)
      return yield* reply(input, lines.join("\n"), binding)
    })

    const detach = Effect.fnUntraced(function* (input: RunInput) {
      const current = yield* bindings.active(input.sessionID)
      if (!current) return yield* reply(input, "This session is not merged; nothing to detach.")
      yield* state.cancel(input.sessionID)
      const binding = yield* bindings.detach(input.sessionID)
      return yield* reply(
        input,
        `Detached from ${current.binding.adapter} session ${current.binding.externalSessionID}. The merged history stays in this session; your next prompt uses ${input.model.providerID}/${input.model.modelID}.`,
        binding ?? current.binding,
      )
    })

    const list = Effect.fnUntraced(function* (input: RunInput, adapter: MergeAdapter.Adapter, cwd: string) {
      const items = yield* adapter.listSessions(cwd, yield* env.all())
      if (items.length === 0) return yield* reply(input, `No ${adapter.id} sessions found for ${cwd}.`)
      const lines = items
        .slice(0, 50)
        .map(
          (item) =>
            `- ${item.id}  ${new Date(item.modified).toISOString()}  ${item.title ?? item.preview ?? ""}${item.branch ? `  (${item.branch})` : ""}`,
        )
      return yield* reply(
        input,
        [
          `${adapter.id} sessions in ${cwd}:`,
          ...lines,
          "",
          `Attach one with /merge ${adapter.id} --resume <id> --dir ${cwd}`,
        ].join("\n"),
      )
    })

    const bind = Effect.fnUntraced(function* (input: RunInput, parsed: Extract<Parsed, { kind: "bind" }>) {
      const adapter = registry.get(parsed.adapter)
      if (!adapter)
        return yield* fail(
          input.sessionID,
          `Unknown merge adapter "${parsed.adapter}". Available: ${registry.ids().join(", ")}`,
        )
      const cwd = yield* directory(input, parsed.dir)
      if (parsed.list) return yield* list(input, adapter, cwd)

      yield* state
        .assertNotBusy(input.sessionID)
        .pipe(
          Effect.catch(() => fail(input.sessionID, "The session is busy. Wait for it to finish, or abort it first.")),
        )
      const parent = yield* posture(input)
      yield* adapter
        .validateArgs(parsed.args, parent)
        .pipe(Effect.catch((error) => fail(input.sessionID, error.message)))
      const environment = yield* env.all()
      // Probe before any state changes: a missing binary must leave the session exactly as it was.
      yield* adapter.probe(environment).pipe(Effect.catch((error) => fail(input.sessionID, error.message)))

      if (parsed.resume !== undefined) {
        const exists = yield* adapter.hasSession(cwd, parsed.resume, environment)
        if (!exists)
          return yield* fail(
            input.sessionID,
            `No ${adapter.id} session ${parsed.resume} found for ${cwd}. List them with /merge ${adapter.id} --list --dir ${cwd}`,
          )
      }
      const binding = yield* bindings
        .create({
          sessionID: input.sessionID,
          adapter: adapter.id,
          transport: "cli",
          externalSessionID: parsed.resume ?? crypto.randomUUID(),
          cwd,
          args: parsed.args,
          status: parsed.resume ? "live" : "starting",
          parentModel: input.model,
        })
        .pipe(Effect.catch((error) => fail(input.sessionID, error.message)))
      return yield* reply(
        input,
        [
          `Merged with ${adapter.id} session ${binding.externalSessionID} (${parsed.resume ? "resumed" : "new"}) in ${cwd}.`,
          `Your prompts now go to ${adapter.id} (${adapter.resolveMode(parsed.args, parent)} permission mode). Use /merge detach to return to OpenCode's model.`,
        ].join("\n"),
        binding,
      )
    })

    const run = Effect.fn("MergeCommand.run")(function* (input: RunInput) {
      const parsed = parse(input.arguments)
      if (parsed.kind === "invalid") return yield* fail(input.sessionID, parsed.message)
      if (parsed.kind === "status") return yield* status(input)
      if (parsed.kind === "detach") return yield* detach(input)
      return yield* bind(input, parsed)
    })

    return Service.of({ run })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    MergeBinding.node,
    MergeAdapterRegistry.node,
    Session.node,
    SessionRunState.node,
    Agent.node,
    Env.node,
    FSUtil.node,
    EventV2Bridge.node,
  ],
})

export * as MergeCommand from "./command"
