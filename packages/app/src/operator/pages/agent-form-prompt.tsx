import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import type { OperatorPromptOverride } from "@opencode-ai/sdk/v2/client"
import { useQuery } from "@tanstack/solid-query"
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { ready, useOperatorClient } from "../data"
import { formatCount } from "../format"
import { Field } from "../ui/field"
import { SelectV2 } from "../ui/select"
import { TextCounters } from "../ui/text-counters"
import { Override } from "./agent-prompt"
import type { Mode } from "./agent-type"
import { requestError } from "./config-helpers"
import { usePromptCatalog, useProfileNames } from "./profile-data"
import { isHelper, PREFIX } from "./profile-model"
import { useProjectSettings } from "./project-prompt"

// The agent form's prompt (agent_form_spec.md §6.1–§6.2): the profile it uses ("Use the default", else one of its
// namespace's), Override (the Sys Prompt tab's own editor, saved with the form), and "System Prompt as sent": the
// whole system prompt the form's unsaved values would send (its own prompt text, mode, model, profile and override;
// POST /operator/prompt/preview), block by block with each block's group type and layer, with characters, words and
// tokens for the whole prompt and for the block chosen. Read-only here; it updates as the form changes.

export const DEFAULT_PROFILE = "@default"
const AGENT_SLOTS = [`${PREFIX}slot.agent`, `${PREFIX}slot.agent-or-base`]

export type PromptChoice = { profile: string; override: OperatorPromptOverride | null }

export function AgentFormPrompt(props: {
  directory: string | undefined
  namespace: string
  agent: string
  prompt: string
  mode: Mode
  model: string | undefined
  value: PromptChoice
  /** The agent's saved setting (editing): its override fills the editor. */
  saved?: { profile?: string; override?: OperatorPromptOverride }
  onChange: (value: PromptChoice) => void
}) {
  const language = useLanguage()
  const api = useOperatorClient()
  const names = useProfileNames()
  const data = usePromptCatalog(() => props.namespace)
  // Read without suspending: the form keeps what was typed while these load (data.ts ready()).
  const catalog = () => ready(data.query)
  const projects = useProjectSettings()
  const profiles = () => catalog()?.profiles ?? []
  const profileOf = (id: string | undefined) => profiles().find((item) => item.id === id)
  // The default: the project's, else the namespace's, else OpenCode's profile.
  const defaultProfile = () =>
    profileOf(ready(projects)?.find((item) => item.key === props.directory)?.defaultProfile) ??
    profileOf(catalog()?.namespace.defaultProfile) ??
    profileOf(`${PREFIX}profile.opencode`) ??
    profiles()[0]
  const chosen = () => (props.value.profile === DEFAULT_PROFILE ? undefined : profileOf(props.value.profile))
  const inEffect = () => chosen() ?? defaultProfile()
  const helperProfile = () => !!catalog() && !!chosen() && isHelper(catalog()!, chosen()!)
  const label = (id: string) =>
    id === DEFAULT_PROFILE
      ? language.t("operator.prompts.useDefault", { name: defaultProfile() ? names.profile(defaultProfile()!) : "" })
      : profileOf(id)
        ? names.profile(profileOf(id)!)
        : id

  // The preview, a moment after the form stops changing.
  const draft = createMemo(() =>
    JSON.stringify({
      agent: props.agent.trim() || "new-agent",
      model: props.model,
      prompt: props.prompt,
      mode: props.mode,
      profile: chosen()?.id,
      override: props.value.override,
    }),
  )
  const [settled, setSettled] = createSignal(draft())
  createEffect(
    on(draft, (value) => {
      const timer = setTimeout(() => setSettled(value), 300)
      return () => clearTimeout(timer)
    }),
  )
  const preview = useQuery(() => ({
    queryKey: api.key("prompt-preview-draft", props.directory, settled()),
    enabled: !!props.directory,
    // The last preview stays while the next one loads.
    placeholderData: <T,>(previous: T) => previous,
    queryFn: () => {
      const input = JSON.parse(settled()) as {
        agent: string
        model?: string
        prompt: string
        mode: Mode
        profile?: string
        override: OperatorPromptOverride | null
      }
      const at = input.model?.indexOf("/") ?? -1
      return api
        .client()
        .operator.prompt.previewDraft(
          {
            directory: props.directory,
            agent: input.agent,
            ...(input.model && at > 0 ? { provider: input.model.slice(0, at), model: input.model.slice(at + 1) } : {}),
            draft: {
              prompt: input.prompt,
              mode: input.mode,
              setting: {
                ...(input.profile ? { profile: input.profile } : {}),
                ...(input.override ? { override: input.override } : {}),
              },
            },
          },
          { throwOnError: true },
        )
        .then((result) => result.data!)
    },
  }))
  const shown = () => ready(preview)
  const sections = () => shown()?.sections ?? []
  const whole = () => (shown()?.system ?? []).join("\n")
  const [selected, setSelected] = createSignal<number>()
  const block = () => (selected() === undefined ? undefined : sections()[selected()!])
  // The agent's own text goes where the profile's Agent prompt slot puts it; a profile without one doesn't send it.
  const noAgentSlot = () =>
    !!shown() && !!props.prompt.trim() && !sections().some((item) => AGENT_SLOTS.includes(item.layer ?? ""))

  return (
    <>
      <Field group label={language.t("operator.prompts.profile")} hint={language.t("operator.help.agentFormProfile")}>
        <SelectV2<string>
          appearance="base"
          aria-label={language.t("operator.prompts.profile")}
          options={[DEFAULT_PROFILE, ...profiles().map((item) => item.id)]}
          current={chosen() ? props.value.profile : DEFAULT_PROFILE}
          label={label}
          onSelect={(id) => {
            if (!id) return
            const helper = id !== DEFAULT_PROFILE && !!catalog() && isHelper(catalog()!, profileOf(id)!)
            // No profile chosen, or a helper's: no override.
            props.onChange({
              profile: id,
              override: id === DEFAULT_PROFILE || helper ? null : props.value.override,
            })
          }}
        />
      </Field>
      <Show when={catalog()}>
        {(found) => (
          <Override
            ns={props.namespace}
            catalog={found()}
            profile={inEffect()}
            setting={{
              ...(chosen() ? { profile: chosen()!.id } : {}),
              ...(props.saved?.override && chosen() ? { override: props.saved.override } : {}),
            }}
            onSave={() => Promise.resolve()}
            onDraft={() => undefined}
            embedded
            disabled={
              !chosen()
                ? language.t("operator.agentForm.overrideNeedsProfile")
                : helperProfile()
                  ? language.t("operator.agentForm.overrideHelper")
                  : undefined
            }
            onChange={(override) => {
              if (JSON.stringify(override) !== JSON.stringify(props.value.override))
                props.onChange({ ...props.value, override })
            }}
          />
        )}
      </Show>
      <details data-component="operator-sent" data-testid="prompt-as-sent" open>
        <summary class="text-13-medium">{language.t("operator.agentForm.asSent")}</summary>
        <p data-slot="operator-note">{language.t("operator.agentForm.asSentHint")}</p>
        <div class="flex flex-wrap items-center gap-3" data-testid="prompt-as-sent-counters">
          <span class="inline-flex items-center gap-1">
            <span data-slot="operator-note">{language.t("operator.agentForm.wholePrompt")}</span>
            <TextCounters text={whole()} model={props.model} directory={props.directory} />
          </span>
          <Show when={block()}>
            {(found) => (
              <span class="inline-flex items-center gap-1" data-testid="prompt-block-counters">
                <span data-slot="operator-note">
                  {language.t("operator.agentForm.thisBlock", { name: found().layerName })}
                </span>
                <TextCounters text={found().text} model={props.model} directory={props.directory} />
              </span>
            )}
          </Show>
        </div>
        <Show when={noAgentSlot()}>
          <p data-slot="operator-note" data-warning="" data-testid="prompt-no-agent-slot">
            {language.t("operator.agentForm.noAgentSlot")}
          </p>
        </Show>
        <Show when={preview.error}>
          {(error) => (
            <pre data-slot="operator-error" role="alert">
              {requestError(error())}
            </pre>
          )}
        </Show>
        <ol data-component="operator-sent-blocks">
          <For each={sections()}>
            {(section, index) => (
              <li
                data-slot="operator-sent-block"
                data-testid="prompt-block"
                data-type={section.type}
                data-selected={selected() === index() ? "" : undefined}
                tabIndex={0}
                onFocus={() => setSelected(index())}
                onClick={() => setSelected(index())}
              >
                <span class="flex flex-wrap items-center gap-2">
                  <Tag variant={section.automatic ? "accent" : "neutral"}>{section.typeName}</Tag>
                  <span data-slot="operator-layer-name">{section.layerName}</span>
                  <Show when={section.automatic}>
                    <Tag>{language.t("operator.prompts.automatic")}</Tag>
                  </Show>
                  <Show when={section.changed}>
                    <Tag>{language.t("operator.profile.changed")}</Tag>
                  </Show>
                  <span data-slot="operator-note">
                    {language.t("operator.prompts.chars", { count: formatCount(section.text.length, language.intl()) })}
                  </span>
                </span>
                <pre data-component="operator-code">{section.text}</pre>
              </li>
            )}
          </For>
        </ol>
      </details>
    </>
  )
}
