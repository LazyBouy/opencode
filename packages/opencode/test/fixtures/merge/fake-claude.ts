// A stand-in for the `claude` CLI used by merge tests. It speaks the same stream-json protocol that
// `claude -p --output-format stream-json --input-format stream-json --permission-prompt-tool stdio`
// speaks (captured from Claude Code 2.1.123 in test/fixtures/merge/claude/*.ndjson), replays a
// scripted turn, and logs what it received so tests can assert on argv and control responses.
//
// Environment:
//   FAKE_CLAUDE_SCRIPT  JSON file `{ turns: Step[][] }`; invocation N plays turns[min(N, last)]
//   FAKE_CLAUDE_LOG     NDJSON log appended with `start`, `stdin`, `exit` and `grandchild` records
//   FAKE_CLAUDE_GATE    a `{ gate: true }` step waits until this file exists
//   CLAUDE_CONFIG_DIR   transcripts are written under `<dir>/projects/<slug(cwd)>/<id>.jsonl`
import fs from "fs"
import path from "path"
import readline from "readline"
import { spawn } from "child_process"

type Step =
  | { text: string }
  | { thinking: string }
  | { tool: string; input: Record<string, unknown>; output?: string; ask?: boolean; error?: boolean }
  | { gate: true }
  | { hang: true }

const argv = process.argv.slice(2)
const log = (record: Record<string, unknown>) =>
  process.env.FAKE_CLAUDE_LOG &&
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ pid: process.pid, ...record }) + "\n")

if (argv.includes("--version")) {
  process.stdout.write("2.1.123 (Claude Code)\n")
  process.exit(0)
}

const flag = (name: string) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}
const newID = flag("--session-id")
const resumeID = flag("--resume")
const id = newID ?? resumeID ?? crypto.randomUUID()
const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME ?? "", ".claude")
const transcript = path.join(configDir, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`)
const starts = process.env.FAKE_CLAUDE_LOG
  ? fs
      .readFileSync(process.env.FAKE_CLAUDE_LOG, { flag: "a+", encoding: "utf8" })
      .split("\n")
      .filter((line) => line.includes('"kind":"start"')).length
  : 0
log({
  kind: "start",
  argv,
  cwd: process.cwd(),
  env: { CLAUDECODE: process.env.CLAUDECODE, OPENCODE_SERVER_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD },
})

const write = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n")
const finish = (code: number) => {
  log({ kind: "exit", code })
  process.exit(code)
}

if (newID && fs.existsSync(transcript)) {
  process.stderr.write(`Error: Session ID ${newID} is already in use.\n`)
  finish(1)
}
if (resumeID && !fs.existsSync(transcript)) {
  write({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    num_turns: 0,
    session_id: crypto.randomUUID(),
    errors: [`No conversation found with session ID: ${resumeID}`],
  })
  finish(1)
}

const script: { turns: Step[][] } = JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_SCRIPT ?? "", "utf8"))
const steps = script.turns[Math.min(starts, script.turns.length - 1)] ?? []
const responses = new Map<string, (value: Record<string, unknown>) => void>()
const pendingResponses = new Map<string, Record<string, unknown>>()
const prompt = new Promise<string>((resolve) => {
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    if (!line.trim()) return
    const message = JSON.parse(line)
    log({ kind: "stdin", message })
    if (message.type === "user") resolve(message.message.content.map((item: { text: string }) => item.text).join("\n"))
    if (message.type === "control_response") {
      const requestID = message.response.request_id
      const waiter = responses.get(requestID)
      if (waiter) waiter(message.response.response)
      if (!waiter) pendingResponses.set(requestID, message.response.response)
    }
    if (message.type === "control_request" && message.request.subtype === "interrupt") {
      write({ type: "control_response", response: { subtype: "success", request_id: message.request_id } })
      write({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "aborted_streaming",
        session_id: id,
      })
      finish(1)
    }
  })
})
const response = (requestID: string) =>
  new Promise<Record<string, unknown>>((resolve) => {
    const early = pendingResponses.get(requestID)
    if (early) return resolve(early)
    responses.set(requestID, resolve)
  })

const user = await prompt
fs.mkdirSync(path.dirname(transcript), { recursive: true })
fs.appendFileSync(
  transcript,
  JSON.stringify({ type: "user", message: { role: "user", content: user }, cwd: process.cwd() }) + "\n",
)
const mode = flag("--permission-mode") ?? "default"
write({
  type: "system",
  subtype: "init",
  session_id: id,
  model: "claude-fake-1",
  permissionMode: mode,
  cwd: process.cwd(),
})

let last = ""
let message = 0
for (const step of steps) {
  const msg = `msg_fake_${++message}`
  if ("text" in step || "thinking" in step) {
    const kind = "text" in step ? "text" : "thinking"
    const value = "text" in step ? step.text : step.thinking
    write({ type: "stream_event", event: { type: "message_start", message: { id: msg } }, parent_tool_use_id: null })
    write({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: kind } },
      parent_tool_use_id: null,
    })
    for (const chunk of [value.slice(0, Math.ceil(value.length / 2)), value.slice(Math.ceil(value.length / 2))]) {
      if (!chunk) continue
      const delta = kind === "text" ? { type: "text_delta", text: chunk } : { type: "thinking_delta", thinking: chunk }
      write({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta }, parent_tool_use_id: null })
    }
    write({
      type: "assistant",
      message: {
        id: msg,
        content: [kind === "text" ? { type: "text", text: value } : { type: "thinking", thinking: value }],
      },
      parent_tool_use_id: null,
    })
    write({ type: "stream_event", event: { type: "content_block_stop", index: 0 }, parent_tool_use_id: null })
    write({ type: "stream_event", event: { type: "message_stop" }, parent_tool_use_id: null })
    if (kind === "text") last = value
    continue
  }
  if ("gate" in step) {
    while (!fs.existsSync(process.env.FAKE_CLAUDE_GATE ?? "")) await Bun.sleep(20)
    continue
  }
  if ("hang" in step) {
    const child = spawn("sleep", ["600"], { stdio: "ignore" })
    log({ kind: "grandchild", child: child.pid })
    await new Promise(() => {})
  }
  if ("tool" in step) {
    const toolID = `toolu_fake_${message}`
    write({
      type: "assistant",
      message: { id: msg, content: [{ type: "tool_use", id: toolID, name: step.tool, input: step.input }] },
      parent_tool_use_id: null,
    })
    if (step.ask) {
      const requestID = `req_fake_${message}`
      write({
        type: "control_request",
        request_id: requestID,
        request: { subtype: "can_use_tool", tool_name: step.tool, input: step.input, tool_use_id: toolID },
      })
      const decision = await response(requestID)
      log({ kind: "decision", requestID, decision })
      if (decision.behavior !== "allow") {
        write({
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: toolID, content: String(decision.message), is_error: true }],
          },
          parent_tool_use_id: null,
        })
        if (decision.interrupt) {
          write({
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            terminal_reason: "aborted_tools",
            session_id: id,
            permission_denials: [{ tool_name: step.tool, tool_input: step.input }],
          })
          finish(1)
        }
        continue
      }
    }
    write({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: toolID, content: step.output ?? "", is_error: step.error === true },
        ],
      },
      parent_tool_use_id: null,
    })
  }
}

write({
  type: "result",
  subtype: "success",
  is_error: false,
  result: last,
  session_id: id,
  total_cost_usd: 0.001,
  duration_ms: 5,
  num_turns: 1,
  terminal_reason: "completed",
  permission_denials: [],
})
process.stdin.on("end", () => finish(0))
