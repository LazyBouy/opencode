import { OperatorProfile } from "@/operator/profile"
import { OperatorProfileStore } from "@/operator/profile-store"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"

// `/operator/profile` is a web page, so these routes live under /operator/prompt-profile.
export const OperatorPromptProfilePaths = {
  catalog: "/operator/prompt-profile",
  layers: "/operator/prompt-profile/layer",
  layer: "/operator/prompt-profile/layer/:id",
  groups: "/operator/prompt-profile/group",
  group: "/operator/prompt-profile/group/:id",
  profiles: "/operator/prompt-profile/profile",
  profile: "/operator/prompt-profile/profile/:id",
  defaults: "/operator/prompt-profile/defaults",
} as const

const profileError = <Name extends string, Status extends number>(name: Name, status: Status) =>
  Schema.ErrorClass<{ readonly name: Name; readonly data: { readonly message: string } }>(name)(
    { name: Schema.Literal(name), data: Schema.Struct({ message: Schema.String }) },
    { httpApiStatus: status },
  )
export class ApiProfileInvalidError extends profileError("OperatorProfileInvalidError", 400) {}
export class ApiProfileNotFoundError extends profileError("OperatorProfileNotFoundError", 404) {}
const errors = [ApiProfileInvalidError, ApiProfileNotFoundError]
const params = { id: Schema.String }
// Not named in the API document, so the generated client takes these as flat parameters.
const DefaultsInput = Schema.Struct({
  global: Schema.optional(Schema.String),
  projects: Schema.Record(Schema.String, Schema.String),
})

const annotate = (identifier: string, summary: string, description: string) =>
  OpenApi.annotations({ identifier, summary, description })

// Prompt profiles (layers, groups, profiles and defaults) are server-wide. Part of OperatorRootApi.
export const OperatorPromptProfileGroup = HttpApiGroup.make("operatorPromptProfile")
  .add(
    HttpApiEndpoint.get("catalog", OperatorPromptProfilePaths.catalog, {
      success: described(OperatorProfileStore.CatalogInfo, "Layers, groups, profiles and defaults"),
    }).annotateMerge(
      annotate(
        "operator.promptProfile.catalog",
        "List prompt profile resources",
        "Every prompt layer (OpenCode's own texts, slots, generated sections, layers you wrote and existing prompts/ and identity/ files), prompt group and profile, the default profiles, and the projects they can be scoped to. Tool descriptions are listed per project by GET /operator/prompt.",
      ),
    ),
    HttpApiEndpoint.post("layerCreate", OperatorPromptProfilePaths.layers, {
      payload: OperatorProfileStore.LayerInput,
      success: described(OperatorProfile.Layer, "The layer"),
      error: errors,
    }).annotateMerge(
      annotate(
        "operator.promptProfile.layer.create",
        "Create a prompt layer",
        "Write a layer, or an override of one of OpenCode's texts (set `overrides`). A project can have one goal and one project-scoped override of each text.",
      ),
    ),
    HttpApiEndpoint.put("layerUpdate", OperatorPromptProfilePaths.layer, {
      params,
      payload: OperatorProfileStore.LayerInput,
      success: described(OperatorProfile.Layer, "The layer"),
      error: errors,
    }).annotateMerge(
      annotate(
        "operator.promptProfile.layer.update",
        "Change a prompt layer",
        "Change a layer. A layer from an existing file is written back to that file, and keeps its scope.",
      ),
    ),
    HttpApiEndpoint.delete("layerRemove", OperatorPromptProfilePaths.layer, {
      params,
      success: described(Schema.Boolean, "Removed"),
      error: errors,
    }).annotateMerge(
      annotate(
        "operator.promptProfile.layer.remove",
        "Delete a prompt layer",
        "Delete a layer no group uses. Removing an override brings back OpenCode's text. Layers from existing files are never deleted.",
      ),
    ),
    HttpApiEndpoint.post("groupCreate", OperatorPromptProfilePaths.groups, {
      payload: OperatorProfileStore.GroupInput,
      success: described(OperatorProfile.PromptGroup, "The group"),
      error: errors,
    }).annotateMerge(
      annotate("operator.promptProfile.group.create", "Create a prompt group", "Create an ordered list of layers."),
    ),
    HttpApiEndpoint.put("groupUpdate", OperatorPromptProfilePaths.group, {
      params,
      payload: OperatorProfileStore.GroupInput,
      success: described(OperatorProfile.PromptGroup, "The group"),
      error: errors,
    }).annotateMerge(annotate("operator.promptProfile.group.update", "Change a prompt group", "Change a group.")),
    HttpApiEndpoint.delete("groupRemove", OperatorPromptProfilePaths.group, {
      params,
      success: described(Schema.Boolean, "Removed"),
      error: errors,
    }).annotateMerge(
      annotate("operator.promptProfile.group.remove", "Delete a prompt group", "Delete a group no profile uses."),
    ),
    HttpApiEndpoint.post("profileCreate", OperatorPromptProfilePaths.profiles, {
      payload: OperatorProfileStore.ProfileInput,
      success: described(OperatorProfile.Profile, "The profile"),
      error: errors,
    }).annotateMerge(
      annotate(
        "operator.promptProfile.profile.create",
        "Create a prompt profile",
        "Create an ordered list of groups: Platform, Purpose, Role, Identity, Capabilities, custom groups, Output format, Tool. Purpose, Role and Identity are required.",
      ),
    ),
    HttpApiEndpoint.put("profileUpdate", OperatorPromptProfilePaths.profile, {
      params,
      payload: OperatorProfileStore.ProfileInput,
      success: described(OperatorProfile.Profile, "The profile"),
      error: errors,
    }).annotateMerge(annotate("operator.promptProfile.profile.update", "Change a prompt profile", "Change a profile.")),
    HttpApiEndpoint.delete("profileRemove", OperatorPromptProfilePaths.profile, {
      params,
      success: described(Schema.Boolean, "Removed"),
      error: errors,
    }).annotateMerge(
      annotate(
        "operator.promptProfile.profile.remove",
        "Delete a prompt profile",
        "Delete a profile that is not a default.",
      ),
    ),
    HttpApiEndpoint.put("defaults", OperatorPromptProfilePaths.defaults, {
      payload: DefaultsInput,
      success: described(OperatorProfile.Defaults, "The defaults"),
      error: errors,
    }).annotateMerge(
      annotate(
        "operator.promptProfile.defaults",
        "Set the default profiles",
        "The profile agents use when they name none: per project, else the global default, else the built-in Default (Helper for title, summary and compaction).",
      ),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "operator prompt profiles", description: "Prompt profile routes." }))
