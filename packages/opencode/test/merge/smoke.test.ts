import { expect } from "bun:test"
import { Effect } from "effect"
import { MergeBinding } from "../../src/merge/binding"
import { Session } from "@/session/session"
import { FakeClaude } from "../lib/fake-claude"
import { configure, merge, send, session, unix } from "./harness"

unix("a merged prompt streams the child's reply into the session without calling OpenCode's model", () =>
  Effect.gen(function* () {
    const { llm } = yield* configure()
    const fake = yield* FakeClaude.install([[{ text: "hello from claude" }]])
    const chat = yield* session()

    yield* merge(chat.id, "claude")
    yield* send(chat.id, "say hello")

    const sessions = yield* Session.Service
    const messages = yield* sessions.messages({ sessionID: chat.id })
    const reply = messages.findLast((msg) => msg.info.role === "assistant")
    const texts = reply?.parts.filter((part) => part.type === "text") ?? []
    expect(texts.map((part) => [part.origin?.role, part.text.split("\n")[0]])).toEqual([
      ["projection", "hello from claude"],
      ["summary", expect.stringContaining("[Merged claude session")],
    ])

    const bindings = yield* MergeBinding.Service
    const active = yield* bindings.active(chat.id)
    const start = FakeClaude.starts(yield* fake.log)[0]
    expect(active?.binding.status).toBe("live")
    expect(FakeClaude.flag(start.argv, "--session-id")).toBe(active?.binding.externalSessionID)
    expect(yield* llm.calls).toBe(0)
  }),
)
