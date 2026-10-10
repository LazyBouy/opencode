export * as OperatorMemoryFormat from "./memory-format"

import matter from "gray-matter"

// The format of short-term memory (specs/docs/feedbacks/memory/memory_spec.md §3): a `MEMORY.md` index of
// lines `- [<title>](<file>.md) — <description>` (an em dash), one detailed `<file>.md` per memory with
// frontmatter. Pure: memory-store.ts reads and writes the files.

export const INDEX = "MEMORY.md"
export const MAX_TITLE = 80
export const MAX_DESCRIPTION = 200
export const MAX_CONTENT = 100_000

export type Entry = { readonly title: string; readonly file: string; readonly description: string }
export type Invalid = { readonly line: number; readonly text: string }
export type Index = {
  readonly entries: ReadonlyArray<Entry & { readonly line: number }>
  readonly invalid: ReadonlyArray<Invalid>
}

const LINE = /^- \[(.+?)\]\(([a-z0-9][a-z0-9-]*\.md)\) — (.+)$/

/** The index's entries, and the lines that are not entries (kept as they are, flagged). */
export function parseIndex(text: string): Index {
  const entries: Array<Entry & { line: number }> = []
  const invalid: Invalid[] = []
  text.split("\n").forEach((raw, at) => {
    const line = raw.replace(/\r$/, "")
    if (!line.trim()) return
    const found = line.match(LINE)
    if (found && found[1]!.length <= MAX_TITLE && found[3]!.length <= MAX_DESCRIPTION)
      entries.push({ title: found[1]!, file: found[2]!, description: found[3]!, line: at + 1 })
    else invalid.push({ line: at + 1, text: line })
  })
  return { entries, invalid }
}

export const formatLine = (entry: Entry) => `- [${entry.title}](${entry.file}) — ${entry.description}`

/** A title or description as one line, trimmed; the reason it is refused, if it is. */
export function checkEntry(input: { title: string; description: string }) {
  const title = oneLine(input.title)
  const description = oneLine(input.description)
  if (!title) return { reason: "A memory needs a title" }
  if (title.length > MAX_TITLE) return { reason: `A title is at most ${MAX_TITLE} characters` }
  if (!description) return { reason: "A memory needs a one-line description" }
  if (description.length > MAX_DESCRIPTION) return { reason: `A description is at most ${MAX_DESCRIPTION} characters` }
  if (title.includes("](") || title.includes("[") || title.includes("]")) return { reason: "A title can't hold [ or ]" }
  return { title, description }
}
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()

/** A file name for a title: its slug, made unique among the folder's files (`-2`, `-3`, …). */
export function fileFor(title: string, taken: ReadonlySet<string>) {
  const base =
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "memory"
  // `memory.md` would be the index itself on a case-insensitive disk.
  for (let n = 1; ; n++) {
    const file = `${base}${n === 1 ? "" : `-${n}`}.md`
    if (!taken.has(file) && file !== INDEX.toLowerCase()) return file
  }
}

/** A file name the tool accepts: one of the folder's memory files, never a path. */
export const isFileName = (file: string) => /^[a-z0-9][a-z0-9-]*\.md$/.test(file) && file !== INDEX.toLowerCase()

export type Detail = {
  readonly title: string
  readonly description: string
  readonly level: string
  readonly created: string
  readonly updated: string
  readonly by: string
  readonly content: string
}

export function renderDetail(detail: Detail) {
  const { content, ...data } = detail
  return matter.stringify(`${content.replace(/\s+$/, "")}\n`, data)
}

export function parseDetail(text: string): Partial<Detail> & { content: string } {
  const parsed = matter(text)
  const data = parsed.data as Record<string, unknown>
  const field = (key: string) =>
    typeof data[key] === "string"
      ? (data[key] as string)
      : data[key] instanceof Date
        ? (data[key] as Date).toISOString()
        : undefined
  return {
    ...(field("title") ? { title: field("title") } : {}),
    ...(field("description") ? { description: field("description") } : {}),
    ...(field("level") ? { level: field("level") } : {}),
    ...(field("created") ? { created: field("created") } : {}),
    ...(field("updated") ? { updated: field("updated") } : {}),
    ...(field("by") ? { by: field("by") } : {}),
    content: parsed.content.replace(/^\n/, "").replace(/\n$/, ""),
  }
}

/**
 * An index as prompts show it: its entry lines, cut at the limits (whichever comes first), and how many
 * more there are.
 */
export function cut(index: Index, limits: { lines: number; chars: number }) {
  const lines: string[] = []
  let chars = 0
  for (const entry of index.entries) {
    const line = formatLine(entry)
    if (lines.length >= limits.lines || chars + line.length + (lines.length ? 1 : 0) > limits.chars) break
    lines.push(line)
    chars += line.length + (lines.length > 1 ? 1 : 0)
  }
  return { lines, more: index.entries.length - lines.length }
}
