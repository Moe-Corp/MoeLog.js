import type { MoeEvent } from './types.ts'

/**
 * Pre-allocated ring buffer. A hard bound on both memory and per-capture work.
 *
 * Drop policy: when full, the oldest event of the *lowest* severity is
 * sacrificed. A debug log never displaces an error, and an error is never lost
 * because of low-level noise.
 */
export class RingBuffer {
  private items: Array<MoeEvent | undefined>
  private head = 0
  private count = 0
  readonly capacity: number
  dropped = 0

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity | 0)
    this.items = new Array<MoeEvent | undefined>(this.capacity)
  }

  get size(): number {
    return this.count
  }

  push(e: MoeEvent): void {
    if (this.count < this.capacity) {
      this.items[(this.head + this.count) % this.capacity] = e
      this.count++
      return
    }

    // Full: pick a victim. The scan is O(capacity), but it only runs under
    // pressure, and capacity is small by design (tens, not thousands).
    let victim = -1
    let worst = e.level
    for (let i = 0; i < this.capacity; i++) {
      const idx = (this.head + i) % this.capacity
      const lv = this.items[idx]!.level
      if (lv < worst) {
        worst = lv
        victim = idx
      }
    }

    this.dropped++
    if (victim === -1) return // everything stored outranks the newcomer

    // Compact: removing the victim and appending the new event preserves order.
    for (let i = victim; ; ) {
      const next = (i + 1) % this.capacity
      if (next === (this.head + this.count) % this.capacity) {
        this.items[i] = e
        break
      }
      this.items[i] = this.items[next]
      i = next
    }
  }

  /** Empties the buffer and returns the events in arrival order. */
  drain(max = this.count): MoeEvent[] {
    const n = Math.min(max, this.count)
    const out: MoeEvent[] = new Array(n)
    for (let i = 0; i < n; i++) {
      const idx = (this.head + i) % this.capacity
      out[i] = this.items[idx]!
      this.items[idx] = undefined
    }
    this.head = (this.head + n) % this.capacity
    this.count -= n
    return out
  }
}
