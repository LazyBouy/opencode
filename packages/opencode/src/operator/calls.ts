export * as OperatorCalls from "./calls"

import { Context, Effect, Layer, Option, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Config } from "@/config/config"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import type { InstanceContext } from "@/project/instance-context"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Provider } from "@/provider/provider"
import { OperatorCallAccounting } from "./call-accounting"
import { OperatorCallFormat } from "./call-format"
import { OperatorCallStore } from "./call-store"
import { OperatorCallView } from "./call-view"
import { OperatorProjects } from "./projects"
import { OperatorProviderTap } from "./provider-tap"
import { OperatorRegistry } from "./registry"
import { OperatorTokenizers } from "./tokenizers"

// Recorded model calls (provider-tap.ts, call-store.ts): registers each call the prompt plugin sees in
// `chat.headers`, linking it to its session, agent and the step's assistant message, and deletes a
// session's calls when the session is deleted for good.

// OpenCode's own side calls, by agent.
const SIDE = new Set(["title", "compaction", "summary"])

export const Raw = Schema.Struct({
  text: Schema.String.annotate({ description: "The exact request body, or the assembled response as JSON" }),
  bytes: Schema.Finite,
}).annotate({ identifier: "OperatorCallRaw" })

export const Export = Schema.Struct({
  format: Schema.Literals(["md", "json"]),
  text: Schema.String,
}).annotate({ identifier: "OperatorCallExport" })

export const Last = Schema.Struct({
  captured: Schema.Boolean,
  at: Schema.optional(Schema.Finite),
  sessionID: Schema.optional(Schema.String),
  callID: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  format: Schema.optional(Schema.String),
  tools: Schema.optional(Schema.String).annotate({ description: "The `tools` value as sent, byte for byte" }),
  bytes: Schema.optional(Schema.Finite),
  inputTokens: Schema.optional(Schema.Finite).annotate({ description: "The request's input tokens, as reported" }),
}).annotate({ identifier: "OperatorToolPromptLast" })

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("OperatorCallNotFound", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly list: (
    sessionID: string,
    filter?: { after?: string; limit?: number; kind?: string; search?: string },
  ) => Effect.Effect<OperatorCallView.List>
  readonly detail: (sessionID: string, callID: string) => Effect.Effect<OperatorCallView.Detail, NotFoundError>
  readonly raw: (
    sessionID: string,
    callID: string,
    part: "request" | "response",
  ) => Effect.Effect<typeof Raw.Type, NotFoundError>
  readonly export: (sessionID: string, format: "md" | "json") => Effect.Effect<typeof Export.Type>
  /** Clears a session's stored token counts, so they are made again (after a tokenizer is added). */
  readonly recount: (sessionID: string) => Effect.Effect<void>
  /** The tokenizers loaded from the tokenizer folder (tokenizers.ts). */
  readonly tokenizers: () => Effect.Effect<OperatorTokenizers.List>
  /** A text's tokens for a model (a form's counters): its tokenizer's count, else an estimate. */
  readonly count: (input: { model?: string; text: string }) => Effect.Effect<OperatorTokenizers.Count>
  /** The newest recorded call of an agent of this project: its tools as sent. */
  readonly last: (agent: string) => Effect.Effect<typeof Last.Type>
  /** Registers a call about to be sent; its id, or nothing when it is not recorded. */
  readonly begin: (input: {
    sessionID: string
    agent: string
    providerID: string
    modelID: string
    userMessageID?: string
    resolutions?: ReadonlyArray<unknown>
  }) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorCalls") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const config = yield* Config.Service
    const providers = yield* Provider.Service
    // The last call of each assistant message: a later one for the same message is a retry.
    const lastCall = new Map<string, string>()

    const begin = Effect.fn("OperatorCalls.begin")(function* (input: {
      sessionID: string
      agent: string
      providerID: string
      modelID: string
      userMessageID?: string
      resolutions?: ReadonlyArray<unknown>
    }) {
      const cfg = yield* config.get()
      const record = cfg.operatorRecordCalls !== false
      OperatorProviderTap.settings.unlinked = record
      const session = yield* sessions.get(SessionID.make(input.sessionID)).pipe(Effect.option)
      // Not recorded: recording is off, or a helper call with no real session.
      if (!record || Option.isNone(session))
        return OperatorProviderTap.register({ sessionID: input.sessionID, kind: "other", skip: true })
      const ctx = yield* InstanceState.context
      const projectKey = yield* Effect.promise(() => OperatorProjects.keyOf(ctx))
      const kind: OperatorCallStore.Kind = SIDE.has(input.agent)
        ? (input.agent as OperatorCallStore.Kind)
        : input.userMessageID
          ? "agent"
          : "other"
      // The step's assistant message exists when the request is prepared: the newest one of this agent,
      // not completed yet (answering the user message, for an agent step).
      const found =
        kind === "agent" || kind === "compaction"
          ? yield* sessions
              .findMessage(
                SessionID.make(input.sessionID),
                (message) =>
                  message.info.role === "assistant" &&
                  !message.info.time.completed &&
                  message.info.agent === input.agent &&
                  (kind === "compaction" || message.info.parentID === input.userMessageID),
              )
              .pipe(Effect.orElseSucceed(() => Option.none()))
          : Option.none()
      const assistantMessageID = Option.isSome(found) ? found.value.info.id : undefined
      const retryOf = assistantMessageID ? lastCall.get(assistantMessageID) : undefined
      const callID = OperatorProviderTap.register({
        sessionID: input.sessionID,
        kind,
        agent: input.agent,
        projectKey,
        directory: ctx.directory,
        ...(input.userMessageID ? { userMessageID: input.userMessageID } : {}),
        ...(assistantMessageID ? { assistantMessageID } : {}),
        ...(retryOf ? { retryOf } : {}),
        model: `${input.providerID}/${input.modelID}`,
        providerID: input.providerID,
        ...(input.resolutions?.length ? { resolutions: input.resolutions } : {}),
      })
      if (assistantMessageID) lastCall.set(assistantMessageID, callID)
      return callID
    })

    const register: NonNullable<typeof OperatorRegistry.calls.begin> = (input) =>
      Effect.runPromise(
        begin(input).pipe(
          Effect.provideService(InstanceRef, input.instance as InstanceContext),
          Effect.catchCause(() => Effect.succeed(undefined)),
        ),
      )
    OperatorRegistry.calls.begin = register
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (OperatorRegistry.calls.begin === register) OperatorRegistry.calls.begin = undefined
      }),
    )

    // A session deleted for good takes its recorded calls with it.
    const onEvent = (event: GlobalEvent) => {
      const payload = event.payload as { type?: string; properties?: { sessionID?: string } } | undefined
      if (payload?.type !== "session.deleted" || !payload.properties?.sessionID) return
      void OperatorCallStore.remove(payload.properties.sessionID).catch(() => undefined)
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("event", onEvent)),
      () => Effect.sync(() => GlobalBus.off("event", onEvent)),
    )

    // A session's calls with their parsed bodies, and its messages.
    type Loaded = {
      loaded: Array<{ call: OperatorCallStore.Call; body?: Record<string, unknown>; text: string; hashes: string[] }>
      input: OperatorCallView.Input
    }
    const load = Effect.fnUntraced(function* (sessionID: string) {
      const calls = yield* Effect.promise(() => OperatorCallStore.list(sessionID))
      const loaded = yield* Effect.promise(() =>
        Promise.all(
          calls.map(async (call) => {
            const text = await OperatorCallStore.body(call).catch(() => "")
            let body: Record<string, unknown> | undefined
            try {
              const parsed = JSON.parse(text)
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed
            } catch {
              // not JSON
            }
            return { call, body, text, hashes: OperatorCallFormat.refs(call.request.body).messages }
          }),
        ),
      )
      const messages = yield* sessions
        .messages({ sessionID: SessionID.make(sessionID) })
        .pipe(Effect.orElseSucceed(() => []))
      const result: Loaded = { loaded, input: { calls: loaded, messages } as unknown as OperatorCallView.Input }
      return result
    })

    // Each model's prices per million tokens (for the cost split), when the provider lists it.
    const pricesOf = Effect.fnUntraced(function* (models: ReadonlyArray<string>) {
      const prices = new Map<string, OperatorCallAccounting.Price>()
      for (const model of new Set(models)) {
        const at = model.indexOf("/")
        if (at <= 0) continue
        const found = yield* providers
          .getModel(ProviderV2.ID.make(model.slice(0, at)), ModelV2.ID.make(model.slice(at + 1)))
          .pipe(Effect.option)
        if (found._tag === "None") continue
        const cost = found.value.cost
        prices.set(model, {
          input: cost?.input ?? 0,
          output: cost?.output ?? 0,
          cacheRead: cost?.cache?.read ?? 0,
          cacheWrite: cost?.cache?.write ?? 0,
        })
      }
      return prices
    })

    // The calls' accounting (call-accounting.ts): stored counts are reused while current; the rest are
    // made now and stored once their call is complete. `fresh` is made again with its contents.
    const accounted = Effect.fnUntraced(function* (sessionID: string, loaded: Loaded, fresh?: string) {
      yield* Effect.promise(() => OperatorTokenizers.ready())
      const base = OperatorCallView.list(loaded.input)
      const stored = (yield* Effect.promise(() => OperatorCallStore.accounting(sessionID))) as Map<
        string,
        OperatorCallAccounting.Accounting
      >
      // A call made again for its contents (details) is stored already when it was before.
      const kept = fresh && stored.has(fresh) ? fresh : undefined
      if (fresh) stored.delete(fresh)
      const prices = yield* pricesOf(loaded.loaded.flatMap((item) => (item.call.model ? [item.call.model] : [])))
      const accountings = OperatorCallAccounting.account(
        loaded.loaded.map((item, at) => ({
          call: item.call,
          body: item.body,
          hashes: item.hashes,
          index: base.calls[at]!.index,
          ...(base.calls[at]!.exchange !== undefined ? { exchange: base.calls[at]!.exchange } : {}),
          ...(base.calls[at]!.cost !== undefined ? { opencodeCost: base.calls[at]!.cost } : {}),
        })),
        { messages: loaded.input.messages, price: (model) => prices.get(model) },
        stored,
      )
      // Stored once complete (the counts of a call still receiving change).
      const save = accountings.flatMap((accounting, at) => {
        const call = loaded.loaded[at]!.call
        const before = stored.get(call.callID)
        if (!call.finishedAt || accounting === before || call.callID === kept) return []
        return [{ callID: call.callID, accounting: OperatorCallAccounting.lean(accounting) }]
      })
      yield* Effect.promise(() => OperatorCallStore.saveAccounting(sessionID, save).catch(() => undefined))
      return { base, accountings }
    })

    // A session's totals with its subagents' (rolled up, a few levels deep).
    const rollup = (sessionID: string, depth: number): Effect.Effect<OperatorCallAccounting.Subagent[]> =>
      Effect.gen(function* () {
        if (depth > 4) return []
        const children = yield* sessions.children(SessionID.make(sessionID)).pipe(Effect.orElseSucceed(() => []))
        return yield* Effect.forEach(children, (child) =>
          Effect.gen(function* () {
            const loaded = yield* load(child.id)
            const { base, accountings } = yield* accounted(child.id, loaded)
            const covered = new Set(
              base.calls.flatMap((call) => (call.assistantMessageID ? [call.assistantMessageID] : [])),
            )
            const summary = OperatorCallAccounting.summarize({
              calls: base.calls.map((call, at) => ({ ...call, accounting: accountings[at]! })),
              exchanges: base.exchanges,
              unrecorded: OperatorCallAccounting.unrecordedSteps(loaded.input.messages, covered),
              subagents: yield* rollup(child.id, depth + 1),
            })
            const all =
              summary.session.rows.find((row) => row.id === "all") ??
              summary.session.rows.find((row) => row.id === "session")!
            return {
              sessionID: child.id,
              title: child.title,
              ...(child.agent ? { agent: child.agent } : {}),
              totals: all.totals,
            }
          }),
        )
      })

    // The list with every call's billing, the turns and the session's totals.
    const full = Effect.fnUntraced(function* (sessionID: string) {
      const loaded = yield* load(sessionID)
      const { base, accountings } = yield* accounted(sessionID, loaded)
      const calls = base.calls.map((call, at) => ({ ...call, billing: OperatorCallView.billingOf(accountings[at]!) }))
      const covered = new Set(calls.flatMap((call) => (call.assistantMessageID ? [call.assistantMessageID] : [])))
      const unrecorded = OperatorCallAccounting.unrecordedSteps(loaded.input.messages, covered)
      const listed = calls.map((call, at) => ({ ...call, accounting: accountings[at]! }))
      const summary = OperatorCallAccounting.summarize({
        calls: listed,
        exchanges: base.exchanges,
        unrecorded,
        subagents: yield* rollup(sessionID, 1),
      })
      const created = yield* sessions.get(SessionID.make(sessionID)).pipe(
        Effect.map((info) => info.time.created),
        Effect.orElseSucceed(() => Date.now()),
      )
      const availability = OperatorCallAccounting.availabilityOf({
        calls: listed,
        unrecorded: unrecorded.length,
        created,
      })
      const view: OperatorCallView.List = {
        ...base,
        calls,
        turns: summary.turns,
        session: summary.session,
        unrecorded,
        availability,
      }
      return { loaded, view, accountings }
    })

    const list = Effect.fn("OperatorCalls.list")(function* (
      sessionID: string,
      filter?: { after?: string; limit?: number; kind?: string; search?: string },
    ) {
      const { loaded: found, view: all } = yield* full(sessionID)
      const loaded = found.loaded
      // Search: what a call sent (its whole body) and what came back.
      const query = filter?.search?.trim().toLowerCase()
      const matched = query
        ? new Set(
            loaded
              .filter((item) =>
                [JSON.stringify(item.body ?? {}), JSON.stringify(item.call.response ?? {}), item.call.model ?? ""].some(
                  (text) => text.toLowerCase().includes(query),
                ),
              )
              .map((item) => item.call.callID),
          )
        : undefined
      const start = filter?.after ? all.calls.findIndex((call) => call.callID === filter.after) + 1 : 0
      const kinds = filter?.kind ? filter.kind.split(",") : undefined
      const picked = all.calls
        .slice(start)
        .filter((call) =>
          !kinds ? true : kinds.some((kind) => (kind === "errors" ? call.failed : call.kind === kind)),
        )
        .filter((call) => !matched || matched.has(call.callID))
      return { ...all, calls: filter?.limit ? picked.slice(0, filter.limit) : picked }
    })

    // The request's Dynamic layers' resolutions, as stored with the call (an old or unreadable blob: none).
    const decodeResolutions = Schema.decodeUnknownOption(Schema.Array(OperatorCallView.Resolution))
    const resolutionsOf = Effect.fnUntraced(function* (call: OperatorCallStore.Call | undefined) {
      if (!call?.resolutions) return undefined
      const text = yield* Effect.promise(() => OperatorCallStore.blob(call.sessionID, call.resolutions!))
      if (text === undefined) return undefined
      const parsed = (() => {
        try {
          return JSON.parse(text) as unknown
        } catch {
          return undefined
        }
      })()
      return Option.getOrUndefined(decodeResolutions(parsed))
    })

    const detail = Effect.fn("OperatorCalls.detail")(function* (sessionID: string, callID: string) {
      const loaded = yield* load(sessionID)
      const found = OperatorCallView.detail(loaded.input, callID)
      if (!found) return yield* new NotFoundError({ message: `No call ${callID} in session ${sessionID}` })
      const { base, accountings } = yield* accounted(sessionID, loaded, callID)
      const at = base.calls.findIndex((call) => call.callID === callID)
      const accounting = accountings[at]
      const resolutions = yield* resolutionsOf(loaded.loaded.find((item) => item.call.callID === callID)?.call)
      return {
        ...found,
        ...(accounting ? { billing: OperatorCallView.billingOf(accounting), accounting } : {}),
        ...(resolutions ? { resolutions } : {}),
      }
    })

    const raw = Effect.fn("OperatorCalls.raw")(function* (
      sessionID: string,
      callID: string,
      part: "request" | "response",
    ) {
      const calls = yield* Effect.promise(() => OperatorCallStore.list(sessionID))
      const call = calls.find((item) => item.callID === callID)
      if (!call) return yield* new NotFoundError({ message: `No call ${callID} in session ${sessionID}` })
      const text =
        part === "request"
          ? yield* Effect.promise(() => OperatorCallStore.body(call))
          : call.response?.parsed === false && call.response.raw !== undefined
            ? call.response.raw
            : JSON.stringify(call.response ?? call.error ?? null, null, 2)
      return { text, bytes: Buffer.byteLength(text) }
    })

    const exportSession = Effect.fn("OperatorCalls.export")(function* (sessionID: string, format: "md" | "json") {
      const { loaded, view, accountings } = yield* full(sessionID)
      if (format === "json")
        return {
          format,
          text: JSON.stringify(
            {
              sessionID,
              totals: view.totals,
              session: view.session,
              turns: view.turns,
              unrecorded: view.unrecorded,
              calls: view.calls.map((summary, at) => ({
                ...summary,
                accounting: OperatorCallAccounting.lean(accountings[at]!),
                request: loaded.loaded[at]!.text,
                response: loaded.loaded[at]!.call.response ?? null,
                error: loaded.loaded[at]!.call.error,
              })),
            },
            null,
            2,
          ),
        }
      return { format, text: OperatorCallView.markdown(loaded.input, view, accountings) }
    })

    const recount = Effect.fn("OperatorCalls.recount")(function* (sessionID: string) {
      yield* Effect.promise(() => OperatorTokenizers.reload())
      yield* Effect.promise(() => OperatorCallStore.clearAccounting(sessionID))
    })

    const tokenizers = Effect.fn("OperatorCalls.tokenizers")(function* () {
      yield* Effect.promise(() => OperatorTokenizers.ready())
      return OperatorTokenizers.list()
    })

    const count = Effect.fn("OperatorCalls.count")(function* (input: { model?: string; text: string }) {
      yield* Effect.promise(() => OperatorTokenizers.ready())
      return OperatorTokenizers.countFor(input.model, input.text)
    })

    const last = Effect.fn("OperatorCalls.last")(function* (agent: string) {
      const ctx = yield* InstanceState.context
      const projectKey = yield* Effect.promise(() => OperatorProjects.keyOf(ctx))
      const found = yield* Effect.promise(() => OperatorCallStore.latest(projectKey, agent))
      if (!found) return { captured: false }
      const call = (yield* Effect.promise(() => OperatorCallStore.list(found.sessionID))).find(
        (item) => item.callID === found.callID,
      )
      if (!call) return { captured: false }
      const key = OperatorCallFormat.refs(call.request.body).tools
      const tools = key ? yield* Effect.promise(() => OperatorCallStore.blob(call.sessionID, key)) : undefined
      return {
        captured: true,
        at: call.startedAt,
        sessionID: call.sessionID,
        callID: call.callID,
        ...(call.model ? { model: call.model } : {}),
        format: call.format,
        ...(tools !== undefined ? { tools, bytes: Buffer.byteLength(tools) } : {}),
        ...(call.response?.usage?.input !== undefined ? { inputTokens: call.response.usage.input } : {}),
      }
    })

    return Service.of({ begin, list, detail, raw, export: exportSession, last, recount, tokenizers, count })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Session.node, Config.node, Provider.node] })
