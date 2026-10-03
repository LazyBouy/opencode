import { useSearchParams } from "@solidjs/router"

// The project an operator page is narrowed to, kept in the URL (`?dir=`) so it survives reloads and
// can be shared. Undefined means all projects.
export function useOperatorScope() {
  const [params, setParams] = useSearchParams<{ dir?: string }>()
  return {
    directory: () => params.dir || undefined,
    setDirectory: (directory: string | undefined) => setParams({ dir: directory }),
  }
}
