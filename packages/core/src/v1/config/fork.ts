export * as ConfigForkV1 from "./fork"

import { Schema } from "effect"
import { ConfigMergeV1 } from "./merge"

// Top-level config keys this fork adds. ConfigV1.Info spreads these fields once, so new fork
// settings are added here without editing upstream's schema.
export const fields = {
  merge: Schema.optional(ConfigMergeV1.Info).annotate({
    description: "Settings for `/merge`, which attaches external agent sessions such as Claude Code",
  }),
}
