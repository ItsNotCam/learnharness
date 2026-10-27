/**
 * LESSON HIGHLIGHTS — the painter (fork feature). Finds each highlight's
 * text in the transcript and paints it as smooth bands behind the text:
 * one band per line (highlight-bands.ts), painted as background layers on
 * the block that holds the text. An element's background always draws
 * behind its own text and above everything behind the element, so bands
 * show in plain lesson text and inside cards alike. The transcript's
 * structure is never touched (React owns it); only the hosts' inline
 * background declarations are set, and restored when their bands go.
 *
 * Re-finding is incremental: a MutationObserver on the transcript root
 * marks the anchor elements whose subtree changed; each animation frame
 * only rebuilds the text maps of dirty anchors that carry highlights. New
 * or replaced anchor elements (a remount after a turn settles, a plan
 * block spliced in) are new map-cache keys, so they rebuild by themselves.
 * The bands are re-measured whenever something can move the text: a
 * re-find, a host or the transcript changing size, fonts loading, or a
 * wide equation scrolled sideways.
 */

import type { HighlightColor, LessonHighlight } from "@/src/core";
import { locateQuote } from "@/src/core";
import {
	anchorElements,
	buildTextMap,
	HL_ANCHOR_ATTR,
	pointInRects,
	rangeSpecs,
	type AnchorTextMap,
	type RangeSpec,
} from "@/components/highlight-dom";
import { bandStyle, lineBands, type BandLayer, type Box } from "@/components/highlight-bands";
import type { HighlightStatus, LessonHighlightsStore } from "@/components/lesson-highlights-store";

/** The band colors: theme tokens (--lh-hl-*, app/globals.css). */
const bandColor = (color: HighlightColor) => `var(--lh-hl-${color})`;
const FLASH_COLOR = "var(--lh-hl-flash)";

/** A live Range over a spec list (for rects and scrolling); null if stale. */
export function liveRange(specs: readonly RangeSpec[]): Range | null {
	if (specs.length === 0) return null;
	const first = specs[0]!;
	const last = specs[specs.length - 1]!;
	if (!first.startContainer.isConnected || !last.endContainer.isConnected) return null;
	try {
		const range = document.createRange();
		range.setStart(first.startContainer, first.startOffset);
		range.setEnd(last.endContainer, last.endOffset);
		return range;
	} catch {
		return null;
	}
}

function paintSignature(list: readonly { id: string; color: HighlightColor }[]): string {
	return list.map((h) => `${h.id}:${h.color}`).join("|");
}

/** What one painted piece (a text run, or a whole formula) occupies, and
 *  the element it starts from (for its band's host). */
function pieceBoxes(spec: RangeSpec): { from: Element; boxes: Box[] } | null {
	const { startContainer, startOffset, endContainer, endOffset } = spec;
	if (!startContainer.isConnected) return null;
	let from: Element | null;
	let rects: Iterable<DOMRect>;
	if (startContainer.nodeType === 3) {
		// A text run inside one text node.
		const range = document.createRange();
		try {
			range.setStart(startContainer, startOffset);
			range.setEnd(endContainer, endOffset);
		} catch {
			return null;
		}
		rects = Array.from(range.getClientRects());
		from = startContainer.parentElement;
	} else {
		// A formula: the element between the boundary points. Its own boxes
		// are one text line tall; its laid-out parts (KaTeX's .base boxes)
		// carry the real height (a fraction's numerator and denominator).
		const el = startContainer.childNodes[startOffset];
		if (!(el instanceof Element)) return null;
		rects = [...Array.from(el.getClientRects()), ...Array.from(el.querySelectorAll(".base"), (b) => b.getBoundingClientRect())];
		from = el;
	}
	if (!from) return null;
	return { from, boxes: Array.from(rects, (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })) };
}

/** A computed color with no alpha: "transparent", rgba(…, 0), or a modern
 *  color with "/ 0" (Tailwind's oklch). An opaque rgb(…, 0) is a color. */
export function transparent(color: string): boolean {
	return color === "transparent" || /^rgba\(.*,\s*0\)$/.test(color) || /\/\s*0\)$/.test(color);
}

/** The element a piece's band is painted on: the nearest ancestor that is
 *  a block-level box, or that has a background of its own (inline code),
 *  which would otherwise cover a band painted further out. Never past the
 *  anchor. */
export function paintHost(from: Element, anchor: Element, styleOf: (el: Element) => CSSStyleDeclaration): HTMLElement | null {
	let last: HTMLElement | null = null;
	for (let el: Element | null = from; el; el = el.parentElement) {
		const cs = styleOf(el);
		if (cs.display !== "contents" && el instanceof HTMLElement) {
			last = el;
			const inline = cs.display === "inline";
			const ownBackground = !transparent(cs.backgroundColor);
			// An inline host must be one box (a background on a wrapped
			// inline is laid out across its pieces).
			if (!inline || (ownBackground && el.getClientRects().length === 1)) return el;
		}
		if (el === anchor) break;
	}
	return last;
}

interface Resolved {
	element: Element;
	map: AnchorTextMap;
	specs: RangeSpec[];
}

/** A host's inline background declarations before it was first painted. */
interface SavedBackground {
	image: string;
	size: string;
	position: string;
	repeat: string;
	signature: string;
}

export class LessonHighlightsPainter {
	private readonly root: HTMLElement;
	private readonly store: LessonHighlightsStore;
	private readonly observer: MutationObserver;
	private readonly resizer: ResizeObserver | null;
	private readonly themeObserver: MutationObserver | null;
	private rootWidth = -1;
	private readonly unsubscribe: () => void;
	private maps = new WeakMap<Element, AnchorTextMap>();
	private resolved = new Map<string, Resolved>();
	/** Painted hosts, with what to restore when their bands go. */
	private hosts = new Map<HTMLElement, SavedBackground>();
	private raf = 0;
	private timer = 0;
	private layoutRaf = 0;
	private flashTimer = 0;
	private flashId: string | null = null;
	private lastList: unknown = null;
	/** Ids + colors last painted: note edits change neither, so they never repaint. */
	private paintedSig = "";
	/** Anchor keys that carry highlights (mutations elsewhere inside an
	 *  anchor — a streaming reply — need no re-find). */
	private highlighted = new Set<string>();
	private destroyed = false;

	constructor(root: HTMLElement, store: LessonHighlightsStore) {
		this.root = root;
		this.store = store;
		this.observer = new MutationObserver((records) => {
			let relevant = false;
			for (const r of records) {
				const target = r.target.nodeType === 1 ? (r.target as Element) : r.target.parentElement;
				const anchor = target?.closest(`[${HL_ANCHOR_ATTR}]`);
				if (anchor) {
					this.maps.delete(anchor);
					if (this.highlighted.has(anchor.getAttribute(HL_ANCHOR_ATTR) ?? "")) relevant = true;
				} else {
					// Outside every anchor: anchors may have been added, removed or
					// replaced (a remount) — re-find.
					relevant = true;
				}
			}
			if (relevant) this.schedule();
		});
		this.observer.observe(root, { childList: true, characterData: true, subtree: true });
		// Text moves inside its block when the block (or the transcript)
		// changes size: a window or sidebar resize, a theme's font, a figure
		// loading. Bands are background positions, so they're re-measured.
		this.resizer =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver((entries) => {
						// The transcript grows taller with every streamed token; only
						// its width moves text inside the blocks.
						const moved = entries.some((entry) => {
							if (entry.target !== root) return true;
							const width = entry.contentRect.width;
							const changed = width !== this.rootWidth;
							this.rootWidth = width;
							return changed;
						});
						if (moved) this.scheduleLayout();
					});
		this.resizer?.observe(root);
		document.fonts?.addEventListener?.("loadingdone", this.onFonts);
		root.addEventListener("scroll", this.onScroll, true);
		// A theme or an appearance setting (font, size, weight) can move text
		// without resizing its block: they change <html>'s class and style.
		this.themeObserver = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => this.scheduleLayout());
		this.themeObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
		this.unsubscribe = store.subscribe(() => {
			if (store.getSnapshot().list !== this.lastList) this.schedule();
		});
		this.schedule();
	}

	private readonly onFonts = () => this.scheduleLayout();

	/** A wide equation scrolled sideways moves its text, not its block. */
	private readonly onScroll = (e: Event) => {
		const target = e.target;
		if (target instanceof HTMLElement && target !== this.root && this.hosts.has(target)) this.scheduleLayout();
	};

	destroy(): void {
		this.destroyed = true;
		cancelAnimationFrame(this.raf);
		cancelAnimationFrame(this.layoutRaf);
		window.clearTimeout(this.timer);
		window.clearTimeout(this.flashTimer);
		this.observer.disconnect();
		this.resizer?.disconnect();
		this.themeObserver?.disconnect();
		document.fonts?.removeEventListener?.("loadingdone", this.onFonts);
		this.root.removeEventListener("scroll", this.onScroll, true);
		this.unsubscribe();
		this.applyBands(new Map());
	}

	/** One batched run per frame — with a timer fallback, because hidden
	 *  and background tabs pause animation frames entirely. */
	private schedule(): void {
		if (this.destroyed || this.raf || this.timer) return;
		const go = () => {
			cancelAnimationFrame(this.raf);
			window.clearTimeout(this.timer);
			this.raf = 0;
			this.timer = 0;
			this.run();
		};
		this.raf = requestAnimationFrame(go);
		this.timer = window.setTimeout(go, 250);
	}

	/** Re-measure the bands on the next frame (text moved, nothing re-found). */
	private scheduleLayout(): void {
		if (this.destroyed || this.layoutRaf) return;
		this.layoutRaf = requestAnimationFrame(() => {
			this.layoutRaf = 0;
			this.layout();
		});
	}

	/** Re-find every highlight and repaint if anything moved. */
	run(): void {
		if (this.destroyed) return;
		const list = this.store.getSnapshot().list;
		this.lastList = list;
		this.highlighted = new Set(list.map((h) => h.anchor));
		if (list.length === 0) {
			// Nothing to find: skip the transcript scan.
			if (this.resolved.size > 0 || this.paintedSig) {
				this.resolved = new Map();
				this.paint(list);
			}
			this.store.setStatus(new Map());
			return;
		}
		const anchors = anchorElements(this.root);
		const next = new Map<string, Resolved>();
		const status = new Map<string, HighlightStatus>();
		for (const h of list) {
			const element = anchors.get(h.anchor);
			if (!element) {
				status.set(h.id, "orphan");
				continue;
			}
			let map = this.maps.get(element);
			if (!map) {
				map = buildTextMap(element);
				this.maps.set(element, map);
			}
			const prev = this.resolved.get(h.id);
			if (prev && prev.element === element && prev.map === map && prev.specs.length > 0) {
				// Unchanged anchor, unchanged map: the old resolution stands
				// unless the quote itself changed (it never does after creation).
				next.set(h.id, prev);
				status.set(h.id, "found");
				continue;
			}
			const at = locateQuote(map.text, h.quote);
			const specs = at ? rangeSpecs(map, at.start, at.end) : [];
			if (specs.length === 0) {
				status.set(h.id, "orphan");
				continue;
			}
			next.set(h.id, { element, map, specs });
			status.set(h.id, "found");
		}
		// Reused resolutions keep their identity, so "changed" is exact.
		const changed = next.size !== this.resolved.size || [...next].some(([id, r]) => this.resolved.get(id) !== r);
		this.resolved = next;
		// Recolors move no text but need a repaint; note edits need neither.
		if (changed || paintSignature(list) !== this.paintedSig) this.paint(list);
		this.store.setStatus(status);
	}

	private paint(list: readonly { id: string; color: HighlightColor }[]): void {
		this.paintedSig = paintSignature(list);
		this.layout();
	}

	/** Measure every found highlight and paint its bands on their hosts. */
	private layout(): void {
		if (this.destroyed) return;
		const styles = new Map<Element, CSSStyleDeclaration>();
		const styleOf = (el: Element) => {
			let cs = styles.get(el);
			if (!cs) {
				cs = getComputedStyle(el);
				styles.set(el, cs);
			}
			return cs;
		};
		// Bottom layer first; reversed below (CSS lists the topmost first).
		const layers = new Map<HTMLElement, BandLayer[]>();
		for (const h of this.store.getSnapshot().list) {
			const r = this.resolved.get(h.id);
			if (!r) continue;
			const byHost = new Map<HTMLElement, Box[]>();
			for (const spec of r.specs) {
				const piece = pieceBoxes(spec);
				const host = piece && paintHost(piece.from, r.element, styleOf);
				if (!piece || !host) continue;
				const boxes = byHost.get(host);
				if (boxes) boxes.push(...piece.boxes);
				else byHost.set(host, [...piece.boxes]);
			}
			const colors = this.flashId === h.id ? [bandColor(h.color), FLASH_COLOR] : [bandColor(h.color)];
			for (const [host, boxes] of byHost) {
				const at = host.getBoundingClientRect();
				// Background positions count from the padding box.
				const originX = at.left + host.clientLeft;
				const originY = at.top + host.clientTop;
				const list = layers.get(host) ?? [];
				for (const band of lineBands(boxes)) {
					for (const color of colors) {
						list.push({ color, x: band.left - originX, y: band.top - originY, width: band.right - band.left, height: band.bottom - band.top });
					}
				}
				if (list.length > 0) layers.set(host, list);
			}
		}
		this.applyBands(layers);
	}

	/** Paint each host's layers; restore hosts that no longer have any.
	 *  Writes only what changed (Session Find watches style changes). */
	private applyBands(layers: ReadonlyMap<HTMLElement, BandLayer[]>): void {
		for (const [host, saved] of this.hosts) {
			if (layers.has(host)) continue;
			host.style.backgroundImage = saved.image;
			host.style.backgroundSize = saved.size;
			host.style.backgroundPosition = saved.position;
			host.style.backgroundRepeat = saved.repeat;
			this.hosts.delete(host);
			this.resizer?.unobserve(host);
		}
		for (const [host, list] of layers) {
			const style = bandStyle([...list].reverse());
			const signature = `${style.image}|${style.size}|${style.position}`;
			let saved = this.hosts.get(host);
			if (saved?.signature === signature) continue;
			if (!saved) {
				saved = {
					image: host.style.backgroundImage,
					size: host.style.backgroundSize,
					position: host.style.backgroundPosition,
					repeat: host.style.backgroundRepeat,
					signature,
				};
				this.hosts.set(host, saved);
				this.resizer?.observe(host);
			}
			saved.signature = signature;
			host.style.backgroundImage = style.image;
			host.style.backgroundSize = style.size;
			host.style.backgroundPosition = style.position;
			host.style.backgroundRepeat = style.repeat;
		}
	}

	/** The painted pieces of one highlight (empty = not found). */
	specsOf(id: string): RangeSpec[] {
		return this.resolved.get(id)?.specs ?? [];
	}

	/** Highlights under a viewport point, newest first (overlaps: the
	 *  newest acts). With the event target, only highlights in the
	 *  target's own anchor are measured. */
	hitTest(x: number, y: number, target?: Node | null): string[] {
		const el = target ? (target.nodeType === 1 ? (target as Element) : target.parentElement) : null;
		const anchor = el ? el.closest(`[${HL_ANCHOR_ATTR}]`) : undefined;
		if (target && !anchor) return []; // not inside any highlightable text
		const hits: LessonHighlight[] = [];
		for (const h of this.store.getSnapshot().list) {
			const r = this.resolved.get(h.id);
			if (!r || (anchor && r.element !== anchor)) continue;
			// The bands as painted: a click between a word and a formula is on it.
			const boxes = r.specs.flatMap((spec) => pieceBoxes(spec)?.boxes ?? []);
			if (pointInRects(lineBands(boxes), x, y, 1)) hits.push(h);
		}
		return hits.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((h) => h.id);
	}

	/** Briefly emphasize one highlight (after a jump). */
	flash(id: string, ms = 1500): void {
		this.flashId = id;
		this.layout();
		window.clearTimeout(this.flashTimer);
		this.flashTimer = window.setTimeout(() => {
			this.flashId = null;
			this.layout();
		}, ms);
	}
}
