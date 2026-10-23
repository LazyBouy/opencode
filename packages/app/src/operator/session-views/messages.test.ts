import { describe, expect, test } from "bun:test"
import { messageMarkOf, pingCardOf, waited } from "./messages"

describe("what messaging puts on parts", () => {
  test("a delivered message's mark, from its text part; none for the user's own words", () => {
    const mark = {
      id: "msg_1",
      agent: "build",
      folder: "/repo",
      from: { kind: "agent", agent: "writer", session: "ses_w" },
      correlationID: "c_1",
      priority: "normal",
    }
    expect(messageMarkOf([{ type: "file" }, { type: "text", metadata: { message: mark } }])).toEqual(mark as never)
    expect(messageMarkOf([{ type: "text" }, { type: "text", metadata: { hook: {} } }])).toBeUndefined()
    expect(messageMarkOf([{ type: "text", metadata: { message: { id: 3 } } }])).toBeUndefined()
  })

  test("a ping call's card, from its tool part's state; none for other tools", () => {
    const card = { verb: "send", status: "waiting", wait: { since: 1, timeout: 120 } }
    expect(pingCardOf({ type: "tool", tool: "ping", state: { status: "running", metadata: { ping: card } } })).toEqual(
      card as never,
    )
    expect(pingCardOf({ type: "tool", tool: "bash", state: { metadata: { ping: card } } })).toBeUndefined()
    expect(pingCardOf({ type: "tool", tool: "ping", state: { status: "pending" } })).toBeUndefined()
  })

  test("the time waited, as m:ss", () => {
    expect(waited(0)).toBe("0:00")
    expect(waited(42_900)).toBe("0:42")
    expect(waited(125_000)).toBe("2:05")
    expect(waited(-5)).toBe("0:00")
  })
})
