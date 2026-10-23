import * as path from "node:path";
import { CONTEXT_NOTES_ENTRY_TYPE } from "./context-notes";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "../tools/todo";
import type { SessionEntry, SessionMessageEntry } from "./session-entries";
import type { SessionManager } from "./session-manager";

export interface RestartSessionStopCheckState {
	continuationCount: number;
	stopHookActive: boolean;
}

export interface RestartSessionStopCheckIntent extends RestartSessionStopCheckState {
	version: 1;
	sessionId: string;
	sessionFile: string;
	boundaryId: string;
	assistantEntryId: string;
}

export const RESTART_SESSION_STOP_CHECK_ENTRY_TYPE = "restart_session_stop_check";
export const RESTART_SESSION_STOP_CHECK_CONSUMED_ENTRY_TYPE = "restart_session_stop_check_consumed";

interface ConsumedRecord {
	version: 1;
	token: string;
}

/** Renderer-only output carries no model context and does not supersede a stop check. */
export function isDisplayOnlyCustomMessage(message: unknown): boolean {
	if (message === null || typeof message !== "object") return false;
	const card = message as { content?: unknown; display?: boolean; attribution?: string };
	return card.display === true && card.content === "" && card.attribution === "agent";
}

function validState(state: RestartSessionStopCheckState): boolean {
	return (
		Number.isInteger(state.continuationCount) &&
		state.continuationCount >= 0 &&
		typeof state.stopHookActive === "boolean"
	);
}

function getSessionIdentity(manager: SessionManager): { sessionId: string; sessionFile: string } | undefined {
	const sessionId = manager.getSessionId();
	const sessionFile = manager.getSessionFile();
	if (!sessionId || !sessionFile || !manager.isSessionOnDisk()) return undefined;
	return { sessionId, sessionFile: path.resolve(sessionFile) };
}

function latestStoppedAssistant(branch: readonly SessionEntry[]): SessionMessageEntry | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (
			(entry.type === "custom" &&
				entry.customType !== CONTEXT_NOTES_ENTRY_TYPE &&
				entry.customType !== USER_TODO_EDIT_CUSTOM_TYPE) ||
			(entry.type === "custom_message" && isDisplayOnlyCustomMessage(entry)) ||
			entry.type === "model_usage" ||
			entry.type === "model_change" ||
			entry.type === "thinking_level_change" ||
			entry.type === "service_tier_change" ||
			entry.type === "title_change" ||
			entry.type === "label" ||
			entry.type === "credential_pin"
		) {
			continue;
		}
		if (entry.type !== "message" || entry.message.role !== "assistant" || entry.message.stopReason !== "stop") {
			return undefined;
		}
		return entry;
	}
	return undefined;
}

function isIntent(value: unknown): value is RestartSessionStopCheckIntent {
	if (value === null || typeof value !== "object") return false;
	const intent = value as Partial<RestartSessionStopCheckIntent>;
	return (
		intent.version === 1 &&
		typeof intent.sessionId === "string" &&
		typeof intent.sessionFile === "string" &&
		path.isAbsolute(intent.sessionFile) &&
		typeof intent.boundaryId === "string" &&
		typeof intent.assistantEntryId === "string" &&
		Number.isInteger(intent.continuationCount) &&
		(intent.continuationCount ?? -1) >= 0 &&
		typeof intent.stopHookActive === "boolean"
	);
}

function intentForEntry(entry: SessionEntry | undefined): RestartSessionStopCheckIntent | undefined {
	if (entry?.type !== "custom" || entry.customType !== RESTART_SESSION_STOP_CHECK_ENTRY_TYPE) return undefined;
	return isIntent(entry.data) ? entry.data : undefined;
}

function isContextChanging(entry: SessionEntry): boolean {
	return (
		entry.type === "message" ||
		(entry.type === "custom_message" && !isDisplayOnlyCustomMessage(entry)) ||
		(entry.type === "custom" &&
			(entry.customType === CONTEXT_NOTES_ENTRY_TYPE || entry.customType === USER_TODO_EDIT_CUSTOM_TYPE)) ||
		entry.type === "compaction" ||
		entry.type === "branch_summary" ||
		entry.type === "reset_boundary" ||
		entry.type === "mode_change" ||
		entry.type === "ttsr_injection" ||
		entry.type === "session_init"
	);
}

function isCurrent(manager: SessionManager, token: string, intent: RestartSessionStopCheckIntent): boolean {
	const identity = getSessionIdentity(manager);
	if (!identity || identity.sessionId !== intent.sessionId || identity.sessionFile !== intent.sessionFile)
		return false;
	const branch = manager.getBranchView();
	const armed = branch.find(entry => entry.id === token);
	const recordedIntent = intentForEntry(armed);
	if (
		!recordedIntent ||
		armed?.parentId !== intent.boundaryId ||
		recordedIntent.version !== intent.version ||
		recordedIntent.sessionId !== intent.sessionId ||
		recordedIntent.sessionFile !== intent.sessionFile ||
		recordedIntent.boundaryId !== intent.boundaryId ||
		recordedIntent.assistantEntryId !== intent.assistantEntryId ||
		recordedIntent.continuationCount !== intent.continuationCount ||
		recordedIntent.stopHookActive !== intent.stopHookActive
	) {
		return false;
	}
	const boundaryIndex = branch.findIndex(entry => entry.id === intent.boundaryId);
	const armedIndex = branch.findIndex(entry => entry.id === token);
	if (boundaryIndex < 0 || armedIndex <= boundaryIndex) return false;
	for (let index = boundaryIndex + 1; index < branch.length; index++) {
		const entry = branch[index];
		if (entry.id === token) continue;
		if (entry.type === "custom" && entry.customType === RESTART_SESSION_STOP_CHECK_CONSUMED_ENTRY_TYPE) continue;
		if (isContextChanging(entry)) return false;
	}
	return latestStoppedAssistant(branch)?.id === intent.assistantEntryId;
}

export async function createRestartSessionStopCheck(
	manager: SessionManager,
	state: RestartSessionStopCheckState,
): Promise<string | undefined> {
	if (!validState(state)) return undefined;
	const identity = getSessionIdentity(manager);
	if (!identity) return undefined;
	const branch = manager.getBranchView();
	const assistant = latestStoppedAssistant(branch);
	const boundaryId = manager.getLeafId();
	if (!assistant || !boundaryId) return undefined;
	const intent: RestartSessionStopCheckIntent = {
		version: 1,
		...identity,
		boundaryId,
		assistantEntryId: assistant.id,
		continuationCount: state.continuationCount,
		stopHookActive: state.stopHookActive,
	};
	const token = manager.appendCustomEntry(RESTART_SESSION_STOP_CHECK_ENTRY_TYPE, intent);
	await manager.flush();
	return isCurrent(manager, token, intent) ? token : undefined;
}

export async function consumeRestartSessionStopCheck(
	manager: SessionManager,
	token: string,
): Promise<RestartSessionStopCheckIntent | undefined> {
	if (!token) return undefined;
	const identity = getSessionIdentity(manager);
	if (!identity) return undefined;
	const intent = intentForEntry(manager.getEntry(token));
	if (
		!intent ||
		intent.sessionId !== identity.sessionId ||
		intent.sessionFile !== identity.sessionFile ||
		manager
			.getEntries()
			.some(
				candidate =>
					candidate.type === "custom" &&
					candidate.customType === RESTART_SESSION_STOP_CHECK_CONSUMED_ENTRY_TYPE &&
					(candidate.data as Partial<ConsumedRecord> | undefined)?.token === token,
			)
	) {
		return undefined;
	}
	// Append before the first await so same-process consumers serialize on the journal state.
	manager.appendCustomEntry(RESTART_SESSION_STOP_CHECK_CONSUMED_ENTRY_TYPE, {
		version: 1,
		token,
	} satisfies ConsumedRecord);
	await manager.flush();
	if (!isCurrent(manager, token, intent)) return undefined;
	return intent;
}

export function isRestartSessionStopCheckCurrent(
	manager: SessionManager,
	token: string,
	intent: RestartSessionStopCheckIntent,
): boolean {
	return isCurrent(manager, token, intent);
}
