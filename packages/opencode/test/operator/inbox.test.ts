import { expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GlobalBus } from "@/bus/global"
import { OperatorInbox } from "@/operator/inbox"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(OperatorInbox.node))

const ask = (directory: string, id: string) =>
  GlobalBus.emit("event", {
    directory,
    payload: {
      type: "permission.asked",
      properties: { id, sessionID: "ses_test", permission: "bash", patterns: ["ls"], metadata: {}, always: ["ls *"] },
    },
  })

it.effect("tracks requests until they are answered or their project closes", () =>
  Effect.gen(function* () {
    const inbox = yield* OperatorInbox.Service
    ask("/work/a", "per_a1")
    ask("/work/b", "per_b1")
    ask("/work/b", "per_b2")
    expect(inbox.pending().map((item) => [item.directory, String(item.request.id)])).toEqual([
      ["/work/a", "per_a1"],
      ["/work/b", "per_b1"],
      ["/work/b", "per_b2"],
    ])

    GlobalBus.emit("event", {
      directory: "/work/a",
      payload: { type: "permission.replied", properties: { sessionID: "ses_test", requestID: "per_a1", reply: "once" } },
    })
    expect(inbox.pending().map((item) => String(item.request.id))).toEqual(["per_b1", "per_b2"])

    GlobalBus.emit("event", {
      directory: "/work/b",
      payload: { type: "server.instance.disposed", properties: { directory: "/work/b" } },
    })
    expect(inbox.pending()).toEqual([])
  }),
)
