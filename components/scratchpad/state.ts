/**
 * What the scratchpad remembers, per browser (localStorage): whether it's
 * open, where it sits and how big it is, and one drawing per lesson
 * (model.ts drawingKeyForPath). A convenience, not data: anything unreadable
 * falls back to defaults. Saving a drawing reports failure (a full storage)
 * so the panel can say it wasn't saved.
 */
import { parseDrawing, serializeDrawing, type PadItem } from "./model";

export interface ScratchpadWindow {
	open: boolean;
	/** Top-left corner in px; null = centered. */
	position: { x: number; y: number } | null;
	size: { width: number; height: number };
}

export const DEFAULT_SIZE = { width: 560, height: 440 };
export const MIN_SIZE = { width: 340, height: 280 };
const WINDOW_KEY = "lh:scratchpad";
const DRAWING_PREFIX = "lh:scratchpad:drawing:";

/** Stored window state, keeping only well-formed fields. Pure, for tests. */
export function parseScratchpadWindow(raw: unknown): ScratchpadWindow {
	const fallback: ScratchpadWindow = { open: false, position: null, size: { ...DEFAULT_SIZE } };
	if (typeof raw !== "object" || raw === null) return fallback;
	const r = raw as Record<string, unknown>;
	const pos = r.position as { x?: unknown; y?: unknown } | null | undefined;
	const size = r.size as { width?: unknown; height?: unknown } | null | undefined;
	const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
	return {
		open: r.open === true,
		position: pos && finite(pos.x) && finite(pos.y) ? { x: pos.x, y: pos.y } : null,
		size:
			size && finite(size.width) && finite(size.height)
				? { width: Math.max(MIN_SIZE.width, size.width), height: Math.max(MIN_SIZE.height, size.height) }
				: { ...DEFAULT_SIZE },
	};
}

export function loadScratchpadWindow(): ScratchpadWindow {
	try {
		const text = window.localStorage.getItem(WINDOW_KEY);
		return parseScratchpadWindow(text ? JSON.parse(text) : null);
	} catch {
		return parseScratchpadWindow(null);
	}
}

export function saveScratchpadWindow(patch: Partial<ScratchpadWindow>): void {
	try {
		window.localStorage.setItem(WINDOW_KEY, JSON.stringify({ ...loadScratchpadWindow(), ...patch }));
	} catch {
		// private window or blocked storage: the scratchpad still works
	}
}

export function loadDrawing(key: string): PadItem[] {
	try {
		return parseDrawing(window.localStorage.getItem(DRAWING_PREFIX + key));
	} catch {
		return [];
	}
}

/** Save a lesson's drawing; false when the browser refused (storage full
 *  or blocked). An empty drawing removes its entry. */
export function saveDrawing(key: string, items: readonly PadItem[]): boolean {
	try {
		const text = serializeDrawing(items);
		if (JSON.parse(text).items.length === 0) window.localStorage.removeItem(DRAWING_PREFIX + key);
		else window.localStorage.setItem(DRAWING_PREFIX + key, text);
		return true;
	} catch {
		return false;
	}
}

/** Where the scratchpad goes in the dock's freed right column (the
 *  answer box slid left for it, chat.tsx): the column's full width, its
 *  remembered height, standing on the column's bottom edge and rising above
 *  it like the side chat. Null when the column is too narrow to hold it.
 *  Pure, for tests. */
export function sideColumnSpot(
	column: { left: number; width: number; bottom: number },
	size: { width: number; height: number },
	viewport: { width: number; height: number },
): { position: { x: number; y: number }; size: { width: number; height: number } } | null {
	if (column.width < MIN_SIZE.width) return null;
	const fitted = clampSize({ width: column.width, height: size.height }, viewport);
	return {
		position: { x: Math.round(column.left), y: Math.round(Math.max(8, column.bottom - fitted.height)) },
		size: fitted,
	};
}

/** The window's size kept inside the viewport (with a margin) and above
 *  the minimum. Pure, for tests. */
export function clampSize(
	size: { width: number; height: number },
	viewport: { width: number; height: number },
	margin = 8,
): { width: number; height: number } {
	return {
		width: Math.round(Math.min(Math.max(size.width, MIN_SIZE.width), Math.max(MIN_SIZE.width, viewport.width - margin * 2))),
		height: Math.round(Math.min(Math.max(size.height, MIN_SIZE.height), Math.max(MIN_SIZE.height, viewport.height - margin * 2))),
	};
}
