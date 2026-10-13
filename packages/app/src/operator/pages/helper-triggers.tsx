import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import type { OperatorHelper, OperatorHelperTrigger, OperatorHelperTriggerOn } from "@opencode-ai/sdk/v2/client"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { For, Index, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { useOperatorClient } from "../data"
import { formatAgo } from "../format"
import { Field } from "../ui/field"
import { SelectV2 } from "../ui/select"
import { requestError } from "./config-helpers"
import {
  browserZone,
  dayName,
  isSchedule,
  MAX_TRIGGERS,
  newTrigger,
  runsByHand,
  TRIGGER_ONS,
  type TriggerForm,
} from "./helper-trigger-model"

// A helper's triggers (agent_types_spec.md §4.9): edited in its form (TriggersEditor), and shown on its Overview with
// their state (TriggersView): a schedule's next start, the last start, starts skipped at its runs an hour, the last
// error, and Run now.

type Words = Pick<OperatorHelperTrigger, "on" | "at" | "minute" | "day" | "cron" | "tz" | "days">

/** A trigger in words: "Every Monday at 03:00 (Europe/Berlin)". */
export function useTriggerWords() {
  const language = useLanguage()
  return (trigger: Words) => {
    const zone = isSchedule(trigger.on) && trigger.tz ? ` (${trigger.tz})` : ""
    if (trigger.on === "hourly")
      return (
        language.t("operator.trigger.words.hourly", { minute: String(trigger.minute ?? 0).padStart(2, "0") }) + zone
      )
    if (trigger.on === "daily") return language.t("operator.trigger.words.daily", { at: trigger.at ?? "" }) + zone
    if (trigger.on === "weekly")
      return (
        language.t("operator.trigger.words.weekly", {
          day: dayName(trigger.day ?? 1, language.intl()),
          at: trigger.at ?? "",
        }) + zone
      )
    if (trigger.on === "cron") return language.t("operator.trigger.words.cron", { cron: trigger.cron ?? "" }) + zone
    if (trigger.on === "session.untouched")
      return language.t("operator.trigger.words.untouched", { days: trigger.days ?? 0 })
    if (trigger.on === "session.turn") return language.t("operator.trigger.words.turn")
    return language.t("operator.trigger.words.created")
  }
}

const onLabel = (language: ReturnType<typeof useLanguage>, on: OperatorHelperTriggerOn) =>
  language.t(`operator.trigger.on.${on.replace(".", "_")}` as "operator.trigger.on.daily")

export function TriggersEditor(props: {
  triggers: ReadonlyArray<TriggerForm>
  onChange: (triggers: TriggerForm[]) => void
}) {
  const language = useLanguage()
  const zone = browserZone()
  const update = (index: number, patch: Partial<TriggerForm>) =>
    props.onChange(props.triggers.map((item, at) => (at === index ? { ...item, ...patch } : item)))
  const days = [0, 1, 2, 3, 4, 5, 6].map(String)
  return (
    <div class="flex flex-col gap-2" data-testid="helper-triggers">
      <Show
        when={props.triggers.length}
        fallback={<span data-slot="operator-note">{language.t("operator.trigger.none")}</span>}
      >
        <Index each={props.triggers}>
          {(trigger, index) => (
            <div data-component="operator-trigger" data-testid="helper-trigger">
              <div data-slot="operator-form-row">
                <Field label={language.t("operator.trigger.when")} hint={language.t("operator.help.triggerWhen")}>
                  <SelectV2<OperatorHelperTriggerOn>
                    appearance="base"
                    aria-label={language.t("operator.trigger.whenOf", { index: index + 1 })}
                    options={[...TRIGGER_ONS]}
                    current={trigger().on}
                    label={(on) => onLabel(language, on)}
                    onSelect={(on) => on && update(index, { on })}
                  />
                </Field>
                <Field
                  group
                  label={language.t("operator.trigger.enabled")}
                  hint={language.t("operator.help.triggerOn")}
                >
                  <Switch checked={trigger().enabled} onChange={(checked) => update(index, { enabled: checked })}>
                    {language.t("operator.trigger.enabledSwitch")}
                  </Switch>
                </Field>
              </div>
              <div data-slot="operator-form-row">
                <Show when={trigger().on === "hourly"}>
                  <Field label={language.t("operator.trigger.minute")} hint={language.t("operator.help.triggerMinute")}>
                    <TextInputV2
                      appearance="base"
                      inputMode="numeric"
                      value={trigger().minute}
                      onInput={(event) => update(index, { minute: event.currentTarget.value })}
                    />
                  </Field>
                </Show>
                <Show when={trigger().on === "weekly"}>
                  <Field group label={language.t("operator.trigger.day")} hint={language.t("operator.help.triggerDay")}>
                    <SelectV2<string>
                      appearance="base"
                      aria-label={language.t("operator.trigger.dayOf", { index: index + 1 })}
                      options={days}
                      current={trigger().day}
                      label={(day) => dayName(Number(day), language.intl())}
                      onSelect={(day) => day && update(index, { day })}
                    />
                  </Field>
                </Show>
                <Show when={trigger().on === "daily" || trigger().on === "weekly"}>
                  <Field label={language.t("operator.trigger.at")} hint={language.t("operator.help.triggerAt")}>
                    <TextInputV2
                      appearance="base"
                      placeholder="03:00"
                      value={trigger().at}
                      onInput={(event) => update(index, { at: event.currentTarget.value })}
                    />
                  </Field>
                </Show>
                <Show when={trigger().on === "cron"}>
                  <Field label={language.t("operator.trigger.cron")} hint={language.t("operator.help.triggerCron")}>
                    <TextInputV2
                      appearance="base"
                      placeholder="0 3 * * 1-5"
                      value={trigger().cron}
                      onInput={(event) => update(index, { cron: event.currentTarget.value })}
                    />
                  </Field>
                </Show>
                <Show when={trigger().on === "session.untouched"}>
                  <Field label={language.t("operator.trigger.days")} hint={language.t("operator.help.triggerDays")}>
                    <TextInputV2
                      appearance="base"
                      inputMode="numeric"
                      value={trigger().days}
                      onInput={(event) => update(index, { days: event.currentTarget.value })}
                    />
                  </Field>
                </Show>
                <Field
                  label={language.t("operator.trigger.maxPerHour")}
                  hint={language.t("operator.help.triggerMaxPerHour")}
                >
                  <TextInputV2
                    appearance="base"
                    inputMode="numeric"
                    value={trigger().maxPerHour}
                    onInput={(event) => update(index, { maxPerHour: event.currentTarget.value })}
                  />
                </Field>
              </div>
              <Show when={isSchedule(trigger().on)}>
                <p data-slot="operator-note" data-testid="trigger-zone">
                  {language.t("operator.trigger.zone", { zone: trigger().tz })}{" "}
                  <Show when={trigger().tz !== zone}>
                    <button type="button" data-slot="operator-link" onClick={() => update(index, { tz: zone })}>
                      {language.t("operator.trigger.useZone", { zone })}
                    </button>
                  </Show>
                </p>
              </Show>
              <Show when={trigger().on === "session.turn" || trigger().on === "project.created"}>
                <p data-slot="operator-note">
                  {language.t(
                    `operator.trigger.about.${trigger().on.replace(".", "_")}` as "operator.trigger.about.session_turn",
                  )}
                </p>
              </Show>
              <Field label={language.t("operator.trigger.input")} hint={language.t("operator.help.triggerInput")}>
                <TextareaV2
                  rows={2}
                  aria-label={language.t("operator.trigger.inputOf", { index: index + 1 })}
                  value={trigger().input}
                  onInput={(event) => update(index, { input: event.currentTarget.value })}
                />
              </Field>
              <div data-slot="operator-actions">
                <ButtonV2
                  size="small"
                  variant="ghost"
                  onClick={() => props.onChange(props.triggers.filter((_, at) => at !== index))}
                >
                  {language.t("operator.trigger.remove")}
                </ButtonV2>
              </div>
            </div>
          )}
        </Index>
      </Show>
      <div>
        <ButtonV2
          size="small"
          variant="neutral"
          disabled={props.triggers.length >= MAX_TRIGGERS}
          onClick={() => props.onChange([...props.triggers, newTrigger(zone)])}
        >
          {language.t("operator.helper.addTrigger")}
        </ButtonV2>
      </div>
    </div>
  )
}

export function TriggersView(props: { helper: OperatorHelper }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const words = useTriggerWords()
  const states = useQuery(() => ({
    queryKey: api.key("helper-triggers", props.helper.namespace, props.helper.name),
    enabled: props.helper.triggers.length > 0,
    refetchInterval: 30_000,
    queryFn: () =>
      api
        .client()
        .operator.helper.triggers({ ns: props.helper.namespace, name: props.helper.name })
        .then((result) => result.data ?? []),
  }))
  const settings = useQuery(() => ({
    queryKey: api.key("helper-settings"),
    queryFn: () =>
      api
        .client()
        .operator.helper.settings()
        .then((result) => result.data!),
  }))
  const stateOf = (id: string) => states.data?.find((item) => item.id === id)
  const when = (at: number, tz?: string) =>
    new Date(at).toLocaleString(language.intl(), {
      dateStyle: "medium",
      timeStyle: "short",
      ...(tz ? { timeZone: tz } : {}),
    })
  const runNow = (trigger: OperatorHelperTrigger) =>
    void api
      .client()
      .operator.helper.runTrigger(
        { ns: props.helper.namespace, name: props.helper.name, id: trigger.id },
        { throwOnError: true },
      )
      .then((result) => {
        showToast({
          variant: result.data.started ? "success" : undefined,
          title: language.t(result.data.started ? "operator.trigger.started" : "operator.trigger.nothing"),
        })
        void queryClient.invalidateQueries({ queryKey: api.key("helper-triggers") })
        void queryClient.invalidateQueries({ queryKey: api.key("helper-runs") })
      })
      .catch((error: unknown) =>
        showToast({ title: language.t("operator.trigger.runFailed"), description: requestError(error) }),
      )
  return (
    <Show when={props.helper.triggers.length} fallback={language.t("operator.trigger.none")}>
      <div class="flex flex-col gap-2" data-testid="helper-trigger-states">
        <Show when={settings.data?.triggersPaused}>
          <p data-slot="operator-note" data-warning="" role="status" data-testid="triggers-paused">
            {language.t("operator.trigger.paused")}
          </p>
        </Show>
        <For each={props.helper.triggers}>
          {(trigger) => (
            <div class="flex flex-col gap-0.5" data-testid="helper-trigger-state" data-trigger={trigger.id}>
              <span class="flex flex-wrap items-center gap-1">
                <span>{words(trigger)}</span>
                <Show when={!trigger.enabled}>
                  <Tag>{language.t("operator.trigger.off")}</Tag>
                </Show>
                <Show when={stateOf(trigger.id)?.running}>
                  <Tag variant="accent">{language.t("operator.helper.runStatus.running")}</Tag>
                </Show>
                <Show when={runsByHand(trigger.on)}>
                  <ButtonV2 size="small" variant="ghost" onClick={() => runNow(trigger)}>
                    {language.t("operator.trigger.runNow")}
                  </ButtonV2>
                </Show>
              </span>
              <Show when={stateOf(trigger.id)}>
                {(state) => (
                  <span data-slot="operator-note">
                    <Show when={state().next}>
                      {(next) =>
                        next() <= Date.now()
                          ? language.t("operator.trigger.due")
                          : language.t("operator.trigger.next", { when: when(next(), trigger.tz) })
                      }
                    </Show>
                    <Show when={state().next && state().lastFired}> · </Show>
                    <Show when={state().lastFired}>
                      {(at) => language.t("operator.trigger.last", { ago: formatAgo(at(), language.intl()) })}
                    </Show>
                  </span>
                )}
              </Show>
              <Show when={stateOf(trigger.id)?.skipped}>
                {(count) => (
                  <span data-slot="operator-note" data-warning="">
                    {language.t("operator.trigger.skipped", { count: count(), max: trigger.maxPerHour ?? 20 })}
                  </span>
                )}
              </Show>
              <Show when={stateOf(trigger.id)?.error}>
                {(error) => (
                  <span data-slot="operator-note" data-warning="" data-testid="trigger-error">
                    {language.t("operator.trigger.error", { error: error() })}
                  </span>
                )}
              </Show>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
