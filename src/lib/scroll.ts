/** The scrolling area of the tab with focus; the window itself doesn't scroll, and the desktop app keeps hidden tabs in the DOM. */
export function contentArea(): Element | null {
  const focused = document.querySelector('.tab-pane.is-focused .app-main')
  if (focused?.getClientRects().length) return focused
  for (const el of document.querySelectorAll('.app-main')) if (el.getClientRects().length) return el
  return null
}

export function scrollContentToTop() {
  contentArea()?.scrollTo(0, 0)
}

/** Primer's useConfirm: a dialog of its own, in a React root of its own, that hiding a tab can't reach. */
export function confirmDialogOpen() {
  return [...document.querySelectorAll('[role="alertdialog"]')].some((d) => d.getClientRects().length > 0)
}

/** Like document.getElementById, but two tabs can show the same page and only the visible one counts. */
export function contentElementById(id: string): Element | null {
  return contentArea()?.querySelector(`[id="${CSS.escape(id)}"]`) ?? null
}

/** A file path as the id of its diff. */
export function cssId(path: string) {
  return path.replace(/[^a-zA-Z0-9_-]/g, '_')
}
