import { describe, expect, it } from 'vitest'
import { currentIndex } from './scrollspy'

describe('currentIndex', () => {
  const tops = [0, 100, 250, 900]
  const at = (line: number, atEnd = false) => currentIndex(tops.length, (i) => tops[i], line, atEnd)
  it('picks the last box that has reached the line', () => {
    expect(at(120)).toBe(1)
    expect(at(250)).toBe(2)
    expect(at(10_000)).toBe(3)
  })
  it('is the first box until anything reaches the line', () => expect(at(-50)).toBe(0))
  it('is the last box at the very end of the page', () => expect(at(120, true)).toBe(3))
  it('has nothing to pick in an empty list', () => expect(currentIndex(0, () => 0, 0, false)).toBe(-1))
})
