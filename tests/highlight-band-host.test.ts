/**
 * Where a highlight band is painted: on the nearest block that holds the
 * text (its background sits behind its own text), or on an inline element
 * with a background of its own (inline code) that would otherwise cover a
 * band painted further out — never past the highlight's anchor, and never
 * on a box-less display:contents wrapper (the answered cards' anchor).
 * linkedom has no layout, so computed styles come from a stub.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element });
const { paintHost, transparent } = await import("../components/lesson-highlights-painter.ts");

const STYLE: Record<string, { display: string; backgroundColor: string }> = {
	DIV: { display: "block", backgroundColor: "rgba(0, 0, 0, 0)" },
	P: { display: "block", backgroundColor: "rgba(0, 0, 0, 0)" },
	STRONG: { display: "inline", backgroundColor: "rgba(0, 0, 0, 0)" },
	SPAN: { display: "inline", backgroundColor: "rgba(0, 0, 0, 0)" },
	CODE: { display: "inline", backgroundColor: "oklch(0.2 0 0)" },
	SECTION: { display: "block", backgroundColor: "oklch(0.25 0 0)" },
};
const styleOf = (el: Element) => {
	const contents = el.getAttribute("data-contents") !== null;
	const base = STYLE[el.tagName] ?? STYLE.DIV!;
	return { ...base, display: contents ? "contents" : base.display } as unknown as CSSStyleDeclaration;
};
(dom.window.HTMLElement.prototype as unknown as { getClientRects: () => unknown[] }).getClientRects = () => [{}];

function build(html: string) {
	document.body.innerHTML = html;
	return { anchor: document.querySelector("[data-hl-anchor]")!, at: (sel: string) => document.querySelector(sel)! };
}

describe("paintHost", () => {
	it("paints on the paragraph, through inline formatting", () => {
		const { anchor, at } = build('<div data-hl-anchor="t:1"><p id="p">plain <strong id="s">bold</strong></p></div>');
		assert.equal(paintHost(at("#s"), anchor, styleOf), at("#p"));
	});

	it("paints on inline code itself, whose background would cover a band behind it", () => {
		const { anchor, at } = build('<div data-hl-anchor="t:1"><p>use <code id="c">FMath::Cos</code></p></div>');
		assert.equal(paintHost(at("#c"), anchor, styleOf), at("#c"));
	});

	it("skips a box-less wrapper anchor and paints on the card inside it", () => {
		const { anchor, at } = build('<div data-hl-anchor="q:1" data-contents><section id="card"><span id="t">question</span></section></div>');
		assert.equal(paintHost(at("#t"), anchor, styleOf), at("#card"));
	});

	it("never goes past the anchor", () => {
		const { anchor, at } = build('<p id="outer"><span data-hl-anchor="u:1"><span id="t">hi</span></span></p>');
		assert.equal(paintHost(at("#t"), anchor, styleOf), anchor, "the anchor's own box when nothing inside it qualifies");
	});
});

describe("transparent", () => {
	it("knows a see-through background from a color", () => {
		for (const c of ["transparent", "rgba(0, 0, 0, 0)", "oklch(0.2 0 0 / 0)"]) assert.equal(transparent(c), true, c);
		for (const c of ["rgb(250, 204, 0)", "rgba(10, 20, 0, 0.5)", "oklch(0.2 0 0)", "rgb(0, 0, 0)"]) assert.equal(transparent(c), false, c);
	});
});
