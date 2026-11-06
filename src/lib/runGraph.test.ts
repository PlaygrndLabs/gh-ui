import { describe, expect, it } from 'vitest'
import { graphEdges } from './runGraph'

const needs: Record<string, string[]> = { version: [], build: ['version'], publish: ['version', 'build'], cask: ['version', 'publish'] }
const cards = Object.keys(needs).map((k) => ({ id: k, keys: [k] }))

describe('graphEdges', () => {
  it('leaves out lines another path already implies', () => {
    expect(graphEdges(cards, (k) => needs[k])).toEqual([
      ['version', 'build'],
      ['build', 'publish'],
      ['publish', 'cask'],
    ])
  })

  it('joins cards rather than jobs, without a line to itself', () => {
    const shared = [
      { id: 'a', keys: ['a1', 'a2'] },
      { id: 'b', keys: ['b'] },
    ]
    expect(graphEdges(shared, (k) => (k === 'b' ? ['a1', 'a2'] : k === 'a2' ? ['a1'] : []))).toEqual([['a', 'b']])
  })

  it('keeps side-by-side branches and ignores jobs with no card', () => {
    const fan = { a: [], b: ['a', 'gone'], c: ['a'], d: ['b', 'c'] } as Record<string, string[]>
    const nodes = Object.keys(fan).map((k) => ({ id: k, keys: [k] }))
    expect(graphEdges(nodes, (k) => fan[k])).toEqual([
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'd'],
      ['c', 'd'],
    ])
  })
})
