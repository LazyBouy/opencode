import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { ErrorBoundary, type ParentProps } from "solid-js"
import { useLanguage } from "@/context/language"
import { UpgradeCheck } from "./settings/working-dir"
import { EmptyState } from "./ui/empty-state"
import "./operator.css"

// Scrolling page frame for every /operator route. A page that fails shows its error here instead of
// taking down the whole app.
export function OperatorShell(props: ParentProps) {
  const language = useLanguage()
  return (
    <div data-component="operator-shell">
      {/* The upgrade's moves wait for a confirmation (global_and_opencode_namespaces_spec.md §12.3). */}
      <UpgradeCheck />
      <div data-slot="operator-shell-content">
        <ErrorBoundary
          fallback={(error: unknown, reset) => (
            <EmptyState
              icon="warning"
              title={language.t("operator.error.title")}
              description={error instanceof Error ? error.message : String(error)}
              action={
                <ButtonV2 variant="outline" onClick={reset}>
                  {language.t("operator.error.retry")}
                </ButtonV2>
              }
            />
          )}
        >
          {props.children}
        </ErrorBoundary>
      </div>
    </div>
  )
}
