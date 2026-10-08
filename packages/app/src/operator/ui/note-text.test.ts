import { describe, expect, test } from "bun:test"
import { dict } from "../i18n/en"
import { inline, parse, plain } from "./note-text"

describe("note text", () => {
  test("inline bold, code and links", () => {
    expect(inline("A **`skill` rule** and [the **Permissions** tab](#agent-permissions).")).toEqual([
      { kind: "text", text: "A " },
      {
        kind: "bold",
        children: [
          { kind: "code", text: "skill" },
          { kind: "text", text: " rule" },
        ],
      },
      { kind: "text", text: " and " },
      {
        kind: "link",
        target: "agent-permissions",
        children: [
          { kind: "text", text: "the " },
          { kind: "bold", children: [{ kind: "text", text: "Permissions" }] },
          { kind: "text", text: " tab" },
        ],
      },
      { kind: "text", text: "." },
    ])
    expect(plain(inline('`"*": "deny"` **first**'))).toBe('"*": "deny" first')
  })

  test("headings, paragraphs, nested lists and code blocks", () => {
    const blocks = parse(
      ["### Title", "", "One", "two.", "", "- a", "  - b", "- c", "", "```jsonc", "{ }", "```"].join("\n"),
    )
    expect(blocks.map((block) => block.kind)).toEqual(["heading", "paragraph", "list", "code"])
    expect(blocks[1]).toEqual({ kind: "paragraph", text: [{ kind: "text", text: "One two." }] })
    const list = blocks[2]
    if (list?.kind !== "list") throw new Error("a list")
    expect(list.items.map((item) => plain(item.text))).toEqual(["a", "c"])
    expect(list.items[0]!.items.map((item) => plain(item.text))).toEqual(["b"])
    expect(blocks[3]).toEqual({ kind: "code", language: "jsonc", text: "{ }" })
  })

  test("the skills note has the spec's four sections and its two examples, exactly", () => {
    const blocks = parse(dict["operator.skillsNote.text"])
    expect(blocks.filter((block) => block.kind === "heading").map((block) => plain(block.text))).toEqual([
      "Where OpenCode finds skills",
      "How an agent gets them",
      "Giving one agent only some skills",
      "Good to know",
    ])
    expect(blocks.flatMap((block) => (block.kind === "code" ? [block.text] : []))).toEqual([
      [
        '"agent": {',
        '  "reviewer": {',
        '    "permission": {',
        '      "skill": { "*": "deny", "effect": "allow", "rtl-*": "ask" }',
        "    }",
        "  }",
        "}",
      ].join("\n"),
      '"permission": { "skill": { "*": "allow", "experimental-*": "deny" } }',
    ])
  })
})
