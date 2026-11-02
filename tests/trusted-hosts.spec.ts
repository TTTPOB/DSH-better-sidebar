/** The sidebar must use native Connection admission, never a reconstructed trust list. */
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import { WebSocketServer } from 'ws'
import type { SidebarHttpRequest, SidebarWebRoute, SidebarWebUpgradeRoute } from '../src/context-types.ts'

/** No retired webRuntime service: rc.2 and newer both expose Connection admission. */
function mount(initialRejection: 401 | 403 | undefined = undefined) {
  let rejection = initialRejection
  const connection = {
    admitAsync: vi.fn(async (_request: SidebarHttpRequest) => rejection === undefined ? { peer: {} } : { rejection }),
    accessExpiresAt: vi.fn((): number | undefined => undefined),
  }
  const routes: SidebarWebRoute[] = []
  const upgrades: SidebarWebUpgradeRoute[] = []
  const effects: Array<() => void> = []
  apply({
    connection,
    webServer: {
      register: (route: SidebarWebRoute) => { routes.push(route); return () => {} },
      registerUpgrade: (route: SidebarWebUpgradeRoute) => { upgrades.push(route); return () => {} },
    },
    sessions: { get: () => undefined },
    tools: { register: () => () => {} },
    effect: (fn: () => void | (() => void)) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') effects.push(cleanup)
    },
    inject: () => () => {},
    on: () => () => {},
    get: () => undefined,
  } as never)
  return {
    connection,
    routes,
    upgrades,
    setRejection: (next: 401 | 403 | undefined) => { rejection = next },
    cleanup: () => { for (const cleanup of effects) cleanup() },
  }
}

function request(url: string, headers: SidebarHttpRequest['headers'] = { host: '127.0.0.1:3080' }) {
  let reads = 0
  const req: SidebarHttpRequest = {
    method: 'POST',
    url,
    headers,
    [Symbol.asyncIterator]: async function* () {
      reads += 1
      yield JSON.stringify({ sessionId: 'test-session' })
    },
  }
  return { req, reads: () => reads }
}

function response() {
  const out = { status: 0, body: '' }
  return {
    out,
    res: {
      writeHead: (status: number) => { out.status = status },
      end: (body?: string | Uint8Array) => { out.body += String(body ?? '') },
    } as never,
  }
}

describe('native Connection admission', () => {
  it('waits for asynchronous Access admission on every HTTP route before dispatch', async () => {
    const mounted = mount()
    try {
      for (const route of mounted.routes) {
        let admit!: (value: { peer: object }) => void
        mounted.connection.admitAsync.mockImplementationOnce(() => new Promise(resolve => { admit = resolve }))
        const input = request(route.path)
        input.req.method = 'OPTIONS'
        const { res, out } = response()
        const pending = route.handler(input.req, res)
        expect(out.status).toBe(0)
        expect(input.reads()).toBe(0)
        admit({ peer: {} })
        await pending
        expect(out.status, route.path).toBe(405)
      }
    } finally {
      mounted.cleanup()
    }
  })

  it('waits for asynchronous Access admission before all three WS upgrades', async () => {
    const mounted = mount()
    const upgrade = vi.spyOn(WebSocketServer.prototype, 'handleUpgrade').mockImplementation(() => {})
    try {
      for (const route of mounted.upgrades) {
        let admit!: (value: { peer: object }) => void
        mounted.connection.admitAsync.mockImplementationOnce(() => new Promise(resolve => { admit = resolve }))
        const { req } = request(route.path)
        const socket = { destroy: vi.fn(), end: vi.fn() }
        const pending = route.handler(req, socket, new Uint8Array())
        const count = upgrade.mock.calls.length
        expect(socket.end).not.toHaveBeenCalled()
        admit({ peer: {} })
        await pending
        expect(upgrade).toHaveBeenCalledTimes(count + 1)
        expect(upgrade.mock.calls.at(-1)?.[0]).toBe(req)
      }
    } finally {
      upgrade.mockRestore()
      mounted.cleanup()
    }
  })

  it('accepts the native verdict without webRuntime and preserves the request and method receiver', async () => {
    const mounted = mount()
    try {
      const { req } = request('/sidebar/api/session.cwd', {
        host: 'example.com',
        origin: 'https://example.com',
        cookie: 'native-authenticated-session',
      })
      const { res, out } = response()
      await mounted.routes.find(route => route.path === '/sidebar/api')!.handler(req, res)
      expect(out.status).toBe(200)
      expect(mounted.connection.admitAsync).toHaveBeenCalledExactlyOnceWith(req)
      expect(mounted.connection.admitAsync.mock.contexts[0]).toBe(mounted.connection)
    } finally {
      mounted.cleanup()
    }
  })

  it.each([401, 403] as const)('refuses native %s on every HTTP route and WebSocket before consuming data', async (rejection) => {
    const mounted = mount(rejection)
    try {
      expect(mounted.routes.map(route => route.path)).toEqual([
        '/sidebar/api', '/sidebar/upload', '/sidebar/write', '/sidebar/bundle',
        '/sidebar/archive', '/sidebar/file', '/sidebar/html',
      ])
      expect(mounted.upgrades.map(route => route.path)).toEqual([
        '/sidebar/ws/agent-opens', '/sidebar/ws/fs-watch', '/sidebar/ws/sidechat',
      ])
      for (const route of mounted.routes) {
        const input = request(route.path)
        const { res, out } = response()
        await route.handler(input.req, res)
        expect(out.status, route.path).toBe(rejection)
        expect(input.reads(), route.path).toBe(0)
        expect(mounted.connection.admitAsync).toHaveBeenLastCalledWith(input.req)
      }
      for (const route of mounted.upgrades) {
        const input = request(route.path)
        const socket = { destroy: vi.fn(), end: vi.fn() }
        await route.handler(input.req, socket, new Uint8Array())
        expect(socket.end, route.path).toHaveBeenCalledWith(expect.stringContaining(`HTTP/1.1 ${rejection}`))
        expect(input.reads(), route.path).toBe(0)
        expect(mounted.connection.admitAsync).toHaveBeenLastCalledWith(input.req)
      }
      expect(mounted.connection.admitAsync).toHaveBeenCalledTimes(10)
    } finally {
      mounted.cleanup()
    }
  })

  it('does not admit HTTP or WS when asynchronous verification throws', async () => {
    const mounted = mount()
    const error = new Error('verification unavailable')
    mounted.connection.admitAsync.mockRejectedValue(error)
    try {
      for (const route of mounted.routes) {
        const input = request(route.path)
        const { res, out } = response()
        await expect(route.handler(input.req, res)).rejects.toBe(error)
        expect(out.status).toBe(0)
        expect(input.reads()).toBe(0)
      }
      for (const route of mounted.upgrades) {
        const socket = { destroy: vi.fn(), end: vi.fn() }
        await expect(route.handler(request(route.path).req, socket, new Uint8Array())).rejects.toBe(error)
        expect(mounted.connection.accessExpiresAt).not.toHaveBeenCalled()
      }
    } finally {
      mounted.cleanup()
    }
  })

  it('has no old-host fallback when native admission is missing', async () => {
    const mounted = mount()
    try {
      Reflect.deleteProperty(mounted.connection, 'admitAsync')
      const input = request('/sidebar/api/session.cwd')
      const { res, out } = response()
      await expect(mounted.routes.find(route => route.path === '/sidebar/api')!.handler(input.req, res)).rejects.toThrow(TypeError)
      expect(out.status).toBe(0)
      expect(input.reads()).toBe(0)
    } finally {
      mounted.cleanup()
    }
  })

  it('does not bypass native refusals for former desktop, image, or port exceptions', async () => {
    const mounted = mount(403)
    try {
      for (const headers of [
        { host: '127.0.0.1:3080', origin: 'dsh-app://app' },
        { host: '127.0.0.1:3080', origin: 'http://127.0.0.1' },
        {
          host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image', referer: 'http://127.0.0.1:3080/',
        },
      ]) {
        const { req } = request('/sidebar/file', headers)
        req.method = 'GET'
        const { res, out } = response()
        await mounted.routes.find(route => route.path === '/sidebar/file')!.handler(req, res)
        expect(out.status).toBe(403)
        expect(mounted.connection.admitAsync).toHaveBeenLastCalledWith(req)
        expect(req.headers).toBe(headers)
      }
    } finally {
      mounted.cleanup()
    }
  })

  it('reads native admission on every request, including authentication expiry', async () => {
    const mounted = mount()
    try {
      const route = mounted.routes.find(route => route.path === '/sidebar/api')!
      const { req } = request('/sidebar/api/session.cwd')
      for (const [rejection, expected] of [[undefined, 200], [401, 401], [403, 403], [undefined, 200]] as const) {
        mounted.setRejection(rejection)
        const { res, out } = response()
        await route.handler(req, res)
        expect(out.status).toBe(expected)
      }
      expect(mounted.connection.admitAsync).toHaveBeenCalledTimes(4)
    } finally {
      mounted.cleanup()
    }
  })
})
