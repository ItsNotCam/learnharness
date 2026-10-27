/**
 * Whether the scratchpad is open, for the rest of the page: the chat view's
 * dock slides the answer box left to make room for it (chat.tsx). The host
 * (scratchpad-host.tsx) is the only writer.
 */
import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();

export function setScratchpadOpen(next: boolean): void {
	if (open === next) return;
	open = next;
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** True while the scratchpad is open (false on the server). */
export function useScratchpadOpen(): boolean {
	return useSyncExternalStore(subscribe, () => open, () => false);
}
