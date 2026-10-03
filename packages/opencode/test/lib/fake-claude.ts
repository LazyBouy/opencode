import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Env } from "../../src/env"
import { tmpdirScoped } from "../fixture/fixture"

// Installs test/fixtures/merge/fake-claude.ts as `claude` on the instance PATH (through the
// per-instance Env service, so nothing global changes) and exposes its log.

export type Step =
  | { text: string }
  | { thinking: string }
  | { tool: string; input: Record<string, unknown>; output?: string; ask?: boolean; error?: boolean }
  | { gate: true }
  | { hang: true }

export type LogEntry =
  | { kind: "start"; pid: number; argv: string[]; cwd: string; env: Record<string, string | undefined> }
  | { kind: "stdin"; pid: number; message: { type: string; [key: string]: unknown } }
  | {
      kind: "decision"
      pid: number
      requestID: string
      decision: { behavior: string; message?: string; interrupt?: boolean }
    }
  | { kind: "grandchild"; pid: number; child: number }
  | { kind: "exit"; pid: number; code: number }

const FAKE = path.join(import.meta.dir, "..", "fixtures", "merge", "fake-claude.ts")

export const install = Effect.fn("test.fakeClaude.install")(function* (turns: Step[][]) {
  const root = yield* tmpdirScoped()
  const bin = path.join(root, "bin")
  const files = {
    script: path.join(root, "script.json"),
    log: path.join(root, "log.ndjson"),
    gate: path.join(root, "gate"),
    config: path.join(root, "claude-config"),
  }
  yield* Effect.promise(async () => {
    await fs.mkdir(bin, { recursive: true })
    await fs.writeFile(path.join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, {
      mode: 0o755,
    })
    await fs.writeFile(files.script, JSON.stringify({ turns }))
    await fs.writeFile(files.log, "")
  })
  // Env is per-instance state, so a reloaded instance needs the variables applied again.
  const apply = Env.Service.use((current) =>
    Effect.all(
      [
        current.set("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`),
        current.set("CLAUDE_CONFIG_DIR", files.config),
        current.set("FAKE_CLAUDE_SCRIPT", files.script),
        current.set("FAKE_CLAUDE_LOG", files.log),
        current.set("FAKE_CLAUDE_GATE", files.gate),
      ],
      { discard: true },
    ),
  )
  yield* apply
  return {
    root,
    apply,
    config: files.config,
    log: Effect.promise(() => fs.readFile(files.log, "utf8")).pipe(
      Effect.map((text) =>
        text
          .split("\n")
          .filter(Boolean)
          .map((line): LogEntry => JSON.parse(line)),
      ),
    ),
    open: Effect.promise(() => fs.writeFile(files.gate, "")),
  }
})

/** Points PATH at an empty directory so no `claude` binary can be found. */
export const uninstall = Effect.fn("test.fakeClaude.uninstall")(function* () {
  const root = yield* tmpdirScoped()
  const env = yield* Env.Service
  yield* env.set("PATH", root)
})

export const starts = (entries: ReadonlyArray<LogEntry>) =>
  entries.filter((entry): entry is Extract<LogEntry, { kind: "start" }> => entry.kind === "start")

export const decisions = (entries: ReadonlyArray<LogEntry>) =>
  entries.filter((entry): entry is Extract<LogEntry, { kind: "decision" }> => entry.kind === "decision")

export function flag(argv: ReadonlyArray<string>, name: string) {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

export function alive(pid: number) {
  return Effect.try({ try: () => process.kill(pid, 0), catch: () => false }).pipe(Effect.orElseSucceed(() => false))
}

export * as FakeClaude from "./fake-claude"
