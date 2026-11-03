/**
 * Which of a list of stacked boxes is being read: the last one whose top has reached the line just below the sticky
 * bars. Before the first reaches it, that's the first; at the very end of the page it's the last, since a short final
 * box can never scroll up that far. `tops` are in document order, so this stays cheap on a pull request with many files.
 */
export function currentIndex(count: number, topAt: (index: number) => number, line: number, atEnd: boolean): number {
  if (count === 0) return -1
  if (atEnd) return count - 1
  let low = 0
  let high = count - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (topAt(middle) <= line) low = middle
    else high = middle - 1
  }
  return low
}
