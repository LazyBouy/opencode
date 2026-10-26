import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQueryFields,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"

// A project file's exact bytes, for clients that keep what an agent wrote (iphi-flow saves them as
// step files, ISSUE-0006). Upstream's /file/content is for display: it trims text, and reads a
// missing file as empty text.
export const OperatorFilePaths = {
  raw: "/operator/file/raw",
} as const

export const OperatorRawFile = Schema.Struct({
  path: Schema.String.annotate({ description: "The path asked for" }),
  size: Schema.Finite.annotate({ description: "Bytes" }),
  mime: Schema.String,
  content: Schema.String.annotate({ description: "The file's bytes, base64" }),
}).annotate({ identifier: "OperatorRawFile" })

export class ApiFileRefusedError extends Schema.ErrorClass<{
  readonly name: "OperatorFileRefusedError"
  readonly data: { readonly message: string }
}>("OperatorFileRefusedError")(
  { name: Schema.Literal("OperatorFileRefusedError"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 400 },
) {}

export class ApiFileNotFoundError extends Schema.ErrorClass<{
  readonly name: "OperatorFileNotFoundError"
  readonly data: { readonly message: string }
}>("OperatorFileNotFoundError")(
  { name: Schema.Literal("OperatorFileNotFoundError"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 404 },
) {}

export class ApiFileTooLargeError extends Schema.ErrorClass<{
  readonly name: "OperatorFileTooLargeError"
  readonly data: { readonly message: string; readonly size: number }
}>("OperatorFileTooLargeError")(
  {
    name: Schema.Literal("OperatorFileTooLargeError"),
    data: Schema.Struct({ message: Schema.String, size: Schema.Finite }),
  },
  { httpApiStatus: 413 },
) {}

export const OperatorFileApi = HttpApi.make("operator-files")
  .add(
    HttpApiGroup.make("operatorFiles")
      .add(
        HttpApiEndpoint.get("raw", OperatorFilePaths.raw, {
          query: Schema.Struct({
            ...WorkspaceRoutingQueryFields,
            path: Schema.String.annotate({ description: "The file, relative to the project folder" }),
            maxBytes: Schema.optional(Schema.NumberFromString).annotate({
              description: "Refuse a larger file (413, with its size) instead of sending it",
            }),
          }),
          success: described(OperatorRawFile, "The file"),
          error: [ApiFileRefusedError, ApiFileNotFoundError, ApiFileTooLargeError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.projectFile.raw",
            summary: "Read a file's exact bytes",
            description:
              "A file in the project folder exactly as it is on disk, as base64, with its size and type. A path that leaves the folder, directly or through a symlink, is refused; a missing path or a folder is not found.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "operator files", description: "Project files, byte for byte." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode operator files HttpApi",
      version: "0.0.1",
      description: "Project files, byte for byte.",
    }),
  )
