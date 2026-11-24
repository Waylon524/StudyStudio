export const DROP_ZONES = Object.freeze(['conversation', 'sources', 'courseware']);

export function resolveDropZone(target, { leftOpen = false, leftTab = 'courseware' } = {}) {
  const element = target && typeof target.closest === 'function'
    ? target
    : target?.parentElement && typeof target.parentElement.closest === 'function'
      ? target.parentElement
      : null;
  if (element) {
    const explicit = element.closest('[data-drop-zone]')?.getAttribute('data-drop-zone');
    if (explicit === 'conversation' || explicit === 'sources' || explicit === 'courseware') {
      return explicit;
    }
    if (leftOpen && element.closest('.studio-left')) {
      return leftTab === 'courseware' ? 'courseware' : 'sources';
    }
  }
  return 'conversation';
}
