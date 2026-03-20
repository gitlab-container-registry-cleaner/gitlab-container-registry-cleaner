import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { RegistryRepositorySchema } from "@gitbeaker/rest";
import { parse, stringify } from "yaml";

const execFileAsync = promisify(execFile);

export interface TargetPreferences {
	defaultConcurrency?: number;
	defaultKeepMostRecent?: number;
}

export type TokenStorage = "config" | "keyring";

export interface Target {
	host: string;
	lastCacheUpdate?: string;
	preferences?: TargetPreferences;
	tokenStorage?: TokenStorage;
	token?: string;
}

export interface Config {
	preferences?: TargetPreferences;
	targets: Target[];
}

const DEFAULT_CONFIG: Config = {
	preferences: {
		defaultConcurrency: 20,
		defaultKeepMostRecent: 0,
	},
	targets: [],
};

function getConfigDir(): string {
	const xdgConfig =
		process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
	return path.join(xdgConfig, "gitlab-registry-cleaner");
}

export class ConfigManager {
	private configDir: string;
	private configPath: string;

	constructor(configDir?: string) {
		this.configDir = configDir ?? getConfigDir();
		this.configPath = path.join(this.configDir, "config.yaml");
	}

	get dir(): string {
		return this.configDir;
	}

	get path(): string {
		return this.configPath;
	}

	private async ensureDir(): Promise<void> {
		await fsp.mkdir(this.configDir, { recursive: true, mode: 0o700 });
	}

	async exists(): Promise<boolean> {
		try {
			await fsp.access(this.configPath);
			return true;
		} catch {
			return false;
		}
	}

	async load(): Promise<Config> {
		if (!(await this.exists())) {
			return { ...DEFAULT_CONFIG, targets: [] };
		}
		const content = await fsp.readFile(this.configPath, "utf-8");
		const config = parse(content) as Config;
		return config;
	}

	async save(config: Config): Promise<void> {
		await this.ensureDir();
		const content = stringify(config);
		await fsp.writeFile(this.configPath, content, { mode: 0o600 });
	}

	async addTarget(
		host: string,
		preferences?: TargetPreferences,
	): Promise<void> {
		const config = await this.load();
		const existing = config.targets.find((t) => t.host === host);
		if (existing) {
			if (preferences) {
				existing.preferences = preferences;
			}
		} else {
			config.targets.push({ host, preferences });
		}
		await this.save(config);
	}

	async removeTarget(host: string): Promise<boolean> {
		const config = await this.load();
		const index = config.targets.findIndex((t) => t.host === host);
		if (index < 0) return false;
		const target = config.targets[index];
		if (target?.tokenStorage === "keyring") {
			await this.keyringDelete(host);
		}
		config.targets.splice(index, 1);
		await this.save(config);
		await this.clearCache(host);
		return true;
	}

	async updatePreferences(
		preferences: TargetPreferences,
		host?: string,
	): Promise<void> {
		const config = await this.load();
		if (host) {
			const target = config.targets.find((t) => t.host === host);
			if (target) {
				target.preferences = { ...target.preferences, ...preferences };
			}
		} else {
			config.preferences = { ...config.preferences, ...preferences };
		}
		await this.save(config);
	}

	async getTarget(host: string): Promise<Target | undefined> {
		const config = await this.load();
		return config.targets.find((t) => t.host === host);
	}

	async getTargets(): Promise<Target[]> {
		const config = await this.load();
		return config.targets;
	}

	async getEffectivePreferences(host?: string): Promise<TargetPreferences> {
		const config = await this.load();
		const globalPrefs = config.preferences ?? {};
		if (host) {
			const target = config.targets.find((t) => t.host === host);
			return { ...globalPrefs, ...target?.preferences };
		}
		return globalPrefs;
	}

	private getCachePath(host: string): string {
		const sanitized = host
			.replace(/^https?:\/\//, "")
			.replace(/[^a-zA-Z0-9.-]/g, "_");
		return path.join(this.configDir, `repositories-${sanitized}.json`);
	}

	async loadCache(host: string): Promise<RegistryRepositorySchema[]> {
		const cachePath = this.getCachePath(host);
		try {
			const content = await fsp.readFile(cachePath, "utf-8");
			return JSON.parse(content) as RegistryRepositorySchema[];
		} catch {
			return [];
		}
	}

	async saveCache(
		host: string,
		repositories: RegistryRepositorySchema[],
	): Promise<string> {
		await this.ensureDir();
		const cachePath = this.getCachePath(host);
		await fsp.writeFile(
			cachePath,
			JSON.stringify(repositories, undefined, "  "),
			{ mode: 0o600 },
		);

		// Update lastCacheUpdate on the target
		const config = await this.load();
		const target = config.targets.find((t) => t.host === host);
		if (target) {
			target.lastCacheUpdate = new Date().toISOString();
			await this.save(config);
		}

		return cachePath;
	}

	async addToCache(
		host: string,
		repo: RegistryRepositorySchema,
	): Promise<void> {
		const repos = await this.loadCache(host);
		const existing = repos.findIndex((r) => r.id === repo.id);
		if (existing >= 0) {
			repos[existing] = repo;
		} else {
			repos.push(repo);
		}
		await this.saveCache(host, repos);
	}

	async clearCache(host: string): Promise<void> {
		const cachePath = this.getCachePath(host);
		try {
			await fsp.unlink(cachePath);
		} catch {
			// ignore if not exists
		}
	}

	// --- Token management ---

	private static readonly KEYRING_SERVICE = "gitlab-registry-cleaner";

	async saveToken(
		host: string,
		token: string,
		storage: TokenStorage = "config",
	): Promise<void> {
		if (storage === "keyring") {
			const supported = await this.isKeyringAvailable();
			if (!supported) {
				throw new Error(
					"Keyring is not available on this system. Use config storage instead.",
				);
			}
			await this.keyringSet(host, token);
			// Remove token from config if it was stored there before
			const config = await this.load();
			const target = config.targets.find((t) => t.host === host);
			if (target) {
				delete target.token;
				target.tokenStorage = "keyring";
				await this.save(config);
			}
		} else {
			const config = await this.load();
			const target = config.targets.find((t) => t.host === host);
			if (target) {
				target.token = token;
				target.tokenStorage = "config";
				await this.save(config);
			}
		}
	}

	async getToken(host: string): Promise<string | undefined> {
		// Environment variable always takes precedence
		if (process.env.GITLAB_TOKEN) {
			return process.env.GITLAB_TOKEN;
		}

		const config = await this.load();
		const target = config.targets.find((t) => t.host === host);
		if (!target) return undefined;

		if (target.tokenStorage === "keyring") {
			return this.keyringGet(host);
		}

		return target.token;
	}

	async deleteToken(host: string): Promise<void> {
		const config = await this.load();
		const target = config.targets.find((t) => t.host === host);
		if (!target) return;

		if (target.tokenStorage === "keyring") {
			await this.keyringDelete(host);
		}
		delete target.token;
		delete target.tokenStorage;
		await this.save(config);
	}

	async getTokenStatus(host: string): Promise<{
		stored: boolean;
		source: "env" | "keyring" | "config" | "none";
	}> {
		if (process.env.GITLAB_TOKEN) {
			return { stored: true, source: "env" };
		}

		const config = await this.load();
		const target = config.targets.find((t) => t.host === host);
		if (!target) return { stored: false, source: "none" };

		if (target.tokenStorage === "keyring") {
			const token = await this.keyringGet(host);
			return { stored: !!token, source: token ? "keyring" : "none" };
		}

		if (target.token) {
			return { stored: true, source: "config" };
		}

		return { stored: false, source: "none" };
	}

	async isKeyringAvailable(): Promise<boolean> {
		const platform = process.platform;
		try {
			if (platform === "darwin") {
				await execFileAsync("security", ["help"], {});
				return true;
			}
			if (platform === "linux") {
				await execFileAsync("secret-tool", ["--version"], {});
				return true;
			}
		} catch {
			return false;
		}
		return false;
	}

	private async keyringSet(host: string, token: string): Promise<void> {
		const account = this.keyringAccount(host);
		const platform = process.platform;

		if (platform === "darwin") {
			// Delete existing entry first (ignore errors)
			try {
				await execFileAsync("security", [
					"delete-generic-password",
					"-s",
					ConfigManager.KEYRING_SERVICE,
					"-a",
					account,
				]);
			} catch {
				// ignore if not exists
			}
			await execFileAsync("security", [
				"add-generic-password",
				"-s",
				ConfigManager.KEYRING_SERVICE,
				"-a",
				account,
				"-w",
				token,
			]);
		} else if (platform === "linux") {
			const child = execFile("secret-tool", [
				"store",
				"--label",
				`GitLab token for ${host}`,
				"service",
				ConfigManager.KEYRING_SERVICE,
				"account",
				account,
			]);
			child.stdin?.write(token);
			child.stdin?.end();
			await new Promise<void>((resolve, reject) => {
				child.on("close", (code) =>
					code === 0
						? resolve()
						: reject(new Error(`secret-tool exited with code ${code}`)),
				);
			});
		} else {
			throw new Error(`Keyring not supported on platform: ${platform}`);
		}
	}

	private async keyringGet(host: string): Promise<string | undefined> {
		const account = this.keyringAccount(host);
		const platform = process.platform;

		try {
			if (platform === "darwin") {
				const { stdout } = await execFileAsync("security", [
					"find-generic-password",
					"-s",
					ConfigManager.KEYRING_SERVICE,
					"-a",
					account,
					"-w",
				]);
				return stdout.trim();
			}
			if (platform === "linux") {
				const { stdout } = await execFileAsync("secret-tool", [
					"lookup",
					"service",
					ConfigManager.KEYRING_SERVICE,
					"account",
					account,
				]);
				return stdout.trim();
			}
		} catch {
			return undefined;
		}
		return undefined;
	}

	private async keyringDelete(host: string): Promise<void> {
		const account = this.keyringAccount(host);
		const platform = process.platform;

		try {
			if (platform === "darwin") {
				await execFileAsync("security", [
					"delete-generic-password",
					"-s",
					ConfigManager.KEYRING_SERVICE,
					"-a",
					account,
				]);
			} else if (platform === "linux") {
				await execFileAsync("secret-tool", [
					"clear",
					"service",
					ConfigManager.KEYRING_SERVICE,
					"account",
					account,
				]);
			}
		} catch {
			// ignore if not exists
		}
	}

	private keyringAccount(host: string): string {
		return host.replace(/^https?:\/\//, "");
	}

	// --- Cache management ---

	async getCacheInfo(
		host: string,
	): Promise<{ path: string; count: number; lastUpdated?: string }> {
		const cachePath = this.getCachePath(host);
		const repos = await this.loadCache(host);
		const config = await this.load();
		const target = config.targets.find((t) => t.host === host);
		return {
			path: cachePath,
			count: repos.length,
			lastUpdated: target?.lastCacheUpdate,
		};
	}
}
