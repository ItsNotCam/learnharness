/**
 * The tracks ledger adapter (docs/tracks.md §3): append-only JSONL under
 * the LH_DATA_DIR seam — round-trip, corrupt-line tolerance, the per-type
 * shape guard, and the notify-after-write `tracks-changed` emission. The
 * seam is set before any config-loading import (the chat-kind discipline).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-tracks-store-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { trackStore } = await import("../src/store/tracks.ts");
const { TRACKS_FILE } = await import("../config.ts");
const { subscribe } = await import("../src/core/events.ts");
type TrackEvent = import("../src/core/contracts.ts").TrackEvent;
type ServerEvent<K extends import("../src/core/events.ts").ServerEventType> = import("../src/core/events.ts").ServerEvent<K>;

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const created: TrackEvent = {
	type: "created",
	at: "2026-11-22T10:00:00.000Z",
	trackId: "trk_a",
	title: "T",
	goal: "G",
	brief: "B",
	explanation: "E",
	findings: [{ kind: "held", text: "basics" }],
	leftOut: null,
	planningChatId: "chat_plan",
	parts: [{ id: "a", number: "1", title: "A", why: "w", dependsOn: [] }],
};

describe("trackStore — the append-only ledger", () => {
	it("appends land under LH_DATA_DIR and read back in order; each append announces tracks-changed", () => {
		const seen: string[] = [];
		const off = subscribe((e) => {
			// The bus hands out the wide union; the type field selects the payload.
			if (e.type === "tracks-changed") seen.push((e as ServerEvent<"tracks-changed">).trackId ?? "");
		});
		trackStore.appendEvent(created);
		trackStore.appendEvent({ type: "part-started", at: "2026-11-22T10:01:00.000Z", trackId: "trk_a", partId: "a", chatId: "chat_a" });
		off();
		assert.equal(TRACKS_FILE, path.join(TMP_DATA, "tracks", "tracks.jsonl"));
		assert.ok(fs.existsSync(TRACKS_FILE));
		assert.deepEqual(seen, ["trk_a", "trk_a"]);
		const events = trackStore.readEvents();
		assert.deepEqual(events.map((e) => e.type), ["created", "part-started"]);
		assert.deepEqual(events[0], created);
	});

	it("corrupt and malformed lines are skipped, never guessed", () => {
		fs.appendFileSync(TRACKS_FILE, "{not json\n", "utf-8");
		fs.appendFileSync(TRACKS_FILE, `${JSON.stringify({ type: "renamed", at: "x", trackId: "trk_a" })}\n`, "utf-8"); // missing title
		fs.appendFileSync(TRACKS_FILE, `${JSON.stringify({ type: "mystery", at: "x", trackId: "trk_a" })}\n`, "utf-8");
		fs.appendFileSync(TRACKS_FILE, `${JSON.stringify({ type: "created", at: "x", trackId: "trk_b", title: "t" })}\n`, "utf-8"); // incomplete created
		trackStore.appendEvent({ type: "renamed", at: "2026-11-22T10:02:00.000Z", trackId: "trk_a", title: "Renamed" });
		const events = trackStore.readEvents();
		assert.deepEqual(events.map((e) => e.type), ["created", "part-started", "renamed"]);
	});

	it("a missing ledger reads as no events", () => {
		fs.rmSync(TRACKS_FILE);
		assert.deepEqual(trackStore.readEvents(), []);
	});
});
