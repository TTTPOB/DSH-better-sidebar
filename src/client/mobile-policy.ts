/** Match Mobile Workbench, not the sidebar's width-only compact layout. */
export const MOBILE_DISABLED_QUERY = '(max-width: 1023px) and (pointer: coarse)'

/** Decide once per activation; changing device mode requires a page refresh.
 * Never tear down an editor on resize: it may contain an unsaved draft.
 */
export function isMobileSidebarDisabled(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(MOBILE_DISABLED_QUERY).matches
}
