import path from "path"
import type { MergeAdapter } from "./adapter/adapter"

// The summary is the only content from a merged turn that a later OpenCode-model turn may see.
// It is built from what the child did, never from raw tool output, and is capped.

const MAX_SUMMARY = 4000
const MAX_RESULT = 1500
const MAX_COMMANDS = 10

export interface Collector {
  readonly observe: (event: MergeAdapter.Event) => void
  readonly deny: (tool: string, reason: string) => void
  readonly interrupted: () => void
  readonly render: (input: {
    adapter: string
    externalSessionID: string
    cwd: string
    files: ReadonlyArray<string>
  }) => {
    text: string
    metadata: Record<string, unknown>
  }
}

export function collector(): Collector {
  const texts = new Map<string, string>()
  const files = new Set<string>()
  const commands: string[] = []
  const denied: string[] = []
  const state = { interrupted: false, done: undefined as Extract<MergeAdapter.Event, { type: "done" }> | undefined }

  return {
    observe(event) {
      if (event.type === "text-start") texts.set(event.id, "")
      if (event.type === "text-delta") texts.set(event.id, (texts.get(event.id) ?? "") + event.text)
      if (event.type === "tool" && event.input) {
        const target = event.input.file_path ?? event.input.notebook_path
        if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(event.name) && typeof target === "string")
          files.add(target)
        if (event.name === "Bash" && typeof event.input.command === "string") commands.push(event.input.command)
      }
      if (event.type === "done") {
        state.done = event
        if (event.interrupted) state.interrupted = true
        event.denials.forEach((item) => denied.push(item.tool))
      }
    },
    deny(tool, reason) {
      denied.push(`${tool} (${reason})`)
    },
    interrupted() {
      state.interrupted = true
    },
    render(input) {
      const last = [...texts.values()].findLast((text) => text.trim().length > 0)?.trim()
      const result = state.done?.result?.trim() || last
      const changed = [...new Set([...files, ...input.files])].map((file) =>
        path.isAbsolute(file) ? path.relative(input.cwd, file) || file : file,
      )
      const lines = [
        `[Merged ${input.adapter} session ${input.externalSessionID} · cwd ${input.cwd}${state.interrupted ? " · interrupted" : ""}]`,
        changed.length ? `Files changed: ${changed.join(", ")}` : undefined,
        commands.length
          ? ["Commands run:", ...commands.slice(0, MAX_COMMANDS).map((command) => `- ${firstLine(command)}`)].join("\n")
          : undefined,
        commands.length > MAX_COMMANDS ? `(${commands.length - MAX_COMMANDS} more commands)` : undefined,
        denied.length ? `Denied: ${[...new Set(denied)].join(", ")}` : undefined,
        state.done?.errors.length ? `Errors: ${state.done.errors.join("; ")}` : undefined,
        result ? `Result: ${truncate(result, MAX_RESULT)}` : undefined,
      ].filter((line) => line !== undefined)
      return {
        text: truncate(lines.join("\n"), MAX_SUMMARY),
        metadata: {
          costUSD: state.done?.costUSD,
          durationMs: state.done?.durationMs,
          turns: state.done?.turns,
          interrupted: state.interrupted,
        },
      }
    },
  }
}

function firstLine(text: string) {
  const line = text.split("\n")[0]
  return line.length < text.length ? `${line} …` : line
}

function truncate(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

export * as MergeSummary from "./summary"
