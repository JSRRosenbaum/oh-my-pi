import { afterEach, describe, expect, it, vi } from "bun:test";
import { SESSION_EXIT_CUSTOM_TYPE } from "../src/session/exit-diagnostics";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "../src/tools/todo";
import { SessionManager } from "../src/session/session-manager";
import { MemorySessionStorage } from "../src/session/session-storage";
import {
	consumeRestartSessionStopCheck,
	createRestartSessionStopCheck,
	isRestartSessionStopCheckCurrent,
	type RestartSessionStopCheckIntent,
} from "../src/session/restart-session-stop-check";

const cwd = "/virtual/restart-stop-check";
const directory = `${cwd}/sessions`;
let storage: MemorySessionStorage;
let manager: SessionManager;

function makeAssistant(text = "completed answer"): void {
	manager.appendMessage({
		role: "assistant",
		provider: "test",
		model: "model",
		api: "test",
		content: [{ type: "text", text }],
		stopReason: "stop",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
		timestamp: Date.now(),
	});
}

async function freshManager(): Promise<SessionManager> {
	storage = new MemorySessionStorage();
	manager = SessionManager.create(cwd, directory, storage);
	manager.appendMessage({ role: "user", content: "request", timestamp: 1 });
	makeAssistant();
	await manager.ensureOnDisk();
	return manager;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await manager?.close();
});

describe("restart session stop-check journal", () => {
	it("creates a qualified durable token and consumes it only once across reopen", async () => {
		await freshManager();
		const token = await createRestartSessionStopCheck(manager, { continuationCount: 2, stopHookActive: true });
		expect(token).toBeDefined();
		if (!token) throw new Error("expected armed token");
		const armed = manager.getEntry(token);
		expect(armed?.type).toBe("custom");
		if (armed?.type !== "custom") throw new Error("expected custom intent entry");
		expect(armed.customType).toBe("restart_session_stop_check");
		expect(isRestartSessionStopCheckCurrent(manager, token, armed.data as RestartSessionStopCheckIntent)).toBe(true);

		const [first, concurrent] = await Promise.all([
			consumeRestartSessionStopCheck(manager, token),
			consumeRestartSessionStopCheck(manager, token),
		]);
		expect([first, concurrent].filter(Boolean)).toHaveLength(1);
		expect(first ?? concurrent).toMatchObject({ continuationCount: 2, stopHookActive: true });
		const file = manager.getSessionFile();
		const userEntry = manager
			.getBranchView()
			.find(entry => entry.type === "message" && entry.message.role === "user");
		if (!file || !userEntry) throw new Error("expected persisted request journal");
		await manager.close();
		manager = await SessionManager.open(file, directory, storage);
		manager.branch(userEntry.id);
		expect(await consumeRestartSessionStopCheck(manager, token)).toBeUndefined();
	});

	it("does not accept a token in a different session journal", async () => {
		await freshManager();
		const token = await createRestartSessionStopCheck(manager, { continuationCount: 0, stopHookActive: true });
		if (!token) throw new Error("expected armed token");
		const other = SessionManager.create(`${cwd}-other`, `${directory}-other`, storage);
		try {
			other.appendMessage({ role: "user", content: "other request", timestamp: 1 });
			other.appendMessage({
				role: "assistant",
				provider: "test",
				model: "model",
				api: "test",
				content: [{ type: "text", text: "other answer" }],
				stopReason: "stop",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
				timestamp: 2,
			});
			await other.ensureOnDisk();
			expect(await consumeRestartSessionStopCheck(other, token)).toBeUndefined();
		} finally {
			await other.close();
		}
	});

	it("rejects a token after the active branch gains a new turn or context injection", async () => {
		await freshManager();
		const token = await createRestartSessionStopCheck(manager, { continuationCount: 0, stopHookActive: true });
		if (!token) throw new Error("expected armed token");
		manager.appendMessage({ role: "user", content: "new request", timestamp: 3 });
		expect(await consumeRestartSessionStopCheck(manager, token)).toBeUndefined();
	});

	it("rejects an attempted handoff when the final transcript entry is a context injection", async () => {
		await freshManager();
		manager.appendCustomMessageEntry("test:injected", [{ type: "text", text: "injected context" }], true);
		expect(
			await createRestartSessionStopCheck(manager, { continuationCount: 0, stopHookActive: true }),
		).toBeUndefined();
	});
	it("rejects a handoff when persisted context notes follow the terminal assistant", async () => {
		await freshManager();
		manager.appendCustomEntry("experimental_context_notes", { version: 1, text: "changed context" });
		expect(
			await createRestartSessionStopCheck(manager, { continuationCount: 0, stopHookActive: true }),
		).toBeUndefined();
	});
	it("invalidates the token when a todo edit changes the live reminder context", async () => {
		await freshManager();
		const token = await createRestartSessionStopCheck(manager, { continuationCount: 0, stopHookActive: true });
		if (!token) throw new Error("expected armed token");
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: [] });
		expect(await consumeRestartSessionStopCheck(manager, token)).toBeUndefined();
	});

	it("allows consumption after native shutdown bookkeeping is appended", async () => {
		await freshManager();
		const token = await createRestartSessionStopCheck(manager, { continuationCount: 0, stopHookActive: true });
		if (!token) throw new Error("expected armed token");
		manager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "restart",
			kind: "normal",
			recordedAt: new Date().toISOString(),
		});
		expect(await consumeRestartSessionStopCheck(manager, token)).toMatchObject({
			continuationCount: 0,
			stopHookActive: true,
		});
	});

	it("does not return a consumed intent when journal flush fails", async () => {
		await freshManager();
		const token = await createRestartSessionStopCheck(manager, { continuationCount: 1, stopHookActive: true });
		if (!token) throw new Error("expected armed token");
		vi.spyOn(manager, "flush").mockRejectedValue(new Error("flush failed"));
		await expect(consumeRestartSessionStopCheck(manager, token)).rejects.toThrow("flush failed");
	});
	it("does not expose an armed token when its journal flush fails", async () => {
		await freshManager();
		vi.spyOn(manager, "flush").mockRejectedValue(new Error("flush failed"));
		await expect(
			createRestartSessionStopCheck(manager, { continuationCount: 1, stopHookActive: true }),
		).rejects.toThrow("flush failed");
	});
});
