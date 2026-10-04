import { Icon } from "@opencode-ai/ui/icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { createMemo, For, Match, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { Field } from "../ui/field"
import { type AgentForm, GENERATED, type Generated, type PromptMode } from "./agent-form-state"
import { usePromptProfile, useProfileNames } from "./profile-data"
import { allowedIn } from "./profile-model"

// The profile option meaning "the project's default, else the global one" (unset). Profile ids are
// slugs, so this cannot collide with one.
const DEFAULT_CHAIN = "@defaults"

// The agent's prompt mode: its profile as it is, the profile plus layers of its own, or a fully
// custom prompt (Purpose and its own prompt, plus the generated sections it picks).
export function PromptModeField(props: {
  form: AgentForm
  set: <K extends keyof AgentForm>(key: K, value: AgentForm[K]) => void
}) {
  const language = useLanguage()
  const names = useProfileNames()
  const data = usePromptProfile()
  const catalog = () => data.query.data
  const [pick, setPick] = createStore({ layer: "", group: "" })

  // The groups of the profile the agent will use: its own, or Default when it follows the defaults.
  const groups = createMemo(() => {
    const loaded = catalog()
    if (!loaded) return []
    const profile = loaded.profiles.find((item) => item.id === (props.form.promptProfile || "default"))
    return (profile?.groups ?? [])
      .map((id) => loaded.groups.find((group) => group.id === id))
      .filter((group) => group !== undefined)
  })
  const layers = createMemo(() => {
    const group = groups().find((item) => item.id === pick.group)
    return (catalog()?.layers ?? []).filter(
      (layer) =>
        layer.origin !== "generated" && layer.origin !== "collection" && (!group || allowedIn(group.type, layer)),
    )
  })

  return (
    <Field
      group
      label={language.t("operator.agentForm.promptMode")}
      hint={language.t(`operator.agentForm.promptModeHint.${props.form.promptMode}`)}
    >
      <div style={{ "max-width": "420px" }}>
        <SegmentedControlV2
          class="segmented-control-v2--full-width"
          value={props.form.promptMode}
          onChange={(value) => value && props.set("promptMode", value as PromptMode)}
        >
          <SegmentedControlItemV2 value="profile">{language.t("operator.prompts.mode.profile")}</SegmentedControlItemV2>
          <SegmentedControlItemV2 value="layers">{language.t("operator.prompts.mode.layers")}</SegmentedControlItemV2>
          <SegmentedControlItemV2 value="custom">{language.t("operator.prompts.mode.custom")}</SegmentedControlItemV2>
        </SegmentedControlV2>
      </div>
      <Switch>
        <Match when={props.form.promptMode !== "custom"}>
          <Field group label={language.t("operator.agentForm.profile")}>
            <SelectV2<string>
              appearance="base"
              options={[DEFAULT_CHAIN, ...(catalog()?.profiles ?? []).map((item) => item.id)]}
              current={props.form.promptProfile || DEFAULT_CHAIN}
              label={(id) => {
                const found = catalog()?.profiles.find((item) => item.id === id)
                return found ? names.profile(found) : language.t("operator.agentForm.defaultProfile")
              }}
              onSelect={(id) => props.set("promptProfile", !id || id === DEFAULT_CHAIN ? "" : id)}
            />
          </Field>
          <Show when={props.form.promptMode === "layers"}>
            <Field
              group
              label={language.t("operator.agentForm.extraLayers")}
              hint={language.t("operator.agentForm.extraLayersHint")}
            >
              <ol data-component="operator-layers" aria-label={language.t("operator.agentForm.extraLayers")}>
                <For each={props.form.promptLayers}>
                  {(item) => (
                    <li data-slot="operator-layer">
                      <span data-slot="operator-layer-open">
                        <span data-slot="operator-layer-name">
                          {(() => {
                            const layer = catalog()?.layers.find((found) => found.id === item.layer)
                            const group = catalog()?.groups.find((found) => found.id === item.group)
                            return `${layer ? names.layer(layer) : item.layer} → ${group ? names.group(group) : item.group}`
                          })()}
                        </span>
                      </span>
                      <IconButtonV2
                        variant="ghost-muted"
                        size="small"
                        aria-label={language.t("operator.profile.removeFrom", { name: item.layer })}
                        icon={<Icon name="close-small" />}
                        onClick={() =>
                          props.set(
                            "promptLayers",
                            props.form.promptLayers.filter((other) => other !== item),
                          )
                        }
                      />
                    </li>
                  )}
                </For>
              </ol>
              <div data-slot="operator-form-row">
                <Field group label={language.t("operator.agentForm.toGroup")}>
                  <SelectV2<string>
                    appearance="base"
                    options={groups().map((group) => group.id)}
                    current={pick.group || undefined}
                    label={(id) => {
                      const group = groups().find((item) => item.id === id)
                      return group ? names.group(group) : id
                    }}
                    onSelect={(id) => setPick({ group: id ?? "", layer: "" })}
                  />
                </Field>
                <Field group label={language.t("operator.agentForm.layer")}>
                  <SelectV2<string>
                    appearance="base"
                    options={layers().map((layer) => layer.id)}
                    current={pick.layer || undefined}
                    label={(id) => {
                      const layer = layers().find((item) => item.id === id)
                      return layer ? `${names.layer(layer)} · ${names.section(layer.section)}` : id
                    }}
                    onSelect={(id) => setPick("layer", id ?? "")}
                  />
                </Field>
              </div>
              <ButtonV2
                size="small"
                variant="outline"
                disabled={!pick.layer || !pick.group}
                onClick={() => {
                  props.set("promptLayers", [...props.form.promptLayers, { layer: pick.layer, group: pick.group }])
                  setPick("layer", "")
                }}
              >
                {language.t("operator.agentForm.addLayer")}
              </ButtonV2>
            </Field>
          </Show>
        </Match>
        <Match when={props.form.promptMode === "custom"}>
          <Field
            group
            label={language.t("operator.agentForm.generated")}
            hint={language.t("operator.agentForm.generatedHint")}
          >
            <div data-slot="operator-scope-list">
              <For each={GENERATED}>
                {(name: Generated) => (
                  <CheckboxV2
                    label={names.layer({ id: `generated.${name}`, name })}
                    checked={props.form.promptGenerated.includes(name)}
                    onChange={(checked: boolean) =>
                      props.set(
                        "promptGenerated",
                        checked
                          ? GENERATED.filter((item) => item === name || props.form.promptGenerated.includes(item))
                          : props.form.promptGenerated.filter((item) => item !== name),
                      )
                    }
                  />
                )}
              </For>
            </div>
          </Field>
        </Match>
      </Switch>
    </Field>
  )
}
