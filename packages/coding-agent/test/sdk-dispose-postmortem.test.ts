import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { postmortem, removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

// Issue #15386: postmortem callbacks are process-global, so any registration a
// session leaves behind after dispose() pins its closure (and the whole
// AgentSession graph) for the life of the process. SDK embedders that create
// and dispose many sessions leak one session per iteration.
describe("createAgentSession dispose releases postmortem registrations", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(() => {
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(
			authStorage,
			path.join(os.tmpdir(), `pi-sdk-pm-models-${Snowflake.next()}.yml`),
		);
		tempDir = path.join(os.tmpdir(), `pi-sdk-dispose-postmortem-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterAll(() => {
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("lets extensions distinguish restart from exit through the SDK session lifecycle", async () => {
		const extensionPath = path.join(tempDir, "shutdown-reason.ts");
		const receiptPath = path.join(tempDir, "shutdown-reason.json");
		fs.writeFileSync(
			extensionPath,
			`export default function(pi) {
				pi.on("session_shutdown", event => Bun.write(${JSON.stringify(receiptPath)}, JSON.stringify(event)));
			}`,
		);
		const preloadedExtensions = await loadExtensions([extensionPath], tempDir);
		expect(preloadedExtensions.errors).toEqual([]);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			hasUI: true,
			bindProcessState: false,
			preloadedExtensions,
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			preloadedCustomToolPaths: [],
		});
		try {
			await session.dispose({ shutdownReason: "restart" });
			expect(JSON.parse(fs.readFileSync(receiptPath, "utf8"))).toEqual({
				type: "session_shutdown",
				reason: "restart",
			});
		} finally {
			await session.dispose();
		}
	});

	it("does not accumulate registrations across create/dispose cycles of MCP-owning sessions", async () => {
		// Registration id → live (uncancelled) count. Process-singleton cleanups
		// (ssh, python kernels) register once and stay; per-session ones must not.
		const live = new Map<string, number>();
		const register = postmortem.register;
		vi.spyOn(postmortem, "register").mockImplementation((id, callback, options) => {
			const cancel = register(id, callback, options);
			live.set(id, (live.get(id) ?? 0) + 1);
			let cancelled = false;
			return () => {
				if (!cancelled) {
					cancelled = true;
					const count = (live.get(id) ?? 0) - 1;
					if (count > 0) live.set(id, count);
					else live.delete(id);
				}
				cancel();
			};
		});
		const cycle = async () => {
			const { session } = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				modelRegistry,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({}),
				model: getBundledModel("openai", "gpt-4o-mini"),
				hasUI: true,
				bindProcessState: false,
				enableMCP: true,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableLsp: false,
				skipPythonPreflight: true,
				rules: [],
				preloadedCustomToolPaths: [],
			});
			await session.dispose();
		};

		await cycle();
		const afterFirst = new Map(live);
		await cycle();
		await cycle();

		expect(live).toEqual(afterFirst);
	});

	for (const shutdownReason of ["quit", "restart"] as const) {
		it(`publishes one ${shutdownReason} lifecycle boundary before concurrent SDK disposal completes`, async () => {
			const observed: string[] = [];
			const { session } = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				modelRegistry,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({}),
				model: getBundledModel("openai", "gpt-4o-mini"),
				hasUI: true,
				bindProcessState: false,
				enableMCP: false,
				disableExtensionDiscovery: true,
				extensions: [pi => {
					pi.on("session_shutdown", event => { observed.push(event.reason); });
				}],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableLsp: false,
				skipPythonPreflight: true,
				rules: [],
				preloadedCustomToolPaths: [],
			});
			try {
				await Promise.all([session.dispose({ shutdownReason }), session.dispose()]);
				expect(observed).toEqual([shutdownReason]);
			} finally {
				await session.dispose();
			}
		});
	}
});
