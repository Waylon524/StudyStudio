export type DropZone = 'conversation' | 'sources' | 'courseware';
export const DROP_ZONES: readonly DropZone[];
export function resolveDropZone(
  target: EventTarget | null,
  options?: { leftOpen?: boolean; leftTab?: string }
): DropZone;
