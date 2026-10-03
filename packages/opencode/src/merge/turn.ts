import path from "path"
import { fileURLToPath } from "url"
import { Cause, Context, Effect, Exit, FiberSet, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LLMEvent } from "@opencode-ai/llm"
import type { SessionMerge } from "@opencode-ai/schema/session-merge"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Env } from "@/env"
import { Permission } from "@/permission"
import { Question } from "@/question"
import { MessageV2 } from "@/session/message-v2"
import { SessionProcessor } from "@/session/processor"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { MergeAdapter } from "./adapter/adapter"
import { MergeAdapterRegistry } from "./adapter/registry"
import { MergeBinding } from "./binding"
import { MergeModel } from "./model"
import { MergeStream } from "./stream"
import { MergeSummary } from "./summary"

export type Outcome = "continue" | "break" | "detached"

export interface RunInput {
  readonly sessionID: SessionID
  readonly session: Session.Info
  readonly entry: MergeBinding.Entry
  readonly lastUser: SessionV1.User
  readonly msgs: ReadonlyArray<SessionV1.WithParts>
  readonly step: number
}

export interface Interface {
  /** Runs one user turn through the bound child harness instead of OpenCode's model. */
  readonly run: (input: RunInput) => Effect.Effect<Outcome>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MergeTurn") {}

const KEEP = "Keep merge"
const DETACH = "Detach and continue here"

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bindings = yield* MergeBinding.Service
    const registry = yield* MergeAdapterRegistry.Service
    const processor = yield* SessionProcessor.Service
    const sessions = yield* Session.Service
    const permission = yield* Permission.Service
    const question = yield* Question.Service
    const agents = yield* Agent.Service
    const env = yield* Env.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const database = yield* Database.Service
    const config = yield* Config.Service

    const notice = Effect.fnUntraced(function* (input: RunInput, text: string) {
      const msg = assistant(input, input.entry.binding.cwd)
      msg.finish = "stop"
      msg.time.completed = Date.now()
      yield* sessions.updateMessage(msg)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: input.sessionID,
        type: "text",
        text,
        origin: origin(input.entry.binding, "notice"),
      } satisfies SessionV1.TextPart)
    })

    const confirmModel = Effect.fnUntraced(function* (input: RunInput) {
      const parent = input.entry.parentModel
      const current = input.lastUser.model
      if (!parent || (parent.providerID === current.providerID && parent.modelID === current.modelID)) return "keep"
      const answers = yield* question
        .ask({
          sessionID: input.sessionID,
          questions: [
            {
              header: "Merged session",
              question: `The model changed to ${current.providerID}/${current.modelID} while this session is merged with ${input.entry.binding.adapter}. Keep sending prompts to ${input.entry.binding.adapter}, or detach and continue with the new model?`,
              options: [
                { label: KEEP, description: `Keep prompting the merged ${input.entry.binding.adapter} session` },
                { label: DETACH, description: "Stop the merge; this and later prompts use OpenCode's model" },
              ],
              custom: false,
            },
          ],
        })
        .pipe(Effect.orElseSucceed(() => []))
      if (answers[0]?.includes(DETACH)) return "detach"
      yield* bindings.update(input.entry.binding.id, {
        parentModel: { providerID: current.providerID, modelID: current.modelID, variant: current.variant },
      })
      return "keep"
    })

    // A previous OpenCode process may have died mid-turn and left its child running. Two writers on
    // one Claude transcript corrupt it, so stop that child first. The command line is checked so a
    // reused pid that belongs to an unrelated process is never signalled.
    const reapOrphan = Effect.fnUntraced(function* (entry: MergeBinding.Entry) {
      if (!entry.pid || entry.binding.process || process.platform === "win32") return
      const pid = entry.pid
      const externalID = entry.binding.externalSessionID
      if (!externalID) return
      const args = yield* Effect.scoped(
        spawner
          .spawn(ChildProcess.make("ps", ["-o", "args=", "-p", String(pid)], { stdin: "ignore" }))
          .pipe(Effect.flatMap((handle) => Stream.mkString(Stream.decodeText(handle.stdout)))),
      ).pipe(Effect.orElseSucceed(() => ""))
      if (!args.includes(externalID)) return
      yield* Effect.logWarning("stopping orphaned merged child", { pid, externalID })
      yield* Effect.try({ try: () => process.kill(-pid, "SIGTERM"), catch: (cause) => cause }).pipe(Effect.ignore)
    })

    const run = Effect.fn("MergeTurn.run")(function* (input: RunInput) {
      const binding = input.entry.binding
      const adapter = registry.get(binding.adapter)
      if (!adapter) {
        yield* bindings.update(binding.id, { status: "error", error: `Unknown merge adapter "${binding.adapter}"` })
        yield* notice(input, `Merge adapter "${binding.adapter}" is not available. Run \`/merge detach\` to continue.`)
        return "break" as const
      }
      if (!MergeAdapterRegistry.enabled(yield* config.get(), adapter.id)) {
        yield* notice(
          input,
          `The ${adapter.name} adapter is turned off in Settings → Adapters. Turn it on, or run \`/merge detach\` to continue here.`,
        )
        return "break" as const
      }

      if ((yield* confirmModel(input)) === "detach") {
        yield* bindings.detach(input.sessionID)
        return "detached" as const
      }

      const agent = yield* agents.get(input.lastUser.agent)
      const ruleset = Permission.merge(agent?.permission ?? [], input.session.permission ?? [])
      const parent: MergeAdapter.Parent = Permission.evaluate("edit", "*", ruleset).action === "deny" ? "plan" : "build"
      const mode = adapter.resolveMode(binding.args, parent)

      const user = input.msgs.findLast((msg) => msg.info.id === input.lastUser.id)
      const prompt = promptText(user?.parts ?? [], binding.cwd)
      if (!prompt) {
        yield* notice(input, "Nothing to send to the merged session.")
        return "break" as const
      }

      if (!input.session.parentID && Session.isDefaultTitle(input.session.title))
        yield* sessions.setTitle({ sessionID: input.sessionID, title: prompt.split("\n")[0].slice(0, 100) })

      const msg = assistant(input, binding.cwd)
      msg.agent = agent?.name ?? input.lastUser.agent
      msg.mode = msg.agent
      yield* sessions.updateMessage(msg)
      const handle = yield* processor.create({
        assistantMessage: msg,
        sessionID: input.sessionID,
        model: MergeModel.stub(binding.adapter),
        origin: origin(binding, "projection"),
      })

      const environment = yield* env.all()
      const externalID = binding.externalSessionID ?? crypto.randomUUID()
      const resume = yield* adapter.hasSession(binding.cwd, externalID, environment)
      yield* reapOrphan(input.entry)

      const summary = MergeSummary.collector()
      const translate = MergeStream.translator({ adapter, cwd: binding.cwd })
      const pending = new Map<string, PermissionV1.ID[]>()
      const denyRules = ruleset.filter((rule) => rule.action === "deny")

      const exit = yield* Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* adapter.start({
            cwd: binding.cwd,
            prompt: [{ type: "text", text: prompt }],
            mode,
            session: { mode: resume ? "resume" : "new", id: externalID },
            args: binding.args,
            env: environment,
          })
          yield* bindings.setProcess(binding.id, harness.pid)
          yield* Effect.addFinalizer(() =>
            Effect.forEach([...pending.values()].flat(), (id) => permission.dismiss(id), { discard: true }),
          )
          const fibers = yield* FiberSet.make()

          const bridge = Effect.fnUntraced(function* (
            request: Extract<MergeAdapter.Event, { type: "permission-request" }>,
          ) {
            const view = adapter.permissionFor(request.tool, request.input, binding.cwd)
            if (parent === "plan" && !view.readOnly) {
              summary.deny(request.tool, "plan mode")
              return yield* harness.respond(request.id, {
                behavior: "deny",
                message: "OpenCode is in plan mode, so this action is not allowed. Describe a plan instead.",
                interrupt: false,
              })
            }
            const tool = request.toolCallID ? { messageID: handle.message.id, callID: request.toolCallID } : undefined
            const outside = request.blockedPath ? outsideDirectory(binding.cwd, request.blockedPath) : undefined
            const asks = [
              ...(outside
                ? [
                    {
                      permission: "external_directory",
                      patterns: [path.join(outside, "*")],
                      always: [path.join(outside, "*")],
                      metadata: { filepath: request.blockedPath, parentDir: outside },
                    },
                  ]
                : []),
              { permission: view.permission, patterns: view.patterns, always: view.always, metadata: view.metadata },
            ].map((ask) => ({ ...ask, id: PermissionV1.ID.ascending() }))
            pending.set(
              request.id,
              asks.map((ask) => ask.id),
            )
            const result = yield* Effect.forEach(
              asks,
              (ask) =>
                permission.ask({
                  id: ask.id,
                  sessionID: input.sessionID,
                  permission: ask.permission,
                  patterns: [...ask.patterns],
                  always: [...ask.always],
                  metadata: ask.metadata,
                  tool,
                  ruleset: denyRules,
                }),
              { discard: true },
            ).pipe(Effect.exit)
            pending.delete(request.id)
            if (Exit.isSuccess(result))
              return yield* harness.respond(request.id, { behavior: "allow", input: request.input })
            const decision = denial(Cause.squash(result.cause))
            summary.deny(request.tool, decision.reason)
            yield* harness.respond(request.id, decision.response)
          })

          const events = harness.events.pipe(
            Stream.tap((event) =>
              Effect.gen(function* () {
                summary.observe(event)
                yield* bindings.touch(binding.id)
                if (event.type === "session") {
                  if (event.externalSessionID !== binding.externalSessionID || binding.status === "starting")
                    yield* bindings.update(binding.id, { status: "live", externalSessionID: event.externalSessionID })
                  if (event.model) {
                    handle.message.modelID = ModelV2.ID.make(event.model)
                    yield* sessions.updateMessage(handle.message)
                  }
                }
                if (event.type === "permission-request") yield* FiberSet.run(fibers, bridge(event))
                if (event.type === "permission-cancel")
                  yield* Effect.forEach(pending.get(event.id) ?? [], (id) => permission.dismiss(id), { discard: true })
              }),
            ),
            Stream.map(translate),
            Stream.flattenIterable,
          )

          return yield* handle.consume(
            Stream.make(LLMEvent.stepStart({ index: 0 })).pipe(
              Stream.concat(events),
              Stream.concat(Stream.suspend(() => Stream.make(LLMEvent.stepFinish({ index: 0, reason: "stop" })))),
            ),
          )
        }),
      ).pipe(
        Effect.onInterrupt(() => Effect.sync(() => summary.interrupted())),
        Effect.ensuring(
          Effect.gen(function* () {
            yield* bindings.setProcess(binding.id, undefined)
            const parts = yield* MessageV2.parts(handle.message.id).pipe(
              Effect.provideService(Database.Service, database),
            )
            const files = parts.flatMap((part) => (part.type === "patch" ? part.files : []))
            const rendered = summary.render({
              adapter: binding.adapter,
              externalSessionID: externalID,
              cwd: binding.cwd,
              files,
            })
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: handle.message.id,
              sessionID: input.sessionID,
              type: "text",
              text: rendered.text,
              time: { start: Date.now(), end: Date.now() },
              metadata: { merge: rendered.metadata },
              origin: origin(binding, "summary", externalID),
            } satisfies SessionV1.TextPart)
          }).pipe(Effect.uninterruptible, Effect.ignore),
        ),
        Effect.exit,
      )

      if (Exit.isFailure(exit)) {
        if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt
        const message = Cause.pretty(exit.cause)
        yield* bindings.update(binding.id, { error: message })
        return "break" as const
      }
      return exit.value === "continue" ? ("continue" as const) : ("break" as const)
    })

    return Service.of({ run })
  }),
)

function assistant(input: RunInput, cwd: string): SessionV1.Assistant {
  return {
    id: MessageID.ascending(),
    parentID: input.lastUser.id,
    role: "assistant",
    mode: input.lastUser.agent,
    agent: input.lastUser.agent,
    path: { cwd, root: cwd },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ModelV2.ID.make(input.entry.binding.adapter),
    providerID: ProviderV2.ID.make(`${input.entry.binding.adapter}-code`),
    time: { created: Date.now() },
    sessionID: input.sessionID,
  }
}

function origin(
  binding: SessionMerge.Binding,
  role: SessionMerge.Origin["role"],
  externalSessionID = binding.externalSessionID,
): SessionMerge.Origin {
  return { type: "merge", bindingID: binding.id, adapter: binding.adapter, externalSessionID, role }
}

function promptText(parts: ReadonlyArray<SessionV1.Part>, cwd: string) {
  return parts
    .flatMap((part) => {
      if (part.type === "text" && !part.synthetic && !part.ignored) return [part.text]
      if (part.type === "file" && part.url.startsWith("file:"))
        return [`@${path.relative(cwd, fileURLToPath(part.url))}`]
      return []
    })
    .join("\n")
    .trim()
}

function outsideDirectory(cwd: string, target: string) {
  const relative = path.relative(cwd, target)
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return undefined
  return path.dirname(target)
}

function denial(error: unknown) {
  if (error instanceof PermissionV1.DeniedError)
    return {
      reason: "denied by rule",
      response: { behavior: "deny", message: "Denied by the user's OpenCode permission rules.", interrupt: false },
    } as const
  if (error instanceof PermissionV1.CorrectedError)
    return {
      reason: "rejected with feedback",
      response: { behavior: "deny", message: error.feedback, interrupt: false },
    } as const
  return {
    reason: "rejected",
    response: { behavior: "deny", message: "The user rejected this action.", interrupt: true },
  } as const
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    MergeBinding.node,
    MergeAdapterRegistry.node,
    SessionProcessor.node,
    Session.node,
    Permission.node,
    Question.node,
    Agent.node,
    Env.node,
    CrossSpawnSpawner.node,
    Database.node,
    Config.node,
  ],
})

export * as MergeTurn from "./turn"
