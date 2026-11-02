/** Sidebar sockets expire using the assertion deadline verified by Connection. */
import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindAccessExpiry } from '../src/ws-access.ts'

function socket() {
  return Object.assign(new EventEmitter(), { terminate: vi.fn() })
}

afterEach(() => { vi.useRealTimers() })

describe('Access socket expiry', () => {
  it('terminates at the verified expiry and clears timers on close', () => {
    vi.useFakeTimers()
    const ws = socket()
    expect(bindAccessExpiry(ws as unknown as WebSocket, Date.now() + 1000)).toBe(true)
    vi.advanceTimersByTime(999)
    expect(ws.terminate).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(ws.terminate).toHaveBeenCalledOnce()
    const closed = socket()
    bindAccessExpiry(closed as unknown as WebSocket, Date.now() + 1000)
    closed.emit('close')
    vi.advanceTimersByTime(1000)
    expect(closed.terminate).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not attach expired sockets or add timers for non-Access requests', () => {
    vi.useFakeTimers()
    const ws = socket()
    expect(bindAccessExpiry(ws as unknown as WebSocket, undefined)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(bindAccessExpiry(ws as unknown as WebSocket, Date.now())).toBe(false)
    expect(ws.terminate).toHaveBeenCalledOnce()
  })
})
