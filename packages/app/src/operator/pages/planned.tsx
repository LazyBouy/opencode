import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { EmptyState } from "../ui/empty-state"
import { PageHeader } from "../ui/page-header"
import { useLanguage } from "@/context/language"
import type { OperatorPage } from "../pages"

type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]

// Placeholder for an operator page that is not built yet: it says what the page will do.
export function PlannedPage(props: { page: OperatorPage }) {
  const language = useLanguage()
  return (
    <>
      <PageHeader
        title={language.t(`operator.page.${props.page.id}.title`)}
        description={language.t(`operator.page.${props.page.id}.description`)}
        actions={<Tag>{language.t("operator.planned.badge")}</Tag>}
      />
      <EmptyState
        icon={props.page.icon}
        title={language.t("operator.planned.title")}
        // Built pages (the Dashboard) have no planned text.
        description={language.t(`operator.page.${props.page.id}.planned` as Key)}
      />
    </>
  )
}
