"use client";
/**
 * THE SCRATCHPAD: a drawing pad for working things out by hand, filling the
 * right-hand sidebar (scratchpad-host.tsx sizes it; a wider sidebar shows
 * more of the page, nothing is rescaled). Styled from the theme tokens,
 * except the drawing area, which is always #202020.
 *
 * Tools: pen (pressure-sensitive with a pen tablet; Shift held as a stroke
 * starts makes it one straight line in 45° steps), eraser, and outline
 * shapes drawn by dragging (Shift keeps them regular, Alt grows them from
 * the press point). Undo/redo (buttons, Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y) and
 * Clear (asks first; undoable). Each lesson keeps its own drawing in this
 * browser (state.ts).
 *
 * A right-click on the drawing area (a mouse's, or a pen's barrel button)
 * opens the brush menu at the cursor, Photoshop-style: pen or eraser, the
 * size, the color. It stays open while you pick, and closes on Esc, another
 * right-click, or a click outside it (a click on the drawing area then
 * only closes it, never draws).
 *
 * Two stacked canvases: the drawing (pen and eraser draw on it live, and
 * it's redrawn from the model on undo, resize and load) and a preview layer
 * for the shape being dragged.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
	CircleIcon,
	EraserIcon,
	MoveUpRightIcon,
	PencilIcon,
	Redo2Icon,
	SlashIcon,
	SquareIcon,
	Trash2Icon,
	TriangleIcon,
	TriangleRightIcon,
	Undo2Icon,
	XIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { MenuShell } from "@/components/menu-shell";
import {
	addItem,
	constrainShape,
	DEFAULT_COLOR,
	ERASER_SCALE,
	isBlank,
	PAD_BACKGROUND,
	PAD_COLORS,
	PAD_SIZES,
	redo,
	straightPenEnd,
	undo,
	type PadHistory,
	type PadItem,
	type PadSizeName,
	type PadTool,
	type PenPoint,
	type Point,
	type ShapeKind,
} from "./model";
import { drawPenSegment, drawSegment, drawShape, redraw } from "./render";
import { loadDrawing, saveDrawing } from "./state";

const TOOLS: readonly { tool: PadTool; label: string; icon: React.ReactNode }[] = [
	{ tool: "pen", label: "Pen (Shift: straight line, 45° steps)", icon: <PencilIcon className="size-4" /> },
	{ tool: "eraser", label: "Eraser", icon: <EraserIcon className="size-4" /> },
	{ tool: "ellipse", label: "Circle / ellipse (Shift: circle · Alt: from center)", icon: <CircleIcon className="size-4" /> },
	{ tool: "rect", label: "Rectangle (Shift: square · Alt: from center)", icon: <SquareIcon className="size-4" /> },
	{ tool: "triangle", label: "Triangle (Shift: equilateral · Alt: from center)", icon: <TriangleIcon className="size-4" /> },
	// lucide's right triangle has its right angle bottom right; ours is bottom left.
	{ tool: "rightTriangle", label: "Right triangle (Shift: 45° · Alt: from center)", icon: <TriangleRightIcon className="size-4 -scale-x-100" /> },
	{ tool: "line", label: "Line (Shift: 15° steps · Alt: from center)", icon: <SlashIcon className="size-4" /> },
	{ tool: "arrow", label: "Arrow (Shift: 15° steps · Alt: from center)", icon: <MoveUpRightIcon className="size-4" /> },
];
/** The brush menu's tools: the pen and the eraser. */
const BRUSH_TOOLS = TOOLS.filter((t) => t.tool === "pen" || t.tool === "eraser");

const SIZE_NAMES: readonly PadSizeName[] = ["thin", "medium", "thick"];
const sizeLabel = (name: PadSizeName) => `${name[0]!.toUpperCase()}${name.slice(1)}`;

const ICON_BUTTON =
	"flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent";

/** The brush menu's width (w-48): near the right edge it opens leftward. */
const MENU_WIDTH = 192;

/** Tool buttons: the toolbar's, and the brush menu's pen and eraser. */
function ToolButtons({
	tools,
	current,
	onPick,
	testPrefix,
}: {
	tools: typeof TOOLS;
	current: PadTool;
	onPick: (tool: PadTool) => void;
	testPrefix: string;
}) {
	return tools.map(({ tool, label, icon }) => (
		<button
			key={tool}
			type="button"
			role="radio"
			aria-checked={current === tool}
			aria-label={label}
			title={label}
			data-testid={`${testPrefix}-tool-${tool}`}
			onClick={() => onPick(tool)}
			className={cn(ICON_BUTTON, current === tool && "bg-accent text-foreground")}
		>
			{icon}
		</button>
	));
}

function SizeButtons({ current, onPick, testPrefix }: { current: PadSizeName; onPick: (size: PadSizeName) => void; testPrefix: string }) {
	return SIZE_NAMES.map((name) => (
		<button
			key={name}
			type="button"
			role="radio"
			aria-checked={current === name}
			aria-label={sizeLabel(name)}
			title={sizeLabel(name)}
			data-testid={`${testPrefix}-size-${name}`}
			onClick={() => onPick(name)}
			className={cn(ICON_BUTTON, current === name && "bg-accent text-foreground")}
		>
			<span className="rounded-full bg-current" style={{ width: PAD_SIZES[name] + 2, height: PAD_SIZES[name] + 2 }} />
		</button>
	));
}

function ColorSwatches({
	current,
	onPick,
	testPrefix,
	swatchClass,
}: {
	current: string;
	onPick: (color: string) => void;
	testPrefix: string;
	swatchClass: string;
}) {
	return PAD_COLORS.map((c) => (
		<button
			key={c}
			type="button"
			role="radio"
			aria-checked={current === c}
			aria-label={`Color ${c}`}
			title={c}
			data-testid={`${testPrefix}-color-${c.slice(1)}`}
			onClick={() => onPick(c)}
			className={cn(swatchClass, "transition-transform hover:scale-110", current === c && "ring-2 ring-[#378ef0] ring-offset-1 ring-offset-background")}
			style={{ backgroundColor: c }}
		/>
	));
}

/** The brush menu, at the cursor (the highlights menu's anchoring): a
 *  zero-size fixed anchor, and the shared menu shell placed from it, kept on
 *  screen. Opening and closing belong to the panel. */
function BrushMenu({ at, children }: { at: { x: number; y: number }; children: React.ReactNode }) {
	const anchorRef = useRef<HTMLDivElement | null>(null);
	// The shell measures the anchor as it mounts: mount it a render later.
	const [ready, setReady] = useState(false);
	useEffect(() => setReady(true), []);
	const alignRight = at.x + MENU_WIDTH + 8 > window.innerWidth;
	return (
		<>
			{createPortal(
				<div ref={anchorRef} aria-hidden style={{ position: "fixed", left: at.x, top: at.y, width: 0, height: 0, pointerEvents: "none" }} />,
				document.body,
			)}
			{ready && (
				<MenuShell
					anchorRef={anchorRef}
					testid="scratchpad-menu"
					preferredSide="down"
					align={alignRight ? "right" : "left"}
					menuClass="flex w-48 flex-col gap-2 rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-lg"
				>
					{children}
				</MenuShell>
			)}
		</>
	);
}

/** The gesture in progress on the canvas. */
type Gesture =
	| { pointer: number; kind: "stroke"; item: Extract<PadItem, { kind: "stroke" }> }
	| { pointer: number; kind: "erase"; item: Extract<PadItem, { kind: "erase" }> }
	// The pen with Shift held as it started: a straight line, previewed live.
	| { pointer: number; kind: "straight"; color: string; size: number; from: Point; to: Point }
	| { pointer: number; kind: "shape"; shape: ShapeKind; color: string; size: number; from: PenPoint; to: PenPoint };

export function ScratchpadPanel({
	drawingKey,
	onClose,
	takeFocus,
}: {
	drawingKey: string;
	onClose: () => void;
	/** True once, right after the user opens the scratchpad: focus it then
	 *  (so Ctrl+Z reaches it), never on a page load or a lesson switch. */
	takeFocus?: () => boolean;
}) {
	const [history, setHistory] = useState<PadHistory>(() => ({ items: loadDrawing(drawingKey), undone: [] }));
	const historyRef = useRef(history);
	historyRef.current = history;
	const [tool, setTool] = useState<PadTool>("pen");
	const [color, setColor] = useState<string>(DEFAULT_COLOR);
	const [sizeName, setSizeName] = useState<PadSizeName>("medium");
	const [confirmClear, setConfirmClear] = useState(false);
	const [saveFailed, setSaveFailed] = useState(false);

	const panelRef = useRef<HTMLDivElement>(null);
	const areaRef = useRef<HTMLDivElement>(null);
	const baseRef = useRef<HTMLCanvasElement>(null);
	const liveRef = useRef<HTMLCanvasElement>(null);
	const scaleRef = useRef(1);
	const gesture = useRef<Gesture | null>(null);

	// The brush menu (right-click): where it's open, mirrored in a ref so
	// the canvas's handlers see a close at once.
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
	const menuOpen = useRef(false);
	const openMenu = (at: { x: number; y: number }) => {
		menuOpen.current = true;
		setMenu(at);
	};
	/** `refocus`: back to the pad (Ctrl+Z reaches it), unless the press that
	 *  closed it went somewhere else on the page. */
	const closeMenu = useCallback((refocus: boolean) => {
		menuOpen.current = false;
		setMenu(null);
		if (refocus) panelRef.current?.focus({ preventScroll: true });
	}, []);
	useEffect(() => {
		if (!menu) return;
		const inMenu = (target: EventTarget | null) => !!(target as Element | null)?.closest?.('[data-testid="scratchpad-menu"]');
		// A press anywhere else closes it. On the drawing area the canvas's
		// own handler closes it (and swallows the press, so nothing draws).
		const onDown = (e: PointerEvent) => {
			if (inMenu(e.target) || e.target === liveRef.current) return;
			closeMenu(false);
		};
		// A right-click on the menu itself closes it too, without the
		// browser's menu.
		const onContext = (e: MouseEvent) => {
			if (!inMenu(e.target)) return;
			e.preventDefault();
			closeMenu(true);
		};
		window.addEventListener("pointerdown", onDown, true);
		window.addEventListener("contextmenu", onContext, true);
		return () => {
			window.removeEventListener("pointerdown", onDown, true);
			window.removeEventListener("contextmenu", onContext, true);
		};
	}, [menu, closeMenu]);

	useEffect(() => {
		if (takeFocus?.()) panelRef.current?.focus({ preventScroll: true });
		// on mount only: a lesson switch remounts the panel without focusing it
	}, []);

	// ── the drawing: redraw from the model, save on every change ──
	const redrawBase = useCallback(() => {
		const ctx = baseRef.current?.getContext("2d");
		if (ctx) redraw(ctx, historyRef.current.items, scaleRef.current);
	}, []);
	const firstSave = useRef(true);
	useEffect(() => {
		redrawBase();
		if (firstSave.current) {
			firstSave.current = false;
			return;
		}
		setSaveFailed(!saveDrawing(drawingKey, history.items));
	}, [history, drawingKey, redrawBase]);

	// Canvases match the drawing area in device pixels (sharp on hi-DPI).
	useEffect(() => {
		const area = areaRef.current;
		if (!area) return;
		const fit = () => {
			const scale = window.devicePixelRatio || 1;
			scaleRef.current = scale;
			for (const canvas of [baseRef.current, liveRef.current]) {
				if (!canvas) continue;
				canvas.width = Math.max(1, Math.round(area.clientWidth * scale));
				canvas.height = Math.max(1, Math.round(area.clientHeight * scale));
			}
			redrawBase();
		};
		fit();
		const observer = new ResizeObserver(fit);
		observer.observe(area);
		return () => observer.disconnect();
	}, [redrawBase]);

	// ── drawing gestures ──
	const pointIn = (e: { clientX: number; clientY: number; pressure: number; pointerType: string }): PenPoint => {
		const rect = liveRef.current!.getBoundingClientRect();
		const point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
		return e.pointerType === "pen" && e.pressure > 0 ? { ...point, p: e.pressure } : point;
	};
	const withScale = (canvas: HTMLCanvasElement | null, draw: (ctx: CanvasRenderingContext2D) => void) => {
		const ctx = canvas?.getContext("2d");
		if (!ctx) return;
		ctx.setTransform(scaleRef.current, 0, 0, scaleRef.current, 0, 0);
		draw(ctx);
		ctx.globalCompositeOperation = "source-over";
	};
	const clearLive = () => {
		const canvas = liveRef.current;
		const ctx = canvas?.getContext("2d");
		if (canvas && ctx) {
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, canvas.width, canvas.height);
		}
	};

	const onCanvasDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
		if (menuOpen.current) {
			// A press while the brush menu is open only closes it (a right
			// press closes it on its contextmenu, below).
			e.preventDefault();
			if (e.button !== 2) closeMenu(true);
			return;
		}
		// The right button (a mouse's, or a pen's barrel button) never draws:
		// it opens the brush menu (onCanvasContextMenu).
		if (gesture.current || e.button === 2 || (e.pointerType === "mouse" && e.button !== 0)) return;
		panelRef.current?.focus({ preventScroll: true });
		setConfirmClear(false);
		e.currentTarget.setPointerCapture(e.pointerId);
		e.preventDefault();
		const point = pointIn(e);
		const width = PAD_SIZES[sizeName];
		if (tool === "pen" && e.shiftKey) {
			const start = { x: point.x, y: point.y };
			gesture.current = { pointer: e.pointerId, kind: "straight", color, size: width, from: start, to: start };
			withScale(liveRef.current, (ctx) => drawPenSegment(ctx, color, width, start, start));
		} else if (tool === "pen") {
			gesture.current = { pointer: e.pointerId, kind: "stroke", item: { kind: "stroke", color, size: width, points: [point] } };
			withScale(baseRef.current, (ctx) => drawPenSegment(ctx, color, width, point, point));
		} else if (tool === "eraser") {
			const eraser = width * ERASER_SCALE;
			gesture.current = { pointer: e.pointerId, kind: "erase", item: { kind: "erase", size: eraser, points: [{ x: point.x, y: point.y }] } };
			withScale(baseRef.current, (ctx) => drawSegment(ctx, "#000", eraser, point, point, true));
		} else {
			gesture.current = { pointer: e.pointerId, kind: "shape", shape: tool, color, size: width, from: point, to: point };
		}
	};

	const onCanvasMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
		const g = gesture.current;
		if (!g || g.pointer !== e.pointerId) return;
		// Every sample since the last frame: smooth lines from fast pens.
		const samples = typeof e.nativeEvent.getCoalescedEvents === "function" ? e.nativeEvent.getCoalescedEvents() : [];
		const events = samples.length > 0 ? samples : [e.nativeEvent];
		if (g.kind === "straight") {
			// Straight and snapped for the whole stroke, Shift held or not.
			g.to = straightPenEnd(g.from, pointIn(events[events.length - 1]!));
			clearLive();
			withScale(liveRef.current, (ctx) => drawPenSegment(ctx, g.color, g.size, g.from, g.to));
			return;
		}
		if (g.kind === "shape") {
			const last = events[events.length - 1]!;
			g.to = pointIn(last);
			const { from, to } = constrainShape(g.shape, g.from, g.to, e.shiftKey, e.altKey);
			clearLive();
			withScale(liveRef.current, (ctx) => drawShape(ctx, g.shape, g.color, g.size, from, to));
			return;
		}
		// The model first, the paint second: a stroke keeps its points even
		// when the canvas can't draw this frame.
		const points = g.item.points as PenPoint[];
		const segments: [PenPoint, PenPoint][] = [];
		for (const ev of events) {
			const point = pointIn(ev);
			const next = g.kind === "stroke" ? point : { x: point.x, y: point.y };
			segments.push([points[points.length - 1]!, next]);
			points.push(next);
		}
		withScale(baseRef.current, (ctx) => {
			for (const [a, b] of segments) {
				if (g.kind === "stroke") drawPenSegment(ctx, g.item.color, g.item.size, a, b);
				else drawSegment(ctx, "#000", g.item.size, a, b, true);
			}
		});
	};

	const onCanvasUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
		const g = gesture.current;
		if (!g || g.pointer !== e.pointerId) return;
		gesture.current = null;
		if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
		if (g.kind === "straight") {
			clearLive();
			// A click without a drag leaves a dot, as the pen does.
			const points = g.to.x === g.from.x && g.to.y === g.from.y ? [g.from] : [g.from, g.to];
			setHistory((h) => addItem(h, { kind: "stroke", color: g.color, size: g.size, points }));
			return;
		}
		if (g.kind === "shape") {
			clearLive();
			const { from, to } = constrainShape(g.shape, g.from, g.to, e.shiftKey, e.altKey);
			// A click without a drag draws nothing.
			if (Math.hypot(to.x - from.x, to.y - from.y) < 2) return;
			setHistory((h) => addItem(h, { kind: "shape", shape: g.shape, color: g.color, size: g.size, from, to }));
			return;
		}
		setHistory((h) => addItem(h, g.item));
	};

	// Shift or Alt pressed or released mid-drag reshapes the preview at once,
	// not on the next move, so the shape you see is the one you'll get.
	const onModifierChange = (e: React.KeyboardEvent) => {
		const g = gesture.current;
		if (!g || g.kind !== "shape" || (e.key !== "Shift" && e.key !== "Alt")) return;
		const { from, to } = constrainShape(g.shape, g.from, g.to, e.shiftKey, e.altKey);
		clearLive();
		withScale(liveRef.current, (ctx) => drawShape(ctx, g.shape, g.color, g.size, from, to));
	};

	// Right-click: the brush menu at the cursor, or closed if it's open.
	const onCanvasContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
		e.preventDefault();
		if (menuOpen.current) {
			closeMenu(true);
			return;
		}
		if (gesture.current) return;
		setConfirmClear(false);
		openMenu({ x: e.clientX, y: e.clientY });
	};

	const doUndo = () => setHistory((h) => undo(h));
	const doRedo = () => setHistory((h) => redo(h));
	const doClear = () => {
		setConfirmClear(false);
		setHistory((h) => (isBlank(h.items) ? h : addItem(h, { kind: "clear" })));
	};
	const blank = isBlank(history.items);

	const shapeTool = tool !== "pen" && tool !== "eraser";
	const iconButton = ICON_BUTTON;

	return (
		<div
			ref={panelRef}
			tabIndex={-1}
			data-testid="scratchpad"
			data-scratchpad=""
			onKeyDown={(e) => {
				const mod = e.ctrlKey || e.metaKey;
				const key = e.key.toLowerCase();
				// Alt is a shape modifier here: it must not reach the browser
				// or the desktop app, which open their menu bar on Alt.
				if (e.key === "Alt" && shapeTool) e.preventDefault();
				onModifierChange(e);
				// Tab moves between the toolbar's buttons, never out to the
				// page's own Tab handling (it cycles the lesson's text fields).
				if (e.key === "Tab") {
					e.stopPropagation();
					return;
				}
				// Esc closes the brush menu (its keys reach here through the
				// portal), else backs out of the clear confirm, and never
				// reaches the page (where it would stop the tutor's turn). The
				// sidebar stays open until it's toggled.
				if (e.key === "Escape") {
					e.preventDefault();
					e.stopPropagation();
					if (menuOpen.current) closeMenu(true);
					else setConfirmClear(false);
					return;
				}
				if (mod && !e.altKey && (key === "z" || key === "y")) {
					e.preventDefault();
					e.stopPropagation();
					if (key === "y" || e.shiftKey) doRedo();
					else doUndo();
				}
			}}
			onKeyUp={(e) => {
				if (e.key === "Alt" && shapeTool) e.preventDefault();
				onModifierChange(e);
			}}
			className="flex h-full min-w-0 flex-1 flex-col bg-background text-foreground outline-none"
		>
			{/* The top bar's mechanics (top-bar.tsx): 60px, one border line, a
			    window-drag band in the desktop app that clears its window
			    buttons (now over this corner). */}
			<header className="lh-drag lh-wco-gutter flex h-15 shrink-0 select-none items-center gap-1 border-b border-border px-3">
				<span className="font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">Scratchpad</span>
				{saveFailed && (
					<span role="status" className="ml-2 text-xs text-red-500" data-testid="scratchpad-unsaved">
						Not saved: browser storage is full
					</span>
				)}
				<div className="ml-auto flex items-center gap-0.5">
					{confirmClear ? (
						<span className="flex items-center gap-1.5 font-ui text-xs">
							<span className="text-muted-foreground">Clear the drawing?</span>
							<button type="button" data-testid="scratchpad-clear-yes" onClick={doClear} className="rounded-sm px-1.5 py-0.5 text-red-500 hover:bg-accent">
								Clear
							</button>
							<button type="button" onClick={() => setConfirmClear(false)} className="rounded-sm px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
								Keep
							</button>
						</span>
					) : (
						<>
							<button type="button" aria-label="Undo" title="Undo (Ctrl+Z)" data-testid="scratchpad-undo" disabled={history.items.length === 0} onClick={doUndo} className={iconButton}>
								<Undo2Icon className="size-4" />
							</button>
							<button type="button" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" data-testid="scratchpad-redo" disabled={history.undone.length === 0} onClick={doRedo} className={iconButton}>
								<Redo2Icon className="size-4" />
							</button>
							<button type="button" aria-label="Clear" title="Clear the drawing" data-testid="scratchpad-clear" disabled={blank} onClick={() => setConfirmClear(true)} className={iconButton}>
								<Trash2Icon className="size-4" />
							</button>
						</>
					)}
					<button type="button" aria-label="Close the scratchpad" title="Close" data-testid="scratchpad-close" onClick={onClose} className={iconButton}>
						<XIcon className="size-4" />
					</button>
				</div>
			</header>

			<div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border px-2.5 py-2" data-testid="scratchpad-toolbar">
				<div role="radiogroup" aria-label="Tool" className="flex items-center gap-0.5">
					<ToolButtons tools={TOOLS} current={tool} onPick={setTool} testPrefix="scratchpad" />
				</div>
				<div role="radiogroup" aria-label="Size" className="flex items-center gap-0.5 border-l pl-2">
					<SizeButtons current={sizeName} onPick={setSizeName} testPrefix="scratchpad" />
				</div>
				<div role="radiogroup" aria-label="Color" className="flex flex-wrap items-center gap-1 border-l pl-2">
					<ColorSwatches current={color} onPick={setColor} testPrefix="scratchpad" swatchClass="size-5 rounded-[4px]" />
				</div>
			</div>

			<div ref={areaRef} className="relative min-h-0 flex-1" style={{ backgroundColor: PAD_BACKGROUND }} data-testid="scratchpad-area">
				<canvas ref={baseRef} aria-hidden="true" className="pointer-events-none absolute inset-0 size-full" />
				<canvas
					ref={liveRef}
					aria-label="Drawing area"
					data-testid="scratchpad-canvas"
					onPointerDown={onCanvasDown}
					onPointerMove={onCanvasMove}
					onPointerUp={onCanvasUp}
					onPointerCancel={onCanvasUp}
					// A stroke the browser drops without a pointerup ends too,
					// instead of drawing on the next hover.
					onLostPointerCapture={onCanvasUp}
					onContextMenu={onCanvasContextMenu}
					className="absolute inset-0 size-full cursor-crosshair touch-none"
				/>
			</div>

			{menu && (
				<BrushMenu at={menu}>
					<div role="radiogroup" aria-label="Tool" className="flex items-center gap-0.5">
						<ToolButtons tools={BRUSH_TOOLS} current={tool} onPick={setTool} testPrefix="scratchpad-menu" />
					</div>
					<div role="radiogroup" aria-label="Size" className="flex items-center gap-0.5 border-t border-border pt-2">
						<SizeButtons current={sizeName} onPick={setSizeName} testPrefix="scratchpad-menu" />
					</div>
					<div role="radiogroup" aria-label="Color" className="grid grid-cols-5 gap-1.5 border-t border-border pt-2">
						<ColorSwatches current={color} onPick={setColor} testPrefix="scratchpad-menu" swatchClass="size-6 rounded-[5px]" />
					</div>
				</BrushMenu>
			)}
		</div>
	);
}
