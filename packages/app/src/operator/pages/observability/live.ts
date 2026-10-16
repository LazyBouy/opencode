import { createEffect, createSignal, on, onCleanup } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"

// The live tail (observability_spec.md §8.6): on each `operator.telemetry.written`, fetch the rows written after the
// last seq with the current filters (at most once a second): new rows go on top, rows already shown are updated in
// place (a running tool call becomes completed). Scrolled away from the newest row, it pauses itself and counts what
// came ("12 new events — show"); hidden, it pauses and catches up when visible again. At most 1,000 rows are kept.

export const WRITTEN = "operator.telemetry.written"
const MAX = 1000

type Row = { id: string; seq: number }

export function useLiveTail<T extends Row>(input: {
  /** Live on, and a relative range ending now. */
  enabled: () => boolean
  /** The seq of the page shown (live rows come after it). */
  seq: () => number | undefined
  /** What changes the rows shown (filters, range): the live rows start again. */
  key: () => unknown
  fetch: (after: number) => Promise<{ rows: T[]; seq: number }>
  /** The view is at its newest row. */
  atTop: () => boolean
  /** The ids of the page's rows (an update to one changes it in place). */
  shown: () => Iterable<string>
}) {
  const sdk = useServerSDK()
  const [fresh, setFresh] = createSignal<T[]>([])
  const [updates, setUpdates] = createSignal<ReadonlyMap<string, T>>(new Map())
  const [waiting, setWaiting] = createSignal<T[]>([])
  const [hidden, setHidden] = createSignal(typeof document !== "undefined" && document.visibilityState === "hidden")
  let last: number | undefined
  let busy = false
  let again = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastFetch = 0

  createEffect(
    on([input.key, input.seq], ([, seq]) => {
      setFresh([])
      setUpdates(new Map())
      setWaiting([])
      last = seq
    }),
  )

  const apply = (rows: T[]) => {
    const next = new Map(updates())
    const shown = new Set([...fresh().map((row) => row.id), ...input.shown()])
    const added: T[] = []
    for (const row of rows) {
      next.set(row.id, row)
      if (!shown.has(row.id) && !added.some((item) => item.id === row.id)) added.push(row)
    }
    setUpdates(next)
    // Newest on top: rows come oldest first.
    if (added.length) setFresh((list) => [...added.toReversed(), ...list].slice(0, MAX))
  }

  const pull = async () => {
    if (!input.enabled() || hidden() || last === undefined) return
    if (busy) {
      again = true
      return
    }
    busy = true
    lastFetch = Date.now()
    try {
      const page = await input.fetch(last)
      last = page.seq
      if (!page.rows.length) return
      if (input.atTop()) apply(page.rows)
      else
        setWaiting((rows) =>
          [...rows.filter((row) => !page.rows.some((item) => item.id === row.id)), ...page.rows].slice(-MAX),
        )
    } catch {
      // the next write tries again
    } finally {
      busy = false
      if (again) {
        again = false
        schedule()
      }
    }
  }
  const schedule = () => {
    if (timer) return
    timer = setTimeout(
      () => {
        timer = undefined
        void pull()
      },
      Math.max(0, 1000 - (Date.now() - lastFetch)),
    )
  }

  const stop = sdk().event.listen((event) => {
    const type = (event.details as { type?: string } | undefined)?.type
    if (type === WRITTEN) schedule()
  })
  const onVisibility = () => {
    setHidden(document.visibilityState === "hidden")
    if (!hidden()) schedule()
  }
  document.addEventListener("visibilitychange", onVisibility)
  onCleanup(() => {
    stop()
    document.removeEventListener("visibilitychange", onVisibility)
    if (timer) clearTimeout(timer)
  })
  // Back at the top: what waited is shown.
  createEffect(() => {
    if (input.atTop() && waiting().length) show()
  })

  const show = () => {
    const rows = waiting()
    setWaiting([])
    apply(rows)
  }

  return {
    /** The rows to show: what came live on top, then the page, each row as last written. */
    rows: (base: ReadonlyArray<T>) => {
      const known = new Set(fresh().map((row) => row.id))
      const changed = updates()
      return [
        ...fresh().map((row) => changed.get(row.id) ?? row),
        ...base.filter((row) => !known.has(row.id)).map((row) => changed.get(row.id) ?? row),
      ].slice(0, MAX)
    },
    waiting: () => waiting().length,
    paused: () => hidden() || waiting().length > 0,
    hidden,
    show,
  }
}
