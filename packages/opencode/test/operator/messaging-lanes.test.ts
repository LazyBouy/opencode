import { describe, expect, test } from "bun:test"
import { OperatorMessageLanes } from "@/operator/messaging/lanes"
import type { OperatorQueueStore } from "@/operator/queue-store"

// The memory lane's backends (SPEC-0023 §6.5, §14): one contract for both. In-process always runs; Redis runs
// when OPENCODE_TEST_REDIS_URL names one (the Docker stack's: redis://redis:6379, with `--profile messaging`).

const item = (
  id: string,
  priority: OperatorQueueStore.Priority,
  createdAt: number,
  agent = "build",
): OperatorQueueStore.Item => ({
  id,
  project: "/repo",
  agent,
  target: "main",
  text: id,
  priority,
  steer: false,
  sender: { kind: "user" },
  status: "in memory",
  lane: "memory",
  createdAt,
})
const held = (id: string, priority: OperatorQueueStore.Priority, createdAt: number, sessionID = "ses_a") => ({
  item: item(id, priority, createdAt),
  sessionID,
  directory: "/repo",
})

const backends: Array<[string, (() => OperatorMessageLanes.MemoryLane) | undefined]> = [
  ["in-process", () => OperatorMessageLanes.inProcess(3)],
  [
    "redis",
    process.env.OPENCODE_TEST_REDIS_URL
      ? () =>
          OperatorMessageLanes.redis(process.env.OPENCODE_TEST_REDIS_URL!, {
            cap: 3,
            prefix: `opencode:test:${Math.random().toString(36).slice(2)}:`,
          })
      : undefined,
  ],
]

for (const [name, make] of backends)
  describe(`the memory lane: ${name}`, () => {
    const run = make ? test : test.skip

    run("holds a session's messages in delivery order, up to its cap; take empties it", async () => {
      const lane = make!()
      try {
        expect(await lane.put(held("low", "low", 1))).toBe(true)
        expect(await lane.put(held("urgent", "urgent", 3))).toBe(true)
        expect(await lane.put(held("normal", "normal", 2))).toBe(true)
        expect(await lane.put(held("over", "normal", 4))).toBe(false)
        // Another session's cap is its own.
        expect(await lane.put(held("other", "normal", 5, "ses_b"))).toBe(true)
        expect((await lane.list({ project: "/repo" })).map((entry) => entry.item.id)).toEqual([
          "urgent",
          "normal",
          "other",
          "low",
        ])
        expect((await lane.get("normal"))?.sessionID).toBe("ses_a")
        expect((await lane.take("ses_a")).map((entry) => entry.item.id)).toEqual(["urgent", "normal", "low"])
        expect(await lane.take("ses_a")).toEqual([])
        expect(await lane.get("normal")).toBeUndefined()
        expect((await lane.list({})).map((entry) => entry.item.id)).toEqual(["other"])
      } finally {
        await lane.take("ses_b")
        lane.close()
      }
    })

    run("remove takes one message out; list filters by project and agent", async () => {
      const lane = make!()
      try {
        await lane.put(held("one", "normal", 1))
        await lane.put({ ...held("two", "normal", 2), item: item("two", "normal", 2, "plan") })
        expect((await lane.remove("one"))?.item.id).toBe("one")
        expect(await lane.remove("one")).toBeUndefined()
        expect((await lane.list({ agent: "plan" })).map((entry) => entry.item.id)).toEqual(["two"])
        expect(await lane.list({ project: "/elsewhere" })).toEqual([])
        expect((await lane.take("ses_a")).map((entry) => entry.item.id)).toEqual(["two"])
      } finally {
        lane.close()
      }
    })

    run("a waiting call gets the first message it accepts, at once; a cancelled wait gets none", async () => {
      const lane = make!()
      try {
        const waiting = lane.wait({ sessionID: "ses_a", accepts: (entry) => entry.correlationID === "c_1" })
        expect(
          lane.handoff({ ...held("no", "normal", 1), item: { ...item("no", "normal", 1), correlationID: "c_2" } }),
        ).toBe(false)
        expect(
          lane.handoff({ ...held("yes", "normal", 2), item: { ...item("yes", "normal", 2), correlationID: "c_1" } }),
        ).toBe(true)
        expect((await waiting.reply).id).toBe("yes")
        const cancelled = lane.wait({ sessionID: "ses_a", accepts: () => true })
        cancelled.cancel()
        expect(lane.handoff(held("late", "normal", 3))).toBe(false)
        await lane.list({})
        if (name === "redis") expect(lane.state()).toMatchObject({ backend: "redis", connection: "connected" })
        else expect(lane.state()).toEqual({ backend: "in-process" })
      } finally {
        lane.close()
      }
    })
  })

test("a server's address is shown by its host, never with its password", () => {
  expect(OperatorMessageLanes.hostOf("redis://user:secret@redis:6379/0")).toBe("redis:6379")
})
