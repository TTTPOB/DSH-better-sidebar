// @vitest-environment jsdom
/** Phone activation must be a no-op, not a hidden mounted sidebar. Global
 * module CSS may load first, but must not style native host resize handles.
 */
import { readFileSync } from 'node:fs'
import { transform } from 'lightningcss'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/context-types.ts'

// Match the host primitive's module-evaluation browser requirements.
window.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
const { apply } = await import('../src/client/index.tsx')
const { MOBILE_DISABLED_QUERY } = await import('../src/client/mobile-policy.ts')

afterEach(() => {
  vi.restoreAllMocks()
  document.body.removeAttribute('data-dsh-better-sidebar-active')
})

function viewport(width: number, coarse: boolean): void {
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
    expect(query).toBe(MOBILE_DISABLED_QUERY)
    return { matches: width <= 1023 && coarse } as MediaQueryList
  })
}

describe('personal fork mobile policy', () => {
  it.each([390, 767, 1023])('does not touch any client context service at coarse width %i', (width) => {
    viewport(width, true)
    const ctx = new Proxy({}, { get(_target, key) { throw new Error('unexpected client registration: ' + String(key)) } })
    const before = document.body.outerHTML
    apply(ctx as Context)
    expect(document.body.outerHTML).toBe(before)
    expect(document.body.hasAttribute('data-dsh-better-sidebar-active')).toBe(false)
  })

  it.each([[390, false], [1023, false], [1024, true]])('keeps desktop registration at width %i, coarse %s', (width, coarse) => {
    viewport(width, coarse)
    const effects: Array<{ run: () => unknown, label: string }> = []
    const provide = vi.fn()
    const ctx = {
      effect: (run: () => unknown, label: string) => { effects.push({ run, label }) },
      provide,
      locale: {},
      get: vi.fn(),
      inject: vi.fn(() => ({ dispose: vi.fn() })),

      sessions: { list: { subscribe: () => () => {} } },
      modules: { import: vi.fn() },
      slots: { inject: vi.fn() },
    }
    apply(ctx as unknown as Context)
    expect(provide).toHaveBeenCalledWith('betterSidebar', expect.anything())
    expect(effects.map(effect => effect.label)).toEqual(expect.arrayContaining([
      'dsh-better-sidebar: native right-Sidebar registrations',
      'dsh-better-sidebar: bottom-workbench toggle',
      'dsh-better-sidebar: register built-in tabs and viewers',
      'dsh-better-sidebar: IME composition guard',
    ]))
    const off = effects.find(effect => effect.label === 'dsh-better-sidebar: global style scope')!.run() as () => void
    expect(document.body.hasAttribute('data-dsh-better-sidebar-active')).toBe(true)
    off()
    expect(document.body.hasAttribute('data-dsh-better-sidebar-active')).toBe(false)
  })

  it('module CSS does not select native resize handles before activation', () => {
    const source = readFileSync('src/client/sidebar.module.css')
    const { code } = transform({ filename: 'sidebar.module.css', code: source, cssModules: true })
    const style = document.createElement('style')
    style.textContent = code.toString()
    document.head.append(style)
    document.body.innerHTML = '<div data-dockkit-float-resize></div>'
    const handle = document.querySelector('[data-dockkit-float-resize]')!
    const rules = Array.from(style.sheet!.cssRules).filter((rule): rule is CSSStyleRule => 'selectorText' in rule)
    expect(rules.filter(rule => handle.matches(rule.selectorText))).toHaveLength(0)
    document.body.setAttribute('data-dsh-better-sidebar-active', '')
    expect(rules.filter(rule => handle.matches(rule.selectorText)).map(rule => rule.style.zIndex)).toContain('2')
    style.remove()
    document.body.innerHTML = ''
  })
})
