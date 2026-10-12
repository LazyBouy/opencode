export * as OperatorTokenizers from "./tokenizers"

import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { Schema } from "effect"
import { Global } from "@opencode-ai/core/global"

// Tokenizers for the Transcript's token accounting (call-accounting.ts), as plug-ins: no tokenizer is
// built in, so counts are measured deltas and estimates (characters ÷ 4) until one is added. A
// tokenizer is a module in `<config>/tokenizers/` (`~/.config/opencode/tokenizers/*.js|mjs|ts`) whose
// default export is one tokenizer or a list of them:
//
//   export default {
//     id: "o200k", label: "OpenAI o200k_base",
//     models: ["openai/*", "*/gpt-4o*", "*/gpt-5*"],   // provider/model, `*` matches anything
//     count: (text) => encoder.encode(text).length,
//   }
//
// It counts every item of a call whose model matches; the first matching tokenizer wins. Loaded when
// the server starts and on reload (`reload`); a call's stored counts say which tokenizer made them, so
// "Recount" (calls.ts) brings old calls in line after one is added.

export interface Tokenizer {
  readonly id: string
  readonly label?: string
  readonly models: ReadonlyArray<string>
  readonly count: (text: string) => number
}

export const Info = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  models: Schema.Array(Schema.String),
  file: Schema.optional(Schema.String).annotate({ description: "The module it was loaded from" }),
}).annotate({ identifier: "OperatorTokenizer" })
export type Info = typeof Info.Type

export const LoadError = Schema.Struct({
  file: Schema.String,
  message: Schema.String,
}).annotate({ identifier: "OperatorTokenizerLoadError" })

export const List = Schema.Struct({
  folder: Schema.String.annotate({ description: "Where tokenizer modules are loaded from" }),
  tokenizers: Schema.Array(Info),
  errors: Schema.Array(LoadError),
}).annotate({ identifier: "OperatorTokenizerList" })
export type List = typeof List.Type

export const folder = () => path.join(Global.Path.config, "tokenizers")

let loaded: Array<{ tokenizer: Tokenizer; file?: string }> = []
let errors: Array<{ file: string; message: string }> = []
let started: Promise<void> | undefined

const valid = (value: unknown): value is Tokenizer =>
  !!value &&
  typeof value === "object" &&
  typeof (value as Tokenizer).id === "string" &&
  Array.isArray((value as Tokenizer).models) &&
  typeof (value as Tokenizer).count === "function"

// Loads every module in the tokenizer folder again.
export async function reload() {
  const dir = folder()
  const files = await fs.readdir(dir).catch(() => [] as string[])
  const next: typeof loaded = []
  const failed: typeof errors = []
  for (const name of files.filter((file) => /\.(m?js|ts)$/.test(file)).sort()) {
    const file = path.join(dir, name)
    try {
      const module = (await import(`${pathToFileURL(file).href}?at=${Date.now()}`)) as { default?: unknown }
      const exported = Array.isArray(module.default) ? module.default : [module.default]
      const found = exported.filter(valid)
      if (!found.length) failed.push({ file, message: "The default export is not a tokenizer ({ id, models, count })" })
      for (const tokenizer of found) next.push({ tokenizer, file })
    } catch (error) {
      failed.push({ file, message: error instanceof Error ? error.message : String(error) })
    }
  }
  loaded = [...loaded.filter((item) => !item.file), ...next]
  errors = failed
}

// Loads the folder once (on first use).
export function ready() {
  return (started ??= reload())
}

// For tests and code: adds a tokenizer that is not in the folder.
export function register(tokenizer: Tokenizer) {
  loaded = [...loaded.filter((item) => item.tokenizer.id !== tokenizer.id), { tokenizer }]
  return () => {
    loaded = loaded.filter((item) => item.tokenizer !== tokenizer)
  }
}

const matches = (pattern: string, model: string) =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
    "i",
  ).test(model)

// The tokenizer for a model (`provider/model`), if one is added.
export function forModel(model: string | undefined): Tokenizer | undefined {
  if (!model) return undefined
  return loaded.find((item) => item.tokenizer.models.some((pattern) => matches(pattern, model)))?.tokenizer
}

// A count that never fails: a tokenizer that throws counts nothing (the caller estimates).
export function count(tokenizer: Tokenizer, text: string): number | undefined {
  try {
    const value = tokenizer.count(text)
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined
  } catch {
    return undefined
  }
}

export const Count = Schema.Struct({
  tokens: Schema.Finite,
  tokenizer: Schema.optional(Schema.String).annotate({
    description: "The tokenizer that counted them; without one, an estimate (characters ÷ 4)",
  }),
}).annotate({ identifier: "OperatorTokenCount" })
export type Count = typeof Count.Type

// A text's tokens for a model: counted by its tokenizer, else estimated as the Transcript does (characters ÷ 4).
export function countFor(model: string | undefined, text: string): Count {
  const tokenizer = forModel(model)
  const counted = tokenizer ? count(tokenizer, text) : undefined
  return counted === undefined ? { tokens: Math.ceil(text.length / 4) } : { tokens: counted, tokenizer: tokenizer!.id }
}

export function list(): List {
  return {
    folder: folder(),
    tokenizers: loaded.map(({ tokenizer, file }) => ({
      id: tokenizer.id,
      label: tokenizer.label ?? tokenizer.id,
      models: [...tokenizer.models],
      ...(file ? { file } : {}),
    })),
    errors: [...errors],
  }
}

// What counts a call: the tokenizer's id, or "estimate". Stored counts made another way are recomputed.
export function signature(model: string | undefined) {
  return forModel(model)?.id ?? "estimate"
}
