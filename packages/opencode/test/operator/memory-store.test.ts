import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { OperatorMemoryFormat as M } from "@/operator/memory-format"
import { OperatorMemoryStore as S } from "@/operator/memory-store"
import { tmpdir } from "../fixture/fixture"

// The memory format and its store (memory_spec.md §3, §5): exact index lines, unique files, bad lines
// kept and flagged, atomic writes under one lock per folder.

describe("the index", () => {
  test("entries are exact lines; other lines are kept and flagged", () => {
    const index = M.parseIndex(
      [
        "- [Prefers short answers](prefers-short-answers.md) — The user wants answers under five lines",
        "Some note by hand",
        "",
        "- [Bad](../escape.md) — Not a file of this folder",
        "- [Release checklist](release-checklist.md) — Steps before tagging",
      ].join("\n"),
    )
    expect(index.entries.map((item) => item.file)).toEqual(["prefers-short-answers.md", "release-checklist.md"])
    expect(index.invalid.map((item) => item.line)).toEqual([2, 4])
    expect(M.formatLine(index.entries[1]!)).toBe("- [Release checklist](release-checklist.md) — Steps before tagging")
  })

  test("titles become unique slugs; the index's own name is never one", () => {
    expect(M.fileFor("Prefers short answers!", new Set())).toBe("prefers-short-answers.md")
    expect(M.fileFor("Café rules", new Set(["cafe-rules.md"]))).toBe("cafe-rules-2.md")
    expect(M.fileFor("Memory", new Set())).toBe("memory-2.md")
    expect(M.checkEntry({ title: "x".repeat(81), description: "d" })).toEqual({
      reason: "A title is at most 80 characters",
    })
    expect(M.checkEntry({ title: " Two\nlines ", description: " one " })).toEqual({
      title: "Two lines",
      description: "one",
    })
  })

  test("prompts cut the index at the line or character limit, whichever comes first", () => {
    const text = Array.from({ length: 5 }, (_, at) => `- [M${at}](m${at}.md) — d`).join("\n")
    expect(M.cut(M.parseIndex(text), { lines: 3, chars: 25_000 })).toMatchObject({ more: 2 })
    expect(M.cut(M.parseIndex(text), { lines: 200, chars: 40 })).toMatchObject({
      lines: ["- [M0](m0.md) — d", "- [M1](m1.md) — d"],
      more: 3,
    })
  })
})

describe("the store", () => {
  test("save, read, update and forget keep the file and its index line together", async () => {
    await using project = await tmpdir()
    const folder = path.join(project.path, ".memory")
    const saved = await S.save({
      folder,
      project: project.path,
      level: "project",
      title: "Release checklist",
      description: "Steps before tagging",
      content: "1. Run the tests",
      by: "agent build · session ses_1",
    })
    expect(saved.line).toBe("- [Release checklist](release-checklist.md) — Steps before tagging")
    const read = await S.read(folder, "release-checklist.md")
    expect(read.detail).toMatchObject({ title: "Release checklist", level: "project", content: "1. Run the tests" })

    // A hand-written line stays where it is.
    await fs.appendFile(path.join(folder, "MEMORY.md"), "A note by hand\n")
    const updated = await S.update({
      folder,
      project: project.path,
      level: "project",
      file: "release-checklist.md",
      description: "The steps before tagging a release",
      content: "1. Run the tests\n2. Tag",
      by: "user",
    })
    expect(updated.before).toContain("1. Run the tests")
    const listed = await S.list(folder)
    expect(listed.text).toBe(
      "- [Release checklist](release-checklist.md) — The steps before tagging a release\nA note by hand\n",
    )
    expect(listed.invalid).toEqual([{ line: 2, text: "A note by hand" }])

    const trashed: string[] = []
    await S.forget({ folder, file: "release-checklist.md", trash: async (file) => trashed.push(file) })
    expect(trashed).toEqual([path.join(folder, "release-checklist.md")])
    expect((await S.list(folder)).text).toBe("A note by hand\n")
    await expect(S.read(folder, "../x.md")).rejects.toThrow("is not a memory file name")
  })

  test("concurrent saves all land, with unique files, and the index stays valid", async () => {
    await using project = await tmpdir()
    const folder = path.join(project.path, ".memory")
    await Promise.all(
      Array.from({ length: 8 }, (_, at) =>
        S.save({
          folder,
          project: project.path,
          level: "agent",
          title: "Same title",
          description: `Saved by session ${at}`,
          content: `${at}`,
          by: `session ${at}`,
        }),
      ),
    )
    const listed = await S.list(folder)
    expect(listed.invalid).toEqual([])
    expect(new Set(listed.entries.map((item) => item.file)).size).toBe(8)
    expect((await fs.readdir(folder)).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })
})
