import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useServer } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { useOperatorClient } from "./data"
import { shortPath } from "./format"
import { requestError } from "./pages/config-helpers"
import { useNamespaces } from "./pages/profile-data"
import { OPENCODE } from "./pages/profile-model"
import { useProjectSettings } from "./pages/project-prompt"
import { Field } from "./ui/field"

// Every session belongs to one project, and the server refuses sessions in folders that are not part
// of one. When a new session is about to start in such a folder (a draft, or a folder's new-session
// page), this asks first: start it in an existing project instead, or make the folder a project.
export function ProjectGate() {
  const layout = useLayout()
  const tabs = useTabs()
  const api = useOperatorClient()
  const dialog = useDialog()
  // Each folder is asked about once per page load.
  const asked = new Set<string>()
  const target = createMemo(() => {
    const route = layout.route()
    if (route.type === "draft") {
      const draft = tabs.store.find((tab) => tab.type === "draft" && tab.draftID === route.draftID)
      return draft?.type === "draft" ? { directory: draft.directory, draftID: route.draftID } : undefined
    }
    if (route.type === "dir-new-sesssion") return { directory: route.dir, draftID: undefined }
    return undefined
  })
  createEffect(
    on(
      () => target()?.directory,
      (directory) => {
        if (!directory || asked.has(directory)) return
        const draftID = target()?.draftID
        void api
          .client()
          .operator.projectSettings.resolve({ directory })
          .then((result) => {
            if (result.data?.project || asked.has(directory)) return
            asked.add(directory)
            void dialog.show(() => (
              <NotAProjectDialog directory={directory} draftID={draftID} onDone={() => dialog.close()} />
            ))
          })
          .catch(() => undefined)
      },
    ),
  )
  return null
}

function NotAProjectDialog(props: { directory: string; draftID?: string; onDone: () => void }) {
  const language = useLanguage()
  const tabs = useTabs()
  const server = useServer()
  const settings = useProjectSettings()
  const [store, setStore] = createStore({ project: undefined as string | undefined })
  const projects = () => (settings.data ?? []).filter((item) => item.registered)

  // The session starts in the chosen project's folder instead.
  const use = () => {
    const key = store.project
    if (!key) return
    if (props.draftID) tabs.updateDraft(props.draftID, { directory: key, worktree: undefined })
    else void tabs.newDraft({ server: server.key, directory: key })
    props.onDone()
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitle>{language.t("operator.gate.title")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="px-4 pt-2 pb-2">
        <div data-component="operator-form" class="min-w-[min(520px,85vw)]">
          <p data-slot="operator-note">{language.t("operator.gate.body", { folder: shortPath(props.directory) })}</p>
          <section class="flex flex-col gap-2" aria-label={language.t("operator.gate.use")}>
            <h3 data-slot="operator-panel-title">{language.t("operator.gate.use")}</h3>
            <div class="flex items-end gap-2 flex-wrap">
              <Field group label={language.t("operator.gate.project")} hint={language.t("operator.help.gateProject")}>
                <SelectV2<string>
                  appearance="base"
                  aria-label={language.t("operator.gate.project")}
                  placeholder={language.t("operator.gate.chooseProject")}
                  options={projects().map((item) => item.key)}
                  current={store.project}
                  label={(key) => {
                    const found = projects().find((item) => item.key === key)
                    return found ? `${found.name} · ${shortPath(found.key)}` : key
                  }}
                  onSelect={(key) => key && setStore("project", key)}
                />
              </Field>
              <ButtonV2 variant="contrast" disabled={!store.project} onClick={use}>
                {language.t("operator.gate.startThere")}
              </ButtonV2>
            </div>
          </section>
          <section class="flex flex-col gap-2" aria-label={language.t("operator.gate.make")}>
            <h3 data-slot="operator-panel-title">{language.t("operator.gate.make")}</h3>
            <RegisterProject directory={props.directory} onDone={props.onDone} />
          </section>
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" onClick={props.onDone}>
          {language.t("common.cancel")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}

// Makes a folder outside git a project: registered as it is (its subfolders belong to it), or made a
// git repository; in OpenCode unless another namespace is chosen.
export function RegisterProject(props: { directory: string; onDone: () => void }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const namespaces = useNamespaces()
  const [store, setStore] = createStore({
    how: "folder" as "folder" | "git",
    namespace: OPENCODE,
    busy: false,
    error: "",
  })
  const list = () => namespaces.data ?? []

  const register = async () => {
    setStore({ busy: true, error: "" })
    await api
      .client()
      .operator.projectSettings.register({
        directory: props.directory,
        git: store.how === "git",
        namespace: store.namespace,
      })
      .then(async () => {
        await Promise.all(
          ["project-summaries", "project-settings", "projects", "namespaces"].map((key) =>
            queryClient.invalidateQueries({ queryKey: api.key(key) }),
          ),
        )
        props.onDone()
      })
      .catch((error: unknown) => setStore("error", requestError(error)))
      .finally(() => setStore("busy", false))
  }

  return (
    <div data-component="operator-form">
      <Field group label={language.t("operator.gate.how")} hint={language.t("operator.help.gateHow")}>
        <SegmentedControlV2 value={store.how} onChange={(value) => value && setStore("how", value as "folder" | "git")}>
          <SegmentedControlItemV2 value="folder">{language.t("operator.gate.asFolder")}</SegmentedControlItemV2>
          <SegmentedControlItemV2 value="git">{language.t("operator.gate.asGit")}</SegmentedControlItemV2>
        </SegmentedControlV2>
      </Field>
      <Show when={list().length > 1}>
        <Field
          group
          label={language.t("operator.column.namespace")}
          hint={language.t("operator.help.projectNamespace")}
        >
          <SelectV2<string>
            appearance="base"
            aria-label={language.t("operator.column.namespace")}
            options={list().map((item) => item.namespace.id)}
            current={store.namespace}
            label={(id) => list().find((item) => item.namespace.id === id)?.namespace.name ?? id}
            onSelect={(id) => id && setStore("namespace", id)}
          />
        </Field>
      </Show>
      <Show when={store.error}>
        <p data-slot="operator-error" role="alert">
          {store.error}
        </p>
      </Show>
      <div data-slot="operator-actions">
        <ButtonV2 variant="contrast" disabled={store.busy} onClick={() => void register()}>
          {language.t("operator.gate.makeIt")}
        </ButtonV2>
      </div>
    </div>
  )
}
