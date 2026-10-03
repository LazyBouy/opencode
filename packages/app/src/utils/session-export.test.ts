import { describe, expect, test } from "bun:test"
import { fetchSessionExport, sessionExportFilename } from "./session-export"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"

describe("sessionExportFilename", () => {
  test("generates filename from title", () => {
    expect(sessionExportFilename({ id: "ses_123", title: "Clone PR in worktree from fork" })).toBe(
      "clone-pr-in-worktree-from-fork.json",
    )
  })

  test("generates filename from slug when title missing", () => {
    expect(sessionExportFilename({ id: "ses_123", slug: "my-session-slug" })).toBe("my-session-slug.json")
  })

  test("falls back to id when title and slug are empty", () => {
    expect(sessionExportFilename({ id: "ses_123" })).toBe("ses_123.json")
  })
})

describe("fetchSessionExport", () => {
  test("fetches full transcript from client", async () => {
    const session = { id: "ses_1", title: "Test Session" } as Session
    const msg = { id: "msg_1", role: "user" } as Message
    const part = { id: "prt_1", type: "text", text: "hello" } as Part
    const messages = [{ info: msg, parts: [part] }]

    const client = {
      session: {
        get: async () => ({ data: session }),
        messages: async () => ({ data: messages }),
      },
    }

    const result = await fetchSessionExport({
      sessionID: "ses_1",
      client,
    })

    expect(result).toEqual({
      info: session,
      messages,
    })
  })

  test("leaves out parts projected from a merged session but keeps its summary", async () => {
    const origin = (role: "projection" | "summary") =>
      ({ type: "merge", bindingID: "mrg_1", adapter: "claude", externalSessionID: "ext-1", role }) as const
    const projection = { id: "prt_1", type: "text", text: "raw child output", origin: origin("projection") } as Part
    const summary = {
      id: "prt_2",
      type: "text",
      text: "[Merged claude session ext-1]",
      origin: origin("summary"),
    } as Part
    const msg = { id: "msg_1", role: "assistant" } as Message
    const client = {
      session: {
        get: async () => ({ data: { id: "ses_1" } as Session }),
        messages: async () => ({ data: [{ info: msg, parts: [projection, summary] }] }),
      },
    }

    const result = await fetchSessionExport({ sessionID: "ses_1", client })

    expect(result.messages[0].parts).toEqual([summary])
  })

  test("throws when session not found", async () => {
    const client = {
      session: {
        get: async () => ({ data: null }),
        messages: async () => ({ data: [] }),
      },
    }

    expect(
      fetchSessionExport({
        sessionID: "ses_missing",
        client,
      }),
    ).rejects.toThrow("Session not found: ses_missing")
  })
})
