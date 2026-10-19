import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import type { OperatorTelemetrySettings, OperatorTelemetrySettingsInput } from "@opencode-ai/sdk/v2/client"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, createSignal, For, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { ready, useOperatorClient } from "../../data"
import { formatBytes, formatCount, formatDateTime } from "../../format"
import { useConfirm } from "../../ui/confirm"
import { Field } from "../../ui/field"
import { FieldHelp } from "../../ui/field-help"
import { OverlayFrame } from "../../ui/overlay-frame"
import { useOverlayParams } from "../../ui/overlay-nav"
import { RecordField } from "../../ui/record-overlay"
import { SelectV2 } from "../../ui/select"
import { requestError } from "../config-helpers"

// Observability settings (observability_spec.md §15), in an overlay from the page's ⋯ menu (not the Settings dialog:
// a section there would be an upstream edit). Recording, retention, the log lines kept, the loop rules, the daily
// budget, the Dashboard's thresholds and call recording (the existing `operatorRecordCalls`); the store; Rebuild from
// history; Clear telemetry (to Trash, after asking).

type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]
const LEVELS = ["error", "warn", "info"] as const
const LOOPS = ["sameCallSameResult", "sameCall", "toolCalls", "modelCalls"] as const

type Form = {
  enabled: boolean
  eventsDays: string
  totalsDays: string
  logLevel: (typeof LEVELS)[number]
  loops: Record<(typeof LOOPS)[number], string>
  dailyBudget: string
  stuckMinutes: string
  queueMinutes: string
  recordCalls: boolean
}

const formOf = (settings: OperatorTelemetrySettings): Form => ({
  enabled: settings.enabled,
  eventsDays: String(settings.eventsDays),
  totalsDays: String(settings.totalsDays),
  logLevel: settings.logLevel,
  loops: Object.fromEntries(LOOPS.map((key) => [key, String(settings.loops[key])])) as Form["loops"],
  dailyBudget: settings.dailyBudget === null ? "" : String(settings.dailyBudget),
  stuckMinutes: String(settings.stuckMinutes),
  queueMinutes: String(settings.queueMinutes),
  recordCalls: settings.recordCalls,
})

export function useTelemetrySettings() {
  const api = useOperatorClient()
  return useQuery(() => ({
    queryKey: api.key("telemetry-settings"),
    queryFn: () =>
      api
        .client()
        .operator.telemetry.settings({ throwOnError: true })
        .then((result) => result.data!),
  }))
}

/** The settings overlay (`settings=1`). */
export function SettingsOverlay() {
  const t = useLanguage().t
  const [dirty, setDirty] = createSignal(false)
  return (
    <OverlayFrame label={t("operator.obs.settings.title")} editing={dirty()}>
      <div data-component="operator-obs-settings" data-testid="obs-settings">
        <SettingsForm onDirty={setDirty} />
      </div>
    </OverlayFrame>
  )
}

function SettingsForm(props: { onDirty: (dirty: boolean) => void }) {
  const language = useLanguage()
  const t = language.t
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const [, setParams] = useOverlayParams<{ settings?: string }>()
  const settings = useTelemetrySettings()
  const storage = useQuery(() => ({
    queryKey: api.key("telemetry-storage"),
    queryFn: () =>
      api
        .client()
        .operator.telemetry.storage({ throwOnError: true })
        .then((result) => result.data!),
  }))
  const backfill = useQuery(() => ({
    queryKey: api.key("telemetry-backfill"),
    refetchInterval: (state) => (state.state.data?.state === "running" ? 1000 : false),
    queryFn: () =>
      api
        .client()
        .operator.telemetry.backfillStatus({ throwOnError: true })
        .then((result) => result.data!),
  }))
  const [form, setForm] = createStore<{ value?: Form; busy: boolean; error?: string; note?: string }>({ busy: false })
  createEffect(
    on(
      () => ready(settings),
      (found) => found && !form.value && setForm("value", formOf(found)),
    ),
  )
  const edit = (change: (value: Form) => Form) => {
    if (!form.value) return
    setForm("value", change({ ...form.value, loops: { ...form.value.loops } }))
    props.onDirty(true)
  }
  const number = (value: string) => (value.trim() === "" ? NaN : Number(value))
  const refreshAll = () =>
    Promise.all(
      ["telemetry-settings", "telemetry-storage", "telemetry-backfill", "telemetry-alert-rules"].map((key) =>
        queryClient.invalidateQueries({ queryKey: api.key(key) }),
      ),
    )

  const save = async () => {
    const value = form.value
    if (!value) return
    setForm({ busy: true, error: undefined, note: undefined })
    const input: OperatorTelemetrySettingsInput = {
      enabled: value.enabled,
      eventsDays: number(value.eventsDays),
      totalsDays: number(value.totalsDays),
      logLevel: value.logLevel,
      loops: Object.fromEntries(
        LOOPS.map((key) => [key, number(value.loops[key])]),
      ) as OperatorTelemetrySettingsInput["loops"],
      // No budget is null (the generated type drops the null the server takes).
      dailyBudget: (value.dailyBudget.trim() === "" ? null : number(value.dailyBudget)) as number,
      stuckMinutes: number(value.stuckMinutes),
      queueMinutes: number(value.queueMinutes),
      recordCalls: value.recordCalls,
    }
    try {
      const saved = await api
        .client()
        .operator.telemetry.settingsUpdate({ operatorTelemetrySettingsInput: input }, { throwOnError: true })
        .then((result) => result.data!)
      setForm({
        value: formOf(saved.settings),
        note: t(`operator.obs.settings.saved.${saved.reload ?? "done"}` as Key),
      })
      props.onDirty(false)
      await refreshAll()
    } catch (error) {
      setForm("error", requestError(error))
    } finally {
      setForm("busy", false)
    }
  }
  const rebuild = async () => {
    await api.client().operator.telemetry.backfill({ throwOnError: true })
    await queryClient.invalidateQueries({ queryKey: api.key("telemetry-backfill") })
  }
  const clear = async () => {
    const ok = await confirm({
      title: t("operator.obs.settings.clearTitle"),
      description: t("operator.obs.settings.clearBody"),
      confirm: t("operator.obs.settings.clearConfirm"),
      danger: true,
    })
    if (!ok) return
    try {
      await api.client().operator.telemetry.clear({ throwOnError: true })
      setForm("note", t("operator.obs.settings.cleared"))
      await queryClient.invalidateQueries({ queryKey: api.key() })
    } catch (error) {
      setForm("error", requestError(error))
    }
  }
  const limits = () => ready(settings)?.limits

  return (
    <Show when={form.value} fallback={<p data-slot="operator-note">{t("common.loading")}</p>}>
      {(value) => (
        <div class="flex flex-col gap-4">
          <div data-component="operator-form" data-testid="obs-settings-form">
            <span class="inline-flex items-center">
              <CheckboxV2
                label={t("operator.obs.settings.enabled")}
                checked={value().enabled}
                onChange={(checked: boolean) => edit((form) => ({ ...form, enabled: checked }))}
              />
              <FieldHelp field={t("operator.obs.settings.enabled")} text={t("operator.obs.help.settingsEnabled")} />
            </span>
            <Field
              label={t("operator.obs.settings.eventsDays")}
              hint={t("operator.obs.help.settingsEventsDays", {
                min: limits()?.eventsDays.min ?? 1,
                max: limits()?.eventsDays.max ?? 365,
              })}
            >
              <TextInputV2
                appearance="base"
                type="number"
                value={value().eventsDays}
                onInput={(event) => edit((form) => ({ ...form, eventsDays: event.currentTarget.value }))}
              />
            </Field>
            <Field
              label={t("operator.obs.settings.totalsDays")}
              hint={t("operator.obs.help.settingsTotalsDays", {
                min: limits()?.totalsDays.min ?? 30,
                max: limits()?.totalsDays.max ?? 1825,
              })}
            >
              <TextInputV2
                appearance="base"
                type="number"
                value={value().totalsDays}
                onInput={(event) => edit((form) => ({ ...form, totalsDays: event.currentTarget.value }))}
              />
            </Field>
            <Field group label={t("operator.obs.settings.logLevel")} hint={t("operator.obs.help.settingsLogLevel")}>
              <SelectV2<(typeof LEVELS)[number]>
                appearance="base"
                aria-label={t("operator.obs.settings.logLevel")}
                options={[...LEVELS]}
                current={value().logLevel}
                label={(level) => t(`operator.obs.levelAtLeast.${level}` as Key)}
                onSelect={(level) => level && edit((form) => ({ ...form, logLevel: level }))}
              />
            </Field>
            <Field group label={t("operator.obs.settings.loops")} hint={t("operator.obs.help.settingsLoops")}>
              <div class="flex flex-wrap gap-3">
                <For each={LOOPS}>
                  {(key) => (
                    <label class="flex flex-col gap-1 text-12-regular">
                      <span>{t(`operator.obs.settings.loop.${key}` as Key)}</span>
                      <TextInputV2
                        appearance="base"
                        type="number"
                        value={value().loops[key]}
                        onInput={(event) =>
                          edit((form) => ({ ...form, loops: { ...form.loops, [key]: event.currentTarget.value } }))
                        }
                      />
                    </label>
                  )}
                </For>
              </div>
            </Field>
            <Field label={t("operator.obs.settings.dailyBudget")} hint={t("operator.obs.help.settingsDailyBudget")}>
              <TextInputV2
                appearance="base"
                type="number"
                placeholder={t("operator.obs.settings.noBudget")}
                value={value().dailyBudget}
                onInput={(event) => edit((form) => ({ ...form, dailyBudget: event.currentTarget.value }))}
              />
            </Field>
            <Field label={t("operator.obs.settings.stuckMinutes")} hint={t("operator.obs.help.settingsStuck")}>
              <TextInputV2
                appearance="base"
                type="number"
                value={value().stuckMinutes}
                onInput={(event) => edit((form) => ({ ...form, stuckMinutes: event.currentTarget.value }))}
              />
            </Field>
            <Field label={t("operator.obs.settings.queueMinutes")} hint={t("operator.obs.help.settingsQueue")}>
              <TextInputV2
                appearance="base"
                type="number"
                value={value().queueMinutes}
                onInput={(event) => edit((form) => ({ ...form, queueMinutes: event.currentTarget.value }))}
              />
            </Field>
            <span class="inline-flex items-center">
              <CheckboxV2
                label={t("operator.obs.settings.recordCalls")}
                checked={value().recordCalls}
                onChange={(checked: boolean) => edit((form) => ({ ...form, recordCalls: checked }))}
              />
              <FieldHelp
                field={t("operator.obs.settings.recordCalls")}
                text={t("operator.obs.help.settingsRecordCalls")}
              />
            </span>
            <Show when={form.error}>
              <pre data-slot="operator-error" role="alert">
                {form.error}
              </pre>
            </Show>
            <Show when={form.note}>
              <p data-slot="operator-note" role="status" data-testid="obs-settings-note">
                {form.note}
              </p>
            </Show>
            <div data-slot="operator-actions">
              <ButtonV2 variant="neutral" onClick={() => setParams({ settings: undefined })}>
                {t("common.close")}
              </ButtonV2>
              <ButtonV2
                variant="contrast"
                disabled={form.busy}
                onClick={() => void save()}
                data-testid="obs-settings-save"
              >
                {t("common.save")}
              </ButtonV2>
            </div>
          </div>
          <section data-slot="operator-obs-section" data-testid="obs-settings-storage">
            <header>
              <h3>{t("operator.obs.settings.storage")}</h3>
              <FieldHelp field={t("operator.obs.settings.storage")} text={t("operator.obs.help.settingsStorage")} />
            </header>
            <Show when={ready(storage)}>
              {(found) => (
                <dl data-component="operator-record-fields">
                  <RecordField label={t("operator.obs.settings.file")} help={t("operator.obs.help.settingsFile")}>
                    <code>{found().path}</code>
                  </RecordField>
                  <RecordField label={t("operator.obs.settings.size")} help={t("operator.obs.help.settingsSize")}>
                    {formatBytes(found().bytes, language.intl())}
                  </RecordField>
                  <RecordField label={t("operator.obs.settings.spans")} help={t("operator.obs.help.settingsSpans")}>
                    {formatCount(found().spans, language.intl())}
                  </RecordField>
                  <RecordField label={t("operator.obs.settings.logs")} help={t("operator.obs.help.settingsLogs")}>
                    {formatCount(found().logs, language.intl())}
                  </RecordField>
                  <RecordField label={t("operator.obs.settings.oldest")} help={t("operator.obs.help.settingsOldest")}>
                    {found().oldestSpan ? formatDateTime(found().oldestSpan, language.intl()) : "—"}
                  </RecordField>
                  <RecordField label={t("operator.obs.settings.kept")} help={t("operator.obs.help.settingsKept")}>
                    {formatCount(found().kept, language.intl())}
                  </RecordField>
                  <RecordField label={t("operator.obs.settings.dropped")} help={t("operator.obs.help.settingsDropped")}>
                    {formatCount(found().dropped, language.intl())}
                  </RecordField>
                  <RecordField
                    label={t("operator.obs.settings.lastPurge")}
                    help={t("operator.obs.help.settingsLastPurge")}
                  >
                    {found().lastPurge ? formatDateTime(found().lastPurge, language.intl()) : "—"}
                  </RecordField>
                </dl>
              )}
            </Show>
            <div data-slot="operator-actions">
              <ButtonV2
                variant="outline"
                disabled={ready(backfill)?.state === "running"}
                onClick={() => void rebuild()}
                data-testid="obs-settings-rebuild"
              >
                {t("operator.obs.settings.rebuild")}
              </ButtonV2>
              <FieldHelp field={t("operator.obs.settings.rebuild")} text={t("operator.obs.help.settingsRebuild")} />
              <ButtonV2 variant="danger" onClick={() => void clear()} data-testid="obs-settings-clear">
                {t("operator.obs.settings.clear")}
              </ButtonV2>
              <FieldHelp field={t("operator.obs.settings.clear")} text={t("operator.obs.help.settingsClear")} />
            </div>
            <Show when={ready(backfill)?.state === "running" ? ready(backfill) : undefined}>
              {(progress) => (
                <p data-slot="operator-note" role="status" data-testid="obs-settings-progress">
                  {t("operator.obs.building", {
                    done: formatCount(progress().done, language.intl()),
                    total: formatCount(progress().total, language.intl()),
                  })}
                </p>
              )}
            </Show>
          </section>
        </div>
      )}
    </Show>
  )
}
