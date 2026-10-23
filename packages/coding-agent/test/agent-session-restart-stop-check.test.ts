import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession restart session_stop check", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-restart-session-stop-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(async () => {
		if (session) await session.dispose();
		session = undefined;
		authStorage.close();
		tempDir.removeSync();
	});

	async function settledSession(options?: {
		hasHandlers?: () => boolean;
		emitSessionStop?: (event: {
			stop_hook_active: boolean;
			signal: AbortSignal;
		}) => Promise<{ continue: true; additionalContext: string } | undefined>;
	}): Promise<{
		manager: SessionManager;
		calls: () => number;
		modelCalls: () => number;
		reopen: () => Promise<SessionManager>;
	}> {
		const model = getBundledModel("openai", "gpt-5");
		if (!model) throw new Error("Expected bundled test model");
		let modelCalls = 0;
		const mock = createMockModel({
			handler: () => ({ content: [`Settled answer ${modelCalls}`], stopReason: "stop" }),
		});
		const makeAgent = (messages: AgentMessage[]) =>
			new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages },
				streamFn: (requestedModel, context, streamOptions) => {
					modelCalls++;
					return mock.stream(requestedModel, context, streamOptions);
				},
			});
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		let calls = 0;
		let hasHandlers = false;
		const extensionRunner = {
			emit: async () => undefined,
			emitBeforeAgentStart: async () => undefined,
			hasHandlers: (eventType: string) => eventType === "session_stop" && (options?.hasHandlers?.() ?? hasHandlers),
			emitSessionStop: async (event: { stop_hook_active: boolean; signal: AbortSignal }) => {
				calls++;
				return options?.emitSessionStop?.(event);
			},
		} as unknown as ExtensionRunner;
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent: makeAgent([]),
			sessionManager: manager,
			settings,
			modelRegistry,
			extensionRunner,
		});
		await session.prompt("Persist a settled answer");
		await session.waitForIdle();
		await manager.flush();
		hasHandlers = true;
		const reopen = async (): Promise<SessionManager> => {
			const previousSession = session;
			if (!previousSession) throw new Error("Expected an active session before restart");
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted session file");
			await previousSession.dispose();
			session = undefined;
			const reopenedManager = await SessionManager.open(sessionFile, undefined, undefined, {
				suppressBreadcrumb: true,
			});
			const messages = reopenedManager.buildSessionContext().messages;
			session = new AgentSession({
				agent: makeAgent(messages),
				sessionManager: reopenedManager,
				settings,
				modelRegistry,
				extensionRunner,
			});
			return reopenedManager;
		};
		return { manager, calls: () => calls, modelCalls: () => modelCalls, reopen };
	}

	it("keeps absent, invalid, and handlerless restart paths inert", async () => {
		const { calls } = await settledSession({ hasHandlers: () => false });
		expect(await session?.prepareRestartSessionStopCheck()).toBeUndefined();
		expect(await session?.recheckSessionStopAfterRestart(undefined)).toBe(false);
		expect(await session?.recheckSessionStopAfterRestart("not-a-journal-entry")).toBe(false);
		expect(calls()).toBe(0);
	});

	it("consumes a persisted intent once, passes carried hook state, and schedules only its permitted continuation", async () => {
		const stopHookActiveValues: boolean[] = [];
		let hookCalls = 0;
		const { manager, calls, modelCalls, reopen } = await settledSession({
			emitSessionStop: async event => {
				stopHookActiveValues.push(event.stop_hook_active);
				if (hookCalls++ === 0) return { continue: true, additionalContext: "Continue the settled work." };
				return undefined;
			},
		});
		const token = await session?.prepareRestartSessionStopCheck();
		expect(token).toBeTruthy();
		if (!token) throw new Error("Expected a journal-bound restart token");
		expect(manager.getEntry(token)?.type).toBe("custom");
		const reopenedManager = await reopen();
		expect(reopenedManager.getEntry(token)?.type).toBe("custom");
		expect(await session?.recheckSessionStopAfterRestart(token)).toBe(true);
		expect(await session?.recheckSessionStopAfterRestart(token)).toBe(false);
		await session?.waitForIdle();
		expect(calls()).toBe(2);
		expect(modelCalls()).toBe(2);
		expect(stopHookActiveValues).toEqual([false, true]);
	});

	it("allows a stop hook's display-only result card without treating it as superseding work", async () => {
		let invocations = 0;
		const { calls, modelCalls, reopen } = await settledSession({
			emitSessionStop: async () => {
				if (invocations++ !== 0) return undefined;
				await session?.sendCustomMessage(
					{
						customType: "test-result-card",
						content: "",
						display: true,
						attribution: "agent",
						details: { result: "continue" },
					},
					{ deliverAs: "nextTurn", triggerTurn: false },
				);
				return { continue: true, additionalContext: "Continue the settled work." };
			},
		});
		const token = await session?.prepareRestartSessionStopCheck();
		if (!token) throw new Error("Expected a journal-bound restart token");
		await reopen();
		expect(await session?.recheckSessionStopAfterRestart(token)).toBe(true);
		await session?.waitForIdle();
		expect(calls()).toBe(2);
		expect(modelCalls()).toBe(2);
	});

	it("rejects a hook's context-bearing next-turn message rather than treating it as a result card", async () => {
		const { calls, modelCalls, reopen } = await settledSession({
			emitSessionStop: async () => {
				await session?.sendCustomMessage(
					{
						customType: "test-context",
						content: "Superseding task evidence",
						display: true,
						attribution: "agent",
					},
					{ deliverAs: "nextTurn", triggerTurn: false },
				);
				return { continue: true, additionalContext: "Stale continuation must not execute." };
			},
		});
		const token = await session?.prepareRestartSessionStopCheck();
		if (!token) throw new Error("Expected a journal-bound restart token");
		await reopen();
		expect(await session?.recheckSessionStopAfterRestart(token)).toBe(false);
		await session?.waitForIdle();
		expect(calls()).toBe(1);
		expect(modelCalls()).toBe(1);
	});

	it("honors a native keyboard interrupt received before startup dispatch begins", async () => {
		const { calls, modelCalls, reopen } = await settledSession();
		const token = await session?.prepareRestartSessionStopCheck();
		if (!token) throw new Error("Expected a journal-bound restart token");
		await reopen();
		session?.interruptRestartSessionStopCheck();
		expect(await session?.recheckSessionStopAfterRestart(token)).toBe(false);
		expect(await session?.recheckSessionStopAfterRestart(token)).toBe(false);
		expect(calls()).toBe(0);
		expect(modelCalls()).toBe(1);
	});

	it("consumes but abstains when the host guard or persisted branch boundary is stale", async () => {
		const { calls, reopen } = await settledSession();
		const token = await session?.prepareRestartSessionStopCheck();
		expect(token).toBeTruthy();
		if (!token) throw new Error("Expected a journal-bound restart token");
		const reopenedManager = await reopen();
		expect(await session?.recheckSessionStopAfterRestart(token, () => false)).toBe(false);
		expect(await session?.recheckSessionStopAfterRestart(token)).toBe(false);
		expect(calls()).toBe(0);

		const secondToken = await session?.prepareRestartSessionStopCheck();
		expect(secondToken).toBeTruthy();
		if (!secondToken) throw new Error("Expected a second journal-bound restart token");
		reopenedManager.appendMessage({ role: "user", content: "New branch work", timestamp: Date.now() });
		await reopenedManager.flush();
		expect(await session?.recheckSessionStopAfterRestart(secondToken)).toBe(false);
		expect(calls()).toBe(0);
	});

	it("rejects host boundary invalidation after the asynchronous stop hook", async () => {
		let canEvaluate = true;
		const { calls, modelCalls, reopen } = await settledSession({
			emitSessionStop: async () => {
				canEvaluate = false;
				return { continue: true, additionalContext: "Must not continue." };
			},
		});
		const token = await session?.prepareRestartSessionStopCheck();
		expect(token).toBeTruthy();
		if (!token) throw new Error("Expected a journal-bound restart token");
		await reopen();
		expect(await session?.recheckSessionStopAfterRestart(token, () => canEvaluate)).toBe(false);
		await session?.waitForIdle();
		expect(calls()).toBe(1);
		expect(modelCalls()).toBe(1);
	});
	it("aborts a delayed restart hook when a new prompt is admitted", async () => {
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<{ continue: true; additionalContext: string }>();
		let invocations = 0;
		const { calls, reopen } = await settledSession({
			emitSessionStop: async () => {
				invocations++;
				if (invocations === 1) {
					started.resolve();
					return finish.promise;
				}
				return undefined;
			},
		});
		const token = await session?.prepareRestartSessionStopCheck();
		expect(token).toBeTruthy();
		if (!token) throw new Error("Expected a journal-bound restart token");
		await reopen();
		const recheck = session?.recheckSessionStopAfterRestart(token);
		await started.promise;
		await session?.prompt("Superseding user input");
		finish.resolve({ continue: true, additionalContext: "Must not continue." });
		expect(await recheck).toBe(false);
		await session?.waitForIdle();
		expect(calls()).toBe(2);
	});

	it("remains abstinent after startup work was superseded before recheck began", async () => {
		const { calls, reopen } = await settledSession();
		const token = await session?.prepareRestartSessionStopCheck();
		expect(token).toBeTruthy();
		if (!token) throw new Error("Expected a journal-bound restart token");
		await reopen();
		await session?.abort();
		expect(await session?.recheckSessionStopAfterRestart(token)).toBe(false);
		expect(calls()).toBe(0);
	});
	it("remains abstinent after a reset supersedes startup work", async () => {
		const { calls, reopen } = await settledSession();
		const token = await session?.prepareRestartSessionStopCheck();
		expect(token).toBeTruthy();
		if (!token) throw new Error("Expected a journal-bound restart token");
		await reopen();
		await session?.resetSessionContext();
		expect(await session?.recheckSessionStopAfterRestart(token)).toBe(false);
		expect(calls()).toBe(0);
	});

	it("aborts a delayed restart hook when the session is explicitly aborted", async () => {
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<{ continue: true; additionalContext: string }>();
		const { calls, reopen } = await settledSession({
			emitSessionStop: async () => {
				started.resolve();
				return finish.promise;
			},
		});
		const token = await session?.prepareRestartSessionStopCheck();
		expect(token).toBeTruthy();
		if (!token) throw new Error("Expected a journal-bound restart token");
		await reopen();
		const recheck = session?.recheckSessionStopAfterRestart(token);
		await started.promise;
		await session?.abort();
		finish.resolve({ continue: true, additionalContext: "Must not continue." });
		expect(await recheck).toBe(false);
		expect(calls()).toBe(1);
	});
	it("rejects continuation when disposal crosses an asynchronous hook", async () => {
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<{ continue: true; additionalContext: string }>();
		const { calls, reopen } = await settledSession({
			emitSessionStop: async () => {
				started.resolve();
				return finish.promise;
			},
		});
		const token = await session?.prepareRestartSessionStopCheck();
		expect(token).toBeTruthy();
		if (!token) throw new Error("Expected a journal-bound restart token");
		await reopen();
		const recheck = session?.recheckSessionStopAfterRestart(token);
		await started.promise;
		session?.beginDispose();
		finish.resolve({ continue: true, additionalContext: "Must not continue." });
		expect(await recheck).toBe(false);
		expect(calls()).toBe(1);
	});
	it("rejects continuation when the session identity changes during a hook", async () => {
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<{ continue: true; additionalContext: string }>();
		const { calls, reopen } = await settledSession({
			emitSessionStop: async () => {
				started.resolve();
				return finish.promise;
			},
		});
		const token = await session?.prepareRestartSessionStopCheck();
		expect(token).toBeTruthy();
		if (!token) throw new Error("Expected a journal-bound restart token");
		await reopen();
		const recheck = session?.recheckSessionStopAfterRestart(token);
		await started.promise;
		expect(session?.freshSession()).toBeTruthy();
		finish.resolve({ continue: true, additionalContext: "Must not continue." });
		expect(await recheck).toBe(false);
		expect(calls()).toBe(1);
	});

	it("abstains on a completed stop result without admitting another turn", async () => {
		const { calls, modelCalls, reopen } = await settledSession({ emitSessionStop: async () => undefined });
		const token = await session?.prepareRestartSessionStopCheck();
		expect(token).toBeTruthy();
		if (!token) throw new Error("Expected a journal-bound restart token");
		await reopen();
		expect(await session?.recheckSessionStopAfterRestart(token)).toBe(false);
		await session?.waitForIdle();
		expect(calls()).toBe(1);
		expect(modelCalls()).toBe(1);
	});

	it("loads deferred extensions before checking restart handlers", async () => {
		let handlersBound = false;
		const { calls, reopen } = await settledSession({ hasHandlers: () => handlersBound });
		handlersBound = true;
		const token = await session?.prepareRestartSessionStopCheck();
		expect(token).toBeTruthy();
		if (!token) throw new Error("Expected a journal-bound restart token");
		await reopen();
		handlersBound = false;
		const loaded = Promise.withResolvers<void>();
		session?.setDeferredExtensionLoader(async () => {
			await loaded.promise;
			handlersBound = true;
		});
		const recheck = session?.recheckSessionStopAfterRestart(token);
		await Promise.resolve();
		expect(calls()).toBe(0);
		loaded.resolve();
		expect(await recheck).toBe(false);
		expect(calls()).toBe(1);
	});

	it("does not evaluate while an admitted submission is waiting for deferred startup", async () => {
		let handlersBound = false;
		const { calls, modelCalls, reopen } = await settledSession({ hasHandlers: () => handlersBound });
		handlersBound = true;
		const token = await session?.prepareRestartSessionStopCheck();
		expect(token).toBeTruthy();
		if (!token) throw new Error("Expected a journal-bound restart token");
		await reopen();
		const loaded = Promise.withResolvers<void>();
		session?.setDeferredExtensionLoader(() => loaded.promise);
		const submission = session?.prompt("Superseding admitted input");
		const recheck = session?.recheckSessionStopAfterRestart(token);
		await Promise.resolve();
		expect(calls()).toBe(0);
		loaded.resolve();
		await submission;
		expect(await recheck).toBe(false);
		await session?.waitForIdle();
		expect(calls()).toBe(1);
		expect(modelCalls()).toBe(2);
	});

	it("restores the carried continuation cap instead of resetting it across restart", async () => {
		let hookStopActive: boolean | undefined;
		const { calls, modelCalls, reopen } = await settledSession({
			emitSessionStop: async event => {
				hookStopActive = event.stop_hook_active;
				return { continue: true, additionalContext: "The carried cap prevents this turn." };
			},
		});
		await session?.prompt("Run this native continuation chain to its existing cap.");
		await session?.waitForIdle();
		await session?.waitForAdmittedSubmissions();
		expect(calls()).toBe(9);
		expect(modelCalls()).toBe(10);
		const token = await session?.prepareRestartSessionStopCheck();
		expect(token).toBeTruthy();
		if (!token) throw new Error("Expected a journal-bound restart token");
		await reopen();
		expect(await session?.recheckSessionStopAfterRestart(token)).toBe(false);
		await session?.waitForIdle();
		expect(calls()).toBe(10);
		expect(modelCalls()).toBe(10);
		expect(hookStopActive).toBe(true);
	});
});
