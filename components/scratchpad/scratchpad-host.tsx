"use client";
/**
 * Mounts the floating scratchpad (root layout, every page). It opens and
 * closes on the toggle-scratchpad shortcut (Alt+P by default) or its button,
 * remembers whether it was open, and loads the panel only when first opened.
 * The drawing shown is the current lesson's (from the URL); switching
 * lessons switches drawings.
 */
import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { kbdEventForAction } from "@/src/core";
import { drawingKeyForPath } from "./model";
import { loadScratchpadWindow, saveScratchpadWindow } from "./state";

const ScratchpadPanel = lazy(() => import("./scratchpad-panel").then((m) => ({ default: m.ScratchpadPanel })));

/** The window event that toggles the scratchpad (shortcut and button). */
export const SCRATCHPAD_TOGGLE_EVENT = kbdEventForAction("toggle-scratchpad");

/** A panel that fails to load (a stale chunk after a deploy, offline)
 *  shows a small note instead of taking the page down with it. */
class ScratchpadBoundary extends Component<{ children: ReactNode; onClose: () => void }, { failed: boolean }> {
	state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	render() {
		if (!this.state.failed) return this.props.children;
		return (
			<div role="alert" className="fixed right-6 bottom-30 z-40 flex items-center gap-3 rounded-xl border bg-card px-3 py-2 text-xs text-muted-foreground shadow-lg">
				The scratchpad couldn&apos;t load. Reload the page to try again.
				<button type="button" onClick={this.props.onClose} className="text-foreground underline underline-offset-2">
					Close
				</button>
			</div>
		);
	}
}

export function ScratchpadHost() {
	const drawingKey = drawingKeyForPath(usePathname());
	// Closed on the server; the remembered state applies after mount.
	const [open, setOpen] = useState<boolean | null>(null);
	useEffect(() => {
		setOpen(loadScratchpadWindow().open);
		const toggle = () => setOpen((o) => !o);
		window.addEventListener(SCRATCHPAD_TOGGLE_EVENT, toggle);
		return () => window.removeEventListener(SCRATCHPAD_TOGGLE_EVENT, toggle);
	}, []);
	useEffect(() => {
		if (open !== null) saveScratchpadWindow({ open });
	}, [open]);
	if (!open) return null;
	return (
		<ScratchpadBoundary onClose={() => setOpen(false)}>
			<Suspense fallback={null}>
				{/* A new lesson remounts the panel with that lesson's drawing. */}
				<ScratchpadPanel key={drawingKey} drawingKey={drawingKey} onClose={() => setOpen(false)} />
			</Suspense>
		</ScratchpadBoundary>
	);
}
