export * as OperatorMemoryTool from "./memory-tool"

import { tool } from "@opencode-ai/plugin"
import { createTwoFilesPatch } from "diff"
import { Context, Fiber } from "effect"
import { InstanceRef } from "@/effect/instance-ref"
import { OperatorMemoryFormat as M } from "./memory-format"
import { OperatorMemoryStore } from "./memory-store"
import { OperatorPermissionEffective } from "./permission-effective"
import { OperatorRegistry } from "./registry"
import { OperatorTrashFiles } from "./trash-files"

// The `memory` tool (specs/docs/feedbacks/memory/memory_spec.md §5): list, read, save, update and forget
// short-term memories at three levels. Every action asks the `memory` permission first, as
// `<VERB>(<level>/<file>)` (READ for list and read, WRITE for save and update, FORGET for forget); a
// denied level is left out of list. An incognito session (a subagent) reads namespace and project memory
// only and never writes. Registered through the fork's prompt plugin (plugins.ts); its context comes from
// memory-service.ts through OperatorRegistry. Asks are made here, so a rejection reaches the session loop
// as it is.

// Offered only where memory-service.ts says (the OpenCode namespace opts in).
OperatorPermissionEffective.declareOptIn("memory")

const LEVELS = ["namespace", "project", "agent"] as const
type Level = (typeof LEVELS)[number]

export const DESCRIPTION = [
  "Short-term memory that carries over between sessions, at three levels:",
  "- namespace: facts and conventions for the whole organisation;",
  "- project: this project's decisions and facts;",
  "- agent: what you learned about your work and the user.",
  "Each level's index (MEMORY.md) lists one line per memory; the index may already be in your system prompt.",
  "Actions: list (the index of one level or all), read (a memory's file), save (a new memory), update (change one), forget (remove one; it goes to Trash).",
  "Save only what will help in a later session, never what is in the code or the git history. Update a memory rather than saving a duplicate, and forget memories that turned out wrong.",
].join("\n")

const INCOGNITO =
  "This session runs incognito (a subagent): it can read namespace and project memory, and never saves, updates or forgets."

const describe = (level: Level) => `${level} memory`

export const memoryTool = tool({
  description: DESCRIPTION,
  args: {
    action: tool.schema.enum(["list", "read", "save", "update", "forget"]).describe("What to do"),
    level: tool.schema
      .enum(LEVELS)
      .optional()
      .describe("namespace, project or agent (list: all levels when left out; required for the other actions)"),
    file: tool.schema.string().optional().describe("The memory's file, as the index names it (read, update, forget)"),
    title: tool.schema.string().optional().describe(`A short title, at most ${M.MAX_TITLE} characters (save, update)`),
    description: tool.schema
      .string()
      .optional()
      .describe(`One line saying what the memory holds, at most ${M.MAX_DESCRIPTION} characters (save, update)`),
    content: tool.schema.string().optional().describe("The memory itself (save, update)"),
  },
  async execute(args, ctx) {
    // The request's project instance, taken before anything is awaited.
    const fiber = Fiber.getCurrent()
    const instance = fiber ? Context.getReferenceUnsafe(fiber.context, InstanceRef) : undefined
    const contextOf = OperatorRegistry.memory.context
    if (!contextOf || !instance) throw new Error("Memory is not available in this session")
    const found = await contextOf({ instance, sessionID: ctx.sessionID, agent: ctx.agent })
    const folderOf = (level: Level) => {
      const folder = found.folders[level]
      if (!folder) throw new Error(found.incognito ? INCOGNITO : `No ${describe(level)} here`)
      return folder
    }
    const level = (): Level => {
      if (!args.level) throw new Error("Say which level: namespace, project or agent")
      return args.level
    }
    const ask = (verb: "READ" | "WRITE" | "FORGET", where: Level, file: string, metadata: Record<string, unknown>) =>
      ctx.ask({
        permission: "memory",
        patterns: [`${verb}(${where}/${file})`],
        always: [`${verb}(${where}/*)`],
        metadata,
      })
    const by = `agent ${ctx.agent} · session ${ctx.sessionID}`
    const diff = (file: string, before: string, after: string) => createTwoFilesPatch(file, file, before, after)

    if (args.action === "list") {
      const levels = args.level ? [args.level] : LEVELS.filter((item) => found.folders[item])
      const parts: string[] = []
      for (const item of levels) {
        // A denied level is left out; one that asks asks now.
        if (found.read[item] === "deny" || !found.folders[item]) {
          if (args.level)
            throw new Error(
              found.incognito && item === "agent" ? INCOGNITO : `Reading ${describe(item)} is not allowed`,
            )
          continue
        }
        const folder = found.folders[item]!
        if (found.read[item] === "ask")
          await ask("READ", item, "*", { description: `List ${describe(item)}`, path: folder })
        const index = await OperatorMemoryStore.list(folder)
        parts.push(
          [
            `<${item}_memory path="${folder}">`,
            ...index.entries.map((entry) => M.formatLine(entry)),
            `</${item}_memory>`,
          ]
            .filter((line, at, all) => all.length > 2 || at !== 1)
            .join("\n"),
        )
      }
      return parts.length ? parts.join("\n") : "No memory you may read here."
    }

    const where = level()
    if (args.action === "read") {
      const folder = folderOf(where)
      const file = args.file ?? ""
      await ask("READ", where, file, { description: `Read ${describe(where)} ${file}`, path: folder })
      const read = await OperatorMemoryStore.read(folder, file)
      return { title: file, output: `${read.path}\n\n${read.text}`, metadata: { path: read.path } }
    }

    if (!found.writes) throw new Error(INCOGNITO)
    const folder = folderOf(where)

    if (args.action === "save") {
      const entry = M.checkEntry({ title: args.title ?? "", description: args.description ?? "" })
      if ("reason" in entry) throw new Error(entry.reason)
      const listed = await OperatorMemoryStore.list(folder)
      // The file the save will use, for the permission's pattern.
      const file = M.fileFor(entry.title, new Set(listed.entries.map((item) => item.file)))
      await ask("WRITE", where, file, {
        title: entry.title,
        description: entry.description,
        path: `${folder}/${file}`,
        diff: diff(file, "", args.content ?? ""),
      })
      const saved = await OperatorMemoryStore.save({
        folder,
        project: found.project,
        level: where,
        title: entry.title,
        description: entry.description,
        content: args.content ?? "",
        by,
      })
      return { title: saved.file, output: `Saved ${saved.path}\n${saved.line}`, metadata: { path: saved.path } }
    }

    const file = args.file ?? ""
    const current = await OperatorMemoryStore.read(folder, file)
    if (args.action === "update") {
      await ask("WRITE", where, file, {
        title: args.title ?? current.detail.title,
        description: args.description ?? current.detail.description,
        path: current.path,
        diff: diff(file, current.detail.content, args.content ?? current.detail.content),
      })
      const saved = await OperatorMemoryStore.update({
        folder,
        project: found.project,
        level: where,
        file,
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.content !== undefined ? { content: args.content } : {}),
        by,
      })
      return { title: saved.file, output: `Updated ${saved.path}\n${saved.line}`, metadata: { path: saved.path } }
    }

    if (args.action === "forget") {
      await ask("FORGET", where, file, {
        title: current.detail.title,
        description: `Forget ${describe(where)}: ${current.detail.description ?? file} (it goes to Trash)`,
        path: current.path,
      })
      const forgotten = await OperatorMemoryStore.forget({
        folder,
        file,
        trash: (path) =>
          OperatorTrashFiles.put({
            kind: "memory",
            name: `${current.detail.title ?? file} (${describe(where)})`,
            project: found.project,
            paths: [path],
          }),
      })
      return { title: file, output: `Forgot ${forgotten.path} (moved to Trash)`, metadata: { path: forgotten.path } }
    }
    throw new Error(`Unknown action ${String(args.action)}`)
  },
})
