import { OperatorProjectRecords } from "@/operator/project-records"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"

// Projects' records (description, status, manager, members, groups). Server-wide: keyed by project.
export const OperatorProjectRecordPaths = {
  records: "/operator/project-records",
} as const

export class ApiProjectRecordInvalidError extends Schema.ErrorClass<{
  readonly name: "OperatorProjectRecordInvalidError"
  readonly data: { readonly message: string }
}>("OperatorProjectRecordInvalidError")(
  { name: Schema.Literal("OperatorProjectRecordInvalidError"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 400 },
) {}

export const OperatorProjectRecordGroup = HttpApiGroup.make("operatorProjectRecords")
  .add(
    HttpApiEndpoint.get("list", OperatorProjectRecordPaths.records, {
      success: described(Schema.Array(OperatorProjectRecords.Record), "Every project's record that was set"),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "operator.projectRecord.list",
        summary: "List projects' records",
        description:
          "Each project's description, status, manager, members (the agents that may participate) and groups. A project without a record is active, with no members (every agent may participate).",
      }),
    ),
    HttpApiEndpoint.put("update", OperatorProjectRecordPaths.records, {
      payload: Schema.Struct({
        key: Schema.String.annotate({ description: "The project" }),
        ...OperatorProjectRecords.Patch.fields,
      }),
      success: described(OperatorProjectRecords.Record, "The project's record"),
      error: ApiProjectRecordInvalidError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "operator.projectRecord.update",
        summary: "Change a project's record",
        description:
          "Change a project's description, status, manager, members or groups. The manager and every group member must be members when the project names members.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "operator project records", description: "Project record routes." }))
