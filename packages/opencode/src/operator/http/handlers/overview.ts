import { OperatorInbox } from "@/operator/inbox"
import { OperatorOverview } from "@/operator/overview"
import { OperatorRootApi } from "../groups/overview"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"

export const operatorOverviewHandlers = HttpApiBuilder.group(OperatorRootApi, "operatorOverview", (handlers) =>
  Effect.gen(function* () {
    const overview = yield* OperatorOverview.Service
    const inbox = yield* OperatorInbox.Service

    return handlers
      .handle("status", () => Effect.sync(() => overview.status()))
      .handle("sessions", (ctx) => overview.sessions(ctx.query))
      .handle("stats", (ctx) => overview.stats({ days: ctx.query.days ?? 14, offset: ctx.query.offset ?? 0 }))
      .handle("permissions", () => Effect.sync(() => inbox.pending()))
  }),
)
