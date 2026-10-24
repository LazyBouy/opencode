export * as OperatorMessagePlaces from "./places"

import path from "path"
import { Global } from "@opencode-ai/core/global"
import { OperatorFileCache } from "../file-cache"
import { OperatorProjectIds } from "../project-ids"

// The projects messaging names (SPEC-0023 §9): by unique id (the message log's key) and by folder (the queue's),
// with their namespace (v1 reaches only projects in the sender's) and a name to show. Read through the file cache:
// every send and every delivery asks.

type Setting = { namespace: string; id?: string }

async function all(): Promise<Record<string, Setting>> {
  const data = await OperatorFileCache.json(path.join(Global.Path.config, "namespaces", "projects.json"))
  if (!data || typeof data !== "object") return {}
  return Object.fromEntries(
    Object.entries(data as Record<string, Record<string, unknown> | undefined>).flatMap(([key, value]) =>
      value && typeof value.namespace === "string"
        ? [[key, { namespace: value.namespace, ...(OperatorProjectIds.valid(value.id) ? { id: value.id } : {}) }]]
        : [],
    ),
  )
}

/** A project's unique id (its folder until it has one). */
export const idOf = async (key: string) => (await all())[key]?.id ?? key

/** A project's folder, by its unique id (or by its folder, for one without an id). */
export async function keyOf(id: string) {
  const projects = await all()
  const found = Object.entries(projects).find(([, setting]) => setting.id === id)?.[0]
  return found ?? (projects[id] || path.isAbsolute(id) ? id : undefined)
}

export const namespaceOf = async (key: string) => (await all())[key]?.namespace

/** A project's name, as messages show it: its folder's. */
export const nameOf = (key: string) => path.basename(key)

/** The projects of a namespace: folder, unique id and name. */
export async function inNamespace(namespace: string) {
  return Object.entries(await all())
    .filter(([, setting]) => setting.namespace === namespace)
    .map(([key, setting]) => ({ key, id: setting.id ?? key, name: nameOf(key) }))
}

/** Every project's unique id (the inbox transport consumes the queues of these that exist). */
export const allIds = async () => Object.entries(await all()).map(([key, setting]) => setting.id ?? key)
