import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Switch as Toggle } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import type { OperatorOnboardingPreview, OperatorOnboardingStatus } from "@opencode-ai/sdk/v2/client"
import { useNavigate } from "@solidjs/router"
import { useQueryClient } from "@tanstack/solid-query"
import { createEffect, For, Match, on, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { ready, useOperatorClient } from "../data"
import { formatDateTime } from "../format"
import { useOnboarding } from "../onboarding"
import { Field } from "../ui/field"
import { useFolderBrowser } from "../ui/folder-browser"
import { PageHeader } from "../ui/page-header"
import { RecordField } from "../ui/record-overlay"
import { requestError } from "./config-helpers"

// The first start of a new installation (specs/docs/feedbacks/memory/memory_spec.md §10): the working folder
// (OpenCode's folder is <it>/opencode), a default OpenCode project in OpenCode's folder, the merged agents
// whose data is outside the home folder, and a summary; then the console opens. It runs once. The opencode
// repository is never added as a project here.

const STEPS = ["folder", "project", "agents", "summary"] as const
type Step = (typeof STEPS)[number]

const opencodeFolder = (folder: string) => `${folder.trim().replace(/\/+$/, "")}/opencode`

export default function WelcomePage() {
  const language = useLanguage()
  const status = useOnboarding()
  return (
    <div data-testid="welcome">
      <PageHeader
        title={language.t("operator.welcome.title")}
        description={language.t("operator.welcome.description")}
      />
      <Show when={ready(status)}>
        {(found) => (
          <Show when={found().pending} fallback={<NotWaiting status={found()} />}>
            <Onboarding status={found()} />
          </Show>
        )}
      </Show>
    </div>
  )
}

// Onboarded already, or set up before onboarding came.
function NotWaiting(props: { status: OperatorOnboardingStatus }) {
  const language = useLanguage()
  const navigate = useNavigate()
  return (
    <section data-component="operator-panel" data-testid="welcome-not-waiting">
      <p data-slot="operator-note">
        {props.status.done
          ? language.t("operator.welcome.doneAlready", {
              date: formatDateTime(props.status.done.at, language.intl()),
              folder: props.status.done.workingDir,
            })
          : language.t("operator.welcome.notNeeded")}
      </p>
      <div data-slot="operator-actions">
        <ButtonV2 variant="contrast" onClick={() => navigate("/operator")}>
          {language.t("operator.welcome.openConsole")}
        </ButtonV2>
      </div>
    </section>
  )
}

function Onboarding(props: { status: OperatorOnboardingStatus }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const browse = useFolderBrowser()
  const [store, setStore] = createStore({
    step: "folder" as Step,
    workingDir: props.status.workingDir ?? props.status.suggested,
    project: props.status.project,
    git: true,
    preview: undefined as OperatorOnboardingPreview | undefined,
    busy: false,
    error: "",
  })
  // What is entered has changed: the next step checks it again.
  createEffect(
    on(
      () => [store.workingDir, store.project, store.git],
      () => setStore("preview", undefined),
      { defer: true },
    ),
  )
  const input = () => ({ workingDir: store.workingDir.trim(), project: store.project.trim(), git: store.git })
  const check = async () => {
    setStore({ busy: true, error: "" })
    const preview = await api
      .client()
      .operator.onboarding.check(input(), { throwOnError: true })
      .then((result) => result.data)
      .catch((error: unknown) => {
        setStore("error", requestError(error))
        return undefined
      })
    setStore({ busy: false, preview })
    return preview
  }
  // Leaving the folder or project step checks what was entered; a problem keeps the step.
  const go = async (step: Step) => {
    const forward = STEPS.indexOf(step) > STEPS.indexOf(store.step)
    if (forward && (store.step === "folder" || store.step === "project")) {
      const preview = await check()
      if (!preview || preview.problems.length) return
    }
    setStore("step", step)
  }
  const finish = async () => {
    setStore({ busy: true, error: "" })
    await api
      .client()
      .operator.onboarding.finish(input(), { throwOnError: true })
      .then(async () => {
        await queryClient.invalidateQueries({ queryKey: api.key() })
        showToast({ title: language.t("operator.welcome.ready") })
        navigate("/operator", { replace: true })
      })
      .catch((error: unknown) => setStore("error", requestError(error)))
      .finally(() => setStore("busy", false))
  }
  const warnings = () =>
    props.status.agents.filter((agent) => !agent.insideHome).length + (store.preview?.separateFileSystems ? 1 : 0)
  const fixed = () => Boolean(props.status.workingDir)
  const stepLabel = (step: Step, index: number) =>
    `${index + 1}. ${language.t(`operator.welcome.step.${step}` as "operator.welcome.step.folder")}`

  return (
    <section data-component="operator-panel" data-testid="welcome-steps">
      <ol class="flex flex-wrap gap-3" aria-label={language.t("operator.welcome.steps")}>
        <For each={STEPS}>
          {(step, index) => (
            <li data-slot="operator-note" aria-current={store.step === step ? "step" : undefined}>
              <Show when={store.step === step} fallback={stepLabel(step, index())}>
                <strong>{stepLabel(step, index())}</strong>
              </Show>
            </li>
          )}
        </For>
      </ol>

      <Switch>
        <Match when={store.step === "folder"}>
          <h2 data-slot="operator-panel-title">{language.t("operator.welcome.step.folder")}</h2>
          <Field
            label={language.t("operator.welcome.workingDir")}
            hint={language.t("operator.help.welcomeWorkingDir", { roots: props.status.roots.join(", ") })}
          >
            <div class="flex items-center gap-2 w-full">
              <TextInputV2
                appearance="base"
                class="flex-1"
                value={store.workingDir}
                disabled={fixed()}
                onInput={(event) => setStore("workingDir", event.currentTarget.value)}
              />
              <Show when={!fixed()}>
                <ButtonV2
                  size="small"
                  variant="outline"
                  onClick={() =>
                    void browse({ over: true, start: props.status.roots[0] }).then((picked) => {
                      if (picked) setStore("workingDir", picked)
                    })
                  }
                >
                  {language.t("settings.namespaces.chooseFolder")}
                </ButtonV2>
              </Show>
            </div>
          </Field>
          <Show when={fixed()}>
            <p data-slot="operator-note">{language.t("operator.welcome.workingDirSet")}</p>
          </Show>
          <p data-slot="operator-note" data-testid="welcome-opencode-folder">
            {language.t("operator.welcome.opencodeFolder", { folder: opencodeFolder(store.workingDir) })}
          </p>
        </Match>

        <Match when={store.step === "project"}>
          <h2 data-slot="operator-panel-title">{language.t("operator.welcome.step.project")}</h2>
          <Field label={language.t("operator.welcome.projectName")} hint={language.t("operator.help.welcomeProject")}>
            <TextInputV2
              appearance="base"
              value={store.project}
              onInput={(event) => setStore("project", event.currentTarget.value)}
            />
          </Field>
          <p data-slot="operator-note" data-testid="welcome-project-folder">
            {language.t("operator.welcome.projectFolder", {
              folder: `${opencodeFolder(store.workingDir)}/${store.project.trim()}`,
            })}
          </p>
          <Field group label={language.t("operator.welcome.git")} hint={language.t("operator.help.welcomeGit")}>
            <Toggle checked={store.git} onChange={(git: boolean) => setStore("git", git)}>
              {language.t("operator.welcome.gitLabel")}
            </Toggle>
          </Field>
          <p data-slot="operator-note">{language.t("operator.welcome.repoNote")}</p>
        </Match>

        <Match when={store.step === "agents"}>
          <h2 data-slot="operator-panel-title">{language.t("operator.welcome.step.agents")}</h2>
          <p data-slot="operator-note">{language.t("operator.welcome.agentsIntro")}</p>
          <Show
            when={props.status.agents.length}
            fallback={<p data-slot="operator-note">{language.t("operator.welcome.noAgents")}</p>}
          >
            <ul class="flex flex-col gap-2" data-testid="welcome-agents">
              <For each={props.status.agents}>
                {(agent) => (
                  <li data-testid={`welcome-agent-${agent.id}`}>
                    <span class="text-12-medium">{agent.name}</span> · <code>{agent.folder}</code>
                    <Show
                      when={agent.insideHome}
                      fallback={
                        <p data-slot="operator-note" data-warning role="alert">
                          {language.t("operator.welcome.agentOutside", {
                            agent: agent.name,
                            folder: agent.folder,
                            home: props.status.home,
                          })}
                        </p>
                      }
                    >
                      <p data-slot="operator-note">
                        {language.t("operator.welcome.agentInside", { home: props.status.home })}
                      </p>
                    </Show>
                    <Show when={!agent.exists}>
                      <p data-slot="operator-note">
                        {language.t("operator.welcome.agentMissing", { agent: agent.name })}
                      </p>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <Show when={store.preview?.separateFileSystems}>
            <p data-slot="operator-note" data-warning role="alert">
              {language.t("operator.welcome.separateFileSystems", { folder: props.status.globalFolder })}
            </p>
          </Show>
        </Match>

        <Match when={store.step === "summary"}>
          <h2 data-slot="operator-panel-title">{language.t("operator.welcome.step.summary")}</h2>
          <Show when={store.preview}>
            {(preview) => (
              <dl data-component="record-fields" data-testid="welcome-summary">
                <RecordField
                  label={language.t("operator.welcome.workingDir")}
                  help={language.t("operator.help.welcomeWorkingDir", { roots: props.status.roots.join(", ") })}
                >
                  <code>{preview().workingDir}</code>
                </RecordField>
                <RecordField
                  label={language.t("operator.welcome.opencode")}
                  help={language.t("operator.help.welcomeOpenCode")}
                >
                  <code>{preview().opencodeFolder}</code>
                </RecordField>
                <RecordField
                  label={language.t("operator.welcome.defaultProject")}
                  help={language.t("operator.help.welcomeProject")}
                >
                  <code>{preview().projectFolder}</code>{" "}
                  <span data-slot="operator-note">
                    {preview().projectExists
                      ? language.t("operator.welcome.projectExists")
                      : store.git
                        ? language.t("operator.welcome.projectGit")
                        : language.t("operator.welcome.projectPlain")}
                  </span>
                </RecordField>
                <RecordField
                  label={language.t("operator.welcome.global")}
                  help={language.t("operator.help.welcomeGlobal")}
                >
                  <code>{props.status.globalFolder}</code>
                </RecordField>
                <RecordField
                  label={language.t("operator.welcome.warnings")}
                  help={language.t("operator.help.welcomeWarnings")}
                >
                  <span data-testid="welcome-warnings">
                    {warnings()
                      ? language.t("operator.welcome.warningCount", { count: warnings() })
                      : language.t("operator.welcome.noWarnings")}
                  </span>
                </RecordField>
              </dl>
            )}
          </Show>
          <p data-slot="operator-note">{language.t("operator.welcome.later")}</p>
        </Match>
      </Switch>

      <Show when={store.preview?.problems.length}>
        <ul data-slot="operator-error" role="alert" data-testid="welcome-problems">
          <For each={store.preview?.problems}>{(problem) => <li>{problem}</li>}</For>
        </ul>
      </Show>
      <Show when={store.error}>
        <p data-slot="operator-error" role="alert">
          {store.error}
        </p>
      </Show>

      <div data-slot="operator-actions">
        <Show when={store.step !== "folder"}>
          <ButtonV2
            variant="neutral"
            disabled={store.busy}
            onClick={() => void go(STEPS[STEPS.indexOf(store.step) - 1]!)}
          >
            {language.t("operator.welcome.back")}
          </ButtonV2>
        </Show>
        <Show
          when={store.step === "summary"}
          fallback={
            <ButtonV2
              variant="contrast"
              disabled={store.busy}
              onClick={() => void go(STEPS[STEPS.indexOf(store.step) + 1]!)}
            >
              {language.t("operator.welcome.next")}
            </ButtonV2>
          }
        >
          <ButtonV2 variant="contrast" disabled={store.busy || !store.preview} onClick={() => void finish()}>
            {language.t("operator.welcome.setUp")}
          </ButtonV2>
        </Show>
      </div>
    </section>
  )
}
