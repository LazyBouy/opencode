import { OperatorProjectInbox } from "@/operator/messaging/inbox"
import { OperatorMessageLanes } from "@/operator/messaging/lanes"
import { OperatorMessagingSettings } from "@/operator/messaging/settings"
import { OperatorProjectRecords } from "@/operator/project-records"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiProjectInboxInvalidError, ApiProjectInboxNotFoundError } from "../groups/project-inbox"

const invalid = (message: string) =>
  new ApiProjectInboxInvalidError({ name: "OperatorProjectInboxInvalidError", data: { message } })
const notFound = (message: string) =>
  new ApiProjectInboxNotFoundError({ name: "OperatorProjectInboxNotFoundError", data: { message } })
const mapError = (error: OperatorProjectInbox.InvalidError | OperatorProjectInbox.NotFoundError) =>
  error._tag === "OperatorProjectInboxNotFound" ? notFound(error.message) : invalid(error.message)

// A project by its unique id: its folder.
const keyOf = (project: string) =>
  Effect.promise(() => OperatorProjectInbox.projectKeyOf(project)).pipe(
    Effect.flatMap((key) => (key ? Effect.succeed(key) : Effect.fail(notFound(`No project ${project}`)))),
  )

const ME = { kind: "user" } as const

export const operatorProjectInboxHandlers = HttpApiBuilder.group(InstanceHttpApi, "operatorProjectInbox", (handlers) =>
  Effect.gen(function* () {
    const inbox = yield* OperatorProjectInbox.Service
    const settingsOf = (key: string) =>
      Effect.gen(function* () {
        const found = yield* inbox.inbox(key)
        const record = yield* Effect.promise(() => OperatorProjectRecords.get(key))
        return {
          unmatched: found.unmatched,
          ...(record.manager ? { manager: record.manager } : {}),
          transport: inbox.transport().kind,
        }
      })
    return handlers
      .handle("enter", (ctx) =>
        Effect.gen(function* () {
          const key = yield* keyOf(ctx.params.project)
          const payload = ctx.payload
          return yield* inbox
            .enter({
              project: key,
              from: { kind: payload.from === "external" ? "external" : "user" },
              ...(payload.to ? { to: payload.to } : {}),
              body: { type: payload.type ?? "text", text: payload.text },
              ...(payload.priority ? { priority: payload.priority } : {}),
              ...(payload.steer !== undefined ? { steer: payload.steer } : {}),
              ...(payload.correlationID ? { correlationID: payload.correlationID } : {}),
              ...(payload.replyTo ? { replyTo: payload.replyTo } : {}),
            })
            .pipe(Effect.mapError(mapError))
        }),
      )
      .handle("messages", (ctx) =>
        Effect.gen(function* () {
          const key = yield* keyOf(ctx.params.project)
          const limit = Number(ctx.query.limit)
          return yield* inbox.messages(key, {
            ...(ctx.query.status ? { status: ctx.query.status } : {}),
            ...(ctx.query.from ? { from: ctx.query.from } : {}),
            limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 200,
          })
        }),
      )
      .handle("rules", (ctx) => keyOf(ctx.params.project).pipe(Effect.flatMap(inbox.inbox)))
      .handle("setRules", (ctx) =>
        keyOf(ctx.params.project).pipe(
          Effect.flatMap((key) => inbox.setRules(key, ctx.payload.rules).pipe(Effect.mapError(mapError))),
        ),
      )
      .handle("test", (ctx) =>
        keyOf(ctx.params.project).pipe(Effect.flatMap((key) => inbox.test(key, ctx.payload.sample, ctx.payload.rules))),
      )
      .handle("settings", (ctx) => keyOf(ctx.params.project).pipe(Effect.flatMap(settingsOf)))
      .handle("setSettings", (ctx) =>
        keyOf(ctx.params.project).pipe(
          Effect.tap((key) => inbox.setUnmatched(key, ctx.payload.unmatched)),
          Effect.flatMap(settingsOf),
        ),
      )
      .handle("message", (ctx) => inbox.record(ctx.params.id).pipe(Effect.mapError(mapError)))
      .handle("remove", (ctx) => inbox.remove(ctx.params.id).pipe(Effect.as(true), Effect.mapError(mapError)))
      .handle("forward", (ctx) => inbox.forward(ctx.params.id, ctx.payload.to, ME).pipe(Effect.mapError(mapError)))
      .handle("drop", (ctx) => inbox.drop(ctx.params.id, ctx.payload.reason ?? "", ME).pipe(Effect.mapError(mapError)))
      .handle("routeAgain", (ctx) => inbox.routeAgain(ctx.params.id).pipe(Effect.mapError(mapError)))
      .handle("broadcast", (ctx) => inbox.broadcast(ctx.params.id, ME).pipe(Effect.mapError(mapError)))
      .handle("status", () =>
        Effect.sync(() => {
          const transport = inbox.transport()
          return {
            memoryLane: {
              backend: "in-process" as const,
              held: OperatorMessageLanes.lane().list({}).length,
              cap: OperatorMessageLanes.CAP,
            },
            inboxTransport: transport.kind,
            ...(transport.kind === "rabbitmq"
              ? { rabbitmq: transport.connection, rabbitmqHost: transport.host, outbox: transport.outbox }
              : { rabbitmq: "not configured" as const, outbox: 0 }),
            redis: "not configured" as const,
          }
        }),
      )
      .handle("messagingSettings", () => Effect.promise(() => OperatorMessagingSettings.read()))
      .handle("setMessagingSettings", (ctx) =>
        Effect.tryPromise({
          try: () => OperatorMessagingSettings.write(ctx.payload),
          catch: (error) => invalid(error instanceof Error ? error.message : String(error)),
        }),
      )
      .handle("counts", () => inbox.counts())
      .handle("conversation", (ctx) => inbox.conversation(ctx.params.correlationID))
  }),
)
