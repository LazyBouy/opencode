import { useNavigate } from "@solidjs/router"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { operatorPages } from "./pages"

// "Go to <page>" entries in the command palette for every operator page.
export function useOperatorCommands() {
  const command = useCommand()
  const language = useLanguage()
  const navigate = useNavigate()
  command.register("operator", () =>
    operatorPages.map((page) => ({
      id: `operator.go.${page.id}`,
      title: language.t("operator.command.go", { page: language.t(`operator.page.${page.id}.title`) }),
      category: language.t("operator.command.category"),
      onSelect: () => navigate(page.path),
    })),
  )
}
