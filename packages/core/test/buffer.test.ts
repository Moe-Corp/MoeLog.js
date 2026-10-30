import { describe, expect, test } from 'bun:test'
import { RingBuffer } from '../src/buffer.ts'
import { LEVEL, TYPE, type Level, type MoeEvent } from '../src/types.ts'

const ev = (msg: string, level: Level = LEVEL.info): MoeEvent => ({ type: TYPE.log, t: 0, level, msg })
const msgs = (events: MoeEvent[]): string[] => events.map((e) => e.msg)

describe('RingBuffer', () => {
  test('drains in arrival order', () => {
    const b = new RingBuffer(4)
    for (const m of ['a', 'b', 'c']) b.push(ev(m))
    expect(msgs(b.drain())).toEqual(['a', 'b', 'c'])
    expect(b.size).toBe(0)
  })

  test('a partial drain keeps the rest in order', () => {
    const b = new RingBuffer(4)
    for (const m of ['a', 'b', 'c']) b.push(ev(m))
    expect(msgs(b.drain(2))).toEqual(['a', 'b'])
    b.push(ev('d'))
    expect(msgs(b.drain())).toEqual(['c', 'd'])
  })

  test('when full, the oldest event of the lowest severity is the victim', () => {
    const b = new RingBuffer(3)
    b.push(ev('err', LEVEL.error))
    b.push(ev('debug-1', LEVEL.debug))
    b.push(ev('debug-2', LEVEL.debug))
    b.push(ev('warn', LEVEL.warn))
    expect(msgs(b.drain())).toEqual(['err', 'debug-2', 'warn'])
    expect(b.dropped).toBe(1)
  })

  test('low-level noise never displaces an error', () => {
    const b = new RingBuffer(2)
    b.push(ev('err-1', LEVEL.error))
    b.push(ev('err-2', LEVEL.error))
    b.push(ev('debug', LEVEL.debug))
    expect(msgs(b.drain())).toEqual(['err-1', 'err-2'])
    expect(b.dropped).toBe(1)
  })

  test('keeps working across wrap-around', () => {
    const b = new RingBuffer(3)
    for (const m of ['a', 'b', 'c']) b.push(ev(m))
    b.drain(2)
    for (const m of ['d', 'e']) b.push(ev(m))
    b.push(ev('f', LEVEL.error)) // full: the oldest info ('c') goes
    expect(msgs(b.drain())).toEqual(['d', 'e', 'f'])
  })

  test('capacity is at least 1', () => {
    const b = new RingBuffer(0)
    expect(b.capacity).toBe(1)
    b.push(ev('a'))
    expect(b.size).toBe(1)
  })
})
