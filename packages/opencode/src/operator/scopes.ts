export * as OperatorScopes from "./scopes"

import path from "path"
import { Schema } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { OperatorNamespaceScope } from "./namespace-scope"

// The words (global_and_opencode_namespaces_spec.md §3), and where a file belongs:
// - Global: the namespace whose folder is `~/.config/opencode` (its config sits directly in it); also
//   `~/.opencode`, part of the Global base. Never "the OpenCode namespace".
// - Namespace: a namespace's folder (OpenCode's included); its config is in the folder's `.opencode/`.
// - Project: a project's folder.
// - Environment: OPENCODE_CONFIG, OPENCODE_CONFIG_DIR and OPENCODE_CONFIG_CONTENT. Never Global, never
//   written by the console.
// - Outside: none of these.
// The deepest folder that contains the file wins: a Global project's files are under
// `~/.config/opencode` but are the project's. "Built in" is OpenCode's own items; "Default" is a
// setting left unset. Neither is a scope.

export const Kind = Schema.Literals(["project", "namespace", "global", "environment", "outside"]).annotate({
  identifier: "OperatorScopeKind",
  description:
    "Where a file belongs: a project's folder, a namespace's folder, Global (`~/.config/opencode`), the environment (OPENCODE_CONFIG, OPENCODE_CONFIG_DIR, OPENCODE_CONFIG_CONTENT), or none of them",
})
export type Kind = typeof Kind.Type

export type Scope =
  | { kind: "project"; project: string }
  | { kind: "namespace"; namespace: string }
  | { kind: "global" }
  | { kind: "environment"; variable: "OPENCODE_CONFIG" | "OPENCODE_CONFIG_DIR" | "OPENCODE_CONFIG_CONTENT" }
  | { kind: "outside" }

/** The folders a classification looks at: projects and namespaces (Global is always there). */
export type Layout = {
  projects: ReadonlyArray<string>
  namespaces: ReadonlyArray<{ id: string; folder: string }>
}

const contains = (folder: string, file: string) =>
  file === folder || file.startsWith(folder.endsWith(path.sep) ? folder : folder + path.sep)

/** Global's folders: its config folder and `~/.opencode`. */
export const globalFolders = () => [path.resolve(Global.Path.config), path.join(Global.Path.home, ".opencode")]

export function classify(file: string, layout: Layout): Scope {
  if (file === "OPENCODE_CONFIG_CONTENT") return { kind: "environment", variable: "OPENCODE_CONFIG_CONTENT" }
  const resolved = path.resolve(file)
  if (Flag.OPENCODE_CONFIG && resolved === path.resolve(Flag.OPENCODE_CONFIG))
    return { kind: "environment", variable: "OPENCODE_CONFIG" }
  if (Flag.OPENCODE_CONFIG_DIR && contains(path.resolve(Flag.OPENCODE_CONFIG_DIR), resolved))
    return { kind: "environment", variable: "OPENCODE_CONFIG_DIR" }
  const candidates: Array<{ folder: string; scope: Scope }> = [
    ...globalFolders().map((folder) => ({ folder, scope: { kind: "global" } as const })),
    ...layout.namespaces.map((item) => ({
      folder: path.resolve(item.folder),
      scope: { kind: "namespace", namespace: item.id } as const,
    })),
    ...layout.projects.map((project) => ({
      folder: path.resolve(project),
      scope: { kind: "project", project } as const,
    })),
  ]
  const found = candidates
    .filter((item) => contains(item.folder, resolved))
    .toSorted((a, b) => b.folder.length - a.folder.length)[0]
  return found?.scope ?? { kind: "outside" }
}

/** The layout now: the namespaces' folders, and the given projects. */
export async function layout(projects: ReadonlyArray<string> = []): Promise<Layout> {
  return { projects, namespaces: await OperatorNamespaceScope.namespaceFolders() }
}

/** Where a file belongs, for the given projects. */
export async function of(file: string, projects: ReadonlyArray<string> = []) {
  return classify(file, await layout(projects))
}
