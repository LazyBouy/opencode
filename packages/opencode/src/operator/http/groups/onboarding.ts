import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"

// The first start of a new installation (memory_spec.md §10, operator/onboarding.ts). Server-wide, part of
// OperatorRootApi. The page is /operator/welcome, so no route here shares its path.
export const OperatorOnboardingPaths = {
  status: "/operator/onboarding/status",
  check: "/operator/onboarding/check",
  finish: "/operator/onboarding/finish",
} as const

export class ApiOnboardingError extends Schema.ErrorClass<{
  readonly name: "OperatorOnboardingError"
  readonly data: { readonly message: string }
}>("OperatorOnboardingError")(
  { name: Schema.Literal("OperatorOnboardingError"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 400 },
) {}

export const OnboardingAgent = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  folder: Schema.String.annotate({ description: "Where the merged agent keeps its records per working folder" }),
  exists: Schema.Boolean,
  insideHome: Schema.Boolean.annotate({
    description: "Outside the home folder, a move can't update its pointers and moves across file systems are skipped",
  }),
}).annotate({ identifier: "OperatorOnboardingAgent" })

export const OnboardingStatus = Schema.Struct({
  pending: Schema.Boolean.annotate({ description: "A new installation that hasn't been onboarded yet" }),
  done: Schema.optional(
    Schema.Struct({ at: Schema.Finite, workingDir: Schema.String, project: Schema.String }).annotate({
      identifier: "OperatorOnboardingDone",
    }),
  ),
  workingDir: Schema.optional(Schema.String).annotate({ description: "The working folder, when it is set already" }),
  suggested: Schema.String.annotate({
    description: "The working folder to suggest: the server's current folder when it can be one, else ~/opencode-home",
  }),
  project: Schema.String.annotate({ description: "The default project's suggested folder name" }),
  home: Schema.String,
  roots: Schema.Array(Schema.String).annotate({ description: "The workspace roots the working folder must be in" }),
  globalFolder: Schema.String,
  agents: Schema.Array(OnboardingAgent),
}).annotate({ identifier: "OperatorOnboardingStatus" })

export const OnboardingInput = Schema.Struct({
  workingDir: Schema.String.annotate({ description: "An absolute folder; OpenCode's folder is <it>/opencode" }),
  project: Schema.String.annotate({ description: "The default project's folder name, made in OpenCode's folder" }),
  git: Schema.optional(Schema.Boolean).annotate({
    description: "Make the project a git repository (default true): OpenCode undoes file changes only in one",
  }),
})

export const OnboardingPreview = Schema.Struct({
  workingDir: Schema.String,
  opencodeFolder: Schema.String,
  projectFolder: Schema.String,
  projectExists: Schema.Boolean.annotate({ description: "The project's folder is there already: it is used as it is" }),
  problems: Schema.Array(Schema.String).annotate({ description: "Why onboarding can't go ahead with these" }),
  separateFileSystems: Schema.Boolean.annotate({
    description: "Global's folder and the working folder are on different file systems",
  }),
}).annotate({ identifier: "OperatorOnboardingPreview" })

export const OnboardingResult = Schema.Struct({
  workingDir: Schema.String,
  opencodeFolder: Schema.String,
  project: Schema.String,
  git: Schema.Boolean,
}).annotate({ identifier: "OperatorOnboardingResult" })

const doc = (identifier: string, summary: string, description: string) =>
  OpenApi.annotations({ identifier, summary, description })

export const OperatorOnboardingGroup = HttpApiGroup.make("operatorOnboarding")
  .add(
    HttpApiEndpoint.get("status", OperatorOnboardingPaths.status, {
      success: described(OnboardingStatus, "Whether onboarding waits, and what it suggests"),
    }).annotateMerge(
      doc(
        "operator.onboarding.status",
        "Onboarding",
        "Whether this installation waits for onboarding; the suggested working folder and project name; the workspace roots; and each merged agent's data folder, with whether it is inside the home folder.",
      ),
    ),
    HttpApiEndpoint.post("check", OperatorOnboardingPaths.check, {
      payload: OnboardingInput,
      success: described(OnboardingPreview, "The folders it would make, and what stops it"),
    }).annotateMerge(
      doc(
        "operator.onboarding.check",
        "Check onboarding's folders",
        "The working folder, OpenCode's folder and the project's folder these would give, why they can't be used if they can't, and whether Global's folder is on another file system. Nothing is made.",
      ),
    ),
    HttpApiEndpoint.post("finish", OperatorOnboardingPaths.finish, {
      payload: OnboardingInput,
      success: described(OnboardingResult, "What was made"),
      error: ApiOnboardingError,
    }).annotateMerge(
      doc(
        "operator.onboarding.finish",
        "Onboard",
        "Sets the working folder (Global and OpenCode become separate namespaces), makes OpenCode's folder and the project's folder in it (a git repository unless git is false), makes the project OpenCode's default project, and records onboarding as done. It runs once.",
      ),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({ title: "operator onboarding", description: "The first start of a new installation." }),
  )
