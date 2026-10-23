import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { AuthStorage, REMOTE_REFRESH_SENTINEL } from "@oh-my-pi/pi-ai";
import { AuthBrokerClient, RemoteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-broker";
import { TempDir } from "@oh-my-pi/pi-utils";
import { readJsonl } from "@oh-my-pi/pi-utils/stream";
import type { Server, Subprocess } from "bun";

const PROVIDER = "broker-extension-oauth-test";
const BEARER = "isolated-broker-extension-token";
const CLI_PATH = path.resolve(import.meta.dir, "../src/cli.ts");

describe("auth-broker serve extension OAuth", () => {
	let tmp: TempDir;
	let tokenServer: Server<undefined>;
	let tokenRequests: string[];
	let extensionPath: string;
	let dbPath: string;
	let credentialId: number;
	let broker: Subprocess<"ignore", "pipe", "pipe"> | undefined;
	let output: Promise<void> | undefined;
	let stderr: Promise<string> | undefined;
	let clientStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tmp = await TempDir.create("@broker-extension-oauth-");
		tokenRequests = [];
		tokenServer = Bun.serve({
			port: 0,
			async fetch(request) {
				const body = (await request.json()) as { refresh_token: string };
				const expected = tokenRequests.length === 0 ? "initial-refresh" : `rotated-refresh-${tokenRequests.length}`;
				if (body.refresh_token !== expected) return Response.json({ error: "invalid_grant" }, { status: 400 });
				tokenRequests.push(body.refresh_token);
				return Response.json({
					access_token: `fresh-access-${tokenRequests.length}`,
					refresh_token: `rotated-refresh-${tokenRequests.length}`,
				});
			},
		});
		extensionPath = tmp.join("provider.ts");
		await Bun.write(
			extensionPath,
			`export default function (pi) {
	pi.registerProvider(${JSON.stringify(PROVIDER)}, {
		baseUrl: "https://example.invalid/v1",
		api: "openai-completions",
		fetchDynamicModels() { throw new Error("Broker must not discover models"); },
		oauth: {
			name: "Broker extension OAuth test",
			async login() { throw new Error("Refresh must not require another login"); },
			async refreshToken(credentials, signal) {
				const response = await fetch(${JSON.stringify(`http://127.0.0.1:${tokenServer.port}/token`)}, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ refresh_token: credentials.refresh }),
					signal,
				});
				if (!response.ok) throw new Error("Token exchange failed");
				const token = await response.json();
				return { ...credentials, access: token.access_token, refresh: token.refresh_token, expires: Date.now() + 3600000 };
			},
		},
	});
}
`,
		);
		await Bun.write(tmp.join(".omp/auth-broker.token"), BEARER);
		await Bun.write(
			tmp.join(".omp/agent/extensions/ambient.ts"),
			`await Bun.write(${JSON.stringify(tmp.join("ambient-loaded"))}, "loaded");
export default function () {}
`,
		);
		dbPath = tmp.join(".omp/agent/agent.db");
		const auth = await AuthStorage.create(dbPath);
		try {
			await auth.credentials.set(PROVIDER, {
				type: "oauth",
				access: "expired-access",
				refresh: "initial-refresh",
				expires: Date.now() - 60_000,
			});
			credentialId = auth.credentials.list(PROVIDER)[0].id;
		} finally {
			auth.close();
		}
	});

	afterEach(async () => {
		clientStorage?.close();
		clientStorage = undefined;
		broker?.kill("SIGTERM");
		await broker?.exited;
		await output?.catch(() => undefined);
		await stderr;
		broker = undefined;
		output = undefined;
		stderr = undefined;
		tokenServer.stop(true);
		await tmp.remove();
	});

	async function startBroker(extensions: string[] = []): Promise<AuthBrokerClient> {
		const ready = Promise.withResolvers<string>();
		broker = Bun.spawn(
			[
				process.execPath,
				CLI_PATH,
				"auth-broker",
				"serve",
				"--bind=127.0.0.1:0",
				...extensions.flatMap(file => ["-e", file]),
			],
			{
				cwd: tmp.path(),
				env: {
					...process.env,
					HOME: tmp.path(),
					PI_CONFIG_DIR: ".omp",
					PI_CODING_AGENT_DIR: tmp.join(".omp/agent"),
					OMP_PROFILE: "",
					PI_PROFILE: "",
					OMP_AUTH_BROKER_URL: "",
					OMP_AUTH_BROKER_TOKEN: "",
					PI_CONFIG_FILES: "",
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		stderr = new Response(broker.stderr).text();
		output = (async () => {
			for await (const event of readJsonl<{ message?: string; url?: string }>(broker!.stdout)) {
				if (event.message === "auth-broker listening" && event.url) ready.resolve(event.url);
			}
		})();
		void output.catch(ready.reject);
		void broker.exited.then(async code => ready.reject(new Error(`Broker exited ${code}: ${await stderr}`)));
		return new AuthBrokerClient({ url: await ready.promise, token: BEARER });
	}

	test("expired extension grants renew repeatedly without exposing refresh tokens to clients", async () => {
		const client = await startBroker([extensionPath]);
		// Join the startup sweep, or reuse its mint if it finished before the listener was ready.
		await client.refreshCredential(credentialId, undefined, "auth-recovery");
		clientStorage = new AuthStorage(new RemoteAuthCredentialStore({ client, streamSnapshots: false }));
		await clientStorage.credentials.revalidate();
		expect(await clientStorage.keys.get(PROVIDER)).toBe("fresh-access-1");
		const wire = clientStorage.credentials.get(PROVIDER);
		expect(wire?.type === "oauth" ? wire.refresh : undefined).toBe(REMOTE_REFRESH_SENTINEL);

		await client.refreshCredential(credentialId);
		await clientStorage.credentials.revalidate();
		expect(await clientStorage.keys.get(PROVIDER)).toBe("fresh-access-2");
		expect(tokenRequests).toEqual(["initial-refresh", "rotated-refresh-1"]);

		const persisted = await AuthStorage.create(dbPath);
		try {
			await persisted.credentials.reload();
			expect(persisted.credentials.list(PROVIDER)[0].id).toBe(credentialId);
			const credential = persisted.credentials.get(PROVIDER);
			expect(credential?.type === "oauth" ? credential.refresh : undefined).toBe("rotated-refresh-2");
		} finally {
			persisted.close();
		}
		expect(await Bun.file(tmp.join("ambient-loaded")).exists()).toBe(false);
	}, 30_000);

	test("the default credential broker does not execute ambient extensions", async () => {
		const client = await startBroker();
		expect((await client.healthz()).ok).toBe(true);
		expect(await Bun.file(tmp.join("ambient-loaded")).exists()).toBe(false);
		expect(tokenRequests).toEqual([]);
	}, 30_000);
});
