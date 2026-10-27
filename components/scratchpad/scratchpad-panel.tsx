"use client";
/**
 * THE FLOATING SCRATCHPAD: a drawing window for working things out by hand.
 * Dragged by its title bar, resized from its bottom-right corner (a bigger
 * window shows more of the page; nothing is rescaled), and styled from the
 * theme tokens, except the drawing area, which is always #202020.
 *
 * Tools: pen (pressure-sensitive with a pen tablet), eraser, and outline
 * shapes drawn by dragging (Shift keeps them regular). Undo/redo (buttons,
 * Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y) and Clear (asks first; undoable). Each
 * lesson keeps its own drawing in this browser (state.ts); Esc closes.
 *
 * Two stacked canvases: the drawing (pen and eraser draw on it live, and
 * it's redrawn from the model on undo, resize and load) and a preview layer
 * for the shape being dragged.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { clampPosition } from "../calculator/state";
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
	undo,
	type PadHistory,
	type PadItem,
	type PadSizeName,
	type PadTool,
	type PenPoint,
	type ShapeKind,
} from "./model";
import { drawPenSegment, drawSegment, drawShape, redraw } from "./render";
import { clampSize, loadDrawing, loadScratchpadWindow, saveDrawing, saveScratchpadWindow } from "./state";

const TOOLS: readonly { tool: PadTool; label: string; icon: React.ReactNode }[] = [
	{ tool: "pen", label: "Pen", icon: <PencilIcon className="size-4" /> },
	{ tool: "eraser", label: "Eraser", icon: <EraserIcon className="size-4" /> },
	{ tool: "ellipse", label: "Circle / ellipse (Shift: circle)", icon: <CircleIcon className="size-4" /> },
	{ tool: "rect", label: "Rectangle (Shift: square)", icon: <SquareIcon className="size-4" /> },
	{ tool: "triangle", label: "Triangle (Shift: equilateral)", icon: <TriangleIcon className="size-4" /> },
	// lucide's right triangle has its right angle bottom right; ours is bottom left.
	{ tool: "rightTriangle", label: "Right triangle (Shift: 45°)", icon: <TriangleRightIcon className="size-4 -scale-x-100" /> },
	{ tool: "line", label: "Line (Shift: 15° steps)", icon: <SlashIcon className="size-4" /> },
	{ tool: "arrow", label: "Arrow (Shift: 15° steps)", icon: <MoveUpRightIcon className="size-4" /> },
];

const SIZE_NAMES: readonly PadSizeName[] = ["thin", "medium", "thick"];

/** The gesture in progress on the canvas. */
type Gesture =
	| { pointer: number; kind: "stroke"; item: Extract<PadItem, { kind: "stroke" }> }
	| { pointer: number; kind: "erase"; item: Extract<PadItem, { kind: "erase" }> }
	| { pointer: number; kind: "shape"; shape: ShapeKind; color: string; size: number; from: PenPoint; to: PenPoint };

export function ScratchpadPanel({ drawingKey, onClose }: { drawingKey: string; onClose: () => void }) {
	const initialWindow = useMemo(() => loadScratchpadWindow(), []);
	const [history, setHistory] = useState<PadHistory>(() => ({ items: loadDrawing(drawingKey), undone: [] }));
	const historyRef = useRef(history);
	historyRef.current = history;
	const [tool, setTool] = useState<PadTool>("pen");
	const [color, setColor] = useState<string>(DEFAULT_COLOR);
	const [sizeName, setSizeName] = useState<PadSizeName>("medium");
	const [confirmClear, setConfirmClear] = useState(false);
	const [saveFailed, setSaveFailed] = useState(false);

	const [position, setPositionState] = useState(initialWindow.position);
	const positionRef = useRef(initialWindow.position);
	const setPosition = (next: { x: number; y: number }) => {
		positionRef.current = next;
		setPositionState(next);
	};
	const [size, setSizeState] = useState(initialWindow.size);
	const sizeRef = useRef(initialWindow.size);
	const setSize = (next: { width: number; height: number }) => {
		sizeRef.current = next;
		setSizeState(next);
	};

	const panelRef = useRef<HTMLDivElement>(null);
	const areaRef = useRef<HTMLDivElement>(null);
	const baseRef = useRef<HTMLCanvasElement>(null);
	const liveRef = useRef<HTMLCanvasElement>(null);
	const scaleRef = useRef(1);
	const gesture = useRef<Gesture | null>(null);

	// Opening focuses the window, so Ctrl+Z and Esc reach it.
	useEffect(() => {
		panelRef.current?.focus({ preventScroll: true });
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

	// ── the window: on screen, title bar included ──
	useEffect(() => {
		const fit = () => {
			const viewport = { width: window.innerWidth, height: window.innerHeight };
			const nextSize = clampSize(sizeRef.current, viewport);
			if (nextSize.width !== sizeRef.current.width || nextSize.height !== sizeRef.current.height) setSize(nextSize);
			const current = positionRef.current ?? { x: (viewport.width - nextSize.width) / 2, y: Math.max(8, (viewport.height - nextSize.height) / 3) };
			const next = clampPosition(current, nextSize, viewport);
			if (!positionRef.current || next.x !== current.x || next.y !== current.y) setPosition(next);
		};
		fit();
		window.addEventListener("resize", fit);
		return () => window.removeEventListener("resize", fit);
	}, []);

	const drag = useRef<{ dx: number; dy: number; pointer: number } | null>(null);
	const onDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
		if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
		const rect = panelRef.current!.getBoundingClientRect();
		drag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, pointer: e.pointerId };
		e.currentTarget.setPointerCapture(e.pointerId);
		e.preventDefault();
	};
	const onDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
		const d = drag.current;
		if (!d || d.pointer !== e.pointerId) return;
		setPosition(clampPosition({ x: e.clientX - d.dx, y: e.clientY - d.dy }, sizeRef.current, { width: window.innerWidth, height: window.innerHeight }));
	};
	const onDragEnd = (e: React.PointerEvent<HTMLDivElement>) => {
		if (!drag.current || drag.current.pointer !== e.pointerId) return;
		drag.current = null;
		e.currentTarget.releasePointerCapture(e.pointerId);
		if (positionRef.current) saveScratchpadWindow({ position: positionRef.current });
	};

	const resizing = useRef<{ pointer: number; startX: number; startY: number; width: number; height: number } | null>(null);
	const onResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
		if (e.button !== 0) return;
		resizing.current = { pointer: e.pointerId, startX: e.clientX, startY: e.clientY, ...sizeRef.current };
		e.currentTarget.setPointerCapture(e.pointerId);
		e.preventDefault();
		e.stopPropagation();
	};
	const onResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
		const r = resizing.current;
		if (!r || r.pointer !== e.pointerId) return;
		const pos = positionRef.current ?? { x: 8, y: 8 };
		// Up to the viewport's right and bottom edges from where the window sits.
		const room = { width: window.innerWidth - pos.x + 8, height: window.innerHeight - pos.y + 8 };
		setSize(clampSize({ width: r.width + e.clientX - r.startX, height: r.height + e.clientY - r.startY }, room));
	};
	const onResizeEnd = (e: React.PointerEvent<HTMLDivElement>) => {
		if (!resizing.current || resizing.current.pointer !== e.pointerId) return;
		resizing.current = null;
		e.currentTarget.releasePointerCapture(e.pointerId);
		saveScratchpadWindow({ size: sizeRef.current });
	};

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
		if (gesture.current || (e.pointerType === "mouse" && e.button !== 0)) return;
		panelRef.current?.focus({ preventScroll: true });
		setConfirmClear(false);
		e.currentTarget.setPointerCapture(e.pointerId);
		e.preventDefault();
		const point = pointIn(e);
		const width = PAD_SIZES[sizeName];
		if (tool === "pen") {
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
		if (g.kind === "shape") {
			const last = events[events.length - 1]!;
			g.to = pointIn(last);
			const { from, to } = constrainShape(g.shape, g.from, g.to, e.shiftKey);
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
		if (g.kind === "shape") {
			clearLive();
			const { from, to } = constrainShape(g.shape, g.from, g.to, e.shiftKey);
			// A click without a drag draws nothing.
			if (Math.hypot(to.x - from.x, to.y - from.y) < 2) return;
			setHistory((h) => addItem(h, { kind: "shape", shape: g.shape, color: g.color, size: g.size, from, to }));
			return;
		}
		setHistory((h) => addItem(h, g.item));
	};

	const doUndo = () => setHistory((h) => undo(h));
	const doRedo = () => setHistory((h) => redo(h));
	const doClear = () => {
		setConfirmClear(false);
		setHistory((h) => (isBlank(h.items) ? h : addItem(h, { kind: "clear" })));
	};
	const blank = isBlank(history.items);

	const iconButton = "flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent";

	return (
		<div
			ref={panelRef}
			role="dialog"
			aria-label="Scratchpad"
			tabIndex={-1}
			data-testid="scratchpad"
			data-scratchpad=""
			onKeyDown={(e) => {
				const mod = e.ctrlKey || e.metaKey;
				const key = e.key.toLowerCase();
				// Tab moves between the toolbar's buttons, never out to the
				// page's own Tab handling (it cycles the lesson's text fields).
				if (e.key === "Tab") {
					e.stopPropagation();
					return;
				}
				if (e.key === "Escape") {
					e.preventDefault();
					e.stopPropagation();
					if (confirmClear) setConfirmClear(false);
					else onClose();
					return;
				}
				if (mod && !e.altKey && (key === "z" || key === "y")) {
					e.preventDefault();
					e.stopPropagation();
					if (key === "y" || e.shiftKey) doRedo();
					else doUndo();
				}
			}}
			className="fixed z-40 flex flex-col overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-lg outline-none"
			style={{
				width: size.width,
				height: size.height,
				...(position ? { left: position.x, top: position.y } : { left: "50%", top: 72, transform: "translateX(-50%)" }),
			}}
		>
			<div
				onPointerDown={onDragStart}
				onPointerMove={onDragMove}
				onPointerUp={onDragEnd}
				onPointerCancel={onDragEnd}
				data-testid="scratchpad-titlebar"
				className="flex cursor-move touch-none select-none items-center gap-1 px-3 pt-2 pb-1"
			>
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
					<button type="button" aria-label="Close the scratchpad" title="Close (Esc)" onClick={onClose} className={iconButton}>
						<XIcon className="size-4" />
					</button>
				</div>
			</div>

			<div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-2.5 pb-2" data-testid="scratchpad-toolbar">
				<div role="radiogroup" aria-label="Tool" className="flex items-center gap-0.5">
					{TOOLS.map(({ tool: t, label, icon }) => (
						<button
							key={t}
							type="button"
							role="radio"
							aria-checked={tool === t}
							aria-label={label}
							title={label}
							data-testid={`scratchpad-tool-${t}`}
							onClick={() => setTool(t)}
							className={cn(iconButton, tool === t && "bg-accent text-foreground")}
						>
							{icon}
						</button>
					))}
				</div>
				<div role="radiogroup" aria-label="Size" className="flex items-center gap-0.5 border-l pl-2">
					{SIZE_NAMES.map((name) => (
						<button
							key={name}
							type="button"
							role="radio"
							aria-checked={sizeName === name}
							aria-label={`${name[0]!.toUpperCase()}${name.slice(1)}`}
							title={`${name[0]!.toUpperCase()}${name.slice(1)}`}
							data-testid={`scratchpad-size-${name}`}
							onClick={() => setSizeName(name)}
							className={cn(iconButton, sizeName === name && "bg-accent text-foreground")}
						>
							<span className="rounded-full bg-current" style={{ width: PAD_SIZES[name] + 2, height: PAD_SIZES[name] + 2 }} />
						</button>
					))}
				</div>
				<div role="radiogroup" aria-label="Color" className="flex flex-wrap items-center gap-1 border-l pl-2">
					{PAD_COLORS.map((c) => (
						<button
							key={c}
							type="button"
							role="radio"
							aria-checked={color === c}
							aria-label={`Color ${c}`}
							title={c}
							data-testid={`scratchpad-color-${c.slice(1)}`}
							onClick={() => setColor(c)}
							className={cn("size-5 rounded-[4px] transition-transform hover:scale-110", color === c && "ring-2 ring-[#378ef0] ring-offset-1 ring-offset-card")}
							style={{ backgroundColor: c }}
						/>
					))}
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
					className="absolute inset-0 size-full cursor-crosshair touch-none"
				/>
				<div
					role="separator"
					aria-label="Resize the scratchpad"
					title="Drag to resize"
					data-testid="scratchpad-resize"
					onPointerDown={onResizeStart}
					onPointerMove={onResizeMove}
					onPointerUp={onResizeEnd}
					onPointerCancel={onResizeEnd}
					className="absolute right-0 bottom-0 size-4 cursor-nwse-resize touch-none"
				>
					<svg viewBox="0 0 16 16" className="size-4 text-white/35" aria-hidden="true">
						<path d="M14 6 6 14M14 10l-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
					</svg>
				</div>
			</div>
		</div>
	);
}
