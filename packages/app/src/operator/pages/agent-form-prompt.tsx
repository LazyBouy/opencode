import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import type { OperatorPromptOverride } from "@opencode-ai/sdk/v2/client"
import { useQuery } from "@tanstack/solid-query"
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { ready, useOperatorClient } from "../data"
import { formatCount } from "../format"
import { useConfirm } from "../ui/confirm"
import { Field } from "../ui/field"
import { FieldHelp } from "../ui/field-help"
import { SelectV2 } from "../ui/select"
import { TextCounters } from "../ui/text-counters"
import {
  editable,
  editBlock,
  gapPlaces,
  insertText,
  isLocal,
  localId,
  type Block,
  type Override as OverrideValue,
  removeBlock,
  resetBlock,
  slotOf,
} from "./agent-form-text"
import { Override } from "./agent-prompt"
import type { Mode } from "./agent-type"
import { requestError } from "./config-helpers"
import { usePromptCatalog, useProfileNames } from "./profile-data"
import { isHelper, PREFIX } from "./profile-model"
import { useProjectSettings } from "./project-prompt"

// The agent form's prompt (agent_form_spec.md §6): the profile it uses ("Use the default", else one of its
// namespace's), Override (the Sys Prompt tab's own editor, saved with the form), and "System Prompt as sent": the
// whole system prompt the form's unsaved values would send (its own prompt text, mode, model, profile and override;
// POST /operator/prompt/preview), block by block with each block's group type and layer, with characters, words and
// tokens for the whole prompt and for the block chosen. Unlocked, it is edited block by block (§6.3): the agent's
// own prompt in its block, and with Override on, texts of the agent's own (agent-form-text.ts).

export const DEFAULT_PROFILE = "@default"

export type PromptChoice = { profile: string; override: OperatorPromptOverride | null }

export function AgentFormPrompt(props: {
  directory: string | undefined
  namespace: string
  agent: string
  prompt: string
  mode: Mode
  model: string | undefined
  value: PromptChoice
  onChange: (value: PromptChoice) => void
  /** The agent's own prompt, written in its block. */
  onPrompt: (text: string) => void
}) {
  const language = useLanguage()
  const confirm = useConfirm()
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

  // Editing (agent_form_spec.md §6.3): the text is locked until unlocked. The agent's own prompt is written in its
  // block; with Override on, every block of a type that isn't locked becomes a text of the agent's own when edited,
  // and text can be added between blocks. Nothing is written into the namespace (§6.4).
  const [unlocked, setUnlocked] = createSignal(false)
  const overrideOn = () => !!props.value.override && !!chosen() && !helperProfile()
  const current = (): OverrideValue => props.value.override ?? {}
  const change = (override: OverrideValue) => props.onChange({ ...props.value, override })
  // Copies made here, by the entry they replace, until the preview shows them (a block keeps its place and focus).
  const [copies, setCopies] = createSignal<Record<string, string>>({})
  // A copy stands for its block while the slot holds the copy and not the original (Reset, or the slot editor, can
  // put the original back).
  const entryOf = (section: Block) => {
    const copy = copies()[section.entry]
    if (!copy) return section.entry
    const ids = slotOf(chosen(), current(), section.type)
    return ids.includes(copy) && !ids.includes(section.entry) ? copy : section.entry
  }
  const forget = (section: Block) => {
    const entry = entryOf(section)
    setCopies(
      Object.fromEntries(Object.entries(copies()).filter(([from, to]) => from !== section.entry && to !== entry)),
    )
  }
  const [touched, setTouched] = createSignal(false)
  createEffect(on(chosen, () => setCopies({}), { defer: true }))

  // Blocks by a key that stays while a block is edited: its type, the entry it came from, and its place among
  // that entry's blocks.
  const rows = createMemo(() => {
    const from = Object.fromEntries(Object.entries(copies()).map(([entry, local]) => [local, entry]))
    const seen = new Map<string, number>()
    return sections().map((section, index) => {
      const base = `${section.type}|${from[section.entry] ?? section.entry}`
      const count = seen.get(base) ?? 0
      seen.set(base, count + 1)
      return { key: `${base}|${count}`, index }
    })
  })
  const keys = createMemo(() => rows().map((row) => row.key))
  const at = (key: string) => {
    const row = rows().find((item) => item.key === key)
    return row ? { index: row.index, section: sections()[row.index]! } : undefined
  }
  const [selected, setSelected] = createSignal<string>()

  const textOf = (section: Block) => {
    if (section.agentPrompt) return touched() ? props.prompt : section.text
    const entry = entryOf(section)
    return isLocal(entry) ? (current().layers?.[localId(entry)]?.text ?? section.text) : section.text
  }
  const block = () => {
    const found = selected() ? at(selected()!) : undefined
    return found ? { name: nameOf(found.section), text: textOf(found.section) } : undefined
  }
  const nameOf = (section: Block) => {
    const entry = entryOf(section)
    if (!isLocal(entry)) return names.layer({ id: section.layer, name: section.layerName })
    const basedOn = current().layers?.[localId(entry)]?.basedOn
    const based = catalog()?.layers.find((item) => item.id === basedOn)
    return based
      ? language.t("operator.agentForm.thisAgent", { name: names.layer(based) })
      : language.t("operator.agentForm.localText")
  }
  const write = (section: Block, text: string) => {
    if (section.agentPrompt) {
      setTouched(true)
      return props.onPrompt(text)
    }
    const done = editBlock(chosen(), current(), { type: section.type, entry: entryOf(section) }, text)
    if (done.entry !== entryOf(section)) setCopies({ ...copies(), [section.entry]: done.entry })
    change(done.override)
  }
  const remove = (section: Block) => {
    const entry = entryOf(section)
    forget(section)
    change(removeBlock(chosen(), current(), { type: section.type, entry }))
  }
  const reset = (section: Block) => {
    const exists = (id: string) => !!catalog()?.layers.some((item) => item.id === id)
    const entry = entryOf(section)
    forget(section)
    change(resetBlock(chosen(), current(), { type: section.type, entry }, exists))
  }
  const resetAll = async () => {
    const ok = await confirm({
      title: language.t("operator.agentForm.resetAllTitle"),
      description: language.t("operator.agentForm.resetAllBody"),
      confirm: language.t("operator.agentForm.resetAll"),
      danger: true,
    })
    if (!ok) return
    setCopies({})
    change({})
  }

  // Text added between blocks: the gap is named by the block below it (or the end).
  const END = "@end"
  const groupTypes = () => catalog()?.groups.find((item) => item.id === shown()?.group.id)?.types ?? []
  const places = (gap: string) => {
    const below = gap === END ? undefined : at(gap)
    const index = below ? below.index : sections().length
    const above = index > 0 ? sections()[index - 1] : undefined
    const placed = (section: Block | undefined) =>
      section ? { type: section.type, entry: entryOf(section) } : undefined
    return gapPlaces(chosen(), current(), groupTypes(), placed(above), placed(below?.section))
  }
  const [adding, setAdding] = createStore({ gap: undefined as string | undefined, text: "", type: "" })
  const add = () => {
    const found = places(adding.gap!)
    const place = found.find((item) => item.type === adding.type) ?? found[0]
    if (!place || !adding.text.trim()) return
    change(insertText(chosen(), current(), place, adding.text))
    setAdding({ gap: undefined, text: "", type: "" })
  }

  // The agent's own text goes where the profile's Agent prompt slot puts it; a profile without one doesn't send it.
  const noAgentSlot = () => !!shown() && !!props.prompt.trim() && !sections().some((item) => item.agentPrompt)

  const Gap = (gap: { place: string }) => (
    <Show when={unlocked() && overrideOn() && places(gap.place).length}>
      <li data-slot="operator-sent-gap">
        <Show
          when={adding.gap === gap.place}
          fallback={
            <ButtonV2
              size="small"
              variant="ghost"
              data-testid="prompt-add-text"
              onClick={() => setAdding({ gap: gap.place, text: "", type: places(gap.place)[0]!.type })}
            >
              {language.t("operator.agentForm.addText")}
            </ButtonV2>
          }
        >
          <div data-component="operator-form" role="group" aria-label={language.t("operator.agentForm.addText")}>
            <TextareaV2
              class="operator-editor"
              rows={3}
              aria-label={language.t("operator.agentForm.newText")}
              value={adding.text}
              onInput={(event) => setAdding("text", event.currentTarget.value)}
            />
            <div class="flex flex-wrap items-center gap-2">
              <Show when={places(gap.place).length > 1}>
                <SelectV2<string>
                  appearance="base"
                  aria-label={language.t("operator.agentForm.addTo")}
                  options={places(gap.place).map((item) => item.type)}
                  current={adding.type}
                  label={(type) => names.typeId(catalog(), type)}
                  onSelect={(type) => type && setAdding("type", type)}
                />
              </Show>
              <Show when={places(gap.place).length === 1}>
                <span data-slot="operator-note">
                  {language.t("operator.agentForm.addToType", {
                    type: names.typeId(catalog(), places(gap.place)[0]!.type),
                  })}
                </span>
              </Show>
              <ButtonV2 size="small" variant="contrast" disabled={!adding.text.trim()} onClick={add}>
                {language.t("operator.agentForm.add")}
              </ButtonV2>
              <ButtonV2 size="small" variant="ghost" onClick={() => setAdding({ gap: undefined, text: "" })}>
                {language.t("common.cancel")}
              </ButtonV2>
            </div>
          </div>
        </Show>
      </li>
    </Show>
  )

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
            // The form's override, edits included: the slot editor and the text edits are the same override.
            setting={{
              ...(chosen() ? { profile: chosen()!.id } : {}),
              ...(props.value.override && chosen() ? { override: props.value.override } : {}),
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
        <div class="flex flex-wrap items-center gap-3">
          <span class="inline-flex items-center">
            <CheckboxV2
              label={language.t("operator.agentForm.locked")}
              checked={!unlocked()}
              onChange={(checked: boolean) => {
                setUnlocked(!checked)
                if (checked) setAdding({ gap: undefined, text: "" })
              }}
            />
            <FieldHelp
              field={language.t("operator.agentForm.locked")}
              text={language.t("operator.help.agentFormLock")}
            />
          </span>
          <Show when={overrideOn() && Object.keys(current()).length}>
            <ButtonV2 size="small" variant="ghost" onClick={() => void resetAll()}>
              {language.t("operator.agentForm.resetAll")}
            </ButtonV2>
          </Show>
        </div>
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
                  {language.t("operator.agentForm.thisBlock", { name: found().name })}
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
          <For each={keys()}>
            {(key) => {
              const row = () => at(key)
              return (
                <Show when={row()}>
                  {(found) => {
                    const section = () => found().section
                    const writable = () => unlocked() && editable(section(), overrideOn())
                    const own = () => isLocal(entryOf(section()))
                    const locked = () => !editable(section(), true)
                    return (
                      <>
                        <Gap place={key} />
                        <li
                          data-slot="operator-sent-block"
                          data-testid="prompt-block"
                          data-type={section().type}
                          data-locked={locked() ? "" : undefined}
                          data-agent-prompt={section().agentPrompt ? "" : undefined}
                          data-selected={selected() === key ? "" : undefined}
                          tabIndex={0}
                          onFocusIn={() => setSelected(key)}
                          onClick={() => setSelected(key)}
                        >
                          <span class="flex flex-wrap items-center gap-2">
                            <Tag variant={section().automatic ? "accent" : "neutral"}>{section().typeName}</Tag>
                            <span data-slot="operator-layer-name">{nameOf(section())}</span>
                            <Show when={locked()}>
                              <Tag data-testid="prompt-block-locked">
                                {language.t(
                                  section().automatic
                                    ? "operator.agentForm.automaticLocked"
                                    : "operator.agentForm.perRequestLocked",
                                )}
                              </Tag>
                            </Show>
                            <Show when={own()}>
                              <Tag data-testid="prompt-block-changed">
                                {language.t("operator.agentForm.changedHere")}
                              </Tag>
                              <ButtonV2 size="small" variant="ghost" onClick={() => reset(section())}>
                                {language.t("operator.agentForm.resetBlock")}
                              </ButtonV2>
                            </Show>
                            <Show when={!own() && section().changed}>
                              <Tag>{language.t("operator.profile.changed")}</Tag>
                            </Show>
                            <Show when={writable() && !section().agentPrompt}>
                              <ButtonV2 size="small" variant="ghost" onClick={() => remove(section())}>
                                {language.t("operator.agentForm.removeBlock")}
                              </ButtonV2>
                            </Show>
                            <span data-slot="operator-note">
                              {language.t("operator.prompts.chars", {
                                count: formatCount(textOf(section()).length, language.intl()),
                              })}
                            </span>
                          </span>
                          <Show when={section().agentPrompt && !props.prompt.trim()}>
                            <p data-slot="operator-note">
                              {language.t(
                                section().text
                                  ? "operator.agentForm.agentPromptBase"
                                  : "operator.agentForm.agentPromptNone",
                              )}
                            </p>
                          </Show>
                          <Show
                            when={writable()}
                            fallback={
                              <Show when={textOf(section())}>
                                <pre data-component="operator-code">{textOf(section())}</pre>
                              </Show>
                            }
                          >
                            <TextareaV2
                              class="operator-editor"
                              rows={Math.min(16, Math.max(3, textOf(section()).split("\n").length))}
                              aria-label={language.t("operator.agentForm.blockText", { name: nameOf(section()) })}
                              value={textOf(section())}
                              onInput={(event) => write(section(), event.currentTarget.value)}
                            />
                          </Show>
                        </li>
                      </>
                    )
                  }}
                </Show>
              )
            }}
          </For>
          <Gap place={END} />
        </ol>
      </details>
    </>
  )
}
