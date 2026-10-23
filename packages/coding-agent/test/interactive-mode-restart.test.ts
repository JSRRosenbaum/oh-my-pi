import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { SessionShutdownEvent } from "@oh-my-pi/pi-coding-agent/extensibility/shared-events";
import { createSessionManager } from "@oh-my-pi/pi-coding-agent/main";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { resolveCliEntryCmd } from "@oh-my-pi/pi-coding-agent/subprocess/worker-client";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import * as natives from "@oh-my-pi/pi-natives";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";

describe("InteractiveMode restart", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let sessionManager: SessionManager;
	let session: AgentSession | undefined;
	let originalArgv: string[];

	beforeAll(() => initTheme());
	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@omp-restart-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		originalArgv = process.argv;
		sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "persona sessions"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		process.argv = originalArgv;
		await session?.dispose();
		session = undefined;
		await sessionManager.close();
		authStorage.close();
		tempDir.removeSync();
		resetSettingsForTest();
	});

	async function restart(
		argv: string[],
		thinking: ConfiguredThinkingLevel = ThinkingLevel.Medium,
		onShutdown?: (event: SessionShutdownEvent) => void,
	): Promise<string[]> {
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		let extensionRunner: ExtensionRunner | undefined;
		if (onShutdown) {
			const runtime = new ExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				pi => {
					pi.on("session_shutdown", onShutdown);
					pi.on("session_stop", () => {});
				},
				tempDir.path(),
				new EventBus(),
				runtime,
				"native-restart-reason",
			);
			extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);
		}
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["test"],
					tools: [],
					messages: sessionManager.buildSessionContext().messages,
				},
			}),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
			extensionRunner,
		});
		session.setThinkingLevel(thinking);
		const mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = () => {};
		mode.ui.terminal.drainInput = async () => {};
		process.argv = [originalArgv[0], originalArgv[1], ...argv];
		// Stop only at the process replacement boundary; teardown and argv production run for real.
		const exec = vi.spyOn(natives, "execReplace").mockImplementation(() => undefined as never);
		const spawn = vi.spyOn(Bun, "spawn").mockReturnValue({ exited: Promise.resolve(0) } as never);
		vi.spyOn(postmortem, "cleanup").mockResolvedValue();
		vi.spyOn(postmortem, "drainStdout").mockResolvedValue();
		vi.spyOn(postmortem, "quit").mockResolvedValue();
		await mode.restart();
		const command = process.platform === "win32" ? spawn.mock.calls[0]?.[0] : exec.mock.calls[0]?.[0];
		if (!Array.isArray(command)) throw new Error("expected replacement command");
		return command.slice(resolveCliEntryCmd().length);
	}

	it("resumes the same persona journal and current model/thinking instead of stale launch overrides", async () => {
		sessionManager.appendMessage({ role: "user", content: "initial request", timestamp: 1 });
		sessionManager.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			api: "anthropic-messages",
			content: [{ type: "text", text: "saved answer" }],
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
		await sessionManager.ensureOnDisk();
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("expected persisted journal");
		const id = sessionManager.getSessionId();
		const transcript = sessionManager.buildSessionContext().messages;
		await sessionManager.close();
		sessionManager = await SessionManager.open(file);
		const command = await restart([
			"--session",
			file,
			"--model",
			"anthropic/claude-sonnet-4-5",
			"--provider",
			"openai-codex",
			"--thinking=low",
			"--append-system-prompt",
			"persona prompt",
			"--skills",
			"/office/skills",
			"-e",
			"/office/extension.ts",
			"--model",
			"openai-codex/gpt-6.1-sol:high",
			"--thinking",
			"high",
			"initial request",
		]);
		const parsed = parseArgs(command);
		expect(parsed.restartSessionStopCheck).toBeUndefined();
		expect(parsed.model).toBe("anthropic/claude-sonnet-4-5");
		expect(parsed.provider).toBeUndefined();
		expect(parsed.thinking).toBe(ThinkingLevel.Medium);
		expect(parsed.appendSystemPrompt).toBe("persona prompt");
		expect(parsed.skills).toEqual(["/office/skills"]);
		expect(parsed.extensions).toEqual(["/office/extension.ts"]);
		expect(parsed.messages).toEqual([]);
		const resumed = await createSessionManager(parsed, tempDir.path(), Settings.isolated());
		if (!resumed) throw new Error("expected resumed journal");
		try {
			expect(resumed.getSessionFile()).toBe(file);
			expect(resumed.getSessionId()).toBe(id);
			expect(resumed.buildSessionContext().messages).toEqual(transcript);
		} finally {
			await resumed.close();
		}
	});

	it("resumes a journal created in a flag-looking relative directory", async () => {
		using relativeDir = TempDir.createSync("-omp-restart-");
		await sessionManager.close();
		sessionManager = SessionManager.create(tempDir.path(), relativeDir.path());
		sessionManager.appendMessage({ role: "user", content: "saved request", timestamp: 1 });
		await sessionManager.ensureOnDisk();
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("expected persisted journal");
		const id = sessionManager.getSessionId();
		const command = await restart(["--model", "anthropic/claude-sonnet-4-5", `--session-dir=${relativeDir.path()}`]);
		const parsed = parseArgs(command);
		const resumed = await createSessionManager(parsed, tempDir.path(), Settings.isolated());
		if (!resumed) throw new Error("expected resumed journal");
		try {
			expect(resumed.getSessionFile()).toBe(path.resolve(file));
			expect(resumed.getSessionId()).toBe(id);
			expect(resumed.buildSessionContext().messages).toEqual([
				{ role: "user", content: "saved request", timestamp: 1 },
			]);
		} finally {
			await resumed.close();
		}
	});

	it("does not resume a journal that has never materialized", async () => {
		const file = sessionManager.getSessionFile();
		const command = await restart(["--model", "anthropic/claude-sonnet-4-5", "initial request"]);
		const parsed = parseArgs(command);
		expect(parsed.resume).toBeUndefined();
		expect(parsed.messages).toEqual([]);
		expect(sessionManager.isSessionOnDisk()).toBe(false);
		if (!file) throw new Error("expected allocated journal path");
		expect(await Bun.file(file).exists()).toBe(false);
	});

	it.each(["auto" as const, ThinkingLevel.Off])(
		"keeps runtime thinking %s instead of a stale explicit effort",
		async thinking => {
			const command = await restart(["--model=anthropic/claude-sonnet-4-5:high", "--thinking=xhigh"], thinking);
			const parsed = parseArgs(command);
			expect(parsed.model).toBe("anthropic/claude-sonnet-4-5");
			expect(parsed.thinking).toBe(thinking);
		},
	);

	it("hands off one persisted terminal journal token when restart handlers are active", async () => {
		sessionManager.appendMessage({ role: "user", content: "completed request", timestamp: 1 });
		sessionManager.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			api: "anthropic-messages",
			content: [{ type: "text", text: "completed answer" }],
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
		await sessionManager.ensureOnDisk();
		const observed: SessionShutdownEvent[] = [];
		const command = await restart([], ThinkingLevel.Medium, event => {
			observed.push(event);
		});
		const parsed = parseArgs(command);
		expect(parsed.restartSessionStopCheck).toBeDefined();
		expect(parsed.messages).toEqual([]);
		expect(observed).toEqual([{ type: "session_shutdown", reason: "restart" }]);
	});
});
