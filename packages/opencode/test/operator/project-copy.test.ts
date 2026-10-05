import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { OperatorProjectCopy } from "../../src/operator/project-copy"
import { tmpdir } from "../fixture/fixture"

const write = async (file: string, text: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}

describe("copying a project's own resources", () => {
  test("copies its .opencode folder and project config, keeps what the target has, leaves the source as it was", async () => {
    await using source = await tmpdir()
    await using target = await tmpdir()
    await write(path.join(source.path, ".opencode", "agents", "docs.md"), "---\nmode: subagent\n---\nWrite docs.\n")
    await write(path.join(source.path, ".opencode", "tools", "hello.ts"), "export default {}\n")
    await write(path.join(source.path, ".opencode", "skills", "review", "SKILL.md"), "# Review\n")
    await write(path.join(source.path, ".opencode", "node_modules", "dep", "index.js"), "module.exports = 1\n")
    await write(path.join(source.path, "opencode.json"), '{ "agent": { "build": { "temperature": 0.1 } } }\n')
    await write(path.join(source.path, "README.md"), "The source's own files are not project resources.\n")
    await write(path.join(target.path, ".opencode", "agents", "docs.md"), "Mine.\n")

    const result = await OperatorProjectCopy.copyFiles(source.path, target.path)
    expect(result.copied.toSorted()).toEqual(
      [
        path.join(".opencode", "skills", "review", "SKILL.md"),
        path.join(".opencode", "tools", "hello.ts"),
        "opencode.json",
      ].toSorted(),
    )
    expect(result.kept).toEqual([path.join(".opencode", "agents", "docs.md")])
    expect(await fs.readFile(path.join(target.path, ".opencode", "agents", "docs.md"), "utf8")).toBe("Mine.\n")
    expect(await Bun.file(path.join(target.path, ".opencode", "node_modules", "dep", "index.js")).exists()).toBe(false)
    expect(await Bun.file(path.join(target.path, "README.md")).exists()).toBe(false)
    expect(await fs.readFile(path.join(source.path, ".opencode", "agents", "docs.md"), "utf8")).toContain("Write docs.")
  })
})
