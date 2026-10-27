/**
 * The scratchpad's drawing pad, interactively (linkedom + act, the
 * calculator's pattern): drawing with the pen and a shape, undo/redo by key,
 * clear with its confirm, per-lesson storage, a failed save, and its ✕ (Esc
 * doesn't close it); the right-click brush menu and Alt-centered shapes.
 * The sidebar around it: scratchpad-sidebar.test.tsx.
 * linkedom has no canvas, so getContext returns a recording stub.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";

const dom = parseHTML("<html><head></head><body></body></html>");
(dom.document as unknown as { oninput: null }).oninput = null;
const store = new Map<string, string>();
let failWrites = false;
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	// The brush menu's shell (menu-shell.tsx) announces itself and re-places
	// on animation frames.
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	CustomEvent: (dom.window as unknown as { CustomEvent: typeof CustomEvent }).CustomEvent,
	HTMLInputElement: (dom.window as unknown as { HTMLInputElement: unknown }).HTMLInputElement,
	HTMLTextAreaElement: (dom.window as unknown as { HTMLTextAreaElement: unknown }).HTMLTextAreaElement,
	ResizeObserver: class {
		observe() {}
		disconnect() {}
	},
});
Object.assign(dom.window, {
	innerWidth: 1280,
	innerHeight: 800,
	devicePixelRatio: 1,
	localStorage: {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => {
			if (failWrites) throw new Error("QuotaExceededError");
			store.set(k, v);
		},
		removeItem: (k: string) => void store.delete(k),
	},
});
// What linkedom lacks: pointer capture, layout boxes, and a 2D context.
const proto = dom.window.HTMLElement.prototype as unknown as Record<string, unknown>;
proto.setPointerCapture = () => {};
proto.releasePointerCapture = () => {};
proto.hasPointerCapture = () => true;
proto.getBoundingClientRect = () => ({ left: 0, top: 0, right: 500, bottom: 300, width: 500, height: 300 });
const paints: string[] = [];
function getContext(this: unknown) {
	return new Proxy({ canvas: this } as Record<string, unknown>, {
		get: (t, p) => (p in t ? t[p as string] : () => void paints.push(String(p))),
		set: (t, p, v) => ((t[p as string] = v), true),
	});
}
proto.getContext = getContext;
// linkedom's own canvas returns no context (it wants node-canvas): override it.
const canvasProto = (dom.window as unknown as { HTMLCanvasElement?: { prototype: Record<string, unknown> } }).HTMLCanvasElement?.prototype;
if (canvasProto) canvasProto.getContext = getContext;

const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const { ScratchpadPanel } = await import("../components/scratchpad/scratchpad-panel.tsx");
const { DEFAULT_COLOR, PAD_COLORS } = await import("../components/scratchpad/model.ts");

const KEY = "lh:scratchpad:drawing:chat_1";
const el = (testId: string) => {
	const found = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
	assert.ok(found, `missing ${testId}`);
	return found;
};
const stored = () => JSON.parse(store.get(KEY) ?? '{"items":[]}').items as { kind: string; shape?: string; points?: unknown[]; from?: unknown; to?: unknown; color?: string }[];

/** A native event with the given fields (linkedom has no PointerEvent). */
function fire(target: HTMLElement, type: string, fields: Record<string, unknown> = {}) {
	const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
	for (const [k, v] of Object.entries(fields)) Object.defineProperty(event, k, { value: v });
	target.dispatchEvent(event);
	return event;
}
async function drag(points: [number, number][], extra: Record<string, unknown> = {}) {
	const canvas = el("scratchpad-canvas");
	const base = { pointerId: 1, pointerType: "mouse", button: 0, pressure: 0.5, shiftKey: false, ...extra };
	await act(async () => {
		const [first, ...rest] = points;
		fire(canvas, "pointerdown", { ...base, clientX: first![0], clientY: first![1] });
		for (const [x, y] of rest) fire(canvas, "pointermove", { ...base, clientX: x, clientY: y });
		const last = points[points.length - 1]!;
		fire(canvas, "pointerup", { ...base, clientX: last[0], clientY: last[1] });
	});
}
async function key(k: string, mods: Record<string, unknown> = {}) {
	await act(async () => fire(el("scratchpad"), "keydown", { key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods }));
}
async function click(testId: string) {
	await act(async () => fire(el(testId), "click"));
}

let root: Root | undefined;
let closed = 0;
async function mount() {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(<ScratchpadPanel drawingKey="chat_1" onClose={() => closed++} />));
}
afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	store.clear();
	closed = 0;
	failWrites = false;
});

describe("ScratchpadPanel", () => {
	it("renders the tools, sizes and the pastel swatch on the gray", () => {
		const html = renderToStaticMarkup(<ScratchpadPanel drawingKey="chat_1" onClose={() => {}} />);
		for (const t of ["pen", "eraser", "ellipse", "rect", "triangle", "rightTriangle", "line", "arrow"]) assert.ok(html.includes(`scratchpad-tool-${t}`), t);
		for (const s of ["thin", "medium", "thick"]) assert.ok(html.includes(`scratchpad-size-${s}`), s);
		for (const c of PAD_COLORS) assert.ok(html.includes(`background-color:${c}`), c);
		assert.match(html, /background-color:#202020/);
		assert.match(html, new RegExp(`aria-checked="true"[^>]*data-testid="scratchpad-color-${DEFAULT_COLOR.slice(1)}"`));
	});

	it("draws a pen stroke and saves it to the lesson", async () => {
		await mount();
		await drag([[10, 10], [20, 20], [30, 25]]);
		const items = stored();
		assert.equal(items.length, 1);
		assert.equal(items[0]!.kind, "stroke");
		assert.equal(items[0]!.points!.length, 3);
		assert.equal(items[0]!.color, DEFAULT_COLOR);
		assert.ok(paints.includes("lineTo"), "the stroke was painted on the canvas");
	});

	it("undoes and redoes with Ctrl+Z and Ctrl+Shift+Z", async () => {
		await mount();
		await drag([[10, 10], [20, 20]]);
		await key("z", { ctrlKey: true });
		assert.equal(store.has(KEY), false, "an empty drawing removes its entry");
		await key("Z", { ctrlKey: true, shiftKey: true });
		assert.equal(stored().length, 1);
		await key("z", { ctrlKey: true });
		await key("y", { ctrlKey: true });
		assert.equal(stored().length, 1, "Ctrl+Y redoes too");
	});

	it("draws a shape by dragging, regular with Shift; a click alone draws nothing", async () => {
		await mount();
		await click("scratchpad-tool-rect");
		await click(`scratchpad-color-${PAD_COLORS[0].slice(1)}`);
		await drag([[100, 100], [130, 160]], { shiftKey: true });
		const [rect] = stored();
		assert.equal(rect!.shape, "rect");
		assert.equal(rect!.color, PAD_COLORS[0]);
		assert.deepEqual(rect!.to, { x: 160, y: 160 }, "Shift: a square");
		await drag([[50, 50], [50, 50]]);
		assert.equal(stored().length, 1);
	});

	it("draws the pen straight in 45° steps when Shift is held as the stroke starts", async () => {
		await mount();
		await drag([[100, 100], [140, 90], [200, 106]], { shiftKey: true });
		const [line] = stored();
		assert.equal(line!.kind, "stroke");
		assert.deepEqual(line!.points, [{ x: 100, y: 100 }, { x: 200, y: 100 }], "one flat line, wobbles dropped");
		await drag([[50, 50], [50, 50]], { shiftKey: true });
		assert.deepEqual(stored()[1]!.points, [{ x: 50, y: 50 }], "a Shift-click leaves a dot");
		await drag([[10, 10], [20, 25], [30, 25]]);
		assert.equal(stored()[2]!.points!.length, 3, "no Shift: freehand");
	});

	it("clears only after the confirm, and the clear undoes", async () => {
		await mount();
		await drag([[10, 10], [20, 20]]);
		await click("scratchpad-clear");
		assert.equal(stored().length, 1, "not yet");
		await key("Escape");
		assert.equal(closed, 0, "Esc first backs out of the confirm");
		await click("scratchpad-clear");
		await click("scratchpad-clear-yes");
		assert.equal(store.has(KEY), false);
		await click("scratchpad-undo");
		assert.equal(stored().length, 1);
	});

	it("opens with the lesson's saved drawing", async () => {
		store.set(KEY, JSON.stringify({ v: 1, items: [{ kind: "stroke", color: "#ec8080", size: 2, points: [{ x: 1, y: 1 }] }] }));
		await mount();
		assert.equal(el("scratchpad-clear").hasAttribute("disabled"), false);
		assert.equal(el("scratchpad-undo").hasAttribute("disabled"), false);
	});

	it("says so when the browser won't save", async () => {
		await mount();
		failWrites = true;
		await drag([[10, 10], [20, 20]]);
		assert.match(el("scratchpad-unsaved").textContent ?? "", /Not saved/);
	});

	it("closes with its ✕, never on Esc", async () => {
		await mount();
		await key("Escape");
		assert.equal(closed, 0);
		await click("scratchpad-close");
		assert.equal(closed, 1);
	});
});

describe("the brush menu (right-click)", () => {
	const menuEl = () => document.querySelector<HTMLElement>('[data-testid="scratchpad-menu"]');
	const inMenu = (testId: string) => {
		const found = menuEl()?.querySelector<HTMLElement>(`[data-testid="scratchpad-menu-${testId}"]`);
		assert.ok(found, `missing menu ${testId}`);
		return found;
	};
	const settle = () => act(async () => new Promise((r) => setTimeout(r, 10)));
	async function rightClick(pointerType = "mouse", x = 120, y = 80) {
		const canvas = el("scratchpad-canvas");
		let menuEvent: Event | undefined;
		await act(async () => {
			fire(canvas, "pointerdown", { pointerId: 1, pointerType, button: 2, pressure: 0.5, shiftKey: false, altKey: false, clientX: x, clientY: y });
			fire(canvas, "pointerup", { pointerId: 1, pointerType, button: 2, pressure: 0, shiftKey: false, altKey: false, clientX: x, clientY: y });
			menuEvent = fire(canvas, "contextmenu", { button: 2, clientX: x, clientY: y });
		});
		await settle(); // the shell mounts a render after its anchor
		return menuEvent!;
	}

	it("opens at a right-click with the pen, eraser, sizes and colors, and draws nothing", async () => {
		await mount();
		const event = await rightClick();
		assert.equal(event.defaultPrevented, true, "no browser menu");
		assert.ok(menuEl(), "open");
		for (const id of ["tool-pen", "tool-eraser", "size-thin", "size-medium", "size-thick"]) inMenu(id);
		assert.equal(menuEl()!.querySelectorAll('[data-testid^="scratchpad-menu-color-"]').length, PAD_COLORS.length);
		assert.equal(menuEl()!.querySelector('[data-testid="scratchpad-menu-tool-ellipse"]'), null, "shapes stay in the toolbar");
		assert.equal(inMenu("tool-pen").getAttribute("aria-checked"), "true");
		assert.equal(store.has(KEY), false, "the right press drew nothing");
	});

	it("stays open while you pick, and the toolbar follows", async () => {
		await mount();
		await rightClick();
		await act(async () => fire(inMenu("tool-eraser"), "click"));
		await act(async () => fire(inMenu("size-thick"), "click"));
		await act(async () => fire(inMenu(`color-${PAD_COLORS[2].slice(1)}`), "click"));
		assert.ok(menuEl(), "still open");
		assert.equal(el("scratchpad-tool-eraser").getAttribute("aria-checked"), "true");
		assert.equal(el("scratchpad-size-thick").getAttribute("aria-checked"), "true");
		assert.equal(el(`scratchpad-color-${PAD_COLORS[2].slice(1)}`).getAttribute("aria-checked"), "true");
		assert.equal(inMenu("tool-eraser").getAttribute("aria-checked"), "true");
	});

	it("closes on Esc, another right-click, or a press outside it", async () => {
		await mount();
		await rightClick();
		await act(async () => fire(menuEl()!, "keydown", { key: "Escape", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }));
		assert.equal(menuEl(), null, "Esc");
		await rightClick();
		await rightClick();
		assert.equal(menuEl(), null, "a second right-click");
		await rightClick();
		await act(async () => fire(document.body, "pointerdown", { pointerId: 1, pointerType: "mouse", button: 0 }));
		assert.equal(menuEl(), null, "a press elsewhere");
	});

	it("a click on the pad while it's open only closes it", async () => {
		await mount();
		await rightClick();
		await drag([[10, 10], [20, 20], [30, 30]]);
		assert.equal(menuEl(), null);
		assert.equal(store.has(KEY), false, "that click didn't draw");
		await drag([[10, 10], [20, 20]]);
		assert.equal(stored().length, 1, "the next one does");
	});

	it("opens from a pen's barrel button, which never draws", async () => {
		await mount();
		await rightClick("pen");
		assert.ok(menuEl());
		assert.equal(store.has(KEY), false);
	});
});

describe("Alt with shapes", () => {
	it("grows the shape from the press point; with Shift it stays regular", async () => {
		await mount();
		await click("scratchpad-tool-ellipse");
		await drag([[100, 100], [130, 160]], { altKey: true });
		assert.deepEqual([stored()[0]!.from, stored()[0]!.to], [{ x: 70, y: 40 }, { x: 130, y: 160 }], "centered on (100, 100)");
		await drag([[100, 100], [130, 160]], { altKey: true, shiftKey: true });
		assert.deepEqual([stored()[1]!.from, stored()[1]!.to], [{ x: 40, y: 40 }, { x: 160, y: 160 }], "a circle about (100, 100)");
	});

	it("extends a line or arrow both ways, the arrowhead at the dragged end", async () => {
		await mount();
		await click("scratchpad-tool-arrow");
		await drag([[100, 100], [150, 120]], { altKey: true });
		assert.deepEqual([stored()[0]!.from, stored()[0]!.to], [{ x: 50, y: 80 }, { x: 150, y: 120 }]);
	});

	it("pressing Alt mid-drag reshapes the preview at once, before the next move", async () => {
		await mount();
		await click("scratchpad-tool-rect");
		const canvas = el("scratchpad-canvas");
		const base = { pointerId: 1, pointerType: "mouse", button: 0, pressure: 0.5, shiftKey: false };
		await act(async () => {
			fire(canvas, "pointerdown", { ...base, altKey: false, clientX: 100, clientY: 100 });
			fire(canvas, "pointermove", { ...base, altKey: false, clientX: 130, clientY: 160 });
		});
		paints.length = 0;
		await act(async () => fire(el("scratchpad"), "keydown", { key: "Alt", ctrlKey: false, metaKey: false, shiftKey: false, altKey: true }));
		assert.ok(paints.includes("clearRect") && paints.includes("stroke"), "redrawn on the key alone");
		await act(async () => fire(canvas, "pointerup", { ...base, altKey: true, clientX: 130, clientY: 160 }));
		assert.deepEqual([stored()[0]!.from, stored()[0]!.to], [{ x: 70, y: 40 }, { x: 130, y: 160 }]);
	});

	it("keeps Alt from reaching the browser while a shape tool is on", async () => {
		await mount();
		const alt = { key: "Alt", ctrlKey: false, metaKey: false, shiftKey: false, altKey: true };
		let down: Event | undefined;
		await act(async () => void (down = fire(el("scratchpad"), "keydown", alt)));
		assert.equal(down!.defaultPrevented, false, "the pen: Alt is left alone");
		await click("scratchpad-tool-rect");
		await act(async () => void (down = fire(el("scratchpad"), "keydown", alt)));
		let up: Event | undefined;
		await act(async () => void (up = fire(el("scratchpad"), "keyup", alt)));
		assert.equal(down!.defaultPrevented, true);
		assert.equal(up!.defaultPrevented, true);
	});
});
