import { useNavigate } from "@solidjs/router"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import type { OperatorPromptProject } from "@opencode-ai/sdk/v2/client"
import { useQuery } from "@tanstack/solid-query"
import { For, type JSX, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { asList, ready, useOperatorClient } from "../data"
import { formatAgo } from "../format"
import { RecordField, RecordView } from "../ui/record-overlay"
import { ProjectPromptForm } from "./project-prompt"
import { ProjectRecordFields, ProjectRecordForm } from "./project-record"

// A project record's sections besides its Overview (fixes_spec.md §2): its agents and sessions (each
// opens in its own page's overlay), its prompt settings and its record (members and groups). Config is
// the Config page's editor (config-editor.tsx).

export const PROJECT_SECTIONS = [
  "overview",
  "agents",
  "sessions",
  "config",
  "prompt",
  "members",
  "models",
  "requests",
] as const
export type ProjectSection = (typeof PROJECT_SECTIONS)[number]

const folderOf = (directory: string) => encodeURIComponent(directory)

function List(props: { label: string; loading: boolean; empty: string; children: JSX.Element; count: number }) {
  const language = useLanguage()
  return (
    <Show when={!props.loading} fallback={<p data-slot="operator-note">{language.t("common.loading")}</p>}>
      <Show when={props.count} fallback={<p data-slot="operator-note">{props.empty}</p>}>
        <ul data-component="record-overlay-list" aria-label={props.label}>
          {props.children}
        </ul>
      </Show>
    </Show>
  )
}

// The project's agents; one opens in the Agents page's overlay.
export function ProjectAgents(props: { directory: string }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const navigate = useNavigate()
  const agents = useQuery(() => ({
    queryKey: api.key("agents", props.directory),
    queryFn: () =>
      api
        .client()
        .operator.agent.list({ directory: props.directory })
        .then((result) => asList(result.data)),
  }))
  const list = () => ready(agents) ?? []
  return (
    <List
      label={language.t("operator.page.agents.title")}
      loading={!ready(agents)}
      empty={language.t("operator.projects.noAgents")}
      count={list().length}
    >
      <For each={list()}>
        {(agent) => (
          <li>
            <button
              type="button"
              data-slot="record-overlay-item"
              data-testid="project-agent"
              onClick={() =>
                navigate(
                  `/operator/agents?dir=${folderOf(props.directory)}&agent=${encodeURIComponent(agent.name)}&adir=${folderOf(props.directory)}`,
                )
              }
            >
              <span data-slot="record-overlay-item-label">
                {agent.name}
                <Tag>{agent.mode}</Tag>
              </span>
              <span data-slot="record-overlay-item-detail">{agent.description ?? ""}</span>
            </button>
          </li>
        )}
      </For>
    </List>
  )
}

// The project's sessions (not the subagents'); one opens in the Sessions page's overlay.
export function ProjectSessions(props: { directory: string }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const navigate = useNavigate()
  const sessions = useQuery(() => ({
    queryKey: api.key("sessions", "project", props.directory),
    queryFn: () =>
      api
        .client()
        .operator.session.list({ within: props.directory, roots: "true", limit: "100" })
        .then((result) => asList(result.data)),
  }))
  const list = () => ready(sessions) ?? []
  return (
    <List
      label={language.t("operator.page.sessions.title")}
      loading={!ready(sessions)}
      empty={language.t("operator.projects.noSessions")}
      count={list().length}
    >
      <For each={list()}>
        {(session) => (
          <li>
            <button
              type="button"
              data-slot="record-overlay-item"
              data-testid="project-session"
              onClick={() =>
                navigate(
                  `/operator/sessions?dir=${folderOf(props.directory)}&session=${encodeURIComponent(session.id)}`,
                )
              }
            >
              <span data-slot="record-overlay-item-label">
                {session.title || session.id}
                <Show when={session.agent}>{(agent) => <Tag>{agent()}</Tag>}</Show>
              </span>
              <span data-slot="record-overlay-item-detail">{formatAgo(session.time.updated, language.intl())}</span>
            </button>
          </li>
        )}
      </For>
    </List>
  )
}

// The project's prompt settings: its namespace, Project Purpose and default profile; Edit changes them.
export function ProjectPromptSection(props: {
  setting: OperatorPromptProject
  name: string
  nsName: string
  purpose: string
  profile: string
  added: boolean
  editing: boolean
  onEditing: (editing: boolean) => void
}) {
  const language = useLanguage()
  return (
    <Show
      when={!props.editing}
      fallback={<ProjectPromptForm project={props.setting} added={props.added} onDone={() => props.onEditing(false)} />}
    >
      <RecordView
        title={props.name}
        actions={
          <ButtonV2 variant="contrast" onClick={() => props.onEditing(true)}>
            {language.t("operator.projects.editPrompt")}
          </ButtonV2>
        }
      >
        <dl data-component="record-fields">
          <RecordField
            label={language.t("operator.column.namespace")}
            help={language.t("operator.help.projectNamespace")}
          >
            {props.nsName}
          </RecordField>
          <RecordField label={language.t("operator.column.purpose")} help={language.t("operator.help.projectGoal")}>
            {props.purpose}
          </RecordField>
          <RecordField
            label={language.t("operator.column.defaultProfile")}
            help={language.t("operator.help.projectDefaultProfile")}
          >
            {props.profile}
          </RecordField>
        </dl>
      </RecordView>
    </Show>
  )
}

// The project's record: goal, description, status, manager, members and groups; Edit changes them.
export function ProjectMembers(props: {
  setting: OperatorPromptProject
  name: string
  editing: boolean
  onEditing: (editing: boolean) => void
}) {
  const language = useLanguage()
  return (
    <RecordView
      title={props.name}
      actions={
        <Show when={!props.editing}>
          <ButtonV2 variant="contrast" onClick={() => props.onEditing(true)}>
            {language.t("operator.projects.editProject")}
          </ButtonV2>
        </Show>
      }
    >
      <Show
        when={!props.editing}
        fallback={<ProjectRecordForm setting={props.setting} name={props.name} onDone={() => props.onEditing(false)} />}
      >
        <dl data-component="record-fields">
          <ProjectRecordFields setting={props.setting} />
        </dl>
      </Show>
    </RecordView>
  )
}
