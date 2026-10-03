import path from "path"
import { BashArity } from "@/permission/arity"
import type { MergeAdapter } from "../adapter"

// Maps Claude Code tool calls onto OpenCode's tool names and input keys so the TUI and web app can
// reuse their native renderers, and onto OpenCode permission names so Claude's approval requests
// are shown and remembered like OpenCode's own.

const READ_ONLY = new Set(["read", "glob", "grep", "webfetch", "websearch", "todowrite", "toolsearch", "list"])

export function describe(name: string, input: Record<string, unknown>, cwd: string): MergeAdapter.ToolView {
  switch (name) {
    case "Bash":
      return {
        tool: "bash",
        input: pick(input, { command: "command", description: "description", timeout: "timeout" }),
      }
    case "Read":
      return {
        tool: "read",
        input: { ...pick(input, { offset: "offset", limit: "limit" }), filePath: file(input, cwd) },
      }
    case "Write":
      return { tool: "write", input: { filePath: file(input, cwd), content: input.content } }
    case "Edit":
      return {
        tool: "edit",
        input: {
          filePath: file(input, cwd),
          oldString: input.old_string,
          newString: input.new_string,
          replaceAll: input.replace_all,
        },
      }
    case "MultiEdit":
    case "NotebookEdit":
      return { tool: "edit", input: { filePath: file(input, cwd) ?? input.notebook_path } }
    case "Glob":
      return { tool: "glob", input: pick(input, { pattern: "pattern", path: "path" }) }
    case "Grep":
      return { tool: "grep", input: pick(input, { pattern: "pattern", path: "path", include: "glob" }) }
    case "WebFetch":
      return { tool: "webfetch", input: pick(input, { url: "url", prompt: "prompt" }) }
    case "WebSearch":
      return { tool: "websearch", input: pick(input, { query: "query" }) }
    case "TodoWrite":
      return { tool: "todowrite", input: { todos: input.todos } }
    case "Task":
    case "Agent":
      return {
        tool: "task",
        input: pick(input, { description: "description", prompt: "prompt", subagent_type: "subagent_type" }),
      }
    default:
      return { tool: name, input }
  }
}

export function permission(name: string, input: Record<string, unknown>, cwd: string): MergeAdapter.PermissionView {
  const target = file(input, cwd)
  const relative = typeof target === "string" ? path.relative(cwd, target) || "." : undefined
  switch (name) {
    case "Bash": {
      const command = typeof input.command === "string" ? input.command : ""
      const tokens = command.trim().split(/\s+/).filter(Boolean)
      return {
        permission: "bash",
        patterns: [command],
        always: tokens.length ? [BashArity.prefix(tokens).join(" ") + " *"] : [],
        metadata: { command, description: input.description },
        readOnly: false,
      }
    }
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return {
        permission: "edit",
        patterns: [relative ?? "*"],
        always: ["*"],
        metadata: { filepath: target },
        readOnly: false,
      }
    case "Read":
      return view("read", relative ?? "*", { filepath: target })
    case "Glob":
    case "Grep":
      return view(name.toLowerCase(), typeof input.pattern === "string" ? input.pattern : "*", {})
    case "WebFetch":
      return view("webfetch", typeof input.url === "string" ? input.url : "*", { url: input.url })
    case "WebSearch":
      return view("websearch", typeof input.query === "string" ? input.query : "*", { query: input.query })
    case "TodoWrite":
      return view("todowrite", "*", {})
    case "ExitPlanMode":
      return { permission: "plan_exit", patterns: ["*"], always: [], metadata: { plan: input.plan }, readOnly: false }
    case "Task":
    case "Agent":
      return {
        permission: "task",
        patterns: [typeof input.subagent_type === "string" ? input.subagent_type : "*"],
        always: ["*"],
        metadata: { description: input.description },
        readOnly: false,
      }
    default:
      return { permission: name.toLowerCase(), patterns: ["*"], always: ["*"], metadata: { input }, readOnly: false }
  }
}

function view(permission: string, pattern: string, metadata: Record<string, unknown>): MergeAdapter.PermissionView {
  return { permission, patterns: [pattern], always: ["*"], metadata, readOnly: READ_ONLY.has(permission) }
}

function file(input: Record<string, unknown>, cwd: string) {
  const value = input.file_path ?? input.notebook_path
  if (typeof value !== "string") return undefined
  return path.isAbsolute(value) ? value : path.join(cwd, value)
}

function pick(input: Record<string, unknown>, keys: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(keys).flatMap(([to, from]) => (input[from] === undefined ? [] : [[to, input[from]]])),
  )
}

export * as ClaudeTools from "./tools"
