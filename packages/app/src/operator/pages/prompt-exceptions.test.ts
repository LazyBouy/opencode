import { describe, expect, test } from "bun:test"
import { exceptionsFor, PROMPT_EXCEPTIONS } from "./prompt-exceptions"

describe("texts not from the Prompt Profile", () => {
  test("each names files of OpenCode's code that exist", async () => {
    const root = new URL("../../../../../", import.meta.url).pathname
    for (const item of PROMPT_EXCEPTIONS)
      for (const file of item.files) expect(await Bun.file(root + file).exists()).toBe(true)
  })

  test("the title and compaction requests are declared only for their agents", () => {
    expect(exceptionsFor("title").map((item) => item.id)).toContain("title-request")
    expect(exceptionsFor("build").map((item) => item.id)).not.toContain("title-request")
    expect(exceptionsFor("build").map((item) => item.id)).not.toContain("compaction-request")
  })
})
