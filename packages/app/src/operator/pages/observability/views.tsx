import { Icon } from "@opencode-ai/ui/icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import type { OperatorTelemetryView, OperatorTelemetryViewState } from "@opencode-ai/sdk/v2/client"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createMemo, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { ready, useOperatorClient } from "../../data"
import { useAskText, useMoveToTrash } from "../../ui/confirm"
import { FieldHelp } from "../../ui/field-help"

// Saved views (observability_spec.md §8.5): the built-in views (read-only), then everyone's on this server. A view
// keeps the tab, filters, sort, visible columns and the facet panel, not the time range or scope. Save updates the
// current view, Save as makes one (also from a built-in), Rename, and Delete moves it to Trash.

type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]
export type View = OperatorTelemetryView
export type ViewState = OperatorTelemetryViewState

export function useViews() {
  const api = useOperatorClient()
  return useQuery(() => ({
    queryKey: api.key("telemetry-views"),
    queryFn: () =>
      api
        .client()
        .operator.telemetry.views({ throwOnError: true })
        .then((result) => result.data!),
  }))
}

/** A view's name: a built-in one's from the page's texts. */
export function useViewName() {
  const t = useLanguage().t
  return (view: View) => (view.builtin ? t(`operator.obs.view.builtin.${view.builtin}` as Key) : view.name)
}

export function ViewsMenu(props: {
  /** The view in the URL (`view=`). */
  current: string | undefined
  /** What the page shows now, as a view's state. */
  state: () => ViewState
  onApply: (view: View) => void
  onSaved: (view: View | undefined) => void
}) {
  const t = useLanguage().t
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const views = useViews()
  const nameOf = useViewName()
  const ask = useAskText()
  const moveToTrash = useMoveToTrash()
  const list = () => ready(views) ?? []
  const current = createMemo(() => list().find((view) => view.id === props.current))
  const builtins = () => list().filter((view) => view.builtin)
  const saved = () => list().filter((view) => !view.builtin)
  const own = () => (current() && !current()!.builtin ? current() : undefined)
  const refresh = () => queryClient.invalidateQueries({ queryKey: api.key("telemetry-views") })

  const saveAs = async () => {
    const answer = await ask({
      title: t("operator.obs.view.saveAsTitle"),
      label: t("operator.obs.view.name"),
      value: current() ? t("operator.obs.view.copyOf", { name: nameOf(current()!) }) : "",
      confirm: t("operator.obs.view.save"),
      description: { label: t("operator.obs.view.description") },
    })
    if (!answer) return
    const made = await api
      .client()
      .operator.telemetry.viewCreate(
        {
          operatorTelemetryViewInput: {
            name: answer.name,
            ...(answer.description ? { description: answer.description } : {}),
            state: props.state(),
          },
        },
        { throwOnError: true },
      )
      .then((result) => result.data!)
    await refresh()
    props.onSaved(made)
  }
  const save = async () => {
    const view = own()
    if (!view) return
    await api
      .client()
      .operator.telemetry.viewUpdate(
        { id: view.id, operatorTelemetryViewPatch: { state: props.state() } },
        { throwOnError: true },
      )
    await refresh()
  }
  const rename = async () => {
    const view = own()
    if (!view) return
    const answer = await ask({
      title: t("operator.obs.view.renameTitle"),
      label: t("operator.obs.view.name"),
      value: view.name,
      confirm: t("operator.obs.view.rename"),
      description: { label: t("operator.obs.view.description"), value: view.description ?? "" },
    })
    if (!answer) return
    await api
      .client()
      .operator.telemetry.viewUpdate(
        { id: view.id, operatorTelemetryViewPatch: { name: answer.name, description: answer.description } },
        { throwOnError: true },
      )
    await refresh()
  }
  const remove = async () => {
    const view = own()
    if (!view) return
    const moved = await moveToTrash(view.name, () =>
      api.client().operator.telemetry.viewDelete({ id: view.id }, { throwOnError: true }),
    )
    if (!moved) return
    await refresh()
    props.onSaved(undefined)
  }

  return (
    <span class="inline-flex items-center" data-testid="obs-views">
      <MenuV2>
        {/* Named by its text: "Views", and the view shown. */}
        <MenuV2.Trigger as={ButtonV2} size="small" variant="outline" data-testid="obs-views-trigger">
          <Icon name="bullet-list" size="small" />
          <span>{t("operator.obs.view.menu")}</span>
          <Show when={current()}>{(view) => <strong data-testid="obs-view-current">{nameOf(view())}</strong>}</Show>
          <Icon name="chevron-down" size="small" />
        </MenuV2.Trigger>
        <MenuV2.Portal>
          <MenuV2.Content>
            <MenuV2.Group>
              <MenuV2.GroupLabel>{t("operator.obs.view.builtins")}</MenuV2.GroupLabel>
              <For each={builtins()}>
                {(view) => (
                  <MenuV2.Item onSelect={() => props.onApply(view)} data-testid="obs-view-item">
                    {nameOf(view)}
                  </MenuV2.Item>
                )}
              </For>
            </MenuV2.Group>
            <Show when={saved().length}>
              <MenuV2.Separator />
              <MenuV2.Group>
                <MenuV2.GroupLabel>{t("operator.obs.view.saved")}</MenuV2.GroupLabel>
                <For each={saved()}>
                  {(view) => (
                    <MenuV2.Item onSelect={() => props.onApply(view)} data-testid="obs-view-item">
                      <span title={view.description}>{view.name}</span>
                    </MenuV2.Item>
                  )}
                </For>
              </MenuV2.Group>
            </Show>
            <MenuV2.Separator />
            <MenuV2.Item disabled={!own()} onSelect={() => void save()}>
              {t("operator.obs.view.save")}
            </MenuV2.Item>
            <MenuV2.Item onSelect={() => void saveAs()}>{t("operator.obs.view.saveAs")}</MenuV2.Item>
            <MenuV2.Item disabled={!own()} onSelect={() => void rename()}>
              {t("operator.obs.view.rename")}
            </MenuV2.Item>
            <MenuV2.Item disabled={!own()} onSelect={() => void remove()}>
              {t("operator.obs.view.delete")}
            </MenuV2.Item>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
      <FieldHelp field={t("operator.obs.view.menu")} text={t("operator.obs.help.views")} />
    </span>
  )
}
