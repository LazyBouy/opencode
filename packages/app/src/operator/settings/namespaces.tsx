import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import type { OperatorNamespaceSummary } from "@opencode-ai/sdk/v2/client"
import {
  type Component,
  createEffect,
  createMemo,
  createResource,
  createUniqueId,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { createStore } from "solid-js/store"
import { SettingsListV2 } from "@/components/settings-v2/parts/list"
import { SettingsRowV2 } from "@/components/settings-v2/parts/row"
import "@/components/settings-v2/settings-v2.css"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { shortPath } from "../format"
import { requestError } from "../pages/config-helpers"
import { PurposeDraft } from "../pages/purpose-draft"
import { FieldHelp } from "../ui/field-help"
import { NamespaceStart, type Start } from "./namespace-start"
import { LevelPermissions } from "../ui/level-permissions"
import { NamespaceConfigEditor, takeRequestedNamespace } from "./namespace-config"
import { useLayout, WorkingDirectory } from "./working-dir"
import { RecordField } from "../ui/record-overlay"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { useLayoutMove } from "../ui/layout-move"
import { ready } from "../data"

const OPENCODE = "opencode"
// The Default project choice that means "the namespace's first project".
const FIRST = "@first"

const projectName = (key: string) => key.split("/").filter(Boolean).at(-1) ?? key

// What the namespace record says about its default project: the chosen one, else its first.
function defaultProjectText(item: OperatorNamespaceSummary, t: ReturnType<typeof useLanguage>["t"]) {
  if (!item.defaultProject) return t("settings.namespaces.noDefaultProject")
  if (item.namespace.defaultProject === item.defaultProject) return projectName(item.defaultProject)
  return t("settings.namespaces.firstProject", { name: projectName(item.defaultProject) })
}

// Settings → Organization → Namespaces: the namespaces (organizations), each with its org purpose, which
// is sent first in every agent's prompt in it. A namespace opens in an overlay over Settings; a new one
// starts as a copy of OpenCode.
export const SettingsNamespacesV2: Component = () => {
  const language = useLanguage()
  const layout = useLayout()
  const dialog = useDialog()
  const serverSdk = useServerSDK()
  const client = () => serverSdk().client.operator.namespace
  const [list, { refetch }] = createResource(() =>
    client()
      .list()
      .then((result) => result.data ?? []),
  )
  const firstLine = (text: string) => text.split("\n").find((line) => line.trim()) ?? ""
  const open = (selected: string, section?: "config") =>
    void dialog.push(() => (
      <Dialog size="large">
        <DialogHeader>
          <DialogTitle>
            {selected === "new"
              ? language.t("settings.namespaces.new")
              : (list.latest?.find((item) => item.namespace.id === selected)?.namespace.name ?? selected)}
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div data-slot="settings-namespace-overlay">
            <NamespaceRecord
              selected={selected}
              section={section}
              list={() => list.latest ?? []}
              refetch={refetch}
              onClose={() => dialog.close()}
            />
          </div>
        </DialogBody>
      </Dialog>
    ))
  // Opened from a project's Config page ("Open Acme's config"): straight to that namespace's Config.
  onMount(() => {
    const requested = takeRequestedNamespace()
    if (requested) open(requested, "config")
  })

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <h2 class="settings-v2-tab-title">{language.t("settings.namespaces.title")}</h2>
        <div class="flex items-center justify-between gap-3 w-full">
          <p class="text-12-regular text-v2-text-text-muted">{language.t("settings.namespaces.description")}</p>
          <span class="inline-flex items-center shrink-0">
            {/* Namespaces live in the working directory (global_and_opencode_namespaces_spec.md §10.1). */}
            <ButtonV2 size="small" variant="outline" disabled={!ready(layout)?.workingDir} onClick={() => open("new")}>
              {language.t("settings.namespaces.new")}
            </ButtonV2>
            <Show when={ready(layout) && !ready(layout)?.workingDir}>
              <FieldHelp
                field={language.t("settings.namespaces.new")}
                text={language.t("settings.namespaces.newNeedsWorkingDir")}
              />
            </Show>
          </span>
        </div>
      </div>

      <div class="settings-v2-tab-body" data-component="settings-namespaces">
        <div class="settings-v2-section">
          <WorkingDirectory onChange={refetch} />
        </div>
        <div class="settings-v2-section">
          <SettingsListV2>
            <For each={list.latest ?? []}>
              {(item: OperatorNamespaceSummary) => (
                <div
                  data-slot="settings-namespace"
                  role="button"
                  tabIndex={0}
                  aria-label={language.t("settings.namespaces.edit", { name: item.namespace.name })}
                  onClick={() => {
                    if (window.getSelection()?.toString()) return
                    open(item.namespace.id)
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return
                    event.preventDefault()
                    open(item.namespace.id)
                  }}
                >
                  <SettingsRowV2
                    field={item.namespace.name}
                    title={
                      <span class="inline-flex items-center gap-2">
                        {item.global && item.namespace.id === OPENCODE
                          ? language.t("settings.namespaces.globalOpenCode")
                          : item.namespace.name}
                        <Show when={item.namespace.id === OPENCODE || item.global}>
                          <Tag title={language.t("operator.builtin.hint")}>{language.t("operator.builtin.label")}</Tag>
                        </Show>
                        <Tag>{language.t("settings.namespaces.projects", { count: item.projects.length })}</Tag>
                      </span>
                    }
                    description={firstLine(item.namespace.purpose) || language.t("settings.namespaces.noPurpose")}
                  >
                    <span />
                  </SettingsRowV2>
                </div>
              )}
            </For>
          </SettingsListV2>
        </div>
      </div>
    </>
  )
}

// One namespace in its overlay: read-only with Edit (a new one opens in edit mode), Save or Cancel,
// and Delete.
function NamespaceRecord(props: {
  selected: string
  /** A section to scroll to once open. */
  section?: "config"
  list: () => ReadonlyArray<OperatorNamespaceSummary>
  refetch: () => unknown
  onClose: () => void
}) {
  const language = useLanguage()
  const moveFolder = useLayoutMove()
  const id = createUniqueId()
  const serverSdk = useServerSDK()
  const client = () => serverSdk().client.operator.namespace
  const [store, setStore] = createStore({
    selected: props.selected,
    editing: props.selected === "new",
    name: "",
    purpose: "",
    defaultProject: FIRST,
    inheritGlobal: true,
    busy: false,
    confirming: false,
    // A new namespace's folder, derived from its name (<working directory>/<id>), and whether to use a
    // folder that is there already.
    preview: undefined as { id: string; folder: string; exists: boolean; empty: boolean; problem?: string } | undefined,
    previewError: "",
    adopt: false,
  })
  const list = {
    get latest() {
      return props.list()
    },
  }
  const refetch = async () => {
    await props.refetch()
  }
  const current = createMemo(() =>
    store.selected === "new" ? undefined : props.list().find((item) => item.namespace.id === store.selected),
  )
  // A new namespace's folder follows its name, as it is typed.
  let previewTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(
    on(
      () => [store.selected, store.name] as const,
      ([selected, name]) => {
        clearTimeout(previewTimer)
        if (selected !== "new" || !name.trim()) return setStore({ preview: undefined, previewError: "", adopt: false })
        previewTimer = setTimeout(() => {
          void client()
            .folderPreview({ name: name.trim() })
            .then((result) => setStore({ preview: result.data ?? undefined, previewError: "", adopt: false }))
            .catch((error: unknown) => setStore({ preview: undefined, previewError: requestError(error) }))
        }, 250)
      },
    ),
  )
  onCleanup(() => clearTimeout(previewTimer))
  const creatable = () => {
    const where = store.preview
    return !!where && !where.problem && (!where.exists || where.empty || store.adopt)
  }
  // The form follows the namespace; a new one starts empty.
  createEffect(
    on([() => store.selected, current], () => {
      const found = current()
      setStore({
        name: found?.namespace.name ?? "",
        purpose: found?.namespace.purpose ?? "",
        // A chosen project that left the namespace is no longer a choice.
        defaultProject:
          found?.namespace.defaultProject && found.projects.includes(found.namespace.defaultProject)
            ? found.namespace.defaultProject
            : FIRST,
        inheritGlobal: found?.namespace.inheritGlobal !== false,
        confirming: false,
      })
    }),
  )

  const fail = (error: unknown) =>
    showToast({ title: language.t("settings.namespaces.failed"), description: requestError(error) })

  // Leaving the form puts focus back in the record (on Edit), so Escape closes the record, not Settings.
  let edit: HTMLButtonElement | undefined
  createEffect(
    on(
      () => store.editing,
      (editing) => {
        if (!editing) queueMicrotask(() => edit?.focus())
      },
      { defer: true },
    ),
  )

  // What a new namespace starts with (its Capabilities step).
  let start: Start = { from: undefined, items: [], config: [] }
  const seed = async (id: string) => {
    if (!start.from || (!start.items.length && !start.config.length)) return
    await serverSdk()
      .client.operator.capability.seed(
        { operatorCapabilitySeed: { from: start.from, to: id, items: start.items, config: start.config } },
        { throwOnError: true },
      )
      .catch((error: unknown) =>
        showToast({ title: language.t("settings.namespaces.seedFailed"), description: requestError(error) }),
      )
  }

  const save = async () => {
    setStore("busy", true)
    const request =
      store.selected === "new"
        ? client().create({
            name: store.name.trim(),
            purpose: store.purpose,
            ...(store.adopt ? { adopt: true } : {}),
            inheritGlobal: store.inheritGlobal,
          })
        : client().update({
            ns: store.selected,
            name: store.name.trim(),
            purpose: store.purpose,
            defaultProject: store.defaultProject === FIRST ? "" : store.defaultProject,
            inheritGlobal: store.inheritGlobal,
          })
    await request
      .then(async (result) => {
        if (store.selected === "new" && result.data) await seed(result.data.id)
        await refetch()
        if (result.data) setStore({ selected: result.data.id, editing: false })
        showToast({ title: language.t("settings.namespaces.saved", { name: store.name.trim() }) })
      })
      .catch(fail)
      .finally(() => setStore("busy", false))
  }

  const remove = async () => {
    setStore("busy", true)
    await client()
      .remove({ ns: store.selected })
      .then(async () => {
        await refetch()
        props.onClose()
      })
      .catch(fail)
      .finally(() => setStore({ busy: false, confirming: false }))
  }

  // Why the namespace cannot be deleted, if it cannot.
  const blocked = () => {
    const found = current()
    if (!found) return undefined
    if (found.namespace.id === OPENCODE) return language.t("settings.namespaces.builtIn")
    if (found.projects.length) return language.t("settings.namespaces.hasProjects", { count: found.projects.length })
    return undefined
  }

  return (
    <Show
      when={store.editing}
      fallback={
        <Show when={current()}>
          {(found) => (
            <div class="flex flex-col gap-3" data-testid="namespace-view">
              <dl data-component="record-fields">
                <RecordField
                  label={language.t("settings.namespaces.name")}
                  help={language.t("operator.help.namespaceName")}
                >
                  <span class="flex items-center gap-2">
                    {found().namespace.name}
                    <Show when={found().namespace.id === OPENCODE}>
                      <Tag title={language.t("operator.builtin.hint")}>{language.t("operator.builtin.label")}</Tag>
                    </Show>
                  </span>
                </RecordField>
                <RecordField
                  label={language.t("settings.namespaces.purpose")}
                  help={language.t("settings.namespaces.purposeHint")}
                >
                  <span style={{ "white-space": "pre-wrap" }}>
                    {found().namespace.purpose || language.t("settings.namespaces.noPurpose")}
                  </span>
                </RecordField>
                <RecordField
                  label={language.t("settings.namespaces.projectsLabel")}
                  help={language.t("operator.help.namespaceProjects")}
                >
                  {found().projects.map(shortPath).join(", ") || language.t("settings.namespaces.noProjects")}
                </RecordField>
                <RecordField
                  label={language.t("settings.namespaces.folder")}
                  help={language.t("operator.help.namespaceFolder")}
                >
                  <span class="inline-flex items-center gap-2 flex-wrap" data-testid="namespace-folder">
                    {found().namespace.folder ?? language.t("settings.namespaces.noFolder")}
                    <Show when={!found().inPlace}>
                      <Tag>{language.t("settings.namespaces.notInPlace", { target: found().target })}</Tag>
                      <ButtonV2
                        size="small"
                        variant="outline"
                        onClick={() => moveFolder({ namespace: found().namespace.id }, () => void props.refetch())}
                      >
                        {language.t("operator.move.intoPlace")}
                      </ButtonV2>
                    </Show>
                  </span>
                </RecordField>
                <RecordField
                  label={language.t("settings.namespaces.defaultProject")}
                  help={language.t("operator.help.namespaceDefaultProject")}
                >
                  <span data-testid="namespace-default-project" title={found().defaultProject}>
                    {defaultProjectText(found(), language.t)}
                  </span>
                </RecordField>
                <RecordField
                  label={language.t("settings.namespaces.inheritGlobal")}
                  help={language.t("operator.help.namespaceInheritGlobal")}
                >
                  <span data-testid="namespace-inherit-global">
                    {found().global
                      ? language.t("settings.namespaces.inheritGlobalSelf")
                      : found().namespace.inheritGlobal === false
                        ? language.t("settings.namespaces.inheritOff")
                        : language.t("settings.namespaces.inheritOn")}
                  </span>
                </RecordField>
              </dl>
              <div class="flex items-center justify-end gap-2">
                <ButtonV2
                  ref={(element: HTMLButtonElement) => (edit = element)}
                  variant="contrast"
                  onClick={() => setStore("editing", true)}
                >
                  {language.t("operator.profile.edit")}
                </ButtonV2>
              </div>
              <h3 class="settings-v2-tab-title">{language.t("operator.levels.title")}</h3>
              <LevelPermissions level="namespace" directory={undefined} namespace={found().namespace.id} />
              <h3 class="settings-v2-tab-title flex items-center">
                {language.t("settings.namespaces.config.title")}
                <FieldHelp
                  field={language.t("settings.namespaces.config.title")}
                  text={language.t("settings.namespaces.config.hint")}
                />
              </h3>
              <NamespaceConfigEditor namespace={found().namespace.id} focus={props.section === "config"} />
            </div>
          )}
        </Show>
      }
    >
      <div class="flex flex-col gap-3" data-component="settings-namespace-form">
        <h3 class="settings-v2-tab-title flex items-center gap-2">
          {store.selected === "new" ? language.t("settings.namespaces.new") : current()?.namespace.name}
          <Show when={store.selected === OPENCODE}>
            <Tag title={language.t("operator.builtin.hint")}>{language.t("operator.builtin.label")}</Tag>
          </Show>
        </h3>
        <Show when={store.selected === "new"}>
          <p class="text-12-regular text-v2-text-text-muted">{language.t("settings.namespaces.copyNote")}</p>
        </Show>
        <div class="flex flex-col gap-1">
          <div class="flex items-center">
            <label class="text-12-medium" for={`${id}-name`}>
              {language.t("settings.namespaces.name")}
            </label>
            <FieldHelp
              field={language.t("settings.namespaces.name")}
              text={language.t("operator.help.namespaceName")}
            />
          </div>
          <TextInputV2
            id={`${id}-name`}
            appearance="base"
            value={store.name}
            onInput={(event) => setStore("name", event.currentTarget.value)}
          />
        </div>
        <Show
          when={!current()?.global}
          fallback={<p data-slot="operator-note">{language.t("settings.namespaces.globalFolder")}</p>}
        >
          {/* The folder is derived from the name: <working directory>/<id> (§10.1). */}
          <Show when={store.selected === "new"}>
            <div class="flex flex-col gap-1" data-testid="namespace-new-folder">
              <div class="flex items-center">
                <span class="text-12-medium">{language.t("settings.namespaces.folder")}</span>
                <FieldHelp
                  field={language.t("settings.namespaces.folder")}
                  text={language.t("settings.namespaces.folderDerived")}
                />
              </div>
              <Show
                when={store.preview}
                fallback={
                  <p data-slot="operator-note">{store.previewError || language.t("settings.namespaces.folderTyped")}</p>
                }
              >
                {(where) => (
                  <>
                    <code class="text-12-regular">{where().folder}</code>
                    <Show when={where().exists && !where().empty}>
                      <p data-slot="operator-note" data-testid="namespace-folder-exists">
                        {where().problem ?? language.t("settings.namespaces.folderExists", { folder: where().folder })}
                      </p>
                      <Show when={!where().problem}>
                        <CheckboxV2
                          label={language.t("settings.namespaces.adopt")}
                          checked={store.adopt}
                          onChange={(checked: boolean) => setStore("adopt", checked)}
                        />
                      </Show>
                    </Show>
                  </>
                )}
              </Show>
            </div>
          </Show>
        </Show>
        <span class="inline-flex items-center">
          <CheckboxV2
            label={language.t("settings.namespaces.inheritGlobal")}
            checked={current()?.global || store.inheritGlobal}
            disabled={current()?.global}
            onChange={(checked: boolean) => setStore("inheritGlobal", checked)}
          />
          <FieldHelp
            field={language.t("settings.namespaces.inheritGlobal")}
            text={language.t("operator.help.namespaceInheritGlobal")}
          />
        </span>
        <Show when={store.selected === "new"}>
          <NamespaceStart
            namespaces={props.list()}
            folder={store.preview?.folder ?? ""}
            onChange={(next) => {
              start = next
            }}
          />
        </Show>
        <div class="flex flex-col gap-1">
          <div class="flex items-center">
            <label class="text-12-medium" for={`${id}-purpose`}>
              {language.t("settings.namespaces.purpose")}
            </label>
            <FieldHelp
              field={language.t("settings.namespaces.purpose")}
              text={language.t("settings.namespaces.purposeHint")}
            />
          </div>
          <TextareaV2
            id={`${id}-purpose`}
            rows={5}
            value={store.purpose}
            onInput={(event) => setStore("purpose", event.currentTarget.value)}
          />
          <Show when={(list.latest ?? []).some((item) => item.projects.length)}>
            {/* The namespace's projects first: the generator runs in one of them. */}
            <PurposeDraft
              kind="org"
              ns={store.selected === "new" ? undefined : store.selected}
              projects={[
                ...(current()?.projects ?? []),
                ...(list.latest ?? []).flatMap((item) => item.projects),
              ].filter((key, index, all) => all.indexOf(key) === index)}
              onDraft={(text) => setStore("purpose", text)}
            />
          </Show>
        </div>
        <Show when={current()}>
          {(found) => (
            <div class="flex flex-col gap-1">
              <div class="flex items-center">
                <span class="text-12-medium">{language.t("settings.namespaces.projectsLabel")}</span>
                <FieldHelp
                  field={language.t("settings.namespaces.projectsLabel")}
                  text={language.t("operator.help.namespaceProjects")}
                />
              </div>
              <span class="text-12-regular text-v2-text-text-muted">
                {found().projects.map(shortPath).join(", ") || language.t("settings.namespaces.noProjects")}
              </span>
            </div>
          )}
        </Show>
        <Show when={current()}>
          {(found) => (
            <div class="flex flex-col gap-1">
              <div class="flex items-center">
                <span class="text-12-medium">{language.t("settings.namespaces.defaultProject")}</span>
                <FieldHelp
                  field={language.t("settings.namespaces.defaultProject")}
                  text={language.t("operator.help.namespaceDefaultProject")}
                />
              </div>
              <Show
                when={found().projects.length}
                fallback={
                  <span class="text-12-regular text-v2-text-text-muted">
                    {language.t("settings.namespaces.noDefaultProject")}
                  </span>
                }
              >
                <SelectV2<string>
                  appearance="base"
                  aria-label={language.t("settings.namespaces.defaultProject")}
                  options={[FIRST, ...found().projects]}
                  current={store.defaultProject}
                  label={(key) =>
                    key === FIRST
                      ? language.t("settings.namespaces.firstProject", {
                          name: projectName(found().firstProject ?? ""),
                        })
                      : projectName(key)
                  }
                  onSelect={(key) => key && setStore("defaultProject", key)}
                />
              </Show>
            </div>
          )}
        </Show>
        <div class="flex items-center justify-end gap-2 flex-wrap">
          <Show when={current()}>
            <Show
              when={store.confirming}
              fallback={
                <span class="flex items-center gap-2" title={blocked()}>
                  <Show when={blocked()}>
                    {(reason) => <span class="text-12-regular text-v2-text-text-muted">{reason()}</span>}
                  </Show>
                  <ButtonV2
                    variant="danger"
                    disabled={store.busy || !!blocked()}
                    onClick={() => setStore("confirming", true)}
                  >
                    {language.t("settings.namespaces.delete")}
                  </ButtonV2>
                </span>
              }
            >
              <span class="text-12-regular">
                {language.t("settings.namespaces.confirmDelete", { name: store.name })}
              </span>
              <ButtonV2 variant="neutral" onClick={() => setStore("confirming", false)}>
                {language.t("common.cancel")}
              </ButtonV2>
              <ButtonV2 variant="danger" disabled={store.busy} onClick={() => void remove()}>
                {language.t("settings.namespaces.delete")}
              </ButtonV2>
            </Show>
          </Show>
          <ButtonV2
            variant="neutral"
            onClick={() => (store.selected === "new" ? props.onClose() : setStore("editing", false))}
          >
            {language.t("common.cancel")}
          </ButtonV2>
          <ButtonV2
            variant="contrast"
            disabled={store.busy || !store.name.trim() || (store.selected === "new" && !creatable())}
            onClick={() => void save()}
          >
            {store.selected === "new"
              ? language.t("settings.namespaces.create")
              : language.t("settings.namespaces.save")}
          </ButtonV2>
        </div>
      </div>
    </Show>
  )
}
