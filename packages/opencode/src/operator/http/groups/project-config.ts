import { Schema } from "effect"
import { QueryBoolean } from "@/server/routes/instance/httpapi/groups/query"
import { OperatorProjectConfig } from "@/operator/project-config"

// Shared by every route that can write a project's config (global_and_opencode_namespaces_spec.md §7.3):
// a project without a config of its own gets a copy of its namespace's on the first write, which needs
// `confirmCopy`. Without it the write is refused with this error, which the app turns into the
// "Save as this project's own config?" question, then repeats the request with `confirmCopy=true`.

export const ConfirmCopyField = {
  confirmCopy: Schema.optional(QueryBoolean).annotate({
    description:
      "true: when the project has no config of its own, give it a copy of its namespace's config with this change",
  }),
}

export class ApiProjectConfigCopyError extends Schema.ErrorClass<ApiProjectConfigCopyError>(
  "OperatorProjectConfigCopyNeededError",
)(
  {
    name: Schema.Literal("OperatorProjectConfigCopyNeededError"),
    data: Schema.Struct({
      message: Schema.String,
      project: Schema.String,
      namespace: Schema.String,
      file: Schema.String.annotate({ description: "Where the project's own config would be written" }),
    }),
  },
  { httpApiStatus: 409 },
) {}

export const copyApiError = (error: OperatorProjectConfig.CopyNeededError) =>
  new ApiProjectConfigCopyError({
    name: "OperatorProjectConfigCopyNeededError",
    data: { message: error.message, project: error.project, namespace: error.namespace, file: error.file },
  })

/**
 * An error mapper that turns a refused copy into its API error and the rest with `map`. Handlers use it
 * with `OperatorProjectConfig.consent(ctx.query.confirmCopy)`.
 */
export const copyOr =
  <E, E2>(map: (error: E) => E2) =>
  (error: E | OperatorProjectConfig.CopyNeededError): E2 | ApiProjectConfigCopyError =>
    error instanceof OperatorProjectConfig.CopyNeededError ? copyApiError(error) : map(error as E)
