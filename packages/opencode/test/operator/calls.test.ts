import fs from "fs/promises"
import path from "path"
import { expect } from "bun:test"
import { Effect, Schedule } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { OperatorCallFormat } from "@/operator/call-format"
import { OperatorCallStore } from "@/operator/call-store"
import { OperatorCalls } from "@/operator/calls"
import { OperatorProviderTap } from "@/operator/provider-tap"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { replacements, root } from "../merge/harness"
import { fakeConfig, fakeProvider } from "./fake-provider"

const it = testEffect(LayerNode.compile(LayerNode.group([root, OperatorCalls.node]), replacements))
const unix = process.platform !== "win32" ? it.instance : it.instance.skip

const setup = (extra: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const fake = yield* Effect.acquireRelease(
      Effect.sync(() => fakeProvider()),
      (item) => Effect.sync(() => item.stop()),
    )
    yield* Effect.promise(() =>
      fs.writeFile(path.join(directory, "opencode.json"), JSON.stringify(fakeConfig(fake.url, extra))),
    )
    return { directory, fake }
  })

const ask = (sessionID: Session.Info["id"], text: string, agent: string, model = "fakechat/chat-model") =>
  Effect.gen(function* () {
    const [providerID, modelID] = model.split("/")
    return yield* (yield* SessionPrompt.Service).prompt({
      sessionID,
      agent,
      model: { providerID: ProviderV2.ID.make(providerID!), modelID: ModelV2.ID.make(modelID!) },
      parts: [{ type: "text", text }],
    })
  })

// The session's calls once every request the fake received has a finished recording.
const recorded = (sessionID: string, expected: () => number) =>
  Effect.promise(() => OperatorCallStore.list(sessionID)).pipe(
    Effect.flatMap((calls) =>
      calls.length >= expected() && calls.every((call) => call.finishedAt)
        ? Effect.succeed(calls)
        : Effect.fail("not yet" as const),
    ),
    Effect.retry({ times: 200, schedule: Schedule.spaced("50 millis") }),
    Effect.orDie,
  )

unix("every call is recorded exactly: OpenAI chat, with tool steps, a plan → build switch and the title call", () =>
  Effect.gen(function* () {
    const { fake } = yield* setup()
    const sessions = yield* Session.Service
    const session = yield* sessions.create({})
    fake.reply(
      { text: "Plan made." },
      { tool: "glob", input: { pattern: "*.md" }, reasoning: "look around" },
      { tool: "glob", input: { pattern: "*.ts" } },
      { text: "Done.", reasoning: "wrap up" },
    )
    yield* ask(session.id, "Plan the work", "plan")
    yield* ask(session.id, "Now do it", "build")
    const calls = yield* recorded(session.id, () => fake.hits.length)

    // Every request the provider received is rebuilt byte for byte from the store.
    expect(calls.length).toBe(fake.hits.length)
    const bodies = yield* Effect.promise(() => Promise.all(calls.map((call) => OperatorCallStore.body(call))))
    for (const hit of fake.hits) expect(bodies).toContain(hit.body)
    expect(calls.every((call) => call.request.exact)).toBe(true)
    // The correlation header never reaches the provider.
    for (const hit of fake.hits) expect(hit.headers[OperatorProviderTap.HEADER]).toBeUndefined()

    // The title call, and the agent steps linked to their assistant messages.
    expect(calls.filter((call) => call.kind === "title")).toHaveLength(1)
    const steps = calls.filter((call) => call.kind === "agent")
    expect(steps.map((call) => call.agent)).toEqual(["plan", "build", "build", "build"])
    const messages = yield* sessions.messages({ sessionID: session.id })
    const assistants: string[] = messages
      .filter((message) => message.info.role === "assistant")
      .map((message) => message.info.id)
    for (const step of steps) expect(assistants).toContain(step.assistantMessageID!)

    // The reminders OpenCode adds in memory are in what was sent.
    const sent = (call: OperatorCallStore.Call) => bodies[calls.indexOf(call)]!
    expect(sent(steps[0]!)).toContain("Plan Mode - System Reminder")
    expect(sent(steps[1]!)).toContain("Your operational mode has changed from plan to build.")

    // De-duplicated: a step's messages start with the previous step's; system and tools are shared.
    const [, second, third] = steps.map((call) => OperatorCallFormat.refs(call.request.body))
    expect(third!.messages.slice(0, second!.messages.length)).toEqual(second!.messages)
    expect(third!.system ?? third!.messages[0]).toBeDefined()
    expect(third!.tools).toBe(second!.tools)

    // The responses, assembled from the stream.
    expect(steps[1]!.response?.blocks).toEqual([
      { type: "reasoning", text: "look around" },
      { type: "tool-call", id: expect.stringMatching(/^call_msg_/), name: "glob", arguments: '{"pattern":"*.md"}' },
    ])
    expect(steps[3]!.response?.blocks).toEqual([
      { type: "reasoning", text: "wrap up" },
      { type: "text", text: "Done." },
    ])
    expect(steps[3]!.response?.usage).toMatchObject({ input: 100, output: 7, reasoning: 3 })
    expect(steps[0]!.format).toBe("openai-chat")

    // The API: exchanges, steps, what is the same as an earlier call, and what is new.
    const api = yield* OperatorCalls.Service
    const view = yield* api.list(session.id)
    expect(view.exchanges.map((item) => item.text)).toEqual(["Plan the work", "Now do it"])
    expect(view.exchanges.every((item) => item.recorded)).toBe(true)
    const agentSteps = view.calls.filter((call) => call.kind === "agent")
    expect(agentSteps.map((call) => [call.exchange, call.step])).toEqual([
      [1, 1],
      [2, 1],
      [2, 2],
      [2, 3],
    ])
    expect(agentSteps[2]!.system.sameAs).toBe(agentSteps[1]!.index)
    expect(agentSteps[2]!.tools.sameAs).toBe(agentSteps[1]!.index)
    expect(agentSteps[2]!.messages.new).toBe(2)
    expect(agentSteps[2]!.usage).toMatchObject({ input: 100, output: 7 })
    expect(view.totals.calls).toBe(calls.length)
    // One call: the reminder added in memory is marked; earlier messages are marked seen.
    const first = yield* api.detail(session.id, agentSteps[1]!.callID)
    const reminded = first.sent.find((message) =>
      JSON.stringify(message.content).includes("operational mode has changed"),
    )
    expect(reminded?.marks).toContain("in-memory")
    const later = yield* api.detail(session.id, agentSteps[2]!.callID)
    expect(later.sent.filter((message) => message.seenIn !== undefined).length).toBe(later.sent.length - 2)
    expect(later.received?.blocks.at(-1)).toMatchObject({ type: "tool-call", name: "glob" })
    expect(later.warnings).toEqual([])
    // Raw request byte for byte; exports.
    const raw = yield* api.raw(session.id, agentSteps[2]!.callID, "request")
    expect(fake.hits.map((hit) => hit.body)).toContain(raw.text)
    expect((yield* api.export(session.id, "md")).text).toContain("### Call")
    expect(JSON.parse((yield* api.export(session.id, "json")).text).calls).toHaveLength(calls.length)
    // Last sent: the build agent's newest request's tools, byte for byte.
    const last = yield* api.last("build")
    expect(last.captured).toBe(true)
    const newest = fake.hits.findLast(
      (hit) => hit.body === bodies[calls.findIndex((call) => call.callID === last.callID)],
    )!
    expect(last.tools).toBe(JSON.stringify(JSON.parse(newest.body).tools))
    expect(yield* api.last("explore")).toEqual({ captured: false })

    // A session deleted for good takes its calls with it.
    yield* sessions.remove(session.id)
    yield* Effect.promise(() => OperatorCallStore.list(session.id)).pipe(
      Effect.flatMap((left) => (left.length === 0 ? Effect.void : Effect.fail("not yet" as const))),
      Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") }),
      Effect.orDie,
    )
  }),
)

unix("an Anthropic call is recorded exactly, with its thinking and signature", () =>
  Effect.gen(function* () {
    const { fake } = yield* setup({ model: "fakeanth/claude-fake", small_model: "fakeanth/claude-fake" })
    const session = yield* (yield* Session.Service).create({})
    fake.reply({ text: "Hello there.", reasoning: "thinking it over" })
    yield* ask(session.id, "Say hello", "build", "fakeanth/claude-fake")
    const calls = yield* recorded(session.id, () => fake.hits.length)
    const bodies = yield* Effect.promise(() => Promise.all(calls.map((call) => OperatorCallStore.body(call))))
    for (const hit of fake.hits) expect(bodies).toContain(hit.body)
    const step = calls.find((call) => call.kind === "agent")!
    expect(step.format).toBe("anthropic")
    expect(OperatorCallFormat.refs(step.request.body).system).toBeDefined()
    expect(step.response?.blocks).toEqual([
      { type: "reasoning", text: "thinking it over", signature: "sig-1" },
      { type: "text", text: "Hello there." },
    ])
    expect(step.response?.usage).toMatchObject({ input: 100, output: 7 })
    expect(step.request.headers).not.toHaveProperty("x-api-key")
    expect(step.request.headers["anthropic-version"]).toBeDefined()
  }),
)

unix("recording off stores nothing", () =>
  Effect.gen(function* () {
    const { fake } = yield* setup({ operatorRecordCalls: false })
    const session = yield* (yield* Session.Service).create({})
    yield* ask(session.id, "Hello", "build")
    expect(fake.hits.length).toBeGreaterThan(0)
    for (const hit of fake.hits) expect(hit.headers[OperatorProviderTap.HEADER]).toBeUndefined()
    yield* Effect.sleep("300 millis")
    expect(yield* Effect.promise(() => OperatorCallStore.list(session.id))).toEqual([])
    OperatorProviderTap.settings.unlinked = true
  }),
)

unix("the tap never fails or changes a request: bad JSON, an unknown call, an unknown format", () =>
  Effect.gen(function* () {
    const { fake } = yield* setup()
    const tapped = OperatorProviderTap.wrap(fetch)
    // An unknown call id and a body that is not JSON: the response is the provider's, the header gone.
    const response = yield* Effect.promise(() =>
      tapped(`${fake.url}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [OperatorProviderTap.HEADER]: "call_unknown",
          "x-opencode-session-id": "ses_tapcheck",
        },
        body: "{not json",
      }),
    )
    expect(response.status).toBe(200)
    expect(yield* Effect.promise(() => response.text())).toContain("chat.completion.chunk")
    expect(fake.hits.at(-1)?.headers[OperatorProviderTap.HEADER]).toBeUndefined()
    expect(fake.hits.at(-1)?.body).toBe("{not json")
    // An unlinked call with a session header is recorded, its raw body kept whole.
    yield* Effect.promise(() =>
      tapped(`${fake.url}/chat/completions`, {
        method: "POST",
        headers: { "x-opencode-session-id": "ses_tapcheck" },
        body: "plain text",
      }).then((res) => res.text()),
    )
    const calls = yield* recorded("ses_tapcheck", () => 1)
    expect(calls[0]?.kind).toBe("unlinked")
    expect(yield* Effect.promise(() => OperatorCallStore.body(calls[0]!))).toBe("plain text")
    // A failing store never fails the request.
    yield* Effect.promise(() => fs.mkdir(path.join(OperatorCallStore.root(), "ses_blocked"), { recursive: true }))
    yield* Effect.promise(() =>
      fs.writeFile(path.join(OperatorCallStore.root(), "ses_blocked", "blobs"), "a file, not a folder"),
    )
    const blocked = yield* Effect.promise(() =>
      tapped(`${fake.url}/chat/completions`, {
        method: "POST",
        headers: { "x-opencode-session-id": "ses_blocked" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
    )
    expect(blocked.status).toBe(200)
    yield* Effect.promise(() => OperatorCallStore.remove("ses_tapcheck"))
    yield* Effect.promise(() => OperatorCallStore.remove("ses_blocked"))
  }),
)

unix("response assembly per format: OpenAI responses and Google streams", () =>
  Effect.sync(() => {
    const responses = [
      {
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "" },
      },
      { type: "response.reasoning_summary_text.delta", delta: "thinking" },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"filePath":' },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"a.ts"}' },
      { type: "response.output_item.done", item: { type: "reasoning", encrypted_content: "enc" } },
      {
        type: "response.completed",
        response: {
          id: "resp_1",
          status: "completed",
          usage: { input_tokens: 5, output_tokens: 2, output_tokens_details: { reasoning_tokens: 1 } },
        },
      },
    ]
    const stream = responses.map((item) => `event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`).join("")
    expect(OperatorCallFormat.assemble("openai-responses", stream)).toEqual({
      parsed: true,
      blocks: [
        { type: "tool-call", id: "call_1", name: "read", arguments: '{"filePath":"a.ts"}' },
        { type: "reasoning", text: "thinking" },
        { type: "reasoning", text: "", encrypted: true, signature: "enc" },
      ],
      finish: "completed",
      usage: { input: 5, output: 2, reasoning: 1 },
      ids: ["resp_1"],
    })
    const google = [
      { candidates: [{ content: { parts: [{ text: "pondering", thought: true }] } }] },
      {
        candidates: [
          {
            content: { parts: [{ text: "Answer" }, { functionCall: { name: "glob", args: { pattern: "*" } } }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, thoughtsTokenCount: 2 },
      },
    ]
    expect(
      OperatorCallFormat.assemble("google", google.map((item) => `data: ${JSON.stringify(item)}\n\n`).join("")),
    ).toEqual({
      parsed: true,
      blocks: [
        { type: "reasoning", text: "pondering" },
        { type: "text", text: "Answer" },
        { type: "tool-call", name: "glob", arguments: '{"pattern":"*"}' },
      ],
      finish: "STOP",
      usage: { input: 9, output: 4, reasoning: 2 },
      ids: [],
    })
    // An unknown format keeps the raw text, not parsed.
    expect(OperatorCallFormat.assemble("other", "raw bytes")).toEqual({ parsed: false, blocks: [], raw: "raw bytes" })
  }),
)
