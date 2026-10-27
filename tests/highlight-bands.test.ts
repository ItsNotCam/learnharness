/**
 * Lesson highlight bands: the boxes of a highlighted run (words, and a
 * formula's taller pieces) merge into one smooth band per line, from the
 * leftmost box to the rightmost and as tall as the tallest, and the bands
 * become background layers (topmost first, sized and placed in px).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bandStyle, lineBands } from "../components/highlight-bands.ts";

const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

describe("lineBands", () => {
	it("joins a line's words and math into one band, closing the gaps and evening the height", () => {
		// "Why a line uses" · M · − · 1 (KaTeX pieces: a taller box, a short one, gaps between).
		const bands = lineBands([box(10, 102, 160, 124), box(166, 100, 180, 126), box(186, 108, 198, 118), box(204, 103, 212, 124)]);
		assert.deepEqual(bands, [box(10, 100, 212, 126)]);
	});

	it("keeps lines apart, a wrapped run gives one band per line", () => {
		const bands = lineBands([box(300, 100, 600, 122), box(10, 126, 250, 148), box(260, 126, 400, 148)]);
		assert.deepEqual(bands, [box(300, 100, 600, 122), box(10, 126, 400, 148)]);
	});

	it("lets a tall formula on a line set that line's band height without swallowing its neighbours", () => {
		// A fraction on line 2 reaches a little into the gaps around it.
		const bands = lineBands([box(10, 100, 200, 122), box(10, 140, 100, 162), box(110, 128, 150, 174), box(10, 180, 200, 202)]);
		assert.deepEqual(bands, [box(10, 100, 200, 122), box(10, 128, 150, 174), box(10, 180, 200, 202)]);
	});

	it("drops empty boxes", () => {
		assert.deepEqual(lineBands([box(10, 100, 10, 120), box(20, 100, 60, 100)]), []);
	});
});

describe("bandStyle", () => {
	it("stacks one solid layer per band, topmost first, never repeating", () => {
		const style = bandStyle([
			{ color: "var(--lh-hl-flash)", x: 1.234, y: 0, width: 50, height: 22.5 },
			{ color: "var(--lh-hl-yellow)", x: 0, y: 30, width: 120.004, height: 22 },
		]);
		assert.equal(style.image, "linear-gradient(var(--lh-hl-flash), var(--lh-hl-flash)), linear-gradient(var(--lh-hl-yellow), var(--lh-hl-yellow))");
		assert.equal(style.size, "50px 22.5px, 120px 22px");
		assert.equal(style.position, "1.23px 0px, 0px 30px");
		assert.equal(style.repeat, "no-repeat, no-repeat");
	});
});
