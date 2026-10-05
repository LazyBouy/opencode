import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import type { OperatorNamespaceSummary } from "@opencode-ai/sdk/v2/client"
import { createSignal, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { useOperatorClient } from "../data"
import { requestError } from "../pages/config-helpers"

// "Copy to namespace…": copies an item, with what it uses that the target lacks, to another
// namespace, and lists what was copied.
export function CopyToNamespace(props: {
  ns: string
  kind: "type" | "layer" | "group" | "profile"
  id: string
  namespaces: ReadonlyArray<OperatorNamespaceSummary>
  onCopied?: () => void
}) {
  const language = useLanguage()
  const api = useOperatorClient()
  const [open, setOpen] = createSignal(false)
  const [target, setTarget] = createSignal<string>()
  const others = () => props.namespaces.filter((item) => item.namespace.id !== props.ns)

  const copy = async () => {
    const chosen = target()
    if (!chosen) return
    await api
      .client()
      .operator.namespace.copy({ ns: props.ns, kind: props.kind, id: props.id, target: chosen })
      .then((result) => {
        const copied = result.data?.copied ?? []
        showToast({
          title: language.t("operator.profile.copied", {
            namespace: others().find((item) => item.namespace.id === chosen)?.namespace.name ?? chosen,
          }),
          description: copied.map((item) => item.name).join(", ") || language.t("operator.profile.copiedNothing"),
        })
        setOpen(false)
        props.onCopied?.()
      })
      .catch((error: unknown) =>
        showToast({ title: language.t("operator.profile.saveFailed"), description: requestError(error) }),
      )
  }

  return (
    <Show
      when={open()}
      fallback={
        <ButtonV2 variant="neutral" disabled={others().length === 0} onClick={() => setOpen(true)}>
          {language.t("operator.profile.copyTo")}
        </ButtonV2>
      }
    >
      <span class="flex items-center gap-2" role="group" aria-label={language.t("operator.profile.copyTo")}>
        <SelectV2<OperatorNamespaceSummary>
          appearance="base"
          aria-label={language.t("operator.profile.targetNamespace")}
          placeholder={language.t("operator.profile.targetNamespace")}
          options={others()}
          current={others().find((item) => item.namespace.id === target())}
          value={(item) => item.namespace.id}
          label={(item) => item.namespace.name}
          onSelect={(item) => setTarget(item?.namespace.id)}
        />
        <ButtonV2 variant="contrast" disabled={!target()} onClick={() => void copy()}>
          {language.t("operator.profile.copy")}
        </ButtonV2>
        <ButtonV2 variant="neutral" onClick={() => setOpen(false)}>
          {language.t("common.cancel")}
        </ButtonV2>
      </span>
    </Show>
  )
}
