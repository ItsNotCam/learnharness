"use client";

import { useId, useMemo } from "react";
import { graphlib } from "dagre-d3-es";
import { layout as dagreLayout } from "dagre-d3-es/src/dagre/index.js";
import { ARROW_HEAD, STROKE_W, edgePathD, wrapTitle } from "@/components/plan-block";
import type { TrackPartStatus, TrackPartView } from "@/src/core";

/**
 * THE TRACK MAP (docs/tracks.md §7.2): the DAG of parts styled by status, a
 * split part drawn as a dashed group holding its sub-parts. Placement runs on
 * dagre's COMPOUND mode (mermaid's engine — the plan diagram's choice), so a
 * split parent is a real cluster whose children stay together; the skin is
 * ours: rectangles, a mono status badge ("3 · IN PROGRESS"), the owner's
 * arrowhead and edge drawing from the plan diagram (edgePathD / ARROW_HEAD).
 *
 * Two sizes, one component: the full map (overview) and the COMPACT mini
 * map (the part rail's track card, the proposal card) that shows numbers
 * only. Edges that touch a split parent are drawn to its first child (into)
 * or from its last child (out of) — dagre lays out edges between leaves.
 *
 * Deterministic + synchronous + DOM-free: SSR and render tests stay exact.
 */

export type TrackMapPart = Pick<TrackPartView, "id" | "number" | "title" | "status" | "dependsOn" | "parentPartId" | "children">;

const FULL = { leafW: 200, leafH: 60, subW: 150, titleChars: 30, subChars: 22, lineH: 14, nodesep: 36, ranksep: 56, groupPad: 12, groupLabelH: 22 };
const MINI = { leafW: 56, leafH: 20, nodesep: 14, ranksep: 22, groupPad: 6, groupLabelH: 0 };
/** Viewbox padding — strokes center on the geometry, the selection ring reaches 4 out. */
const PAD = 8;

export interface TrackLayout {
	/** Leaf boxes, top-left. */
	nodes: Map<string, { x: number; y: number; w: number; h: number }>;
	/** Split-parent groups, top-left, inflated by the group padding (+ the label strip). */
	groups: Map<string, { x: number; y: number; w: number; h: number }>;
	edges: Array<{ from: string; to: string; src: string; dst: string; points: Array<{ x: number; y: number }> }>;
	width: number;
	height: number;
}

/** The compound dagre layout. Pure, exported for tests. */
export function trackLayout(parts: readonly TrackMapPart[], compact: boolean): TrackLayout {
	const nodes = new Map<string, { x: number; y: number; w: number; h: number }>();
	const groups = new Map<string, { x: number; y: number; w: number; h: number }>();
	const edges: TrackLayout["edges"] = [];
	if (parts.length === 0) return { nodes, groups, edges, width: 0, height: 0 };
	const byId = new Map(parts.map((p) => [p.id, p]));
	const isParent = (id: string) => (byId.get(id)?.children.length ?? 0) > 0;
	const g = new graphlib.Graph({ compound: true, multigraph: true });
	const sizes = compact ? MINI : FULL;
	g.setGraph({ rankdir: "TB", nodesep: sizes.nodesep, ranksep: sizes.ranksep, marginx: 0, marginy: 0 });
	for (const p of parts) {
		if (isParent(p.id)) {
			g.setNode(p.id, {}); // a cluster: dagre sizes it from its children
			continue;
		}
		const w = compact ? MINI.leafW : p.parentPartId !== undefined ? FULL.subW : FULL.leafW;
		const lines = compact ? 1 : wrapTitle(p.title, p.parentPartId !== undefined ? FULL.subChars : FULL.titleChars).length;
		const h = compact ? MINI.leafH : FULL.leafH + Math.max(0, lines - 2) * FULL.lineH;
		g.setNode(p.id, { width: w, height: h });
	}
	for (const p of parts) {
		if (p.parentPartId !== undefined && byId.has(p.parentPartId)) g.setParent(p.id, p.parentPartId);
	}
	// Edges between LEAVES: a dependency on a split parent lands on its first
	// child; a dependent of a split parent leaves from its last child.
	const firstChild = (id: string): string => {
		const kid = byId.get(id)?.children[0];
		return kid !== undefined && isParent(kid) ? firstChild(kid) : (kid ?? id);
	};
	const lastChild = (id: string): string => {
		const kids = byId.get(id)?.children ?? [];
		const kid = kids[kids.length - 1];
		return kid !== undefined && isParent(kid) ? lastChild(kid) : (kid ?? id);
	};
	for (const p of parts) {
		for (const dep of p.dependsOn) {
			if (!byId.has(dep)) continue;
			const src = isParent(dep) ? lastChild(dep) : dep;
			const dst = isParent(p.id) ? firstChild(p.id) : p.id;
			if (src === dst) continue;
			const name = `${dep}->${p.id}`;
			g.setEdge(src, dst, { label: "", width: 0, height: 0 }, name);
			edges.push({ from: dep, to: p.id, src, dst, points: [] });
		}
	}
	dagreLayout(g, undefined);
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	const stretch = (x: number, y: number, w: number, h: number) => {
		minX = Math.min(minX, x);
		minY = Math.min(minY, y);
		maxX = Math.max(maxX, x + w);
		maxY = Math.max(maxY, y + h);
	};
	for (const p of parts) {
		const pos = g.node(p.id) as { x: number; y: number; width: number; height: number } | undefined;
		if (!pos) continue;
		if (isParent(p.id)) {
			const pad = sizes.groupPad;
			const box = {
				x: pos.x - pos.width / 2 - pad,
				y: pos.y - pos.height / 2 - pad - sizes.groupLabelH,
				w: pos.width + 2 * pad,
				h: pos.height + 2 * pad + sizes.groupLabelH,
			};
			groups.set(p.id, box);
			stretch(box.x, box.y, box.w, box.h);
		} else {
			const box = { x: pos.x - pos.width / 2, y: pos.y - pos.height / 2, w: pos.width, h: pos.height };
			nodes.set(p.id, box);
			stretch(box.x, box.y, box.w, box.h);
		}
	}
	for (const e of edges) {
		const edge = g.edge(e.src, e.dst, `${e.from}->${e.to}`) as { points?: Array<{ x: number; y: number }> } | undefined;
		e.points = edge?.points?.map((pt) => ({ x: pt.x, y: pt.y })) ?? [];
		for (const pt of e.points) stretch(pt.x, pt.y, 0, 0);
	}
	if (minX === Infinity) return { nodes, groups, edges, width: 0, height: 0 };
	// Translate so the ink starts at the origin (inflated groups can go negative).
	for (const box of nodes.values()) {
		box.x -= minX;
		box.y -= minY;
	}
	for (const box of groups.values()) {
		box.x -= minX;
		box.y -= minY;
	}
	for (const e of edges) for (const pt of e.points) {
		pt.x -= minX;
		pt.y -= minY;
	}
	return { nodes, groups, edges, width: maxX - minX, height: maxY - minY };
}

// ─── the skin ────────────────────────────────────────────────────────────────

interface Skin {
	stroke: string;
	strokeWidth: number;
	dash?: string;
	fill: string;
	badge: string;
	title: string;
	label: string;
}

const SKIN: Record<Exclude<TrackPartStatus, "split">, Skin> = {
	done: { stroke: "var(--border)", strokeWidth: STROKE_W, fill: "var(--card)", badge: "var(--muted-foreground)", title: "var(--foreground)", label: "DONE" },
	"in-progress": {
		stroke: "var(--lh-track-accent)",
		strokeWidth: 2,
		fill: "color-mix(in oklab, var(--card) 88%, var(--lh-track-accent))",
		badge: "var(--lh-track-accent)",
		title: "var(--foreground)",
		label: "IN PROGRESS",
	},
	ready: { stroke: "var(--muted-foreground)", strokeWidth: STROKE_W, fill: "var(--card)", badge: "var(--foreground)", title: "var(--foreground)", label: "READY" },
	later: { stroke: "var(--border)", strokeWidth: STROKE_W, dash: "4 3", fill: "transparent", badge: "var(--muted-foreground)", title: "var(--muted-foreground)", label: "LATER" },
};

/** A leaf's drawn status (a split parent never draws a node). */
function leafStatus(status: TrackPartStatus): Exclude<TrackPartStatus, "split"> {
	return status === "split" ? "later" : status;
}

export function TrackMap({
	parts,
	selectedId = null,
	onSelect,
	hereId = null,
	compact = false,
	proposal = false,
	className,
	ariaLabel = "Track map",
}: {
	parts: readonly TrackMapPart[];
	/** The ringed part (the overview's selection). */
	selectedId?: string | null;
	onSelect?: (partId: string) => void;
	/** The part this chat IS (the rail's "N · HERE" badge). */
	hereId?: string | null;
	/** The mini map: numbers only. */
	compact?: boolean;
	/** The proposal card's map: every part is "later" except starts, which read START. */
	proposal?: boolean;
	className?: string;
	ariaLabel?: string;
}) {
	const layout = useMemo(() => trackLayout(parts, compact), [parts, compact]);
	const markerId = useId().replace(/[^a-zA-Z0-9-]/g, "");
	const byId = useMemo(() => new Map(parts.map((p) => [p.id, p])), [parts]);
	if (parts.length === 0) return null;
	const vbW = layout.width + 2 * PAD;
	const vbH = layout.height + 2 * PAD;
	const headH = compact ? 8 : 12;
	const headW = (headH / 104) * 50.2;
	return (
		<svg
			viewBox={`${-PAD} ${-PAD} ${vbW} ${vbH}`}
			className={className}
			style={{ fontFamily: "var(--font-ui)", maxWidth: `${vbW}px` }}
			role="img"
			aria-label={ariaLabel}
			data-testid={compact ? "track-mini-map" : "track-map"}
		>
			<defs>
				<marker id={markerId} viewBox="0 0 50.2 104" refX={27.2} refY={52} markerWidth={headW} markerHeight={headH} markerUnits="userSpaceOnUse" orient="auto">
					<path d={ARROW_HEAD} style={{ fill: "var(--muted-foreground)" }} />
				</marker>
			</defs>
			{[...layout.groups.entries()].map(([id, box]) => {
				const part = byId.get(id);
				if (!part) return null;
				const selected = id === selectedId;
				return (
					<g
						key={id}
						data-testid={`track-group-${id}`}
						role={onSelect ? "button" : undefined}
						tabIndex={onSelect ? 0 : undefined}
						aria-label={`Part ${part.number}, ${part.title}, split into sub-parts`}
						onClick={onSelect ? () => onSelect(id) : undefined}
						onKeyDown={onSelect ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(id); } } : undefined}
						style={{ cursor: onSelect ? "pointer" : undefined }}
					>
						<rect
							x={box.x}
							y={box.y}
							width={box.w}
							height={box.h}
							rx={compact ? 4 : 10}
							style={{ fill: "color-mix(in oklab, var(--background) 60%, var(--card))", stroke: selected ? "var(--foreground)" : "var(--border)", strokeWidth: selected ? 1.5 : STROKE_W, strokeDasharray: "4 3" }}
						/>
						{!compact && (
							<text x={box.x + 12} y={box.y + 15} style={{ fill: "var(--muted-foreground)", fontSize: 10.5, letterSpacing: "0.06em" }}>
								{`${part.number} · ${part.title.toUpperCase()} · SPLIT BY LH`}
							</text>
						)}
					</g>
				);
			})}
			{layout.edges.map((e) => {
				if (e.points.length < 2) return null;
				const target = layout.nodes.get(e.dst);
				const d = edgePathD(e.points, target ? { x: target.x, y: target.y, w: target.w, h: target.h } : undefined);
				return (
					<path
						key={`${e.from}->${e.to}`}
						d={d}
						style={{ fill: "none", stroke: "var(--muted-foreground)", strokeWidth: STROKE_W }}
						markerEnd={`url(#${markerId})`}
					/>
				);
			})}
			{[...layout.nodes.entries()].map(([id, box]) => {
				const part = byId.get(id);
				if (!part) return null;
				const status = proposal ? (part.dependsOn.length === 0 ? "ready" : "later") : leafStatus(part.status);
				const skin = SKIN[status];
				const selected = id === selectedId;
				const here = id === hereId;
				const badge = proposal
					? part.dependsOn.length === 0
						? `${part.number} · START`
						: part.number
					: compact
						? here
							? `${part.number} · HERE`
							: part.number
						: `${part.number} · ${skin.label}`;
				const lines = compact ? [] : wrapTitle(part.title, part.parentPartId !== undefined ? FULL.subChars : FULL.titleChars);
				return (
					<g
						key={id}
						data-testid={`track-node-${id}`}
						data-status={status}
						role={onSelect ? "button" : undefined}
						tabIndex={onSelect ? 0 : undefined}
						aria-label={`Part ${part.number}, ${part.title}, ${skin.label.toLowerCase()}`}
						onClick={onSelect ? () => onSelect(id) : undefined}
						onKeyDown={onSelect ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(id); } } : undefined}
						style={{ cursor: onSelect ? "pointer" : undefined }}
					>
						{selected && (
							<rect x={box.x - 4} y={box.y - 4} width={box.w + 8} height={box.h + 8} rx={compact ? 6 : 12} style={{ fill: "none", stroke: "var(--foreground)", strokeWidth: 1.5 }} />
						)}
						<rect
							x={box.x}
							y={box.y}
							width={box.w}
							height={box.h}
							rx={compact ? 4 : 8}
							style={{ fill: here && compact ? "color-mix(in oklab, var(--card) 88%, var(--lh-track-accent))" : skin.fill, stroke: here && compact ? "var(--lh-track-accent)" : skin.stroke, strokeWidth: here && compact ? 1.6 : skin.strokeWidth, strokeDasharray: skin.dash }}
						/>
						{compact ? (
							<text x={box.x + box.w / 2} y={box.y + box.h / 2 + 3.5} textAnchor="middle" style={{ fill: here ? "var(--foreground)" : skin.badge, fontSize: 9 }}>
								{badge}
							</text>
						) : (
							<>
								<text x={box.x + 12} y={box.y + 16} style={{ fill: skin.badge, fontSize: 10.5, letterSpacing: "0.07em" }}>
									{badge}
								</text>
								{lines.map((line, i) => (
									<text
										key={i}
										x={box.x + 12}
										y={box.y + 34 + i * FULL.lineH}
										style={{ fill: skin.title, fontSize: 14, fontFamily: "var(--font-prose)" }}
									>
										{line}
									</text>
								))}
							</>
						)}
					</g>
				);
			})}
		</svg>
	);
}
