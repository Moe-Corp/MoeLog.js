import type { HookName, Hooks } from './types.ts'

/**
 * The microkernel pipeline. Integrations hook in here; the core knows about
 * none of them. A handler that throws is unregistered instead of breaking the
 * host application.
 */
export class HookBus {
  private handlers: { [K in HookName]: Array<Hooks[K]> } = {
    onCapture: [],
    beforeSend: [],
    onResult: [],
  }

  on<K extends HookName>(hook: K, fn: Hooks[K]): () => void {
    this.handlers[hook].push(fn)
    return () => {
      const arr = this.handlers[hook] as Array<Hooks[K]>
      const i = arr.indexOf(fn)
      if (i >= 0) arr.splice(i, 1)
    }
  }

  /** Filter chain: the first handler returning null drops the event. */
  filter<T>(hook: 'onCapture' | 'beforeSend', value: T): T | null {
    const arr = this.handlers[hook] as unknown as Array<(v: T) => T | null>
    for (let i = 0; i < arr.length; i++) {
      try {
        const next = arr[i]!(value)
        if (next === null) return null
        value = next
      } catch {
        arr.splice(i--, 1) // a broken hook is never retried
      }
    }
    return value
  }

  emitResult(...args: Parameters<Hooks['onResult']>): void {
    for (const fn of this.handlers.onResult) {
      try {
        fn(...args)
      } catch {
        /* silence */
      }
    }
  }

  clear(): void {
    this.handlers.onCapture.length = 0
    this.handlers.beforeSend.length = 0
    this.handlers.onResult.length = 0
  }
}
