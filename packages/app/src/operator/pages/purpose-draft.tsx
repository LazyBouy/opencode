import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useOperatorClient } from "../data"
import { useOperatorProjects } from "../project"
import { Field } from "../ui/field"
import { requestError } from "./config-helpers"

// Asks the purpose generator (a helper agent) for a draft org or project purpose, from the project's
// files (or the namespace's projects) and an optional brief. The draft goes into the editor, to be
// edited and saved.
export function PurposeDraft(props: {
  kind: "org" | "project"
  // The namespace whose org purpose is drafted.
  ns?: string
  // Projects to offer, first one chosen; every known project when none are given.
  projects?: ReadonlyArray<string>
  onDraft: (text: string) => void
}) {
  const language = useLanguage()
  const api = useOperatorClient()
  // Pages outside the operator layout (Settings) pass their projects.
  const known = props.projects ? () => [] : useOperatorProjects()
  const [store, setStore] = createStore({
    brief: "",
    project: undefined as string | undefined,
    busy: false,
    error: "",
  })
  const options = () => (props.projects?.length ? [...props.projects] : known().map((item) => item.directory))
  const project = () => store.project ?? options()[0]
  const name = (key: string) =>
    known().find((item) => item.directory === key)?.label ?? key.split("/").filter(Boolean).at(-1) ?? key

  const draft = async () => {
    const directory = project()
    if (!directory) return
    setStore({ busy: true, error: "" })
    await api
      .client()
      .operator.prompt.purpose({ directory, kind: props.kind, ns: props.ns, brief: store.brief.trim() || undefined })
      .then((result) => {
        if (result.data?.text) props.onDraft(result.data.text)
      })
      .catch((error: unknown) => setStore("error", requestError(error)))
      .finally(() => setStore("busy", false))
  }

  return (
    <section data-component="operator-form" aria-label={language.t("operator.purposeDraft.title")}>
      <div class="flex items-end gap-2 flex-wrap">
        <Show when={props.kind === "project" || options().length > 1}>
          <Field
            group
            label={language.t("operator.purposeDraft.project")}
            hint={language.t(
              props.kind === "project" ? "operator.help.purposeDraftProject" : "operator.help.purposeDraftOrgProject",
            )}
          >
            <SelectV2<string>
              appearance="base"
              aria-label={language.t("operator.purposeDraft.project")}
              options={options()}
              current={project()}
              label={name}
              onSelect={(key) => key && setStore("project", key)}
            />
          </Field>
        </Show>
        <Field label={language.t("operator.purposeDraft.brief")} hint={language.t("operator.help.purposeDraftBrief")}>
          <TextInputV2
            appearance="base"
            value={store.brief}
            placeholder={language.t("operator.purposeDraft.briefPlaceholder")}
            onInput={(event) => setStore("brief", event.currentTarget.value)}
          />
        </Field>
        <ButtonV2 variant="outline" disabled={store.busy || !project()} onClick={() => void draft()}>
          {store.busy ? language.t("operator.purposeDraft.writing") : language.t("operator.purposeDraft.write")}
        </ButtonV2>
      </div>
      <Show when={store.error}>
        <p data-slot="operator-error" role="alert">
          {store.error}
        </p>
      </Show>
    </section>
  )
}
