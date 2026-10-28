export * as OperatorSessionCorrelation from "./session-correlation"

import fs from "fs/promises"
import path from "path"
import { Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { OperatorFileCache } from "../file-cache"

// A session's default correlation id for ping (SPEC-0026): a client sets it with the session's
// permissions, and `ping send` uses it when a call names none. Kept in
// `<data>/operator/session-correlations.json`, keyed by session, and dropped with the session.

// The legacy OpenAPI drops null from schemas, so an empty value clears the default.
export const Value = Schema.String.check(Schema.isPattern(/^[^\r\n]{0,200}$/)).annotate({
  description: "Up to 200 characters, no line breaks; empty clears it",
})

export const file = () => path.join(Global.Path.data, "operator", "session-correlations.json")
type Store = Record<string, string>
const read = (): Promise<Store> =>
  Bun.file(file())
    .json()
    .catch(() => ({}))
let queue: Promise<unknown> = Promise.resolve()
// Changes to the store happen one at a time.
function change(work: (store: Store) => void) {
  const next = queue.then(async () => {
    const store = await read()
    work(store)
    await fs.mkdir(path.dirname(file()), { recursive: true })
    await Bun.write(file(), JSON.stringify(store, null, 2) + "\n")
  })
  queue = next.catch(() => undefined)
  return next
}

// Read on every send: through the file cache. Writers read the file themselves.
export async function of(sessionID: string): Promise<string | undefined> {
  const store = ((await OperatorFileCache.json(file())) ?? {}) as Store
  return store[sessionID]
}

export function set(sessionID: string, correlationID: string) {
  return change((store) => {
    if (correlationID) store[sessionID] = correlationID
    else delete store[sessionID]
  })
}

export function forget(sessionID: string) {
  return set(sessionID, "")
}
