import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import type {
  OperatorLayoutMoveItem,
  OperatorLayoutMoveReport,
  OperatorLayoutPlan,
  OperatorLayoutPlanInput,
} from "@opencode-ai/sdk/v2/client"
import { useQueryClient } from "@tanstack/solid-query"
import { createSignal, For, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useOperatorClient } from "../data"
import { formatBytes, shortPath } from "../format"
import { requestError } from "../pages/config-helpers"
import { useNamespaces } from "../pages/profile-data"

// Moving folders (global_and_opencode_namespaces_spec.md §11): the plan first (each folder from → to,
// its sessions and size, and what blocks it), nothing moving until "Move N folders"; then the report.
// Used by Move to namespace…, Move into OpenCode's folder and a misplaced namespace's Move into place.

export type MoveTarget =
  | { project: string; name: string }
  | { namespace: string }
  // The upgrade's moves (§12): "Not now" instead of Cancel.
  | { upgrade: true }
  // A new working directory: every namespace folder but Global's moves into it (§9).
  | { workingDir: string }

/** Opens the move dialog: a project (choosing its namespace, or straight to `namespace`), or a namespace. */
export function useLayoutMove() {
  const dialog = useDialog()
  return (target: MoveTarget | (MoveTarget & { namespace?: string }), onDone?: () => void) => {
    const open = dialog.active ? dialog.push : dialog.show
    void open(() => <MoveDialog target={target} onDone={onDone} />)
  }
}

function MoveDialog(props: { target: MoveTarget | (MoveTarget & { namespace?: string }); onDone?: () => void }) {
  const language = useLanguage()
  const dialog = useDialog()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const namespaces = useNamespaces()
  const project = "project" in props.target ? props.target : undefined
  const [store, setStore] = createStore({
    namespace: ("namespace" in props.target ? props.target.namespace : undefined) ?? "",
    name: project?.name ?? "",
    plan: undefined as OperatorLayoutPlan | undefined,
    chosen: [] as string[],
    waitIdle: false,
    busy: false,
    error: "",
    report: undefined as OperatorLayoutMoveReport | undefined,
  })
  // Choosing the namespace and name first (Move to namespace…), unless the target names one.
  const [choosing] = createSignal(!!project && !("namespace" in props.target && props.target.namespace))

  const upgrade = "upgrade" in props.target
  const workingDir = "workingDir" in props.target ? props.target.workingDir : undefined
  const planInput = (): OperatorLayoutPlanInput | undefined => {
    if (upgrade) return { kind: "upgrade" }
    if (workingDir) return { kind: "working-dir", workingDir }
    if (!project) return { kind: "namespace", namespace: (props.target as { namespace: string }).namespace }
    return store.namespace
      ? { kind: "project", project: project.project, namespace: store.namespace, name: store.name.trim() }
      : undefined
  }
  // "Not now": the upgrade's confirmation comes back at the next server start; nothing moves.
  const later = async () => {
    await api
      .client()
      .operator.layout.later()
      .catch(() => undefined)
    await queryClient.invalidateQueries({ queryKey: api.key("layout") })
    dialog.close()
  }

  const check = async () => {
    const input = planInput()
    if (!input) return
    setStore({ busy: true, error: "", plan: undefined })
    await api
      .client()
      .operator.layout.plan({ operatorLayoutPlanInput: input }, { throwOnError: true })
      .then((result) => {
        const plan = result.data!
        setStore({
          plan,
          // Blocked rows start unchecked; a busy one can wait until idle.
          chosen: plan.items.filter((item) => !item.blockers.length).map((item) => item.id),
        })
      })
      .catch((error: unknown) => setStore("error", requestError(error)))
      .finally(() => setStore("busy", false))
  }
  onMount(() => {
    if (!choosing()) void check()
  })

  const movable = (item: OperatorLayoutMoveItem) =>
    item.blockers.every((blocker) => blocker.kind === "busy") && (!item.blockers.length || store.waitIdle)
  const move = async () => {
    const plan = store.plan
    if (!plan) return
    setStore({ busy: true, error: "" })
    await api
      .client()
      .operator.layout.move(
        {
          operatorLayoutMoveInput: {
            plan: plan.id,
            items: store.chosen,
            ...(store.waitIdle ? { waitIdle: true } : {}),
          },
        },
        { throwOnError: true },
      )
      .then(async (result) => {
        setStore("report", result.data!)
        await queryClient.invalidateQueries({ queryKey: api.key() })
        props.onDone?.()
      })
      .catch((error: unknown) => setStore("error", requestError(error)))
      .finally(() => setStore("busy", false))
  }

  const nsOptions = () => (namespaces.data ?? []).map((item) => item.namespace.id)
  const nsName = (id: string) => (namespaces.data ?? []).find((item) => item.namespace.id === id)?.namespace.name ?? id

  return (
    <Dialog size="large">
      <DialogHeader>
        <DialogTitle>
          {upgrade
            ? language.t("operator.move.upgradeTitle")
            : workingDir
              ? language.t("operator.move.workingDirTitle", { folder: workingDir })
              : project
                ? language.t("operator.move.projectTitle", { name: project.name })
                : language.t("operator.move.namespaceTitle", { name: nsName(store.namespace) })}
        </DialogTitle>
      </DialogHeader>
      <DialogBody>
        <div class="flex flex-col gap-3" data-component="operator-move">
          <Show when={choosing() && !store.report}>
            <div class="flex flex-wrap items-end gap-2">
              <label class="flex flex-col gap-1 text-12-medium">
                {language.t("operator.column.namespace")}
                <SelectV2<string>
                  appearance="base"
                  aria-label={language.t("operator.column.namespace")}
                  options={nsOptions()}
                  current={store.namespace || undefined}
                  label={nsName}
                  onSelect={(id) => id && setStore({ namespace: id, plan: undefined })}
                />
              </label>
              <label class="flex flex-col gap-1 text-12-medium">
                {language.t("operator.move.name")}
                <TextInputV2
                  appearance="base"
                  value={store.name}
                  aria-label={language.t("operator.move.name")}
                  onInput={(event) => setStore({ name: event.currentTarget.value, plan: undefined })}
                />
              </label>
              <ButtonV2
                size="small"
                variant="outline"
                disabled={store.busy || !store.namespace || !store.name.trim()}
                onClick={() => void check()}
              >
                {language.t("operator.move.check")}
              </ButtonV2>
            </div>
          </Show>
          <Show when={store.busy && !store.plan && !store.report}>
            <p data-slot="operator-note">{language.t("operator.move.planning")}</p>
          </Show>
          <Show when={!store.report && store.plan}>
            {(plan) => (
              <>
                <Show when={upgrade}>
                  <p data-slot="operator-note">{language.t("operator.move.upgradeHint")}</p>
                </Show>
                <Show when={!plan().items.length}>
                  <p data-slot="operator-note">{language.t("operator.move.nothing")}</p>
                </Show>
                <p data-slot="operator-note">{language.t("operator.move.planHint")}</p>
                <table data-component="operator-table" data-testid="move-plan">
                  <thead>
                    <tr>
                      <th />
                      <th>{language.t("operator.move.from")}</th>
                      <th>{language.t("operator.move.to")}</th>
                      <th>{language.t("operator.column.sessions")}</th>
                      <th>{language.t("operator.move.size")}</th>
                      <th>{language.t("operator.move.blockers")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={plan().items}>
                      {(item) => (
                        <tr data-testid="move-row">
                          <td>
                            <CheckboxV2
                              label={language.t("operator.move.choose", { name: item.name })}
                              hideLabel
                              checked={store.chosen.includes(item.id)}
                              disabled={!movable(item)}
                              onChange={(checked: boolean) =>
                                setStore(
                                  "chosen",
                                  checked ? [...store.chosen, item.id] : store.chosen.filter((id) => id !== item.id),
                                )
                              }
                            />
                          </td>
                          <td title={item.from}>
                            <code>{shortPath(item.from)}</code>
                          </td>
                          <td title={item.to}>
                            <code>{item.to}</code>
                          </td>
                          <td>{item.sessions}</td>
                          <td>{item.size === undefined ? "—" : formatBytes(item.size, language.intl())}</td>
                          <td>
                            <For each={item.blockers} fallback={<Tag>{language.t("operator.move.ready")}</Tag>}>
                              {(blocker) => (
                                <p data-testid="move-blocker" data-kind={blocker.kind}>
                                  {blocker.message}
                                </p>
                              )}
                            </For>
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
                <Show when={plan().items.some((item) => item.blockers.some((blocker) => blocker.kind === "busy"))}>
                  <CheckboxV2
                    label={language.t("operator.move.waitIdle")}
                    checked={store.waitIdle}
                    onChange={(checked: boolean) => setStore("waitIdle", checked)}
                  />
                </Show>
                <p data-slot="operator-note">{language.t("operator.move.byHandHint")}</p>
              </>
            )}
          </Show>
          <Show when={store.busy && store.plan && !store.report}>
            <p role="status" data-slot="operator-note">
              {language.t("operator.move.moving")}
            </p>
          </Show>
          <Show when={store.report}>{(report) => <MoveReport report={report()} />}</Show>
          <Show when={store.error}>
            <p data-slot="operator-error" role="alert">
              {store.error}
            </p>
          </Show>
        </div>
      </DialogBody>
      <DialogFooter>
        <Show
          when={!store.report}
          fallback={
            <ButtonV2 variant="contrast" onClick={() => dialog.close()}>
              {language.t("operator.move.done")}
            </ButtonV2>
          }
        >
          <ButtonV2 variant="neutral" onClick={() => (upgrade ? void later() : dialog.close())}>
            {upgrade ? language.t("operator.move.later") : language.t("common.cancel")}
          </ButtonV2>
          <ButtonV2
            variant="contrast"
            disabled={store.busy || !store.plan || (!store.chosen.length && !workingDir)}
            onClick={() => void move()}
          >
            {language.t("operator.move.move", { count: store.chosen.length })}
          </ButtonV2>
        </Show>
      </DialogFooter>
    </Dialog>
  )
}

function MoveReport(props: { report: OperatorLayoutMoveReport }) {
  const language = useLanguage()
  return (
    <div class="flex flex-col gap-2" data-testid="move-report">
      <Show when={props.report.moved.length}>
        <h3 class="text-12-medium">{language.t("operator.move.moved")}</h3>
        <ul>
          <For each={props.report.moved}>
            {(item) => (
              <li>
                <code>{item.from}</code> → <code>{item.to}</code> ·{" "}
                {language.t("operator.move.sessionsLinked", { count: item.sessions })}
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={props.report.skipped.length}>
        <h3 class="text-12-medium">{language.t("operator.move.skipped")}</h3>
        <ul>
          <For each={props.report.skipped}>
            {(item) => (
              <li>
                <code>{item.from}</code>: {item.reason}
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={props.report.byHand.length}>
        <h3 class="text-12-medium">{language.t("operator.move.byHand")}</h3>
        <ul>
          <For each={props.report.byHand}>
            {(file) => (
              <li>
                <code>{file}</code>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}
