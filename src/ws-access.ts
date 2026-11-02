import type { WebSocket } from 'ws'

/** Bound a sidebar transport to the assertion expiry verified by Connection.
 * Like the host gateway, re-arm long delays instead of overflowing Node timers. */
export function bindAccessExpiry(ws: WebSocket, expiresAt: number | undefined): boolean {
  if (expiresAt === undefined) return true
  let timer: ReturnType<typeof setTimeout>
  const expire = (): void => {
    const remaining = expiresAt - Date.now()
    if (remaining <= 0) { ws.terminate(); return }
    timer = setTimeout(expire, Math.min(remaining, 2_147_483_647))
    timer.unref()
  }
  if (expiresAt <= Date.now()) { ws.terminate(); return false }
  ws.once('close', () => { clearTimeout(timer) })
  expire()
  return true
}
