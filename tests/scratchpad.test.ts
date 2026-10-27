/**
 * The scratchpad's pure parts: shape constraints and geometry, pen width,
 * the undo history (clear included), storage round-trips, the per-lesson
 * key, the window state, and what the renderer asks the canvas to do.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	addItem,
	constrainShape,
	drawingKeyForPath,
	EMPTY_HISTORY,
	isBlank,
	PAD_BACKGROUND,
	PAD_COLORS,
	parseDrawing,
	penWidth,
	redo,
	serializeDrawing,
	shapeGeometry,
	undo,
	visibleItems,
	type PadItem,
} from "../components/scratchpad/model.ts";
import { clampSize, MIN_SIZE, parseScratchpadWindow } from "../components/scratchpad/state.ts";
import { drawItem } from "../components/scratchpad/render.ts";
import { KEYBOARD_ACTIONS } from "../src/core/keyboard.ts";

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

describe("the swatch and background", () => {
	it("are the user's pastel set and gray", () => {
		assert.equal(PAD_BACKGROUND, "#202020");
		assert.deepEqual([...PAD_COLORS], ["#ec8080", "#f4b084", "#fae080", "#d6f080", "#96e896", "#80e8c8", "#7fdcef", "#80b0f4", "#a68ef0", "#e690e6"]);
	});
});

describe("shapes", () => {
	const from = { x: 100, y: 100 };

	it("Shift makes circles and squares regular, in the drag's direction", () => {
		assert.deepEqual(constrainShape("ellipse", from, { x: 130, y: 160 }, true), { from, to: { x: 160, y: 160 } });
		assert.deepEqual(constrainShape("rect", from, { x: 40, y: 120 }, true), { from, to: { x: 40, y: 160 } });
		assert.deepEqual(constrainShape("rect", from, { x: 130, y: 160 }, false), { from, to: { x: 130, y: 160 } }, "no Shift: as dragged");
	});

	it("Shift makes the triangle equilateral and the right triangle 45°", () => {
		const eq = constrainShape("triangle", from, { x: 200, y: 150 }, true);
		assert.ok(close(eq.to.y - from.y, (100 * Math.sqrt(3)) / 2));
		const right = constrainShape("rightTriangle", from, { x: 160, y: 130 }, true);
		assert.deepEqual(right.to, { x: 160, y: 160 });
	});

	it("Shift snaps lines and arrows to 15° steps, keeping the length", () => {
		const { to } = constrainShape("line", from, { x: 200, y: 108 }, true);
		assert.ok(close(to.y, 100), "a near-flat line snaps flat");
		assert.ok(close(Math.hypot(to.x - 100, to.y - 100), Math.hypot(100, 8)));
	});

	it("puts the right angle at the bottom left whichever way you drag", () => {
		for (const to of [{ x: 200, y: 200 }, { x: 0, y: 0 }]) {
			const g = shapeGeometry("rightTriangle", from, to, 4);
			assert.equal(g.type, "polygon");
			const pts = (g as { points: { x: number; y: number }[] }).points;
			const left = Math.min(from.x, to.x);
			const bottom = Math.max(from.y, to.y);
			assert.ok(pts.some((p) => p.x === left && p.y === bottom), "a corner at the box's bottom left");
		}
	});

	it("draws an arrow as a shaft plus a two-sided head", () => {
		const g = shapeGeometry("arrow", from, { x: 200, y: 100 }, 4);
		assert.equal(g.type, "polylines");
		const lines = (g as { lines: { x: number; y: number }[][] }).lines;
		assert.equal(lines.length, 2);
		assert.equal(lines[1]!.length, 3);
		assert.ok(lines[1]!.every((p) => p.x <= 200), "the head points back from the tip");
	});

	it("an ellipse spans the drag box", () => {
		assert.deepEqual(shapeGeometry("ellipse", from, { x: 160, y: 140 }, 2), { type: "ellipse", cx: 130, cy: 120, rx: 30, ry: 20 });
	});
});

describe("the pen", () => {
	it("draws the plain width without pressure, and scales with a pen's pressure", () => {
		assert.equal(penWidth(4, undefined), 4);
		assert.ok(penWidth(4, 0.1) < penWidth(4, 0.9));
		assert.ok(penWidth(4, 5) <= 4 * 1.3, "pressure is clamped");
	});
});

describe("the history", () => {
	const stroke = (n: number): PadItem => ({ kind: "stroke", color: "#ec8080", size: 2, points: [{ x: n, y: n }] });

	it("undoes and redoes, and a new action ends the redo trail", () => {
		let h = addItem(addItem(EMPTY_HISTORY, stroke(1)), stroke(2));
		h = undo(h);
		assert.equal(h.items.length, 1);
		assert.equal(h.undone.length, 1);
		h = redo(h);
		assert.equal(h.items.length, 2);
		h = addItem(undo(h), stroke(3));
		assert.deepEqual(h.undone, []);
		assert.equal(undo(EMPTY_HISTORY), EMPTY_HISTORY, "nothing to undo: unchanged");
	});

	it("clear hides everything before it, and undoing it brings it back", () => {
		let h = addItem(addItem(EMPTY_HISTORY, stroke(1)), { kind: "clear" });
		assert.ok(isBlank(h.items));
		h = addItem(h, stroke(2));
		assert.equal(visibleItems(h.items).length, 1);
		h = undo(undo(h));
		assert.equal(visibleItems(h.items).length, 1);
		assert.ok(!isBlank(h.items));
	});
});

describe("storage", () => {
	it("round-trips a drawing at 0.1 px, keeping only what's on screen", () => {
		const items: PadItem[] = [
			{ kind: "stroke", color: "#ec8080", size: 2, points: [{ x: 1.234, y: 5.678 }] },
			{ kind: "clear" },
			{ kind: "stroke", color: "#80b0f4", size: 4, points: [{ x: 10.04, y: 20.06, p: 0.456 }] },
			{ kind: "erase", size: 16, points: [{ x: 3, y: 4 }] },
			{ kind: "shape", shape: "arrow", color: "#96e896", size: 8, from: { x: 0, y: 0 }, to: { x: 9.99, y: 1 } },
		];
		assert.deepEqual(parseDrawing(serializeDrawing(items)), [
			{ kind: "stroke", color: "#80b0f4", size: 4, points: [{ x: 10, y: 20.1, p: 0.46 }] },
			{ kind: "erase", size: 16, points: [{ x: 3, y: 4 }] },
			{ kind: "shape", shape: "arrow", color: "#96e896", size: 8, from: { x: 0, y: 0 }, to: { x: 10, y: 1 } },
		]);
	});

	it("drops anything malformed and never throws", () => {
		assert.deepEqual(parseDrawing(null), []);
		assert.deepEqual(parseDrawing("not json"), []);
		const text = JSON.stringify({
			v: 1,
			items: [
				{ kind: "stroke", color: "red", size: 2, points: [{ x: 1, y: 1 }] },
				{ kind: "stroke", color: "#ec8080", size: 999, points: [{ x: 1, y: 1 }] },
				{ kind: "shape", shape: "star", color: "#ec8080", size: 2, from: { x: 0, y: 0 }, to: { x: 1, y: 1 } },
				{ kind: "erase", size: 8, points: [{ x: "a" }] },
				{ kind: "stroke", color: "#ec8080", size: 2, points: [{ x: 1, y: 1 }] },
			],
		});
		assert.deepEqual(parseDrawing(text), [{ kind: "stroke", color: "#ec8080", size: 2, points: [{ x: 1, y: 1 }] }]);
	});

	it("keys drawings by lesson, everything else shares one", () => {
		assert.equal(drawingKeyForPath("/chat/chat_mvo2s58j_e47d075a"), "chat_mvo2s58j_e47d075a");
		assert.equal(drawingKeyForPath("/chat/chat_1?x=1"), "chat_1");
		assert.equal(drawingKeyForPath("/graph"), "general");
		assert.equal(drawingKeyForPath(null), "general");
	});
});

describe("the window", () => {
	it("reads stored state defensively and keeps the size above the minimum", () => {
		assert.deepEqual(parseScratchpadWindow(null), { open: false, position: null, size: { width: 560, height: 440 } });
		assert.deepEqual(parseScratchpadWindow({ open: true, position: { x: 5, y: 6 }, size: { width: 10, height: 900 } }), {
			open: true,
			position: { x: 5, y: 6 },
			size: { width: MIN_SIZE.width, height: 900 },
		});
	});

	it("never grows past the viewport", () => {
		assert.deepEqual(clampSize({ width: 2000, height: 2000 }, { width: 1000, height: 700 }), { width: 984, height: 684 });
		assert.deepEqual(clampSize({ width: 10, height: 10 }, { width: 1000, height: 700 }), MIN_SIZE);
	});

	it("opens with Alt+P", () => {
		assert.equal(KEYBOARD_ACTIONS.find((a) => a.id === "toggle-scratchpad")?.binding, "alt+p");
	});
});

describe("rendering", () => {
	function fakeCtx() {
		const calls: string[] = [];
		const ctx = new Proxy(
			{ calls, globalCompositeOperation: "source-over" } as Record<string, unknown>,
			{
				get(target, prop) {
					if (prop in target) return target[prop as string];
					return (...args: unknown[]) => void calls.push(`${String(prop)}(${args.length})`);
				},
				set(target, prop, value) {
					target[prop as string] = value;
					if (prop === "globalCompositeOperation") calls.push(`gco=${value}`);
					return true;
				},
			},
		);
		return ctx as unknown as CanvasRenderingContext2D & { calls: string[] };
	}

	it("erases with destination-out and strokes shapes with their geometry", () => {
		const ctx = fakeCtx();
		drawItem(ctx, { kind: "erase", size: 16, points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] });
		assert.ok(ctx.calls.includes("gco=destination-out"));
		const shapes = fakeCtx();
		drawItem(shapes, { kind: "shape", shape: "ellipse", color: "#ec8080", size: 2, from: { x: 0, y: 0 }, to: { x: 10, y: 10 } });
		assert.ok(shapes.calls.includes("ellipse(7)"));
		assert.ok(shapes.calls.includes("stroke(0)"));
	});
});
