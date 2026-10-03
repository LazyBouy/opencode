#!/usr/bin/env bun
// Records Claude Code's stream-json protocol for the merge adapter's tests.
//
//   bun script/merge-claude-spike.ts            run every scenario against the real `claude` and
//                                               write scrubbed fixtures (costs a few cents; uses
//                                               your own Claude login, never reads credentials)
//   bun script/merge-claude-spike.ts --from dir scrub previously captured raw *.ndjson files
//
// Fixtures land in test/fixtures/merge/claude/. Scrubbing replaces session ids, working
// directories and the home directory with placeholders, drops account and environment detail from
// `system/init`, and removes `rate_limit_event` lines.
import fs from "fs/promises"
import os from "os"
import path from "path"
import { parseArgs } from "util"

const out = path.join(import.meta.dir, "..", "test", "fixtures", "merge", "claude")
const args = parseArgs({ args: Bun.argv.slice(2), options: { from: { type: "string" } } })

type Scenario = {
  name: string
  prompt: string
  mode: string
  policy: "allow" | "deny" | "interrupt"
  resume?: string
}

const scenarios: Scenario[] = [
  { name: "01-new-text", prompt: "Reply with exactly the word: pineapple", mode: "default", policy: "allow" },
  {
    name: "02-resume-bash-allow",
    prompt:
      "What single word did you reply with last time? Then use the Bash tool to run exactly: touch spike-allow.txt",
    mode: "default",
    policy: "allow",
    resume: "01-new-text",
  },
  {
    name: "03-bash-deny",
    prompt: "Use the Bash tool to run exactly: touch spike-deny.txt",
    mode: "default",
    policy: "deny",
  },
  {
    name: "03-bash-interrupt",
    prompt: "Use the Bash tool to run exactly: touch spike-interrupt.txt",
    mode: "default",
    policy: "interrupt",
  },
  {
    name: "05-tools-acceptedits",
    prompt:
      "Do these steps in order, one tool per step, no explanations: 1) Write the file notes.txt with content alpha. 2) Read notes.txt. 3) Edit notes.txt replacing alpha with beta.",
    mode: "acceptEdits",
    policy: "allow",
  },
]

if (args.values.from) {
  const dir = args.values.from
  const files = (await fs.readdir(dir)).filter((file) => file.endsWith(".ndjson"))
  await fs.mkdir(out, { recursive: true })
  for (const file of files)
    await fs.writeFile(path.join(out, file), scrub(await fs.readFile(path.join(dir, file), "utf8")))
  console.log(`scrubbed ${files.length} captures into ${out}`)
  process.exit(0)
}

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "merge-spike-"))
const ids = new Map<string, string>()
await fs.mkdir(out, { recursive: true })
for (const scenario of scenarios) {
  const id = scenario.resume ? ids.get(scenario.resume)! : crypto.randomUUID()
  ids.set(scenario.name, id)
  const raw = await run(scenario, id)
  await fs.writeFile(path.join(out, `${scenario.name}.ndjson`), scrub(raw))
  console.log(`recorded ${scenario.name}`)
}
await fs.rm(workspace, { recursive: true, force: true })

async function run(scenario: Scenario, id: string) {
  const proc = Bun.spawn(
    [
      "claude",
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-prompt-tool",
      "stdio",
      "--permission-mode",
      scenario.mode,
      scenario.resume ? "--resume" : "--session-id",
      id,
      "--model",
      "haiku",
      "--max-budget-usd",
      "0.2",
    ],
    { cwd: workspace, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  )
  const send = (value: unknown) => void proc.stdin.write(JSON.stringify(value) + "\n")
  send({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: scenario.prompt }] },
    parent_tool_use_id: null,
  })
  const lines: string[] = []
  const reader = proc.stdout.getReader()
  let buffer = ""
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += new TextDecoder().decode(chunk.value)
    const parts = buffer.split("\n")
    buffer = parts.pop() ?? ""
    for (const line of parts.filter((item) => item.trim())) {
      lines.push(line)
      const message = JSON.parse(line)
      if (message.type === "control_request" && message.request?.subtype === "can_use_tool") {
        const response =
          scenario.policy === "allow"
            ? { behavior: "allow", updatedInput: message.request.input }
            : { behavior: "deny", message: "denied by spike", interrupt: scenario.policy === "interrupt" }
        send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response } })
      }
      if (message.type === "result") void proc.stdin.end()
    }
  }
  await proc.exited
  return lines.join("\n") + "\n"
}

function scrub(raw: string) {
  const ids = new Map<string, string>()
  const placeholder = (value: string) => {
    if (!ids.has(value)) ids.set(value, ids.size === 0 ? "{{session_id}}" : `{{session_id_${ids.size + 1}}}`)
    return ids.get(value)!
  }
  return (
    raw
      .split("\n")
      .filter((line) => line.trim().startsWith("{"))
      .map((line) => JSON.parse(line))
      .filter((value) => value.type && value.type !== "rate_limit_event")
      .map((value) => {
        if (value.type === "system" && value.subtype === "init")
          return {
            type: "system",
            subtype: "init",
            session_id: value.session_id,
            model: value.model,
            permissionMode: value.permissionMode,
            cwd: value.cwd,
            claude_code_version: value.claude_code_version,
            uuid: value.uuid,
          }
        if (value.type === "result") return { ...value, modelUsage: undefined }
        return value
      })
      .map((value) => {
        const text = JSON.stringify(value)
          .replace(/"session_id":"([0-9a-f-]{36})"/g, (_, id) => `"session_id":"${placeholder(id)}"`)
          .replace(/\/tmp\/[^"\\]*?(merge-spike-[A-Za-z0-9]+|scratchpad\/ws1)/g, "{{cwd}}")
          .replace(new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "{{home}}")
        return text
      })
      .join("\n") + "\n"
  )
}
