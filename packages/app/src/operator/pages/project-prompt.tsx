import { useNavigate } from "@solidjs/router"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "../ui/select"
import type { OperatorPromptProject } from "@opencode-ai/sdk/v2/client"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { asList, useOperatorClient } from "../data"
import { Field } from "../ui/field"
import { RecordView } from "../ui/record-overlay"
import { requestError } from "./config-helpers"
import { useNamespaces, useProfileNames } from "./profile-data"
import { isHelper, namespaceDefault } from "./profile-model"
import { useLayoutMove } from "../ui/layout-move"

// The option that means "no link" (not a possible layer or profile id).
const NONE = "@none"

// The prompt settings of every project: its namespace, Project Purpose and default profile.
export function useProjectSettings() {
  const api = useOperatorClient()
  return useQuery(() => ({
    queryKey: api.key("project-settings"),
    queryFn: () =>
      api
        .client()
        .operator.projectSettings.list()
        .then((result) => asList(result.data)),
  }))
}

// A project's prompt settings in edit mode (the project overlay's Edit): its Project Purpose and default
// profile. Its namespace is shown with Move to namespace…: moving the folder carries its settings (and
// copies what they use into the new namespace).
export function ProjectPromptForm(props: { project: OperatorPromptProject; onDone: () => void }) {
  const language = useLanguage()
  const navigate = useNavigate()
  const names = useProfileNames()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const namespaces = useNamespaces()
  const moveFolder = useLayoutMove()
  const [store, setStore] = createStore({
    purpose: props.project.purpose ?? NONE,
    defaultProfile: props.project.defaultProfile ?? NONE,
    busy: false,
    error: "",
  })
  const catalog = useQuery(() => ({
    queryKey: api.key("prompt-catalog", props.project.namespace),
    queryFn: () =>
      api
        .client()
        .operator.namespace.catalog({ ns: props.project.namespace })
        .then((result) => result.data!),
  }))
  const list = () => namespaces.data ?? []
  const nsName = (id: string) => list().find((item) => item.namespace.id === id)?.namespace.name ?? id
  const purposes = () =>
    (catalog.data?.layers ?? []).filter((layer) => layer.type === "purpose" && layer.origin === "user")
  // A helper profile is for an agent, never a project's default.
  const profiles = () => (catalog.data?.profiles ?? []).filter((profile) => !isHelper(catalog.data!, profile))
  const fallback = () => {
    const loaded = catalog.data
    if (!loaded) return ""
    const id = namespaceDefault(loaded)
    const found = loaded.profiles.find((item) => item.id === id)
    return found ? names.profile(found) : id
  }

  const refresh = () =>
    Promise.all(
      ["project-settings", "prompt-catalog", "namespaces", "agent-prompt", "prompt-preview", "project-summaries"].map(
        (key) => queryClient.invalidateQueries({ queryKey: api.key(key) }),
      ),
    )
  const send = () =>
    api
      .client()
      .operator.projectSettings.update({
        key: props.project.key,
        // An empty string clears a link.
        purpose: store.purpose === NONE ? "" : store.purpose,
        defaultProfile: store.defaultProfile === NONE ? "" : store.defaultProfile,
      })
      .then((result) => result.data!)

  const save = async () => {
    setStore({ busy: true, error: "" })
    await send()
      .then(async () => {
        await refresh()
        props.onDone()
      })
      .catch((error: unknown) => setStore("error", requestError(error)))
      .finally(() => setStore("busy", false))
  }

  return (
    <RecordView
      title={language.t("operator.profile.editing", { name: props.project.name })}
      actions={
        <>
          <ButtonV2 variant="neutral" onClick={props.onDone}>
            {language.t("common.cancel")}
          </ButtonV2>
          <ButtonV2 variant="contrast" disabled={store.busy} onClick={() => void save()}>
            {language.t("operator.config.save")}
          </ButtonV2>
        </>
      }
    >
      <div data-component="operator-form">
        {/* A project's namespace is where its folder is: it changes by moving the folder (§5, §11). */}
        <Field
          group
          label={language.t("operator.column.namespace")}
          hint={language.t("operator.help.projectNamespaceMove")}
        >
          <span class="inline-flex items-center gap-2" data-testid="project-namespace">
            {nsName(props.project.namespace)}
            <ButtonV2
              size="small"
              variant="outline"
              onClick={() =>
                moveFolder(
                  { project: props.project.key, name: props.project.key.split("/").at(-1) ?? "" },
                  props.onDone,
                )
              }
            >
              {language.t("operator.move.toNamespace")}
            </ButtonV2>
          </span>
        </Field>
        {/* The selects read their labels when they mount, so they wait for the namespace's items. */}
        <Show when={catalog.data} fallback={<p data-slot="operator-note">{language.t("common.loading")}</p>}>
          <Field group label={language.t("operator.column.purpose")} hint={language.t("operator.projects.purposeHint")}>
            <div class="flex items-center gap-2 flex-wrap">
              <SelectV2<string>
                appearance="base"
                aria-label={language.t("operator.column.purpose")}
                options={[NONE, ...purposes().map((layer) => layer.id)]}
                current={store.purpose}
                label={(id) =>
                  id === NONE
                    ? language.t("operator.projects.noPurpose")
                    : (purposes().find((layer) => layer.id === id)?.name ?? id)
                }
                onSelect={(id) => id !== null && setStore("purpose", id)}
              />
              <button
                type="button"
                data-slot="operator-link"
                onClick={() =>
                  navigate(
                    `/operator/profile?ns=${encodeURIComponent(props.project.namespace)}&tab=layers&layer=new:purpose&rns=${encodeURIComponent(props.project.namespace)}`,
                  )
                }
              >
                {language.t("operator.profile.new.purpose")}
              </button>
            </div>
          </Field>
          <Field
            group
            label={language.t("operator.column.defaultProfile")}
            hint={language.t("operator.help.projectDefaultProfile")}
          >
            <SelectV2<string>
              appearance="base"
              aria-label={language.t("operator.column.defaultProfile")}
              options={[NONE, ...profiles().map((profile) => profile.id)]}
              current={store.defaultProfile}
              label={(id) => {
                if (id === NONE) return language.t("operator.projects.namespaceDefault", { name: fallback() })
                const found = profiles().find((profile) => profile.id === id)
                return found ? names.profile(found) : id
              }}
              onSelect={(id) => id !== null && setStore("defaultProfile", id)}
            />
          </Field>
        </Show>
        <Show when={store.error}>
          <p data-slot="operator-error" role="alert">
            {store.error}
          </p>
        </Show>
      </div>
    </RecordView>
  )
}
