import { Effect } from "effect"
import { MergeAdapter } from "../adapter"

// Flags OpenCode owns: the output/control protocol, permission plumbing, session identity, and
// anything that could swap Claude's settings or route the turn off this machine.
const REJECTED = new Set([
  "-p",
  "--print",
  "--output-format",
  "--input-format",
  "--include-partial-messages",
  "--verbose",
  "--replay-user-messages",
  "--permission-prompt-tool",
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "-r",
  "--resume",
  "-c",
  "--continue",
  "--session-id",
  "--fork-session",
  "--no-session-persistence",
  "--settings",
  "--setting-sources",
  "--sdk-url",
  "--remote",
  "--teleport",
  "--ide",
  "--json-schema",
])

// Only a `build` parent may choose Claude's own approval posture.
const BUILD_ONLY = new Set(["--permission-mode", "--allowedTools", "--allowed-tools"])

const MODES = new Set(["default", "acceptEdits", "auto", "dontAsk", "plan"])

export function validate(args: ReadonlyArray<string>, parent: MergeAdapter.Parent) {
  return Effect.gen(function* () {
    if (args.length > 0 && !args[0].startsWith("-"))
      return yield* new MergeAdapter.InvalidArgs({
        message: `Unexpected argument "${args[0]}": pass Claude flags after "--", for example "-- --model haiku"`,
      })
    for (const [index, token] of args.entries()) {
      if (token.includes("bypassPermissions"))
        return yield* new MergeAdapter.InvalidArgs({
          message: "bypassPermissions is never allowed in a merged session",
        })
      if (!token.startsWith("-")) continue
      const flag = token.split("=")[0]
      if (REJECTED.has(flag))
        return yield* new MergeAdapter.InvalidArgs({ message: `${flag} is managed by OpenCode and cannot be passed` })
      if (!BUILD_ONLY.has(flag)) continue
      const value = token.includes("=") ? token.slice(flag.length + 1) : args[index + 1]
      if (flag === "--permission-mode" && (!value || !MODES.has(value)))
        return yield* new MergeAdapter.InvalidArgs({
          message: `--permission-mode must be one of ${[...MODES].join(", ")}`,
        })
      if (parent === "plan" && !(flag === "--permission-mode" && value === "plan"))
        return yield* new MergeAdapter.InvalidArgs({
          message: `${flag} is not allowed while the OpenCode agent is in plan mode`,
        })
    }
  })
}

export function resolveMode(args: ReadonlyArray<string>, parent: MergeAdapter.Parent) {
  if (parent === "plan") return "plan"
  return (
    args
      .flatMap((token, index) => {
        if (token.startsWith("--permission-mode=")) return [token.slice("--permission-mode=".length)]
        if (token === "--permission-mode" && args[index + 1]) return [args[index + 1]]
        return []
      })
      .findLast((mode) => MODES.has(mode)) ?? "default"
  )
}

// The adapter sets `--permission-mode` itself from `resolveMode`; drop the user's copy. A plan
// parent also drops `--allowedTools`, in case it was stored while the parent was `build`.
export function forSpawn(args: ReadonlyArray<string>, parent: MergeAdapter.Parent) {
  const strip = parent === "plan" ? BUILD_ONLY : new Set(["--permission-mode"])
  return args.reduce(
    (state, token) => {
      if (token.startsWith("-")) {
        const flag = token.split("=")[0]
        if (strip.has(flag)) return { kept: state.kept, skipping: !token.includes("=") }
        return { kept: [...state.kept, token], skipping: false }
      }
      if (state.skipping) return state
      return { kept: [...state.kept, token], skipping: false }
    },
    { kept: [] as string[], skipping: false },
  ).kept
}

export * as ClaudeArgs from "./args"
