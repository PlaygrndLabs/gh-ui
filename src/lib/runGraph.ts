// The lines of a workflow run's job graph, apart from React and the DOM.

export interface GraphNode {
  id: string
  /** The workflow-file jobs this card shows. */
  keys: string[]
}

/**
 * Which cards a line joins, from each job's `needs`. A line that another path already implies is left out, as on
 * github.com: when publish needs both version and build, and build needs version, only build joins publish.
 */
export function graphEdges(cards: GraphNode[], needsOf: (key: string) => string[]): Array<[string, string]> {
  const cardOf = new Map(cards.flatMap((c) => c.keys.map((k) => [k, c.id] as const)))
  const after = new Map<string, Set<string>>(cards.map((c) => [c.id, new Set()]))
  for (const card of cards)
    for (const key of card.keys)
      for (const need of needsOf(key)) {
        const from = cardOf.get(need)
        if (from && from !== card.id) after.get(from)!.add(card.id)
      }
  const reaches = (from: string, to: string, skip: string, seen = new Set<string>()): boolean => {
    for (const next of after.get(from) ?? []) {
      if (next === skip || seen.has(next)) continue
      seen.add(next)
      if (next === to || reaches(next, to, skip, seen)) return true
    }
    return false
  }
  const edges: Array<[string, string]> = []
  for (const [from, nexts] of after)
    for (const to of nexts)
      if (![...nexts].some((via) => via !== to && reaches(via, to, ''))) edges.push([from, to])
  return edges
}
