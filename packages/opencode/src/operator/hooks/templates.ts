export * as OperatorHookTemplates from "./templates"

import { OperatorHookEvents } from "./events"

// What the console's New script and Test start from (SPEC-0022 §10.2, §10.4): a sample of what each event sends
// (§7.6), and a script per language that reads it and prints a valid answer for the event. A template answers
// nothing ("no objection") until it's edited, so a new hook changes nothing by itself.

export const LANGUAGES = ["shell", "python", "javascript"] as const
export type Language = (typeof LANGUAGES)[number]
export const EXTENSIONS: Record<Language, string> = { shell: ".sh", python: ".py", javascript: ".js" }

const base = (event: OperatorHookEvents.Name) => ({
  event,
  hook: "example",
  level: "project",
  time: "2026-10-21T14:02:11.204Z",
  session: { id: "ses_example", parentID: null, title: "Fix the login test" },
  agent: { name: "build", type: "usual" },
  project: { id: "7k3mq", name: "web", folder: "/home/me/web" },
  namespace: { id: "acme", name: "Acme" },
  cwd: "/home/me/web",
  model: { provider: "openrouter", id: "anthropic/claude-sonnet-4" },
})

const added: Record<OperatorHookEvents.Name, Record<string, unknown>> = {
  "session.created": {},
  "session.deleted": {},
  "prompt.submitted": { prompt: "Fix the failing login test", files: [] },
  "turn.before": { turn: 3, prompt: "Fix the failing login test" },
  "turn.after": {
    turn: 3,
    steps: 4,
    finish: "stop",
    usage: { input: 18200, output: 640, cached: 15000 },
    cost: 0.021,
  },
  "step.before": { turn: 3, step: 2, messages: 9, tokensEstimate: 18000 },
  "step.after": {
    turn: 3,
    step: 2,
    finish: "tool-calls",
    usage: { input: 9100, output: 120, cached: 7500 },
    cost: 0.004,
    tools: ["bash"],
  },
  "tool.before": { tool: "bash", callID: "call_example", input: { command: "bun test", description: "Run the tests" } },
  "tool.after": {
    tool: "bash",
    callID: "call_example",
    input: { command: "bun test", description: "Run the tests" },
    output: "12 pass\n0 fail",
    title: "Run the tests",
    durationMs: 1840,
  },
  "subagent.before": {
    callID: "call_example",
    subagent: "general",
    prompt: "Find where the session token is set",
    description: "Find the token",
  },
  "subagent.after": {
    callID: "call_example",
    subagent: "general",
    childSessionID: "ses_child",
    output: "It's set in src/auth/session.ts:42.",
  },
  "permission.asked": {
    permission: "bash",
    patterns: ["git push origin main"],
    tool: "bash",
    callID: "call_example",
    metadata: { command: "git push origin main" },
  },
  "compaction.before": { reason: "overflow", tokens: 182000 },
  "compaction.after": { autoContinue: true },
  "session.error": { error: { name: "APIError", message: "rate limited" } },
  "file.edited": { file: "/home/me/web/src/auth/session.ts", tool: "edit", callID: "call_example" },
}

/** A sample of what the event sends, for Test. */
export function sample(event: OperatorHookEvents.Name, hook = "example", level = "project") {
  return { ...base(event), hook, level, ...added[event] }
}

// What the template's answer could be, as a comment: the fields the event uses (§8).
function answers(event: OperatorHookEvents.Name) {
  const fields = OperatorHookEvents.of(event).fields
  const lines: string[] = []
  if (fields.includes("allow")) lines.push('{"allow": false, "reason": "…"}  refuses')
  if (fields.includes("input")) lines.push('{"input": {…}}  runs the tool with this input instead')
  if (fields.includes("prompt")) lines.push('{"prompt": "…"}  replaces the text')
  if (fields.includes("output")) lines.push('{"output": "…"}  replaces the result the model gets')
  if (fields.includes("context")) lines.push('{"context": "…"}  adds text for the model')
  if (fields.includes("continue")) lines.push('{"continue": false}  no automatic "continue" turn')
  return lines
}

/** A script for the event that reads its input and prints nothing (no objection), with what it could answer. */
export function script(event: OperatorHookEvents.Name, language: Language) {
  const kind = OperatorHookEvents.of(event).kind
  const intro = [
    `${event}: ${kind === "blocking" ? "the session waits for this script's answer" : "runs alongside the session; its answer changes nothing"}.`,
    "It gets the event as one JSON object on stdin, and prints nothing or one JSON object.",
    ...(answers(event).length ? ["It could answer:", ...answers(event).map((line) => `  ${line}`)] : []),
  ]
  if (language === "shell")
    return [
      "#!/bin/sh",
      ...intro.map((line) => `# ${line}`),
      "input=$(cat)",
      "",
      "# Nothing printed: no objection.",
      "exit 0",
      "",
    ].join("\n")
  if (language === "python")
    return [
      "#!/usr/bin/env python3",
      ...intro.map((line) => `# ${line}`),
      "import json",
      "import sys",
      "",
      "event = json.load(sys.stdin)",
      "",
      "# Nothing printed: no objection. To answer, print one object, e.g. print(json.dumps({...}))",
      "",
    ].join("\n")
  return [
    "#!/usr/bin/env bun",
    ...intro.map((line) => `// ${line}`),
    "const event = JSON.parse(await Bun.stdin.text())",
    "",
    "// Nothing printed: no objection. To answer, print one object, e.g. console.log(JSON.stringify({ ... }))",
    "void event",
    "",
  ].join("\n")
}
