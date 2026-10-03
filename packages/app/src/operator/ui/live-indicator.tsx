import { useLanguage } from "@/context/language"

export function LiveIndicator(props: { live: boolean }) {
  const language = useLanguage()
  return (
    <span data-component="operator-live" data-live={props.live ? "" : undefined} role="status">
      <span data-slot="operator-live-dot" aria-hidden="true" />
      {props.live ? language.t("operator.live.on") : language.t("operator.live.off")}
    </span>
  )
}
