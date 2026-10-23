import { isRecord } from "@oh-my-pi/pi-utils";
import type { ExtensionUIContext } from "./types";

/** Public dialog metadata; privileged approvals intentionally carry no title. */
export interface UserWaitPrompt {
	kind: "select" | "confirm" | "input" | "editor" | "custom";
	title?: string;
	timeout?: number;
}

/** Track UI lifecycle and distinguish timed dialogs from operator-owned computer waits. */
export type UserWaitTracker = <T>(dialog: () => Promise<T>, prompt?: UserWaitPrompt) => Promise<T>;

/** The {@link ExtensionUIContext} methods that wait for the user's answer. */
const DIALOGS: Record<string, true> = {
	select: true,
	confirm: true,
	input: true,
	editor: true,
	custom: true,
	askDialog: true,
	approve: true,
};

type Method = (...args: unknown[]) => unknown;

/**
 * `ui` with each dialog run through `track`. Timed dialogs still publish their
 * waiting span, but the tracker leaves their deadline-owned time with the agent.
 * Other members pass through and replacement methods are read on every access.
 */
export function trackUserWaits(ui: ExtensionUIContext, track: UserWaitTracker): ExtensionUIContext {
	// Wrappers keep their identity while the member they wrap does.
	const methods = new Map<PropertyKey, { value: Method; method: Method }>();
	return new Proxy(ui, {
		get(target, property) {
			const value: unknown = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			const cached = methods.get(property);
			if (cached?.value === value) return cached.method;
			const method: Method = Object.hasOwn(DIALOGS, property)
				? (...args) => {
						const kind =
							property === "select" || property === "confirm" || property === "input" || property === "editor"
								? property
								: "custom";
						const options = args.find(arg => isRecord(arg) && typeof arg.timeout === "number");
						const timeout =
							isRecord(options) && typeof options.timeout === "number" ? options.timeout : undefined;
						const title = kind !== "custom" && typeof args[0] === "string" ? args[0] : undefined;
						return track(() => value.apply(target, args), { kind, title, timeout });
					}
				: value.bind(target);
			methods.set(property, { value: value as Method, method });
			return method;
		},
	});
}
