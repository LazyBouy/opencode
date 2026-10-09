import { describe, expect, test } from "bun:test"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { OperatorScopes } from "@/operator/scopes"

// The words (global_and_opencode_namespaces_spec.md §3, §13 #4): one classifier for where a file belongs.
// The deepest folder that contains it wins.

const layout: OperatorScopes.Layout = {
  namespaces: [
    { id: "opencode", folder: "/work/opencode" },
    { id: "acme", folder: "/work/acme" },
  ],
  projects: ["/work/acme/site", path.join(Global.Path.config, "notes"), "/elsewhere/tool"],
}
const kind = (file: string) => OperatorScopes.classify(file, layout)

describe("where a file belongs", () => {
  test("project, namespace, Global and outside, the deepest folder winning", () => {
    expect(kind("/work/acme/site/.opencode/opencode.jsonc")).toEqual({ kind: "project", project: "/work/acme/site" })
    expect(kind("/work/acme/.opencode/opencode.jsonc")).toEqual({ kind: "namespace", namespace: "acme" })
    expect(kind("/work/opencode/.opencode/commands/x.md")).toEqual({ kind: "namespace", namespace: "opencode" })
    expect(kind(path.join(Global.Path.config, "opencode.jsonc"))).toEqual({ kind: "global" })
    expect(kind(path.join(Global.Path.home, ".opencode", "agents", "a.md"))).toEqual({ kind: "global" })
    // A Global project's files are under Global's folder but are the project's.
    expect(kind(path.join(Global.Path.config, "notes", ".opencode", "opencode.jsonc"))).toMatchObject({
      kind: "project",
    })
    expect(kind("/elsewhere/tool/opencode.json")).toMatchObject({ kind: "project" })
    expect(kind("/tmp/other/opencode.json")).toEqual({ kind: "outside" })
    // A folder that only starts with a namespace's name isn't in it.
    expect(kind("/work/acme-two/x")).toEqual({ kind: "outside" })
  })

  test("the environment's config is never Global", () => {
    expect(kind("OPENCODE_CONFIG_CONTENT")).toEqual({ kind: "environment", variable: "OPENCODE_CONFIG_CONTENT" })
    const before = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = path.join(Global.Path.config, "custom")
    try {
      expect(kind(path.join(Global.Path.config, "custom", "opencode.json"))).toEqual({
        kind: "environment",
        variable: "OPENCODE_CONFIG_DIR",
      })
    } finally {
      if (before === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = before
    }
  })
})
