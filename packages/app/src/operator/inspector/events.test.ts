import { describe, expect, test } from "bun:test"
import { eventSession } from "./events"

describe("eventSession", () => {
  test("finds the session in the shapes session, message and part events use", () => {
    expect(eventSession("permission.asked", { sessionID: "ses_a" })).toBe("ses_a")
    expect(eventSession("message.updated", { info: { id: "msg_1", sessionID: "ses_b" } })).toBe("ses_b")
    expect(eventSession("message.part.updated", { part: { sessionID: "ses_c" } })).toBe("ses_c")
    expect(eventSession("session.updated", { info: { id: "ses_d" } })).toBe("ses_d")
  })

  test("ignores events without a session", () => {
    expect(eventSession("message.updated", { info: { id: "msg_1" } })).toBeUndefined()
    expect(eventSession("server.connected", {})).toBeUndefined()
    expect(eventSession("x", null)).toBeUndefined()
  })
})
