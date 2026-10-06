export * as OperatorProviderTap from "./provider-tap"

import { GlobalBus } from "@/bus/global"
import { OperatorCallFormat } from "./call-format"
import { OperatorCallStore } from "./call-store"

// Records every model call: the one fork line in provider/provider.ts `timeoutFetch` wraps the fetch
// each provider request goes through. The fork's prompt plugin registers a call in `chat.headers` and
// adds the header `x-operator-call` with its id; the tap removes that header before the request
// leaves (the only change it ever makes to a request) and records the call under that id. The
// request is recorded at once, the response from a clone of it once it has streamed, both in the
// background: the tap never fails, delays or otherwise changes the request or the response. Stored
// in call-store.ts.

export const HEADER = "x-operator-call"
const SESSION_HEADER = "x-opencode-session-id"
// Headers kept with a call: never Authorization, API keys or cookies.
const KEPT_HEADERS = ["content-type", "anthropic-version", "anthropic-beta", "openai-beta"]
const MAX_ERROR = 64 * 1024

export type Registration = {
  callID: string
  sessionID: string
  kind: OperatorCallStore.Kind
  agent?: string
  projectKey?: string
  directory?: string
  userMessageID?: string
  assistantMessageID?: string
  retryOf?: string
  model?: string
  providerID?: string
  /** Not recorded (a helper call with no real session): the header is still removed. */
  skip?: boolean
}

// Calls registered by the plugin and not sent yet, by id.
const registered = new Map<string, Registration & { at: number }>()
let sequence = 0
const newID = () => `call_${Date.now().toString(36)}${(sequence++).toString(36).padStart(4, "0")}`

export function register(input: Omit<Registration, "callID">): string {
  const now = Date.now()
  // A call registered for a request that never went out is forgotten after ten minutes.
  for (const [id, item] of registered) if (now - item.at > 600_000) registered.delete(id)
  const callID = newID()
  registered.set(callID, { ...input, callID, at: now })
  return callID
}

// Whether calls without the plugin's header (an unknown caller) are recorded. The calls service keeps
// it in line with config `operatorRecordCalls`.
export const settings = { unlinked: true }

// For tests: called with each finished recording.
export const audit: { done?: (input: { sessionID: string; callID: string }) => void } = {}

function headersOf(headers: unknown): Record<string, string> {
  if (!headers) return {}
  if (headers instanceof Headers)
    return Object.fromEntries([...headers.entries()].map(([k, v]) => [k.toLowerCase(), v]))
  if (Array.isArray(headers)) return Object.fromEntries(headers.map(([k, v]) => [String(k).toLowerCase(), String(v)]))
  return Object.fromEntries(
    Object.entries(headers as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), String(v)]),
  )
}

function withoutHeader(headers: unknown, name: string): unknown {
  if (headers instanceof Headers) {
    const next = new Headers(headers)
    next.delete(name)
    return next
  }
  if (Array.isArray(headers)) return headers.filter(([key]) => String(key).toLowerCase() !== name)
  return Object.fromEntries(
    Object.entries(headers as Record<string, unknown>).filter(([key]) => key.toLowerCase() !== name),
  )
}

const emit = (
  call: { sessionID: string; callID: string; directory?: string; kind: string; agent?: string },
  type: string,
) =>
  GlobalBus.emit("event", {
    ...(call.directory ? { directory: call.directory } : {}),
    payload: {
      type,
      properties: {
        sessionID: call.sessionID,
        callID: call.callID,
        kind: call.kind,
        ...(call.agent ? { agent: call.agent } : {}),
      },
    },
  })

function endpointOf(url: string) {
  try {
    const parsed = new URL(url)
    return parsed.host + parsed.pathname
  } catch {
    return url.split("?")[0] ?? url
  }
}

// Records the request; returns a promise that settles when it is stored.
function recordRequest(
  reg: Registration,
  input: { url: string; body: string; headers: Record<string, string>; started: number },
) {
  const split = OperatorCallFormat.split(input.body)
  const call: OperatorCallStore.Call = {
    callID: reg.callID,
    sessionID: reg.sessionID,
    kind: reg.kind,
    ...(reg.projectKey ? { projectKey: reg.projectKey } : {}),
    ...(reg.directory ? { directory: reg.directory } : {}),
    ...(reg.agent ? { agent: reg.agent } : {}),
    ...(reg.userMessageID ? { userMessageID: reg.userMessageID } : {}),
    ...(reg.assistantMessageID ? { assistantMessageID: reg.assistantMessageID } : {}),
    ...(reg.retryOf ? { retryOf: reg.retryOf } : {}),
    ...(reg.model ? { model: reg.model } : {}),
    ...(reg.providerID ? { providerID: reg.providerID } : {}),
    endpoint: endpointOf(input.url),
    format: OperatorCallFormat.detect(input.url, split.parsed),
    startedAt: input.started,
    request: {
      body: split.stored,
      bytes: Buffer.byteLength(input.body),
      exact: split.exact,
      headers: Object.fromEntries(
        KEPT_HEADERS.flatMap((key) => (input.headers[key] ? [[key, input.headers[key]]] : [])),
      ),
    },
  }
  return OperatorCallStore.saveCall(call, split.blobs).then(() => {
    emit(call, "operator.call.recorded")
    if (call.kind === "agent" && call.projectKey && call.agent)
      void OperatorCallStore.setLatest(call.projectKey, call.agent, {
        sessionID: call.sessionID,
        callID: call.callID,
        at: call.startedAt,
      }).catch(() => undefined)
    return call
  })
}

async function recordResponse(
  stored: Promise<OperatorCallStore.Call>,
  reg: Registration,
  outcome: { response: Response; firstByte: number } | { error: unknown; at: number },
) {
  const call = await stored
  if ("error" in outcome) {
    await OperatorCallStore.updateCall(reg.sessionID, reg.callID, {
      finishedAt: outcome.at,
      error: { message: outcome.error instanceof Error ? outcome.error.message : String(outcome.error) },
    })
  } else {
    const text = await outcome.response.text().catch(() => "")
    const finishedAt = Date.now()
    const ok = outcome.response.status >= 200 && outcome.response.status < 300
    await OperatorCallStore.updateCall(reg.sessionID, reg.callID, {
      firstByteAt: outcome.firstByte,
      finishedAt,
      httpStatus: outcome.response.status,
      ...(ok
        ? { response: OperatorCallFormat.assemble(call.format, text) }
        : { error: { status: outcome.response.status, body: text.slice(0, MAX_ERROR) } }),
    })
  }
  emit(call, "operator.call.updated")
  audit.done?.({ sessionID: reg.sessionID, callID: reg.callID })
}

// The provider fetch, recording each call it makes.
export function wrap<F extends (input: any, init?: any) => Promise<Response>>(fetchFn: F): F {
  return (async (input: any, init?: any) => {
    let request = init
    let reg: Registration | undefined
    let target: { url: string; body: string; headers: Record<string, string>; started: number } | undefined
    try {
      const headers = headersOf(init?.headers)
      const callID = headers[HEADER]
      if (callID) {
        request = { ...init, headers: withoutHeader(init.headers, HEADER) }
        reg = registered.get(callID)
        registered.delete(callID)
      } else if (headers[SESSION_HEADER] && settings.unlinked) {
        reg = { callID: newID(), sessionID: headers[SESSION_HEADER], kind: "unlinked" }
      }
      if (reg?.skip) reg = undefined
      if (reg && typeof request?.body === "string") {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input?.url ?? input)
        target = { url, body: request.body, headers, started: Date.now() }
      }
    } catch {
      // Recording never gets in the way of the request.
    }
    // Parsing and storing wait until the request has gone out.
    const stored =
      reg && target
        ? new Promise<OperatorCallStore.Call>((resolve, reject) => {
            const current = reg!
            const sent = target!
            setTimeout(() => {
              try {
                recordRequest(current, sent).then(resolve, reject)
              } catch (error) {
                reject(error)
              }
            }, 0)
          })
        : undefined
    stored?.catch(() => undefined)
    try {
      const response = await fetchFn(input, request)
      if (stored && reg) {
        try {
          const copy = response.clone()
          const outcome = { response: copy, firstByte: Date.now() }
          const current = reg
          setTimeout(() => void recordResponse(stored, current, outcome).catch(() => undefined), 0)
        } catch {
          // a response that cannot be cloned is not recorded
        }
      }
      return response
    } catch (error) {
      if (stored && reg) {
        const current = reg
        setTimeout(() => void recordResponse(stored, current, { error, at: Date.now() }).catch(() => undefined), 0)
      }
      throw error
    }
  }) as F
}
