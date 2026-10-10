import { Effect, Schema, Scope, Stream } from "effect"
import type { SessionMerge } from "@opencode-ai/schema/session-merge"

export class Unavailable extends Schema.TaggedErrorClass<Unavailable>()("MergeAdapterUnavailable", {
  adapter: Schema.String,
  message: Schema.String,
}) {}

export class InvalidArgs extends Schema.TaggedErrorClass<InvalidArgs>()("MergeInvalidArgs", {
  message: Schema.String,
}) {}

export class StartFailed extends Schema.TaggedErrorClass<StartFailed>()("MergeStartFailed", {
  message: Schema.String,
}) {}

export class RelocateFailed extends Schema.TaggedErrorClass<RelocateFailed>()("MergeRelocateFailed", {
  adapter: Schema.String,
  message: Schema.String,
}) {}

export type Env = Record<string, string | undefined>

export interface Content {
  readonly type: "text"
  readonly text: string
}

// The OpenCode agent posture the child must respect. `plan` parents are read-only no matter what
// the user passes through; `build` parents may opt into the child's own permission modes.
export type Parent = "plan" | "build"

export interface StartInput {
  readonly cwd: string
  readonly prompt: ReadonlyArray<Content>
  readonly mode: string
  readonly session: { readonly mode: "new" | "resume"; readonly id: string }
  readonly args: ReadonlyArray<string>
  readonly env: Env
}

export type Event =
  | { readonly type: "session"; readonly externalSessionID: string; readonly model?: string; readonly mode?: string }
  | { readonly type: "text-start" | "text-end" | "reasoning-start" | "reasoning-end"; readonly id: string }
  | { readonly type: "text-delta" | "reasoning-delta"; readonly id: string; readonly text: string }
  | {
      readonly type: "tool"
      readonly id: string
      readonly name: string
      readonly input?: Record<string, unknown>
      readonly output?: string
      readonly status: "running" | "completed" | "error"
    }
  | {
      readonly type: "permission-request"
      readonly id: string
      readonly tool: string
      readonly toolCallID?: string
      readonly input: Record<string, unknown>
      readonly blockedPath?: string
      readonly description?: string
    }
  | { readonly type: "permission-cancel"; readonly id: string }
  | {
      readonly type: "done"
      readonly isError: boolean
      readonly interrupted: boolean
      readonly result?: string
      readonly errors: ReadonlyArray<string>
      readonly costUSD?: number
      readonly durationMs?: number
      readonly turns?: number
      readonly denials: ReadonlyArray<{ readonly tool: string; readonly input: unknown }>
    }
  | { readonly type: "error"; readonly message: string }

export type Decision =
  | { readonly behavior: "allow"; readonly input: Record<string, unknown> }
  | { readonly behavior: "deny"; readonly message: string; readonly interrupt: boolean }

export interface Harness {
  readonly pid: number
  readonly events: Stream.Stream<Event, StartFailed>
  readonly respond: (requestID: string, decision: Decision) => Effect.Effect<void>
  readonly interrupt: Effect.Effect<void>
}

export interface ExternalSession {
  readonly id: string
  readonly modified: number
  readonly title?: string
  readonly preview?: string
  readonly branch?: string
}

export interface ToolView {
  readonly tool: string
  readonly input: Record<string, unknown>
}

export interface PermissionView {
  readonly permission: string
  readonly patterns: ReadonlyArray<string>
  readonly always: ReadonlyArray<string>
  readonly metadata: Record<string, unknown>
  readonly readOnly: boolean
}

// What an adapter changed when a folder moved: the move's journal keeps it, to undo it
// (operator/layout-move.ts).
export interface Relocation {
  readonly adapter: string
  /** Folders and files renamed, in order. */
  readonly renames: ReadonlyArray<{ readonly from: string; readonly to: string }>
  /** Files whose recorded working folder was rewritten, at their new paths. */
  readonly rewritten: ReadonlyArray<string>
}

// For a move's plan: how many of the adapter's per-folder records would follow the folder, and why they
// can't, if they can't.
export interface RelocationCheck {
  /** Where the adapter keeps them. */
  readonly root: string
  readonly folders: number
  readonly problem?: string
}

// An agent that keeps its own records per working folder (Claude Code's transcripts under
// `projects/<folder name>`): when a folder moves, its records of sessions that ran in the folder or below
// it follow, so those sessions resume in the new place.
export interface Relocator {
  readonly check: (from: string, env: Env) => Effect.Effect<RelocationCheck>
  readonly move: (from: string, to: string, env: Env) => Effect.Effect<Relocation, RelocateFailed>
  /** Puts back what `move` did. */
  readonly restore: (done: Relocation, from: string, to: string) => Effect.Effect<void>
}

export interface Adapter {
  readonly id: string
  readonly name: string
  readonly transports: ReadonlyArray<SessionMerge.Transport>
  readonly probe: (env: Env) => Effect.Effect<{ readonly binary: string; readonly version: string }, Unavailable>
  readonly start: (input: StartInput) => Effect.Effect<Harness, StartFailed, Scope.Scope>
  readonly validateArgs: (args: ReadonlyArray<string>, parent: Parent) => Effect.Effect<void, InvalidArgs>
  readonly resolveMode: (args: ReadonlyArray<string>, parent: Parent) => string
  readonly hasSession: (cwd: string, id: string, env: Env) => Effect.Effect<boolean>
  readonly listSessions: (cwd: string, env: Env) => Effect.Effect<ReadonlyArray<ExternalSession>>
  readonly describeTool: (name: string, input: Record<string, unknown>, cwd: string) => ToolView
  readonly permissionFor: (name: string, input: Record<string, unknown>, cwd: string) => PermissionView
  readonly relocator?: Relocator
}

export * as MergeAdapter from "./adapter"
