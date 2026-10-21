// A fake model provider for the call-recording tests: it keeps every request exactly as received (the
// raw body and the headers) and answers in the OpenAI chat format (/v1/chat/completions) or the
// Anthropic format (/v1/messages), streamed, from a queue of replies ("ok" when the queue is empty).

export type Reply =
  | { text: string; reasoning?: string; signature?: string }
  | { tool: string; input: unknown; reasoning?: string }
  // Several tool calls in one step (OpenAI chat only).
  | { tools: Array<{ tool: string; input: unknown }> }

export type Hit = { url: string; headers: Record<string, string>; body: string }

const sse = (lines: string[]) => new Response(lines.join(""), { headers: { "content-type": "text/event-stream" } })

function chat(reply: Reply, id: string) {
  const chunk = (delta: unknown, extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta, ...extra }] })}\n\n`
  const lines = [chunk({ role: "assistant" })]
  if ("reasoning" in reply && reply.reasoning) lines.push(chunk({ reasoning_content: reply.reasoning }))
  if ("text" in reply) lines.push(chunk({ content: reply.text }))
  else if ("tools" in reply)
    lines.push(
      chunk({
        tool_calls: reply.tools.map((item, index) => ({
          index,
          id: `call_${id}_${index}`,
          type: "function",
          function: { name: item.tool, arguments: JSON.stringify(item.input) },
        })),
      }),
    )
  else
    lines.push(
      chunk({
        tool_calls: [
          {
            index: 0,
            id: `call_${id}`,
            type: "function",
            function: { name: reply.tool, arguments: JSON.stringify(reply.input) },
          },
        ],
      }),
    )
  lines.push(
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "text" in reply ? "stop" : "tool_calls" }],
      usage: { prompt_tokens: 100, completion_tokens: 7, completion_tokens_details: { reasoning_tokens: 3 } },
    })}\n\n`,
  )
  lines.push("data: [DONE]\n\n")
  return sse(lines)
}

function anthropic(reply: Reply, id: string) {
  if ("tools" in reply) throw new Error("several tool calls: OpenAI chat only")
  const event = (type: string, data: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  const lines = [
    event("message_start", {
      message: {
        id,
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-fake",
        usage: { input_tokens: 100, output_tokens: 1 },
      },
    }),
  ]
  let index = 0
  if (reply.reasoning) {
    lines.push(event("content_block_start", { index, content_block: { type: "thinking", thinking: "" } }))
    lines.push(event("content_block_delta", { index, delta: { type: "thinking_delta", thinking: reply.reasoning } }))
    lines.push(event("content_block_delta", { index, delta: { type: "signature_delta", signature: "sig-1" } }))
    lines.push(event("content_block_stop", { index }))
    index++
  }
  if ("text" in reply) {
    lines.push(event("content_block_start", { index, content_block: { type: "text", text: "" } }))
    lines.push(event("content_block_delta", { index, delta: { type: "text_delta", text: reply.text } }))
  } else {
    lines.push(
      event("content_block_start", {
        index,
        content_block: { type: "tool_use", id: `toolu_${id}`, name: reply.tool, input: {} },
      }),
    )
    lines.push(
      event("content_block_delta", {
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(reply.input) },
      }),
    )
  }
  lines.push(event("content_block_stop", { index }))
  lines.push(
    event("message_delta", {
      delta: { stop_reason: "text" in reply ? "end_turn" : "tool_use" },
      usage: { output_tokens: 7 },
    }),
  )
  lines.push(event("message_stop", {}))
  return sse(lines)
}

export function fakeProvider() {
  const hits: Hit[] = []
  const queue: Reply[] = []
  let count = 0
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.text()
      const url = new URL(request.url)
      hits.push({ url: url.pathname, headers: Object.fromEntries(request.headers.entries()), body })
      const id = `msg_${++count}`
      // The title request gets its own answer; others take the queue.
      const reply: Reply = body.includes("Generate a title for this conversation")
        ? { text: "A title" }
        : (queue.shift() ?? { text: "ok" })
      if (url.pathname.endsWith("/chat/completions")) return chat(reply, id)
      if (url.pathname.endsWith("/messages")) return anthropic(reply, id)
      return new Response("not found", { status: 404 })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    hits,
    reply: (...replies: Reply[]) => queue.push(...replies),
    stop: () => server.stop(true),
  }
}

const model = (id: string) => ({
  id,
  name: id,
  attachment: false,
  reasoning: true,
  temperature: true,
  tool_call: true,
  release_date: "2025-01-01",
  limit: { context: 100000, output: 10000 },
  cost: { input: 1, output: 2 },
  options: {},
})

// Config for the two fake providers: `fakechat` (OpenAI chat) and `fakeanth` (Anthropic).
export function fakeConfig(url: string, extra: Record<string, unknown> = {}) {
  return {
    model: "fakechat/chat-model",
    small_model: "fakechat/chat-model",
    provider: {
      fakechat: {
        name: "Fake chat",
        id: "fakechat",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: { "chat-model": model("chat-model") },
        options: { apiKey: "test-key", baseURL: url },
      },
      fakeanth: {
        name: "Fake Anthropic",
        id: "fakeanth",
        env: [],
        npm: "@ai-sdk/anthropic",
        models: { "claude-fake": model("claude-fake") },
        options: { apiKey: "test-key", baseURL: url },
      },
    },
    ...extra,
  }
}
