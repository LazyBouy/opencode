import { describe, expect, test } from "bun:test"
import { projectOptions } from "./project"

// The operator pages' projects (specs/docs/issues/002): the console's records only, the chosen namespace's when one
// is chosen, each labelled "name · id" so same-named projects never share a label.
describe("project options", () => {
  const records = [
    { key: "/work/opencode/app", id: "7k3mq", name: "app", namespace: "opencode" },
    { key: "/work/acme/app", id: "q2r9d", name: "app", namespace: "acme" },
    { key: "/work/acme/site", id: "m0v4c", name: "site", namespace: "acme" },
  ]

  test("every record, labelled with its id; same names get different labels", () => {
    const options = projectOptions(records)
    expect(options.map((item) => item.label)).toEqual(["app · 7k3mq", "app · q2r9d", "site · m0v4c"])
    expect(new Set(options.map((item) => item.label)).size).toBe(options.length)
    expect(options[1]).toEqual({
      directory: "/work/acme/app",
      id: "q2r9d",
      name: "app",
      namespace: "acme",
      label: "app · q2r9d",
    })
  })

  test("a chosen namespace's only", () => {
    expect(projectOptions(records, "acme").map((item) => item.directory)).toEqual(["/work/acme/app", "/work/acme/site"])
    expect(projectOptions(records, "opencode").map((item) => item.id)).toEqual(["7k3mq"])
  })
})
