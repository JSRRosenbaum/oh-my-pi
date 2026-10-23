import { describe, expect, it } from "bun:test";
import type { RemoteDialogHost, RemoteDialogRequest, RemoteDialogResponse } from "../../../src/modes/remote-dialogs";
import { RemoteDialogHosts } from "../../../src/modes/remote-dialogs";
import { ExtensionUiController } from "../../../src/modes/controllers/extension-ui-controller";
import type { InteractiveModeContext } from "../../../src/modes/types";

type RemoteDialogValue = Extract<RemoteDialogResponse, { kind: "answered" }>["value"];
class DeferredHost implements RemoteDialogHost {
	readonly requests: RemoteDialogRequest[] = [];
	readonly signals: AbortSignal[] = [];
	readonly waiters: ((result: RemoteDialogResponse) => void)[] = [];

	request(request: RemoteDialogRequest, signal: AbortSignal): Promise<RemoteDialogResponse> {
		this.requests.push(request);
		this.signals.push(signal);
		const { promise, resolve } = Promise.withResolvers<RemoteDialogResponse>();
		this.waiters.push(resolve);
		signal.addEventListener("abort", () => resolve({ kind: "unavailable" }), { once: true });
		return promise;
	}

	answer(value: RemoteDialogValue): void {
		this.waiters.shift()?.({ kind: "answered", value });
	}

	unavailable(): void {
		this.waiters.shift()?.({ kind: "unavailable" });
	}
}

function makeController(hosts: RemoteDialogHosts) {
	const local = Promise.withResolvers<string | undefined>();
	const localConfirm = Promise.withResolvers<boolean>();
	const localSignals: AbortSignal[] = [];
	class TestController extends ExtensionUiController {
		override showHookSelector(
			_title: string,
			_options: string[],
			options?: { signal?: AbortSignal },
		): Promise<string | undefined> {
			if (options?.signal) localSignals.push(options.signal);
			return local.promise;
		}

		override showHookConfirm(
			_title?: string,
			_message?: string,
			options?: { signal?: AbortSignal },
		): Promise<boolean> {
			if (options?.signal) localSignals.push(options.signal);
			return localConfirm.promise;
		}
	}
	const context = { remoteDialogHosts: hosts, collabHost: undefined } as unknown as InteractiveModeContext;
	return { controller: new TestController(context), local, localConfirm, localSignals };
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("registered remote dialog hosts", () => {
	it("first remote answer wins, aborting local and every losing host", async () => {
		const registry = new RemoteDialogHosts("session-a");
		const first = new DeferredHost();
		const second = new DeferredHost();
		registry.register(first);
		registry.register(second);
		const { controller, localSignals } = makeController(registry);
		const result = controller.showRemoteAwareSelector("Ship?", ["yes", "no"]);
		second.answer("no");
		await expect(result).resolves.toBe("no");
		expect(localSignals[0]?.aborted).toBe(true);
		expect(first.signals[0]?.aborted).toBe(true);
		expect(second.signals[0]?.aborted).toBe(false);
		expect(second.requests[0]?.provenance).toEqual({
			sessionId: "session-a",
			generation: 0,
			promptClass: "extension-user",
		});
	});
	it("local answer wins and aborts every remote request", async () => {
		const registry = new RemoteDialogHosts("session-a");
		const first = new DeferredHost();
		const second = new DeferredHost();
		registry.register(first);
		registry.register(second);
		const { controller, local, localSignals } = makeController(registry);
		const result = controller.showRemoteAwareSelector("Ship?", ["yes", "no"]);
		local.resolve("yes");
		await expect(result).resolves.toBe("yes");
		expect(localSignals[0]?.aborted).toBe(false);
		expect(first.signals[0]?.aborted).toBe(true);
		expect(second.signals[0]?.aborted).toBe(true);
	});

	it("a genuine remote cancellation wins instead of being mistaken for unavailability", async () => {
		const registry = new RemoteDialogHosts("session-a");
		const host = new DeferredHost();
		registry.register(host);
		const { controller, localSignals } = makeController(registry);
		const result = controller.showRemoteAwareSelector("Ship?", ["yes", "no"]);
		host.answer(undefined);
		await expect(result).resolves.toBeUndefined();
		expect(localSignals[0]?.aborted).toBe(true);
	});
	it("routes confirm remotely and preserves native local cancel as false", async () => {
		const registry = new RemoteDialogHosts("session-a");
		const remote = new DeferredHost();
		registry.register(remote);
		const { controller } = makeController(registry);
		const result = controller.showRemoteAwareConfirm("Continue?", "Proceed?");
		expect(remote.requests[0]?.kind).toBe("confirm");
		remote.answer(true);
		await expect(result).resolves.toBe(true);

		const fallbackRegistry = new RemoteDialogHosts("session-b");
		const unavailable = new DeferredHost();
		fallbackRegistry.register(unavailable);
		const fallback = makeController(fallbackRegistry);
		const fallbackResult = fallback.controller.showRemoteAwareConfirm("Continue?", "Proceed?");
		unavailable.unavailable();
		fallback.localConfirm.resolve(false);
		await expect(fallbackResult).resolves.toBe(false);
	});

	it("unavailable host leaves the local dialog alive", async () => {
		const registry = new RemoteDialogHosts("session-a");
		const host = new DeferredHost();
		registry.register(host);
		const { controller, local, localSignals } = makeController(registry);
		const result = controller.showRemoteAwareSelector("Ship?", ["yes", "no"]);
		host.unavailable();
		await flushMicrotasks();
		expect(localSignals[0]?.aborted).toBe(false);
		local.resolve("yes");
		await expect(result).resolves.toBe("yes");
	});
	it("treats a response with the wrong type for the request as unavailable", async () => {
		const registry = new RemoteDialogHosts("session-a");
		registry.register({ request: () => Promise.resolve({ kind: "answered", value: true }) });
		const { controller, local, localSignals } = makeController(registry);
		const result = controller.showRemoteAwareSelector("Ship?", ["yes", "no"]);
		await flushMicrotasks();
		expect(localSignals[0]?.aborted).toBe(false);
		local.resolve("yes");
		await expect(result).resolves.toBe("yes");
	});

	it("disposing a registration aborts it and ignores a late answer", async () => {
		const registry = new RemoteDialogHosts("session-a");
		const host = new DeferredHost();
		const dispose = registry.register(host);
		const { controller, local, localSignals } = makeController(registry);
		const result = controller.showRemoteAwareSelector("Ship?", ["yes", "no"]);
		dispose();
		await flushMicrotasks();
		expect(host.signals[0]?.aborted).toBe(true);
		expect(localSignals[0]?.aborted).toBe(false);
		host.answer("no");
		await flushMicrotasks();
		expect(localSignals[0]?.aborted).toBe(false);
		local.resolve("yes");
		await expect(result).resolves.toBe("yes");
	});

	it("aborts a replaced session's hosts without disposing the registry", async () => {
		const registry = new RemoteDialogHosts("session-a");
		const first = new DeferredHost();
		registry.register(first);
		const { controller, local } = makeController(registry);
		const oldRequest = controller.showRemoteAwareSelector("Old question", ["yes", "no"]);
		const generation = registry.generation;

		registry.abortCurrentGeneration();

		expect(first.signals[0]?.aborted).toBe(true);
		expect(registry.list()).toEqual([]);
		expect(registry.sessionId).toBe("session-a");
		expect(registry.generation).toBe(generation);
		local.resolve("no");
		await expect(oldRequest).resolves.toBe("no");
		const successor = new DeferredHost();
		registry.register(successor);
		const next = makeController(registry).controller.showRemoteAwareSelector("New question", ["yes", "no"]);
		successor.answer("yes");
		await expect(next).resolves.toBe("yes");
	});
	it("session generation invalidation prevents stale responses", async () => {
		const registry = new RemoteDialogHosts("session-a");
		const host = new DeferredHost();
		registry.register(host);
		const { controller, local, localSignals } = makeController(registry);
		const result = controller.showRemoteAwareSelector("Ship?", ["yes", "no"]);
		registry.advanceGeneration("session-b");
		host.answer("no");
		await flushMicrotasks();
		expect(host.signals[0]?.aborted).toBe(true);
		expect(localSignals[0]?.aborted).toBe(false);
		local.resolve("yes");
		await expect(result).resolves.toBe("yes");
	});
});
