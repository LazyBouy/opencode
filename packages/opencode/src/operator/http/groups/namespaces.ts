import { OperatorProfile } from "@/operator/profile"
import { OperatorProfileStore } from "@/operator/profile-store"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"

// Namespaces (organizations) and their prompt profile items, and project settings. Server-wide, part of
// OperatorRootApi. `/operator/profile` and `/operator/projects` are web pages, so these paths differ.
export const OperatorNamespacePaths = {
  namespaces: "/operator/namespaces",
  namespace: "/operator/namespaces/:ns",
  catalog: "/operator/namespaces/:ns/catalog",
  types: "/operator/namespaces/:ns/types",
  type: "/operator/namespaces/:ns/types/:id",
  layers: "/operator/namespaces/:ns/layers",
  layer: "/operator/namespaces/:ns/layers/:id",
  copyLayer: "/operator/namespaces/:ns/layers/:id/copy",
  groups: "/operator/namespaces/:ns/groups",
  group: "/operator/namespaces/:ns/groups/:id",
  profiles: "/operator/namespaces/:ns/profiles",
  profile: "/operator/namespaces/:ns/profiles/:id",
  copy: "/operator/namespaces/:ns/copy",
  projects: "/operator/project-settings",
  resolve: "/operator/project-settings/resolve",
  register: "/operator/project-settings/register",
  folderMove: "/operator/project-settings/folder/move",
  folderArchive: "/operator/project-settings/folder/archive",
} as const

const profileError = <Name extends string, Status extends number>(name: Name, status: Status) =>
  Schema.ErrorClass<{ readonly name: Name; readonly data: { readonly message: string } }>(name)(
    { name: Schema.Literal(name), data: Schema.Struct({ message: Schema.String }) },
    { httpApiStatus: status },
  )
export class ApiProfileInvalidError extends profileError("OperatorProfileInvalidError", 400) {}
export class ApiProfileNotFoundError extends profileError("OperatorProfileNotFoundError", 404) {}
const errors = [ApiProfileInvalidError, ApiProfileNotFoundError]
const ns = { ns: Schema.String }
const item = { ns: Schema.String, id: Schema.String }

// Payloads are not named in the API document, so the generated client takes flat parameters.
const TypeInput = Schema.Struct({ name: Schema.String, description: Schema.optional(Schema.String) })
const LayerInput = Schema.Struct({
  name: Schema.String,
  type: Schema.String.annotate({ description: "The group type id" }),
  section: Schema.optional(OperatorProfile.Section).annotate({
    description: "New layers only: the Layer Definition section (purpose, role, identity or custom)",
  }),
  text: Schema.String,
})
const GroupInput = Schema.Struct({ name: Schema.String, types: Schema.Array(Schema.String) })
const ProfileInput = Schema.Struct({ name: Schema.String, group: Schema.String, slots: OperatorProfile.Slots })
const Copied = Schema.Struct({ copied: Schema.Array(OperatorProfileStore.Copied) }).annotate({
  identifier: "OperatorPromptCopyResult",
})

const Resolution = Schema.Struct({
  directory: Schema.String,
  project: Schema.optional(
    Schema.Struct({
      key: Schema.String.annotate({ description: "The project's folder" }),
      git: Schema.Boolean,
    }),
  ).annotate({ description: "The project the folder belongs to; missing when it is not part of one" }),
}).annotate({ identifier: "OperatorProjectResolution" })

const Registered = Schema.Struct({
  project: OperatorProfileStore.ProjectInfo,
  copied: Schema.optional(
    Schema.Struct({
      files: Schema.Array(Schema.String).annotate({ description: "Files copied, relative to the project" }),
      kept: Schema.Array(Schema.String).annotate({ description: "Files the folder already had, left as they were" }),
      items: Schema.Array(OperatorProfileStore.Copied).annotate({
        description: "Prompt items copied to another namespace",
      }),
      sessions: Schema.Finite.annotate({ description: "Sessions copied" }),
    }),
  ).annotate({ description: "What was copied from the source project" }),
}).annotate({ identifier: "OperatorProjectRegisterResult" })

const doc = (identifier: string, summary: string, description: string) =>
  OpenApi.annotations({ identifier, summary, description })

export const OperatorNamespaceGroup = HttpApiGroup.make("operatorNamespace")
  .add(
    HttpApiEndpoint.get("list", OperatorNamespacePaths.namespaces, {
      success: described(Schema.Array(OperatorProfileStore.NamespaceSummary), "Namespaces"),
    }).annotateMerge(
      doc(
        "operator.namespace.list",
        "List namespaces",
        "Every namespace (organization) with its projects. OpenCode comes first.",
      ),
    ),
    HttpApiEndpoint.post("create", OperatorNamespacePaths.namespaces, {
      payload: Schema.Struct({ name: Schema.String, purpose: Schema.optional(Schema.String) }),
      success: described(OperatorProfile.Namespace, "The new namespace"),
      error: errors,
    }).annotateMerge(
      doc(
        "operator.namespace.create",
        "Create a namespace",
        "Create a namespace as a copy of OpenCode: OpenCode's own types, layers, groups and profiles are copied, and built-in items stay shared. It starts with no projects.",
      ),
    ),
    HttpApiEndpoint.get("get", OperatorNamespacePaths.namespace, {
      params: ns,
      success: described(OperatorProfile.Namespace, "The namespace"),
      error: errors,
    }).annotateMerge(doc("operator.namespace.get", "Get a namespace", "A namespace's record.")),
    HttpApiEndpoint.patch("update", OperatorNamespacePaths.namespace, {
      params: ns,
      payload: Schema.Struct({
        name: Schema.optional(Schema.String),
        purpose: Schema.optional(Schema.String).annotate({ description: "The org purpose" }),
        defaultProfile: Schema.optional(Schema.String).annotate({ description: "An empty string clears it" }),
      }),
      success: described(OperatorProfile.Namespace, "The namespace"),
      error: errors,
    }).annotateMerge(
      doc(
        "operator.namespace.update",
        "Change a namespace",
        "Change a namespace's name, its org purpose (sent first in every agent's prompt) or its default profile.",
      ),
    ),
    HttpApiEndpoint.delete("remove", OperatorNamespacePaths.namespace, {
      params: ns,
      success: described(Schema.Boolean, "Deleted"),
      error: errors,
    }).annotateMerge(
      doc(
        "operator.namespace.remove",
        "Delete a namespace",
        "Delete a namespace that has no projects, with its items. OpenCode cannot be deleted.",
      ),
    ),
    HttpApiEndpoint.get("catalog", OperatorNamespacePaths.catalog, {
      params: ns,
      success: described(
        OperatorProfileStore.CatalogInfo,
        "Types, layers, groups, profiles, projects and agent settings",
      ),
      error: errors,
    }).annotateMerge(
      doc(
        "operator.namespace.catalog",
        "Get a namespace's prompt items",
        "Built-in and the namespace's own group types, layers, groups and profiles, the namespace's projects, and its agents' prompt settings. Tool descriptions are listed per project by GET /operator/prompt.",
      ),
    ),
    HttpApiEndpoint.post("typeCreate", OperatorNamespacePaths.types, {
      params: ns,
      payload: TypeInput,
      success: described(OperatorProfile.GroupType, "The group type"),
      error: errors,
    }).annotateMerge(doc("operator.namespace.type.create", "Create a group type", "Create a custom group type.")),
    HttpApiEndpoint.put("typeUpdate", OperatorNamespacePaths.type, {
      params: item,
      payload: TypeInput,
      success: described(OperatorProfile.GroupType, "The group type"),
      error: errors,
    }).annotateMerge(doc("operator.namespace.type.update", "Change a group type", "Change a custom group type.")),
    HttpApiEndpoint.delete("typeRemove", OperatorNamespacePaths.type, {
      params: item,
      success: described(Schema.Boolean, "Deleted"),
      error: errors,
    }).annotateMerge(
      doc(
        "operator.namespace.type.remove",
        "Delete a group type",
        "Delete a custom group type no layer or group uses.",
      ),
    ),
    HttpApiEndpoint.post("layerCreate", OperatorNamespacePaths.layers, {
      params: ns,
      payload: LayerInput,
      success: described(OperatorProfile.Layer, "The layer"),
      error: errors,
    }).annotateMerge(
      doc("operator.namespace.layer.create", "Create a layer", "Create a layer: one text of one group type."),
    ),
    HttpApiEndpoint.put("layerUpdate", OperatorNamespacePaths.layer, {
      params: item,
      payload: LayerInput,
      success: described(OperatorProfile.Layer, "The layer"),
      error: errors,
    }).annotateMerge(
      doc(
        "operator.namespace.layer.update",
        "Change a layer",
        "Change a layer's name and text, and the type of a Custom layer. A copy of one of OpenCode's texts keeps its type.",
      ),
    ),
    HttpApiEndpoint.delete("layerRemove", OperatorNamespacePaths.layer, {
      params: item,
      success: described(Schema.Boolean, "Deleted"),
      error: errors,
    }).annotateMerge(
      doc("operator.namespace.layer.remove", "Delete a layer", "Delete a layer no profile, override or project uses."),
    ),
    HttpApiEndpoint.post("layerCopy", OperatorNamespacePaths.copyLayer, {
      params: item,
      payload: Schema.Struct({
        text: Schema.optional(Schema.String).annotate({
          description: "A tool description's text (from GET /operator/prompt)",
        }),
      }),
      success: described(OperatorProfile.Layer, "The editable copy"),
      error: errors,
    }).annotateMerge(
      doc(
        "operator.namespace.layer.copy",
        "Make an editable copy",
        "Copy one of OpenCode's texts into the namespace. The copy does nothing until a profile includes it; OpenCode's text stays as it is.",
      ),
    ),
    HttpApiEndpoint.post("groupCreate", OperatorNamespacePaths.groups, {
      params: ns,
      payload: GroupInput,
      success: described(OperatorProfile.Group, "The group"),
      error: errors,
    }).annotateMerge(
      doc(
        "operator.namespace.group.create",
        "Create a group",
        "Create an ordering of group types. Purpose, Agent role and Agent identity are required, and no type repeats.",
      ),
    ),
    HttpApiEndpoint.put("groupUpdate", OperatorNamespacePaths.group, {
      params: item,
      payload: GroupInput,
      success: described(OperatorProfile.Group, "The group"),
      error: errors,
    }).annotateMerge(doc("operator.namespace.group.update", "Change a group", "Change a group.")),
    HttpApiEndpoint.delete("groupRemove", OperatorNamespacePaths.group, {
      params: item,
      success: described(Schema.Boolean, "Deleted"),
      error: errors,
    }).annotateMerge(doc("operator.namespace.group.remove", "Delete a group", "Delete a group no profile uses.")),
    HttpApiEndpoint.post("profileCreate", OperatorNamespacePaths.profiles, {
      params: ns,
      payload: ProfileInput,
      success: described(OperatorProfile.Profile, "The profile"),
      error: errors,
    }).annotateMerge(
      doc(
        "operator.namespace.profile.create",
        "Create a profile",
        "Create a profile: a group, and for each of its types an ordered slot of layers of that type. Purpose is automatic and holds no layers.",
      ),
    ),
    HttpApiEndpoint.put("profileUpdate", OperatorNamespacePaths.profile, {
      params: item,
      payload: ProfileInput,
      success: described(OperatorProfile.Profile, "The profile"),
      error: errors,
    }).annotateMerge(doc("operator.namespace.profile.update", "Change a profile", "Change a profile.")),
    HttpApiEndpoint.delete("profileRemove", OperatorNamespacePaths.profile, {
      params: item,
      success: described(Schema.Boolean, "Deleted"),
      error: errors,
    }).annotateMerge(
      doc(
        "operator.namespace.profile.remove",
        "Delete a profile",
        "Delete a profile no agent, project or namespace default uses.",
      ),
    ),
    HttpApiEndpoint.post("copy", OperatorNamespacePaths.copy, {
      params: ns,
      payload: Schema.Struct({
        kind: OperatorProfileStore.Kind,
        id: Schema.String,
        target: Schema.String.annotate({ description: "The namespace to copy to" }),
      }),
      success: described(Copied, "What was copied"),
      error: errors,
    }).annotateMerge(
      doc(
        "operator.namespace.copy",
        "Copy to another namespace",
        'Copy a type, layer, group or profile to another namespace, with what it uses that the target lacks. A name the target already uses gets " (copy)".',
      ),
    ),
    HttpApiEndpoint.get("projects", OperatorNamespacePaths.projects, {
      success: described(Schema.Array(OperatorProfileStore.ProjectInfo), "Projects"),
    }).annotateMerge(
      doc(
        "operator.projectSettings.list",
        "List project prompt settings",
        "Every project with its namespace, linked Project Purpose and default profile.",
      ),
    ),
    HttpApiEndpoint.put("project", OperatorNamespacePaths.projects, {
      payload: Schema.Struct({
        key: Schema.String.annotate({ description: "The project's folder" }),
        namespace: Schema.optional(Schema.String),
        purpose: Schema.optional(Schema.String).annotate({
          description: "A Project Purpose layer; an empty string clears it",
        }),
        defaultProfile: Schema.optional(Schema.String).annotate({ description: "An empty string clears it" }),
        dryRun: Schema.optional(Schema.Boolean).annotate({ description: "Only list what a move would copy" }),
      }),
      success: described(
        Schema.Struct({
          project: OperatorProfileStore.ProjectInfo,
          copied: Schema.Array(OperatorProfileStore.Copied),
        }).annotate({
          identifier: "OperatorProjectSettingResult",
        }),
        "The project",
      ),
      error: errors,
    }).annotateMerge(
      doc(
        "operator.projectSettings.update",
        "Change a project's prompt settings",
        "Set a project's namespace, Project Purpose or default profile. A new namespace moves the project: what it uses is copied there, so its prompts stay the same.",
      ),
    ),
    HttpApiEndpoint.get("projectResolve", OperatorNamespacePaths.resolve, {
      query: Schema.Struct({ directory: Schema.String }),
      success: described(Resolution, "The folder's project"),
    }).annotateMerge(
      doc(
        "operator.projectSettings.resolve",
        "Find a folder's project",
        "The project a folder belongs to: the git repository it is in, or the registered folder outside git it is in. Sessions can start only in a project.",
      ),
    ),
    HttpApiEndpoint.post("projectRegister", OperatorNamespacePaths.register, {
      payload: Schema.Struct({
        directory: Schema.String.annotate({ description: "A folder outside git" }),
        git: Schema.optional(Schema.Boolean).annotate({
          description: "Make it a git repository (git init) instead of registering it as it is",
        }),
        namespace: Schema.optional(Schema.String).annotate({
          description: "Its namespace; by default the source project's, or OpenCode",
        }),
        from: Schema.optional(Schema.String).annotate({
          description:
            "A project to copy: its agents with their prompt settings, its tools, skills and commands. The source is left as it is.",
        }),
        sessions: Schema.optional(Schema.Boolean).annotate({
          description: "With from: copy the source's sessions too (off by default)",
        }),
      }),
      success: described(Registered, "The project, and what was copied"),
      error: errors,
    }).annotateMerge(
      doc(
        "operator.projectSettings.register",
        "Make a folder a project",
        "Register a folder outside git as a project (its subfolders belong to it too), or make it a git repository; a missing folder is created. With from, the new project is a copy of another: in the same namespace the prompt profiles are shared, in another the ones it uses are copied. Sessions can start only in a project.",
      ),
    ),
    HttpApiEndpoint.post("folderMove", OperatorNamespacePaths.folderMove, {
      payload: Schema.Struct({
        directory: Schema.String.annotate({ description: "A folder that is not part of a project" }),
        project: Schema.String.annotate({ description: "The project to move its sessions to" }),
      }),
      success: described(
        Schema.Struct({ moved: Schema.Finite, archived: Schema.Finite }).annotate({
          identifier: "OperatorFolderMoveResult",
        }),
        "Sessions moved, and sessions archived because they could not be moved",
      ),
      error: errors,
    }).annotateMerge(
      doc(
        "operator.folderSessions.move",
        "Move a folder's sessions into a project",
        "Move the sessions that ran in a folder that is not part of a project (with their subagent sessions) to a project's folder. A session that cannot be moved is archived. The files they changed stay where they are.",
      ),
    ),
    HttpApiEndpoint.post("folderArchive", OperatorNamespacePaths.folderArchive, {
      payload: Schema.Struct({
        directory: Schema.String.annotate({ description: "A folder that is not part of a project" }),
      }),
      success: described(
        Schema.Struct({ archived: Schema.Finite }).annotate({ identifier: "OperatorFolderArchiveResult" }),
        "Sessions archived",
      ),
      error: errors,
    }).annotateMerge(
      doc(
        "operator.folderSessions.archive",
        "Archive a folder's sessions",
        "Archive the sessions that ran in a folder that is not part of a project.",
      ),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({ title: "operator namespaces", description: "Namespace and prompt profile routes." }),
  )
