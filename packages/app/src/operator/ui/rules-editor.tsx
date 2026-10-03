import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { Index } from "solid-js"
import { useLanguage } from "@/context/language"
import type { Action, Rule } from "./rules"

const ACTIONS: Action[] = ["allow", "ask", "deny"]

// Editable list of permission rules. Order matters: the last rule that matches a request decides it.
export function RulesEditor(props: { rules: readonly Rule[]; onChange: (rules: Rule[]) => void }) {
  const language = useLanguage()
  const update = (index: number, change: Partial<Rule>) =>
    props.onChange(props.rules.map((rule, position) => (position === index ? { ...rule, ...change } : rule)))
  const move = (index: number, by: number) => {
    const next = [...props.rules]
    const [item] = next.splice(index, 1)
    next.splice(Math.max(0, Math.min(next.length, index + by)), 0, item)
    props.onChange(next)
  }

  return (
    <div data-component="operator-rules">
      <Index each={props.rules}>
        {(rule, index) => (
          <div data-slot="operator-rule">
            <TextInputV2
              appearance="base"
              value={rule().permission}
              placeholder={language.t("operator.rules.permission")}
              aria-label={language.t("operator.rules.permission")}
              onChange={(event) => update(index, { permission: event.currentTarget.value })}
            />
            <TextInputV2
              appearance="base"
              value={rule().pattern}
              placeholder="*"
              aria-label={language.t("operator.rules.pattern")}
              onChange={(event) => update(index, { pattern: event.currentTarget.value })}
            />
            <SelectV2<Action>
              appearance="base"
              aria-label={language.t("operator.rules.action")}
              options={ACTIONS}
              current={rule().action}
              label={(action) => language.t(`operator.permission.action.${action}`)}
              onSelect={(action) => action && update(index, { action })}
            />
            <IconButtonV2
              variant="ghost-muted"
              size="small"
              aria-label={language.t("operator.rules.up")}
              icon={<Icon name="arrow-up" />}
              disabled={index === 0}
              onClick={() => move(index, -1)}
            />
            <IconButtonV2
              variant="ghost-muted"
              size="small"
              aria-label={language.t("operator.rules.remove")}
              icon={<Icon name="trash" />}
              onClick={() => props.onChange(props.rules.filter((_, position) => position !== index))}
            />
          </div>
        )}
      </Index>
      <div>
        <ButtonV2
          size="small"
          variant="outline"
          onClick={() => props.onChange([...props.rules, { permission: "", pattern: "*", action: "ask" }])}
        >
          {language.t("operator.rules.add")}
        </ButtonV2>
      </div>
    </div>
  )
}
