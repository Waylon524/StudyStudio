export type PdfOutlineNode = {
  title: string;
  page: number;
  children?: PdfOutlineNode[];
};

export type PdfOutlineFlatEntry = {
  title: string;
  page: number;
  level: number;
};

export type PdfOutlineGenerationState = {
  status: 'idle' | 'generating' | 'ready' | 'failed';
  requestId?: string | null;
  startedAt?: string | null;
  updatedAt?: string | null;
  error?: string | null;
};

export const MAX_OUTLINE_ITEMS: number;
export const MAX_OUTLINE_DEPTH: number;
export const MAX_OUTLINE_TITLE_LENGTH: number;

export function checkedPdfOutline(
  items: unknown,
  options?: { maxPage?: number }
): { items: PdfOutlineNode[]; count: number };

export function countOutlineNodes(items: readonly PdfOutlineNode[] | null | undefined): number;
export function stableOutlineSignature(items: readonly PdfOutlineNode[] | null | undefined): string;
export function entriesToOutlineTree(
  entries: readonly PdfOutlineFlatEntry[] | unknown,
  options?: { maxPage?: number }
): PdfOutlineNode[];
