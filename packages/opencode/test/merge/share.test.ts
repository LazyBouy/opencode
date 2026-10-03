import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionMerge } from "@opencode-ai/schema/session-merge"
import { AccountRepo } from "../../src/account/repo"
import { MergeBinding } from "../../src/merge/binding"
import { ShareNext } from "@/share/share-next"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { FakeClaude } from "../lib/fake-claude"
import { configure, merge, replacements, root, send, session } from "./harness"

const synced: string[] = []
const client = HttpClient.make((request) => {
  if (request.url.endsWith("/sync") && request.body._tag === "Uint8Array")
    synced.push(new TextDecoder().decode(request.body.body))
  const body = request.url.endsWith("/sync")
    ? { ok: true }
    : { id: "shr_merge", url: "https://share.test/s", secret: "sec" }
  return Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
    ),
  )
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([root, ShareNext.node, AccountRepo.node]), [
    ...replacements,
    [httpClient, Layer.succeed(HttpClient.HttpClient, client)],
  ]),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip

unix("acceptance 8: a share carries the summary and external id, never the raw child stream", () =>
  Effect.gen(function* () {
    synced.length = 0
    yield* configure()
    yield* FakeClaude.install([
      [
        { tool: "Bash", input: { command: "cat secrets.txt", description: "read" }, output: "RAW-7c1f" },
        { text: "first answer" },
      ],
      [{ tool: "Read", input: { file_path: "notes.txt" }, output: "RAW-9d2e" }, { text: "second answer" }],
    ])
    const chat = yield* session()
    yield* merge(chat.id, "claude")
    yield* send(chat.id, "go")
    const id = (yield* (yield* MergeBinding.Service).active(chat.id))?.binding.externalSessionID

    const share = yield* ShareNext.Service
    yield* share.create(chat.id)
    yield* pollWithTimeout(
      Effect.sync(() => (synced.some((body) => body.includes(`"type":"session"`)) ? true : undefined)),
      "full share sync never happened",
      "10 seconds",
    )
    yield* send(chat.id, "again")
    yield* pollWithTimeout(
      Effect.sync(() =>
        synced.filter((body) => body.includes("[Merged claude session")).length >= 2 ? true : undefined,
      ),
      "live share sync of the second summary never happened",
      "10 seconds",
    )

    const all = synced.join("\n")
    expect(all).toContain(`[Merged claude session ${id}`)
    expect(all).toContain("cat secrets.txt")
    expect(all).not.toContain("RAW-7c1f")
    expect(all).not.toContain("RAW-9d2e")
    expect(all).not.toContain(`"role":"projection"`)
  }),
)

it.effect("isProjection selects only raw child parts", () =>
  Effect.sync(() => {
    const origin = (role: SessionMerge.Origin["role"]) => ({
      origin: { type: "merge" as const, bindingID: SessionMerge.ID.create(), adapter: "claude", role },
    })
    expect(SessionMerge.isProjection(origin("projection"))).toBe(true)
    expect(SessionMerge.isProjection(origin("summary"))).toBe(false)
    expect(SessionMerge.isProjection(origin("notice"))).toBe(false)
    expect(SessionMerge.isProjection({})).toBe(false)
    expect(SessionMerge.visibleToModel(origin("summary"))).toBe(true)
    expect(SessionMerge.visibleToModel(origin("notice"))).toBe(false)
  }),
)
