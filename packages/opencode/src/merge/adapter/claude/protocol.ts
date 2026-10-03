import { Option, Schema } from "effect"

// Line shapes emitted by `claude -p --output-format stream-json --verbose --include-partial-messages`
// and the control channel enabled by `--permission-prompt-tool stdio`. Unknown line types are ignored.

const ParentToolUseID = Schema.optional(Schema.NullOr(Schema.String))

export const Init = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literal("init"),
  session_id: Schema.String,
  model: Schema.optional(Schema.String),
  permissionMode: Schema.optional(Schema.String),
})

const MessageStart = Schema.Struct({
  type: Schema.Literal("message_start"),
  message: Schema.Struct({ id: Schema.String }),
})

const BlockStart = Schema.Struct({
  type: Schema.Literal("content_block_start"),
  index: Schema.Number,
  content_block: Schema.Struct({ type: Schema.String }),
})

const BlockDelta = Schema.Struct({
  type: Schema.Literal("content_block_delta"),
  index: Schema.Number,
  delta: Schema.Struct({
    type: Schema.String,
    text: Schema.optional(Schema.String),
    thinking: Schema.optional(Schema.String),
  }),
})

const BlockStop = Schema.Struct({
  type: Schema.Literal("content_block_stop"),
  index: Schema.Number,
})

export const StreamEvent = Schema.Struct({
  type: Schema.Literal("stream_event"),
  parent_tool_use_id: ParentToolUseID,
  event: Schema.Union([MessageStart, BlockStart, BlockDelta, BlockStop, Schema.Struct({ type: Schema.String })]),
})

const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
const ThinkingBlock = Schema.Struct({ type: Schema.Literal("thinking"), thinking: Schema.String })
const ToolUseBlock = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Record(Schema.String, Schema.Unknown),
})
const ToolResultBlock = Schema.Struct({
  type: Schema.Literal("tool_result"),
  tool_use_id: Schema.String,
  content: Schema.optional(Schema.Unknown),
  is_error: Schema.optional(Schema.NullOr(Schema.Boolean)),
})
const OtherBlock = Schema.Struct({ type: Schema.String })

export const Assistant = Schema.Struct({
  type: Schema.Literal("assistant"),
  uuid: Schema.optional(Schema.String),
  parent_tool_use_id: ParentToolUseID,
  message: Schema.Struct({
    id: Schema.String,
    content: Schema.Array(Schema.Union([TextBlock, ThinkingBlock, ToolUseBlock, OtherBlock])),
  }),
})

export const User = Schema.Struct({
  type: Schema.Literal("user"),
  uuid: Schema.optional(Schema.String),
  parent_tool_use_id: ParentToolUseID,
  message: Schema.Struct({
    content: Schema.Union([Schema.String, Schema.Array(Schema.Union([ToolResultBlock, TextBlock, OtherBlock]))]),
  }),
})

export const Result = Schema.Struct({
  type: Schema.Literal("result"),
  subtype: Schema.String,
  is_error: Schema.optional(Schema.Boolean),
  result: Schema.optional(Schema.String),
  total_cost_usd: Schema.optional(Schema.Number),
  duration_ms: Schema.optional(Schema.Number),
  num_turns: Schema.optional(Schema.Number),
  terminal_reason: Schema.optional(Schema.String),
  errors: Schema.optional(Schema.Array(Schema.String)),
  permission_denials: Schema.optional(
    Schema.Array(Schema.Struct({ tool_name: Schema.String, tool_input: Schema.optional(Schema.Unknown) })),
  ),
})

export const CanUseTool = Schema.Struct({
  type: Schema.Literal("control_request"),
  request_id: Schema.String,
  request: Schema.Struct({
    subtype: Schema.Literal("can_use_tool"),
    tool_name: Schema.String,
    input: Schema.Record(Schema.String, Schema.Unknown),
    tool_use_id: Schema.optional(Schema.String),
    blocked_path: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
  }),
})

export const ControlCancel = Schema.Struct({
  type: Schema.Literal("control_cancel_request"),
  request_id: Schema.String,
})

export type Line =
  | { readonly kind: "init"; readonly value: typeof Init.Type }
  | { readonly kind: "stream"; readonly value: typeof StreamEvent.Type }
  | { readonly kind: "assistant"; readonly value: typeof Assistant.Type }
  | { readonly kind: "user"; readonly value: typeof User.Type }
  | { readonly kind: "result"; readonly value: typeof Result.Type }
  | { readonly kind: "can-use-tool"; readonly value: typeof CanUseTool.Type }
  | { readonly kind: "cancel"; readonly value: typeof ControlCancel.Type }

const parseJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const decoders: ReadonlyArray<(input: unknown) => Option.Option<Line>> = [
  (input) => Option.map(Schema.decodeUnknownOption(Init)(input), (value) => ({ kind: "init", value })),
  (input) => Option.map(Schema.decodeUnknownOption(StreamEvent)(input), (value) => ({ kind: "stream", value })),
  (input) => Option.map(Schema.decodeUnknownOption(Assistant)(input), (value) => ({ kind: "assistant", value })),
  (input) => Option.map(Schema.decodeUnknownOption(User)(input), (value) => ({ kind: "user", value })),
  (input) => Option.map(Schema.decodeUnknownOption(Result)(input), (value) => ({ kind: "result", value })),
  (input) => Option.map(Schema.decodeUnknownOption(CanUseTool)(input), (value) => ({ kind: "can-use-tool", value })),
  (input) => Option.map(Schema.decodeUnknownOption(ControlCancel)(input), (value) => ({ kind: "cancel", value })),
]

export function decode(line: string): Line | undefined {
  const json = parseJson(line)
  if (Option.isNone(json)) return undefined
  return decoders.map((decoder) => decoder(json.value)).find(Option.isSome)?.value
}

export function userMessage(content: ReadonlyArray<{ type: "text"; text: string }>) {
  return JSON.stringify({ type: "user", message: { role: "user", content }, parent_tool_use_id: null }) + "\n"
}

export function controlResponse(
  requestID: string,
  response:
    | { behavior: "allow"; updatedInput: Record<string, unknown> }
    | { behavior: "deny"; message: string; interrupt: boolean },
) {
  return (
    JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestID, response } }) +
    "\n"
  )
}

export function interruptRequest(requestID: string) {
  return JSON.stringify({ type: "control_request", request_id: requestID, request: { subtype: "interrupt" } }) + "\n"
}

export * as ClaudeProtocol from "./protocol"
