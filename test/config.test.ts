import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RegistryRepositorySchema } from "@gitbeaker/rest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigManager } from "../src/config.js";

describe("ConfigManager", () => {
	let tmpDir: string;
	let configManager: ConfigManager;

	beforeEach(async () => {
		tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gcrc-test-"));
		configManager = new ConfigManager(tmpDir);
	});

	afterEach(async () => {
		await fsp.rm(tmpDir, { recursive: true, force: true });
	});

	it("should report not exists when no config file", async () => {
		expect(await configManager.exists()).toBe(false);
	});

	it("should return default config when no file exists", async () => {
		const config = await configManager.load();
		expect(config.targets).toEqual([]);
		expect(config.preferences).toBeDefined();
	});

	it("should save and load config", async () => {
		await configManager.save({
			preferences: { defaultConcurrency: 10, defaultKeepMostRecent: 5 },
			targets: [{ host: "https://gitlab.example.com" }],
		});

		expect(await configManager.exists()).toBe(true);

		const config = await configManager.load();
		expect(config.targets).toHaveLength(1);
		expect(config.targets[0]?.host).toBe("https://gitlab.example.com");
		expect(config.preferences?.defaultConcurrency).toBe(10);
	});

	it("should add a target", async () => {
		await configManager.addTarget("https://gitlab.one.com");
		await configManager.addTarget("https://gitlab.two.com");

		const targets = await configManager.getTargets();
		expect(targets).toHaveLength(2);
		expect(targets[0]?.host).toBe("https://gitlab.one.com");
		expect(targets[1]?.host).toBe("https://gitlab.two.com");
	});

	it("should update existing target preferences", async () => {
		await configManager.addTarget("https://gitlab.example.com", {
			defaultConcurrency: 10,
		});
		await configManager.addTarget("https://gitlab.example.com", {
			defaultConcurrency: 30,
		});

		const targets = await configManager.getTargets();
		expect(targets).toHaveLength(1);
		expect(targets[0]?.preferences?.defaultConcurrency).toBe(30);
	});

	it("should remove a target and its cache", async () => {
		const fakeRepo = {
			id: 1,
			path: "test",
		} as RegistryRepositorySchema;
		await configManager.addTarget("https://gitlab.example.com");
		await configManager.saveCache("https://gitlab.example.com", [fakeRepo]);

		const removed = await configManager.removeTarget(
			"https://gitlab.example.com",
		);
		expect(removed).toBe(true);

		const targets = await configManager.getTargets();
		expect(targets).toHaveLength(0);

		const repos = await configManager.loadCache("https://gitlab.example.com");
		expect(repos).toEqual([]);
	});

	it("should return false when removing non-existent target", async () => {
		const removed = await configManager.removeTarget("https://nope.com");
		expect(removed).toBe(false);
	});

	it("should update global preferences", async () => {
		await configManager.save({
			preferences: { defaultConcurrency: 20 },
			targets: [],
		});

		await configManager.updatePreferences({ defaultConcurrency: 50 });

		const config = await configManager.load();
		expect(config.preferences?.defaultConcurrency).toBe(50);
	});

	it("should update target-specific preferences", async () => {
		await configManager.addTarget("https://gitlab.example.com", {
			defaultConcurrency: 10,
		});

		await configManager.updatePreferences(
			{ defaultConcurrency: 99 },
			"https://gitlab.example.com",
		);

		const target = await configManager.getTarget("https://gitlab.example.com");
		expect(target?.preferences?.defaultConcurrency).toBe(99);
	});

	it("should get effective preferences merging global and target", async () => {
		await configManager.save({
			preferences: { defaultConcurrency: 20, defaultKeepMostRecent: 5 },
			targets: [
				{
					host: "https://gitlab.example.com",
					preferences: { defaultConcurrency: 50 },
				},
			],
		});

		const prefs = await configManager.getEffectivePreferences(
			"https://gitlab.example.com",
		);
		expect(prefs.defaultConcurrency).toBe(50); // target overrides
		expect(prefs.defaultKeepMostRecent).toBe(5); // from global
	});

	describe("Repository cache", () => {
		const fakeRepo = {
			id: 42,
			path: "my-group/my-project",
			tags_count: 10,
			project_id: 1,
			location: "gitlab.com/my-group/my-project",
			created_at: "2024-01-01T00:00:00Z",
		} as RegistryRepositorySchema;

		it("should return empty array for missing cache", async () => {
			const repos = await configManager.loadCache("https://gitlab.example.com");
			expect(repos).toEqual([]);
		});

		it("should save and load cache", async () => {
			await configManager.saveCache("https://gitlab.example.com", [fakeRepo]);

			const repos = await configManager.loadCache("https://gitlab.example.com");
			expect(repos).toHaveLength(1);
			expect(repos[0]?.id).toBe(42);
		});

		it("should isolate caches per host", async () => {
			await configManager.saveCache("https://gitlab.one.com", [fakeRepo]);
			await configManager.saveCache("https://gitlab.two.com", [
				{ ...fakeRepo, id: 99 } as RegistryRepositorySchema,
			]);

			const repos1 = await configManager.loadCache("https://gitlab.one.com");
			const repos2 = await configManager.loadCache("https://gitlab.two.com");
			expect(repos1).toHaveLength(1);
			expect(repos1[0]?.id).toBe(42);
			expect(repos2).toHaveLength(1);
			expect(repos2[0]?.id).toBe(99);
		});

		it("should add to cache without duplicating", async () => {
			await configManager.saveCache("https://gitlab.example.com", [fakeRepo]);
			await configManager.addToCache("https://gitlab.example.com", {
				...fakeRepo,
				tags_count: 20,
			} as RegistryRepositorySchema);

			const repos = await configManager.loadCache("https://gitlab.example.com");
			expect(repos).toHaveLength(1);
			expect(repos[0]?.tags_count).toBe(20);
		});

		it("should add new repo to cache", async () => {
			await configManager.saveCache("https://gitlab.example.com", [fakeRepo]);
			await configManager.addToCache("https://gitlab.example.com", {
				...fakeRepo,
				id: 99,
			} as RegistryRepositorySchema);

			const repos = await configManager.loadCache("https://gitlab.example.com");
			expect(repos).toHaveLength(2);
		});

		it("should clear cache", async () => {
			await configManager.saveCache("https://gitlab.example.com", [fakeRepo]);
			await configManager.clearCache("https://gitlab.example.com");

			const repos = await configManager.loadCache("https://gitlab.example.com");
			expect(repos).toEqual([]);
		});

		it("should update lastCacheUpdate on target when saving cache", async () => {
			await configManager.addTarget("https://gitlab.example.com");
			await configManager.saveCache("https://gitlab.example.com", [fakeRepo]);

			const target = await configManager.getTarget(
				"https://gitlab.example.com",
			);
			expect(target?.lastCacheUpdate).toBeDefined();
		});

		it("should return cache info", async () => {
			await configManager.addTarget("https://gitlab.example.com");
			await configManager.saveCache("https://gitlab.example.com", [fakeRepo]);

			const info = await configManager.getCacheInfo(
				"https://gitlab.example.com",
			);
			expect(info.count).toBe(1);
			expect(info.lastUpdated).toBeDefined();
			expect(info.path).toContain("repositories-");
		});
	});

	describe("Token management", () => {
		it("should save and retrieve token from config", async () => {
			await configManager.addTarget("https://gitlab.example.com");
			await configManager.saveToken(
				"https://gitlab.example.com",
				"glpat-test123",
				"config",
			);

			const token = await configManager.getToken("https://gitlab.example.com");
			expect(token).toBe("glpat-test123");
		});

		it("should return undefined for host without token", async () => {
			await configManager.addTarget("https://gitlab.example.com");
			const token = await configManager.getToken("https://gitlab.example.com");
			expect(token).toBeUndefined();
		});

		it("should return undefined for unknown host", async () => {
			const token = await configManager.getToken("https://unknown.com");
			expect(token).toBeUndefined();
		});

		it("should prefer env var over config token", async () => {
			await configManager.addTarget("https://gitlab.example.com");
			await configManager.saveToken(
				"https://gitlab.example.com",
				"config-token",
				"config",
			);

			const originalEnv = process.env.GITLAB_TOKEN;
			process.env.GITLAB_TOKEN = "env-token";
			try {
				const token = await configManager.getToken(
					"https://gitlab.example.com",
				);
				expect(token).toBe("env-token");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.GITLAB_TOKEN;
				} else {
					process.env.GITLAB_TOKEN = originalEnv;
				}
			}
		});

		it("should delete token from config", async () => {
			await configManager.addTarget("https://gitlab.example.com");
			await configManager.saveToken(
				"https://gitlab.example.com",
				"glpat-test123",
				"config",
			);
			await configManager.deleteToken("https://gitlab.example.com");

			const token = await configManager.getToken("https://gitlab.example.com");
			expect(token).toBeUndefined();

			const target = await configManager.getTarget(
				"https://gitlab.example.com",
			);
			expect(target?.token).toBeUndefined();
			expect(target?.tokenStorage).toBeUndefined();
		});

		it("should report token status correctly", async () => {
			await configManager.addTarget("https://gitlab.example.com");

			let status = await configManager.getTokenStatus(
				"https://gitlab.example.com",
			);
			expect(status).toEqual({ stored: false, source: "none" });

			await configManager.saveToken(
				"https://gitlab.example.com",
				"glpat-test",
				"config",
			);
			status = await configManager.getTokenStatus("https://gitlab.example.com");
			expect(status).toEqual({ stored: true, source: "config" });
		});

		it("should report env token status", async () => {
			const originalEnv = process.env.GITLAB_TOKEN;
			process.env.GITLAB_TOKEN = "env-token";
			try {
				const status = await configManager.getTokenStatus(
					"https://gitlab.example.com",
				);
				expect(status).toEqual({ stored: true, source: "env" });
			} finally {
				if (originalEnv === undefined) {
					delete process.env.GITLAB_TOKEN;
				} else {
					process.env.GITLAB_TOKEN = originalEnv;
				}
			}
		});

		it("should store token and storage type in config file", async () => {
			await configManager.addTarget("https://gitlab.example.com");
			await configManager.saveToken(
				"https://gitlab.example.com",
				"my-token",
				"config",
			);

			const config = await configManager.load();
			const target = config.targets.find(
				(t) => t.host === "https://gitlab.example.com",
			);
			expect(target?.token).toBe("my-token");
			expect(target?.tokenStorage).toBe("config");
		});

		it("should remove token when removing target", async () => {
			await configManager.addTarget("https://gitlab.example.com");
			await configManager.saveToken(
				"https://gitlab.example.com",
				"my-token",
				"config",
			);

			await configManager.removeTarget("https://gitlab.example.com");

			const token = await configManager.getToken("https://gitlab.example.com");
			expect(token).toBeUndefined();
		});
	});

	describe("XDG_CONFIG_HOME", () => {
		it("should use custom config dir", () => {
			const manager = new ConfigManager("/custom/path");
			expect(manager.dir).toBe("/custom/path");
			expect(manager.path).toBe("/custom/path/config.yaml");
		});
	});
});
