export * as ConfigMergeV1 from "./merge"

import { Schema } from "effect"

export const Adapter = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Allow `/merge <adapter>` to start or resume sessions with this adapter (default: true)",
  }),
})
export type Adapter = Schema.Schema.Type<typeof Adapter>

export const Info = Schema.Struct({
  adapters: Schema.optional(Schema.Record(Schema.String, Adapter)).annotate({
    description: "Per-adapter settings for `/merge`, keyed by adapter id, for example `claude`",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
