import type { CollabUiRequestDraft, CollabUiResponseValue } from "@oh-my-pi/pi-wire";
import type { ExtensionAskDialogQuestion, ExtensionAskDialogResult } from "../extensibility/extensions/types";

export type RemoteDialogPromptClass = "agent-ask" | "extension-user";

export interface RemoteDialogProvenance {
	sessionId: string;
	generation: number;
	promptClass: RemoteDialogPromptClass;
}

export type RemoteDialogRequest =
	| (Extract<CollabUiRequestDraft, { kind: "select" }> & { provenance: RemoteDialogProvenance })
	| (Extract<CollabUiRequestDraft, { kind: "editor" }> & { provenance: RemoteDialogProvenance })
	| { kind: "confirm"; title: string; message: string; provenance: RemoteDialogProvenance }
	| { kind: "input"; title: string; placeholder?: string; provenance: RemoteDialogProvenance }
	| { kind: "ask"; questions: ExtensionAskDialogQuestion[]; provenance: RemoteDialogProvenance };

export type RemoteDialogResponse =
	| { kind: "answered"; value: CollabUiResponseValue | boolean | ExtensionAskDialogResult | undefined }
	| { kind: "unavailable" };

export interface RemoteDialogHost {
	request(request: RemoteDialogRequest, signal: AbortSignal): Promise<RemoteDialogResponse> | null;
}

export interface RegisteredRemoteDialogHost {
	readonly host: RemoteDialogHost;
	readonly signal: AbortSignal;
	isActive(): boolean;
}

interface HostEntry extends RegisteredRemoteDialogHost {
	controller: AbortController;
	active: boolean;
}

/** Session/generation-local set of surfaces that may answer eligible user dialogs. */
export class RemoteDialogHosts {
	#hosts: HostEntry[] = [];
	#generation: number;
	#disposed = false;
	#sessionId: string;

	constructor(sessionId: string, generation = 0) {
		this.#sessionId = sessionId;
		this.#generation = generation;
	}

	get sessionId(): string {
		return this.#sessionId;
	}

	get generation(): number {
		return this.#generation;
	}

	register(host: RemoteDialogHost): () => void {
		if (this.#disposed) return () => {};
		const controller = new AbortController();
		const entryGeneration = this.#generation;
		const entry: HostEntry = {
			host,
			controller,
			signal: controller.signal,
			active: true,
			isActive: () => entry.active && !this.#disposed && entryGeneration === this.#generation,
		};
		this.#hosts.push(entry);
		return () => this.#remove(entry);
	}

	list(generation = this.#generation): readonly RegisteredRemoteDialogHost[] {
		if (this.#disposed || generation !== this.#generation) return [];
		return this.#hosts.filter(entry => entry.isActive());
	}

	provenance(promptClass: RemoteDialogPromptClass): RemoteDialogProvenance {
		return { sessionId: this.#sessionId, generation: this.#generation, promptClass };
	}

	abortCurrentGeneration(): void {
		for (const entry of this.#hosts) this.#remove(entry);
	}

	advanceGeneration(sessionId = this.#sessionId): void {
		this.abortCurrentGeneration();
		this.#sessionId = sessionId;
		this.#generation += 1;
	}

	dispose(): void {
		this.#disposed = true;
		this.abortCurrentGeneration();
	}

	#remove(entry: HostEntry): void {
		if (!entry.active) return;
		entry.active = false;
		entry.controller.abort();
		this.#hosts = this.#hosts.filter(candidate => candidate !== entry);
	}
}
