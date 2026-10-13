import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { FieldHelp } from "./field-help"

// A view-only id next to a selector (specs/docs/issues/002): the chosen namespace's or project's unique id, with a
// copy button and an (i). Hovering shows its folder, so same-named ones are told apart.
export function IdChip(props: { label: string; id: string; path?: string; help: string; testid?: string }) {
  const language = useLanguage()
  const copy = () =>
    void navigator.clipboard
      .writeText(props.id)
      .then(() =>
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("operator.ids.copied", { id: props.id }),
        }),
      )
      .catch(() => showToast({ title: language.t("operator.toolPrompt.copyFailed") }))
  return (
    <span
      data-slot="operator-id-chip"
      class="inline-flex items-center gap-1"
      title={props.path}
      data-testid={props.testid}
    >
      <span data-slot="operator-note">{props.label}</span>
      <code>{props.id}</code>
      <button
        type="button"
        data-slot="operator-link"
        aria-label={language.t("operator.ids.copy", { label: props.label })}
        onClick={copy}
      >
        {language.t("operator.ids.copyShort")}
      </button>
      <FieldHelp field={props.label} text={props.help} />
    </span>
  )
}
