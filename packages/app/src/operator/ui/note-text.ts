// A note's text, written in a small part of Markdown so it can live in en.ts as one string: `### `
// headings, paragraphs, `- ` lists (nested by two spaces), fenced code blocks, and inline `**bold**`,
// `code` and [links](#target). Parsed into blocks the note renders; nothing else is supported.

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "bold"; children: Inline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; target: string; children: Inline[] }

export type Item = { text: Inline[]; items: Item[] }

export type Block =
  | { kind: "heading"; text: Inline[] }
  | { kind: "paragraph"; text: Inline[] }
  | { kind: "list"; items: Item[] }
  | { kind: "code"; language: string; text: string }

export function inline(text: string): Inline[] {
  const result: Inline[] = []
  let rest = text
  const push = (value: string) => {
    if (!value) return
    const last = result.at(-1)
    if (last?.kind === "text") last.text += value
    else result.push({ kind: "text", text: value })
  }
  while (rest) {
    const code = rest.match(/^`([^`]+)`/)
    if (code) {
      result.push({ kind: "code", text: code[1]! })
      rest = rest.slice(code[0].length)
      continue
    }
    const bold = rest.match(/^\*\*(.+?)\*\*/)
    if (bold) {
      result.push({ kind: "bold", children: inline(bold[1]!) })
      rest = rest.slice(bold[0].length)
      continue
    }
    const link = rest.match(/^\[([^\]]+)\]\(#([\w-]+)\)/)
    if (link) {
      result.push({ kind: "link", target: link[2]!, children: inline(link[1]!) })
      rest = rest.slice(link[0].length)
      continue
    }
    const next = rest.slice(1).search(/[`*[]/)
    const end = next === -1 ? rest.length : next + 1
    push(rest.slice(0, end))
    rest = rest.slice(end)
  }
  return result
}

export function parse(source: string): Block[] {
  const lines = source.split("\n")
  const blocks: Block[] = []
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", text: inline(paragraph.join(" ")) })
    paragraph = []
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (!line.trim()) {
      flush()
      continue
    }
    const fence = line.match(/^```(\w*)$/)
    if (fence) {
      flush()
      const body: string[] = []
      while (index + 1 < lines.length && lines[index + 1] !== "```") body.push(lines[++index]!)
      index++
      blocks.push({ kind: "code", language: fence[1] ?? "", text: body.join("\n") })
      continue
    }
    if (line.startsWith("### ")) {
      flush()
      blocks.push({ kind: "heading", text: inline(line.slice(4)) })
      continue
    }
    const bullet = line.match(/^( *)- (.*)$/)
    if (bullet) {
      flush()
      const last = blocks.at(-1)
      const list = last?.kind === "list" ? last : undefined
      const items = list?.items ?? []
      if (!list) blocks.push({ kind: "list", items })
      // Two spaces per level; an item goes under the last item one level up.
      let level = Math.floor(bullet[1]!.length / 2)
      let into = items
      while (level-- > 0 && into.at(-1)) into = into.at(-1)!.items
      into.push({ text: inline(bullet[2]!), items: [] })
      continue
    }
    // A line indented under a list item continues it.
    const last = blocks.at(-1)
    if (!paragraph.length && last?.kind === "list" && line.startsWith("  ")) {
      let item = last.items.at(-1)
      while (item?.items.length) item = item.items.at(-1)
      if (item) item.text.push(...inline(` ${line.trim()}`))
      continue
    }
    paragraph.push(line.trim())
  }
  flush()
  return blocks
}

// The text a note shows, without markup (for tests and copying).
export function plain(text: Inline[]): string {
  return text.map((part) => (part.kind === "text" || part.kind === "code" ? part.text : plain(part.children))).join("")
}
