import { InstanceState } from "@/effect/instance-state"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import fs from "fs/promises"
import path from "path"
import { ApiFileNotFoundError, ApiFileRefusedError, ApiFileTooLargeError } from "../groups/files"

const refused = (file: string) =>
  new ApiFileRefusedError({
    name: "OperatorFileRefusedError",
    data: { message: `${file} is outside the project folder` },
  })

const notFound = (file: string) =>
  new ApiFileNotFoundError({ name: "OperatorFileNotFoundError", data: { message: `${file} is not a file here` } })

// Exact bytes of a project file (ISSUE-0006). The real path is checked as well as the asked one, so a
// symlink cannot lead out of the folder.
const raw = Effect.fn("OperatorFiles.raw")(function* (input: { path: string; maxBytes?: number }) {
  const directory = (yield* InstanceState.context).directory
  const absolute = path.resolve(directory, input.path)
  if (!FSUtil.contains(directory, absolute)) return yield* Effect.fail(refused(input.path))
  const root = yield* Effect.promise(() => fs.realpath(directory))
  const real = yield* Effect.promise(() => fs.realpath(absolute).catch(() => undefined))
  if (real === undefined) return yield* Effect.fail(notFound(input.path))
  if (!FSUtil.contains(root, real)) return yield* Effect.fail(refused(input.path))
  const info = yield* Effect.promise(() => fs.stat(real))
  if (!info.isFile()) return yield* Effect.fail(notFound(input.path))
  if (input.maxBytes !== undefined && info.size > input.maxBytes)
    return yield* Effect.fail(
      new ApiFileTooLargeError({
        name: "OperatorFileTooLargeError",
        data: { message: `${input.path} is ${info.size} bytes, over ${input.maxBytes}`, size: info.size },
      }),
    )
  const content = yield* Effect.promise(() => fs.readFile(real))
  return { path: input.path, size: content.length, mime: FSUtil.mimeType(real), content: content.toString("base64") }
})

export const operatorFileHandlers = HttpApiBuilder.group(InstanceHttpApi, "operatorFiles", (handlers) =>
  Effect.succeed(
    handlers.handle("raw", (ctx) =>
      raw({ path: ctx.query.path, ...(ctx.query.maxBytes === undefined ? {} : { maxBytes: ctx.query.maxBytes }) }),
    ),
  ),
)
