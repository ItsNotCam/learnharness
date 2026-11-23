"use client";

import { createContext } from "react";
import type { ChatTrackContext } from "@/src/core";

/**
 * The chat page's track context (docs/tracks.md §7): what the track cards,
 * the `part://` chip renderer (md-blocks) and the rail need to know about
 * the chat they render in. A tiny module of its own so md-blocks — which
 * every markdown surface imports — never pulls the card/map code along.
 */
export interface TrackChatContextValue {
	chatId: string;
	/** The chat's membership, resolved server-side (null = loose). */
	track: ChatTrackContext | null;
	/** The latest CLEAN propose_track call id — the proposal the actions act on. */
	latestProposalCallId: string | null;
	/** "Change something": put the caret in the composer. */
	focusComposer: () => void;
}

export const TrackChatContext = createContext<TrackChatContextValue>({
	chatId: "",
	track: null,
	latestProposalCallId: null,
	focusComposer: () => {},
});
