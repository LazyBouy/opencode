export * as SessionMerge from "./session-merge"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { ascending } from "./identifier"
import { NonNegativeInt, optional, statics } from "./schema"
import { SessionID } from "./session-id"

export const ID = Schema.String.check(Schema.isStartsWith("mrg_")).pipe(
  Schema.brand("SessionMerge.ID"),
  statics((schema) => ({ create: () => schema.make("mrg_" + ascending()) })),
)
export type ID = typeof ID.Type

export const Transport = Schema.Literals(["cli", "http", "grpc"]).annotate({ identifier: "SessionMerge.Transport" })
export type Transport = typeof Transport.Type

export const Status = Schema.Literals(["starting", "live", "detached", "closed", "error"]).annotate({
  identifier: "SessionMerge.Status",
})
export type Status = typeof Status.Type

export const Adapter = Schema.Struct({
  id: Schema.String.annotate({ description: "Adapter id used by `/merge <id>`, for example `claude`" }),
  name: Schema.String,
  transports: Schema.Array(Transport),
  enabled: Schema.Boolean.annotate({ description: "False when turned off with `merge.adapters.<id>.enabled`" }),
  available: Schema.Boolean.annotate({ description: "Whether the adapter's program was found and is new enough" }),
  binary: Schema.String.pipe(optional),
  version: Schema.String.pipe(optional),
  message: Schema.String.pipe(optional).annotate({ description: "Why the adapter is unavailable" }),
}).annotate({ identifier: "SessionMerge.Adapter" })
export type Adapter = typeof Adapter.Type

export const Binding = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  adapter: Schema.String.annotate({ description: "Harness adapter id, for example `claude`" }),
  transport: Transport,
  externalSessionID: Schema.String.pipe(optional),
  cwd: Schema.String,
  status: Status,
  args: Schema.Array(Schema.String).annotate({ description: "Passthrough arguments reapplied on every child turn" }),
  error: Schema.String.pipe(optional),
  time: Schema.Struct({
    created: NonNegativeInt,
    updated: NonNegativeInt,
    lastEvent: NonNegativeInt.pipe(optional),
    detached: NonNegativeInt.pipe(optional),
  }),
  process: Schema.Struct({
    pid: NonNegativeInt,
    started: NonNegativeInt,
  }).pipe(optional),
}).annotate({ identifier: "SessionMerge.Binding" })
export interface Binding extends Schema.Schema.Type<typeof Binding> {}

// Provenance stamped on every part projected from, or written about, a merged child session.
// `projection` parts are display-only and never reach OpenCode's model; `summary` is the one
// model-visible digest per child turn; `notice` records `/merge` command output.
export const Origin = Schema.Struct({
  type: Schema.Literal("merge"),
  bindingID: ID,
  adapter: Schema.String,
  externalSessionID: Schema.String.pipe(optional),
  externalEventID: Schema.String.pipe(optional),
  role: Schema.Literals(["projection", "summary", "notice"]),
}).annotate({ identifier: "SessionMerge.Origin" })
export interface Origin extends Schema.Schema.Type<typeof Origin> {}

export function visibleToModel(part: { origin?: Origin }) {
  return part.origin?.type !== "merge" || part.origin.role === "summary"
}

/** Raw child content: excluded from share and export unless the user opts into the foreign transcript. */
export function isProjection(part: { origin?: Origin }) {
  return part.origin?.type === "merge" && part.origin.role === "projection"
}

const Updated = define({
  type: "session.merge.updated",
  schema: {
    sessionID: SessionID,
    binding: Schema.NullOr(Binding),
  },
})
export const Event = { Updated, Definitions: inventory(Updated) }
