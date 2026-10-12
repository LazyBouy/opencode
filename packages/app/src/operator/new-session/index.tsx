import { useNavigate } from "@solidjs/router"
import { SelectV2 } from "../ui/select"
import { createEffect, createMemo, createSignal, type JSX, on, onCleanup, Show } from "solid-js"
import type { PromptProjectController } from "@/components/prompt-project-selector"
import { PromptGitStatus, PromptWorkspaceSelector } from "@/components/prompt-workspace-selector"
import { useLanguage } from "@/context/language"
import { useLocal } from "@/context/local"
import { useSDK } from "@/context/sdk"
import type { NewSessionDraftController } from "@/pages/new-session/new-session-draft-controller"
import type { NewSessionWorkspaceController } from "@/pages/new-session/new-session-workspace-controller"
import { asList, ready } from "../data"
import { useNamespaces } from "../pages/profile-data"
import { recordOf, useProjectRecords } from "../pages/project-record"
import { useProjectSettings } from "../pages/project-prompt"
import { OPENCODE } from "../pages/profile-model"
import symbol from "./iphi-symbol.svg?raw"
import "./new-session.css"

export * as OperatorNewSession from "./index"

// The New session page (session_fixes_spec.md §2): the i-Phi wordmark in place of OpenCode's, and a
// Namespace and a Project dropdown in place of "New project" and the folder-based project selector.
// Two fork lines in pages/new-session/new-session-view.tsx call these.

// The i-Phi symbol and "i-Phi", in the box OpenCode's wordmark fills (its width, about its height). The
// symbol and text take the wordmark's colour; the dot stays orange.
export function wordmark(): JSX.Element {
  return (
    <div
      data-component="operator-iphi-wordmark"
      class="w-full text-v2-background-bg-inverse"
      role="img"
      aria-label="i-Phi"
    >
      <span data-slot="operator-iphi-symbol" aria-hidden="true" innerHTML={symbol} />
      <span data-slot="operator-iphi-text" aria-hidden="true">
        i-Phi
      </span>
    </div>
  )
}

// The fork's row stands in for upstream's "New project" button and project selector, which stay
// hidden while the fork is there.
export const replacesProjectRow = true

export function projectRow(props: {
  project: PromptProjectController
  workspace: NewSessionWorkspaceController
  input: NewSessionDraftController["input"]
}): JSX.Element {
  return <ProjectRow {...props} />
}

// Whether a folder is a project's folder or inside it.
const within = (key: string, folder: string) => folder === key || folder.startsWith(key.endsWith("/") ? key : `${key}/`)

function ProjectRow(props: {
  project: PromptProjectController
  workspace: NewSessionWorkspaceController
  input: NewSessionDraftController["input"]
}) {
  const language = useLanguage()
  const navigate = useNavigate()
  const sdk = useSDK()
  const local = useLocal()
  const namespaces = useNamespaces()
  const settings = useProjectSettings()
  const records = useProjectRecords()
  const list = () => asList(ready(namespaces))
  const [chosen, setChosen] = createSignal<string>()
  const namespace = () => list().find((item) => item.namespace.id === chosen())
  const projects = () => namespace()?.projects ?? []
  // The project the draft is in: the longest project folder its folder is in.
  const project = createMemo(
    () =>
      projects()
        .filter((key) => within(key, sdk().directory))
        .toSorted((a, b) => b.length - a.length)[0],
  )

  // A namespace's projects by name; the parent folder only when two names clash.
  const nameOf = (key: string) =>
    asList(ready(settings)).find((item) => item.key === key)?.name ?? key.split("/").filter(Boolean).at(-1) ?? key
  const label = (key: string) => {
    const name = nameOf(key)
    const clash = projects().some((other) => other !== key && nameOf(other) === name)
    if (!clash) return name
    const parent = key.split("/").filter(Boolean).at(-2)
    return parent ? `${name} (${parent})` : name
  }

  const open = (key: string | undefined) => {
    if (key && key !== sdk().directory) props.project.select({ worktree: key })
  }
  // Choosing a namespace takes its default project.
  const choose = (id: string) => {
    setChosen(id)
    open(list().find((item) => item.namespace.id === id)?.defaultProject)
  }
  // At first: the namespace of the project the tab was opened from, keeping that project (a tab opened
  // for a project, e.g. a project's New session, stays in it); else OpenCode with its default project.
  createEffect(
    on(list, (loaded) => {
      if (chosen() || !loaded.length) return
      const from = loaded.find((item) => item.projects.some((key) => within(key, sdk().directory)))
      if (from) setChosen(from.namespace.id)
      else choose(OPENCODE)
    }),
  )

  // Sending is blocked without a project, or when the agent is not one of the project's members.
  const agent = () => local.agent.current()?.name
  const outsider = () => {
    const key = project()
    const name = agent()
    if (!key || !name) return undefined
    const record = recordOf(ready(records), key)
    return record.members.length && !record.members.includes(name) ? name : undefined
  }
  const blocked = () => !!chosen() && (!projects().length || !project() || !!outsider())

  let row: HTMLDivElement | undefined
  const send = language.t("ui.promptInput.send")
  const stop = (event: Event) => {
    event.preventDefault()
    event.stopPropagation()
  }
  const guard = (event: Event) => {
    if (!blocked()) return
    const target = event.target instanceof Element ? event.target : undefined
    if (!target?.closest('form[data-component="prompt-input-v2"]')) return
    if (event.type === "submit") return stop(event)
    if (event.type === "click" && target.closest(`button[aria-label="${send}"]`)) return stop(event)
    if (event instanceof KeyboardEvent && event.key === "Enter" && !event.shiftKey && !event.isComposing)
      return stop(event)
  }
  createEffect(() => {
    const page = row?.closest('[data-component="session-new-design"]')
    if (!page) return
    for (const type of ["keydown", "click", "submit"]) page.addEventListener(type, guard, true)
    onCleanup(() => {
      for (const type of ["keydown", "click", "submit"]) page.removeEventListener(type, guard, true)
    })
  })

  return (
    <div ref={row} data-component="operator-new-session-row" class="flex flex-col items-center gap-2">
      <div class="flex min-h-7 min-w-0 flex-col items-center justify-center gap-2 text-v2-text-text-faint sm:flex-row">
        <SelectV2<string>
          appearance="inline"
          aria-label={language.t("operator.newSession.namespace")}
          options={list().map((item) => item.namespace.id)}
          current={chosen()}
          label={(id) => list().find((item) => item.namespace.id === id)?.namespace.name ?? id}
          onSelect={(id) => id && choose(id)}
        />
        <Show
          when={projects().length}
          fallback={<span data-slot="operator-new-session-empty">{language.t("operator.newSession.noProjects")}</span>}
        >
          <SelectV2<string>
            appearance="inline"
            aria-label={language.t("operator.newSession.project")}
            options={projects().toSorted((a, b) => label(a).localeCompare(label(b)))}
            current={project()}
            placeholder={language.t("operator.newSession.chooseProject")}
            label={label}
            onSelect={(key) => key && open(key)}
          />
          <Show
            when={props.workspace.bar.visible()}
            fallback={<PromptGitStatus branch={props.workspace.bar.branch()} noGit={!props.workspace.project.git()} />}
          >
            <PromptWorkspaceSelector
              value={props.workspace.selection.value()}
              projectRoot={props.workspace.project.root()}
              workspaces={props.workspace.project.workspaces()}
              branch={props.workspace.bar.branch()}
              onChange={props.workspace.selection.set}
              onDone={props.input.restoreFocus}
            />
          </Show>
        </Show>
      </div>
      <Show when={chosen() && !projects().length}>
        <p data-slot="operator-new-session-note" role="status">
          {language.t("operator.newSession.noProjectsHint")}{" "}
          <button
            type="button"
            data-slot="operator-link"
            onClick={() => navigate(`/operator/projects?ns=${encodeURIComponent(chosen()!)}`)}
          >
            {language.t("operator.newSession.addProject")}
          </button>
        </p>
      </Show>
      <Show when={outsider()}>
        {(name) => (
          <p data-slot="operator-new-session-note" role="status">
            {language.t("operator.newSession.notMember", { agent: name(), project: label(project()!) })}
          </p>
        )}
      </Show>
    </div>
  )
}
