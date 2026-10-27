/**
 * LESSON HIGHLIGHTS — the band geometry (fork feature). A highlight is
 * painted as one smooth band per line, behind the text: the band is a
 * background layer on the block that holds the text (lesson-highlights-
 * painter.ts paints it). The CSS Custom Highlight API can't do this: it
 * colors each piece of text on its own, so math (many small pieces in other
 * fonts, spaced by margins rather than text) came out as a patchwork of
 * boxes of different heights with gaps between them.
 *
 * Pure: rects in, bands and CSS strings out.
 */

export interface Box {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/** The boxes of one highlight in one block, merged into one band per line:
 *  from the line's leftmost box to its rightmost, as tall as its tallest
 *  (a formula). A box joins a line when either one's vertical middle falls
 *  inside the other; empty boxes are dropped. Pure. */
export function lineBands(boxes: readonly Box[]): Box[] {
	const sorted = boxes.filter((b) => b.right - b.left > 0.5 && b.bottom - b.top > 0.5).sort((a, b) => a.top - b.top || a.left - b.left);
	const lines: Box[] = [];
	for (const b of sorted) {
		const mid = (b.top + b.bottom) / 2;
		const line = lines.find((l) => (mid >= l.top && mid <= l.bottom) || ((l.top + l.bottom) / 2 >= b.top && (l.top + l.bottom) / 2 <= b.bottom));
		if (!line) {
			lines.push({ ...b });
			continue;
		}
		line.left = Math.min(line.left, b.left);
		line.right = Math.max(line.right, b.right);
		line.top = Math.min(line.top, b.top);
		line.bottom = Math.max(line.bottom, b.bottom);
	}
	return lines;
}

/** One band layer: a solid color at a spot in the host's padding box. */
export interface BandLayer {
	/** A CSS color (a theme token: var(--lh-hl-yellow)). */
	color: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

/** The background declarations that paint `layers` (first = topmost, as
 *  CSS stacks them). Pure. */
export function bandStyle(layers: readonly BandLayer[]): { image: string; size: string; position: string; repeat: string } {
	const px = (n: number) => `${Math.round(n * 100) / 100}px`;
	return {
		image: layers.map((l) => `linear-gradient(${l.color}, ${l.color})`).join(", "),
		size: layers.map((l) => `${px(l.width)} ${px(l.height)}`).join(", "),
		position: layers.map((l) => `${px(l.x)} ${px(l.y)}`).join(", "),
		repeat: layers.map(() => "no-repeat").join(", "),
	};
}
