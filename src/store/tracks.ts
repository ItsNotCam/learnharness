/**
 * TrackStore — the fs JSONL adapter for the tracks ledger (docs/tracks.md,
 * owner ruling 2026-11-22): data/tracks/tracks.jsonl (config.TRACKS_FILE),
 * append-only, one line per TrackEvent. Implements core/ports.ts TrackStore.
 *
 * Same idioms as the graph ledgers (src/store/graph.ts): sync fs, strict
 * per-line shape guards (a corrupt or unknown line is skipped, never
 * guessed), corrupt-line-tolerant reads. The track service (src/server/
 * tracks.ts) is the sole writer; the fold and every status are derived in
 * core/tracks.ts. Every append announces `tracks-changed` AFTER the write
 * lands (the notify-after-write law).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { TRACKS_FILE } from "../../config.ts";
import { emit } from "../core/events.ts";
import type { TrackStore } from "../core/ports.ts";
import type { TrackEvent, TrackFinding, TrackPartSpec } from "../core/contracts.ts";

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

const isString = (v: unknown): v is string => typeof v === "string";
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);

const isPartSpec = (v: unknown): v is TrackPartSpec =>
	isRecord(v) &&
	isString(v.id) &&
	isString(v.number) &&
	isString(v.title) &&
	isString(v.why) &&
	isStringArray(v.dependsOn) &&
	(v.parentPartId === undefined || isString(v.parentPartId));

const isFinding = (v: unknown): v is TrackFinding => isRecord(v) && (v.kind === "held" || v.kind === "low") && isString(v.text);

/** The ledger's line guard: every event type's exact shape. */
function isTrackEvent(v: unknown): v is TrackEvent {
	if (!isRecord(v) || !isString(v.at) || !isString(v.trackId)) return false;
	switch (v.type) {
		case "created":
			return (
				isString(v.title) &&
				isString(v.goal) &&
				isString(v.brief) &&
				isString(v.explanation) &&
				Array.isArray(v.findings) &&
				v.findings.every(isFinding) &&
				(v.leftOut === null || isString(v.leftOut)) &&
				isString(v.planningChatId) &&
				Array.isArray(v.parts) &&
				v.parts.every(isPartSpec)
			);
		case "replanned":
			return (v.afterPartId === null || isString(v.afterPartId)) && isString(v.note) && Array.isArray(v.parts) && v.parts.every(isPartSpec);
		case "part-started":
		case "practice-attached":
			return isString(v.partId) && isString(v.chatId);
		case "renamed":
			return isString(v.title);
		case "deleted":
			return true;
		default:
			return false;
	}
}

function readRawLines(file: string): unknown[] {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return []; // no ledger yet — no track has ever been created
	}
	const out: unknown[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			out.push(JSON.parse(trimmed));
		} catch {
			// Corrupt line: skip rather than fail the whole read — a torn
			// append must never take the sidebar down with it.
		}
	}
	return out;
}

export const trackStore: TrackStore = {
	appendEvent(event: TrackEvent): void {
		fs.mkdirSync(path.dirname(TRACKS_FILE), { recursive: true });
		fs.appendFileSync(TRACKS_FILE, `${JSON.stringify(event)}\n`, "utf-8");
		emit("tracks-changed", { trackId: event.trackId });
	},
	readEvents(): TrackEvent[] {
		return readRawLines(TRACKS_FILE).filter(isTrackEvent);
	},
};
