import { describe, expect, test } from "bun:test";
import type {
	ExtensionActions,
	ExtensionCommandContextActions,
	ExtensionContextActions,
	ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

async function createHost(initializeUi: boolean) {
	let actions: ExtensionContextActions | undefined;
	const state = {
		streaming: false,
		queued: 0,
		asyncWork: false,
		closed: false,
		closeActions: [] as Array<"shutdown" | "restart">,
		admitted: 0,
		pendingSubmission: false,
		settleAdmitted: undefined as (() => void) | undefined,
	};
	const errors: string[] = [];
	const runner = {
		initialize(
			_actions: ExtensionActions,
			contextActions: ExtensionContextActions,
			_commandActions?: ExtensionCommandContextActions,
			_uiContext?: ExtensionUIContext,
		) {
			actions = contextActions;
		},
		getComposerShapes: () => [],
		onError() {},
		async emit() {},
	};
	const host = Object.assign(Object.create(InteractiveMode.prototype), {
		lifecycleRequest: undefined,
		syncComposerShape() {},
		session: {
			extensionRunner: runner,
			get isStreaming() {
				return state.streaming;
			},
			get queuedMessageCount() {
				return state.queued;
			},
			get hasAdmittedSubmission() {
				return state.admitted > 0;
			},
			hasPendingAsyncWork: () => state.asyncWork,
			async waitForIdle() {},
			waitForAdmittedSubmissions() {
				if (state.admitted === 0) return Promise.resolve();
				const settled = Promise.withResolvers<void>();
				state.settleAdmitted = settled.resolve;
				return settled.promise;
			},
		},
		hasPendingSubmission: () => state.pendingSubmission,
		async shutdown() {
			state.closed = true;
			state.closeActions.push("shutdown");
		},
		async restart() {
			state.closed = true;
			state.closeActions.push("restart");
		},
		showError(message: string) {
			errors.push(message);
		},
		setToolUIContext() {},
		editor: { setText() {}, handleInput() {}, getText: () => "" },
		setWorkingMessage() {},
		setEditorComponent() {},
		toolOutputExpanded: false,
		setToolsExpanded() {},
	}) as InteractiveModeContext;
	Object.defineProperty(host, "isShuttingDown", { get: () => state.closed });
	const controller = new ExtensionUiController(host);
	if (initializeUi) await controller.initHooksAndCustomTools();
	else controller.initializeHookRunner({} as ExtensionUIContext, false);
	if (!actions?.restart) throw new Error("Extension restart runtime was not initialized");
	return { host, actions, requestRestart: actions.restart, state, errors };
}

async function flushShutdown() {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("interactive extension shutdown", () => {
	test("an idle background request closes the initialized host without terminal input", async () => {
		const { actions, state, errors } = await createHost(true);
		actions.shutdown();
		await flushShutdown();
		expect(state.closed).toBe(true);
		expect(errors).toEqual([]);
	});

	test("a rebound hook runtime also closes an idle host without another submit", async () => {
		const { actions, state, errors } = await createHost(false);
		actions.shutdown();
		await flushShutdown();
		expect(state.closed).toBe(true);
		expect(errors).toEqual([]);
	});

	test("keeps the request pending until streaming, queued input and async work settle", async () => {
		const { host, actions, state, errors } = await createHost(true);
		state.streaming = true;
		actions.shutdown();
		await flushShutdown();
		expect(state.closed).toBe(false);

		state.streaming = false;
		state.queued = 1;
		await host.checkLifecycleRequested();
		expect(state.closed).toBe(false);

		state.queued = 0;
		state.asyncWork = true;
		await host.checkLifecycleRequested();
		expect(state.closed).toBe(false);

		state.asyncWork = false;
		host.requestLifecycle("shutdown");
		await flushShutdown();
		expect(state.closed).toBe(true);
		expect(errors).toEqual([]);
	});

	test("waits for an admitted extension submission and re-evaluates the turn it started", async () => {
		const { host, actions, state, errors } = await createHost(true);
		state.admitted = 1;
		actions.shutdown();
		await flushShutdown();
		expect(state.closed).toBe(false);

		// The submission dispatches a turn as it settles: still not a shutdown boundary.
		state.streaming = true;
		state.admitted = 0;
		state.settleAdmitted?.();
		await flushShutdown();
		expect(state.closed).toBe(false);

		state.streaming = false;
		host.requestLifecycle("shutdown");
		await flushShutdown();
		expect(state.closed).toBe(true);
		expect(errors).toEqual([]);
	});

	test("keeps the request pending while a foreground submission is still being prepared", async () => {
		const { host, actions, state, errors } = await createHost(true);
		state.pendingSubmission = true;
		actions.shutdown();
		await flushShutdown();
		expect(state.closed).toBe(false);

		state.pendingSubmission = false;
		await host.checkLifecycleRequested();
		expect(state.closed).toBe(true);
		expect(errors).toEqual([]);
	});
});

describe("interactive extension restart", () => {
	test("an idle request reuses native restart once without terminal input", async () => {
		const { host, requestRestart, state, errors } = await createHost(true);
		requestRestart();
		requestRestart();
		await flushShutdown();
		await host.checkLifecycleRequested();
		expect(state.closeActions).toEqual(["restart"]);
		expect(errors).toEqual([]);
	});

	test("a rebound hook runtime can request restart", async () => {
		const { requestRestart, state } = await createHost(false);
		requestRestart();
		await flushShutdown();
		expect(state.closeActions).toEqual(["restart"]);
	});

	test("does not drop queued input or stop accepted background work to restart", async () => {
		const { host, requestRestart, state } = await createHost(true);
		state.streaming = true;
		state.queued = 1;
		state.asyncWork = true;
		requestRestart();
		await flushShutdown();
		expect(state.closeActions).toEqual([]);
		expect(state.queued).toBe(1);
		expect(state.asyncWork).toBe(true);

		state.streaming = false;
		await host.checkLifecycleRequested();
		expect(state.closeActions).toEqual([]);
		state.queued = 0;
		await host.checkLifecycleRequested();
		expect(state.closeActions).toEqual([]);
		state.asyncWork = false;
		await host.checkLifecycleRequested();
		expect(state.closeActions).toEqual(["restart"]);
	});

	test("waits for admitted input and the turn it starts before restarting", async () => {
		const { host, requestRestart, state } = await createHost(true);
		state.admitted = 1;
		requestRestart();
		await flushShutdown();
		expect(state.closeActions).toEqual([]);

		state.streaming = true;
		state.admitted = 0;
		state.settleAdmitted?.();
		await flushShutdown();
		expect(state.closeActions).toEqual([]);
		state.streaming = false;
		await host.checkLifecycleRequested();
		expect(state.closeActions).toEqual(["restart"]);
	});

	test("retains a restart while foreground input is being prepared", async () => {
		const { host, requestRestart, state } = await createHost(true);
		state.pendingSubmission = true;
		requestRestart();
		await flushShutdown();
		expect(state.closeActions).toEqual([]);
		state.pendingSubmission = false;
		await host.checkLifecycleRequested();
		expect(state.closeActions).toEqual(["restart"]);
	});

	test("shutdown overrides a pending restart without waiting on another session", async () => {
		const { host, actions, requestRestart, state } = await createHost(true);
		state.asyncWork = true;
		requestRestart();
		await flushShutdown();
		actions.shutdown();
		await flushShutdown();
		state.asyncWork = false;
		await host.checkLifecycleRequested();
		expect(state.closeActions).toEqual(["shutdown"]);
	});

	test("a later restart cannot override a pending shutdown", async () => {
		const { host, actions, requestRestart, state } = await createHost(true);
		state.asyncWork = true;
		actions.shutdown();
		await flushShutdown();
		requestRestart();
		await flushShutdown();
		state.asyncWork = false;
		await host.checkLifecycleRequested();
		expect(state.closeActions).toEqual(["shutdown"]);
	});
});
