// Checking out a pull request in a local clone, as allow-listed git commands (electron/git-policy.cjs).

export interface CheckoutTarget {
  number: number
  /** The head branch, in the pull request's own repository. */
  headRef: string
  fromFork: boolean
}

/**
 * The branch to end up on, and the git commands to get there. A branch in this repository is used as is, tracking the
 * remote; a fork's has no remote here, so it comes down as pr-<number> from the ref GitHub keeps for every pull request.
 * Nothing here can overwrite work: updates only fast-forward, and git refuses a switch that would lose changes.
 */
export function checkoutPlan({ number, headRef, fromFork }: CheckoutTarget, currentBranch: string | null) {
  if (fromFork) {
    const branch = `pr-${number}`
    const ref = `pull/${number}/head`
    // git won't fetch into the branch that's checked out.
    if (currentBranch === branch) return { branch, steps: [['pull', '--ff-only', 'origin', ref]] }
    return { branch, steps: [['fetch', 'origin', `${ref}:${branch}`], ['switch', branch]] }
  }
  return { branch: headRef, steps: [['fetch', 'origin', headRef], ['switch', headRef], ['pull', '--ff-only', 'origin', headRef]] }
}
