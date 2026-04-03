import { Command } from "commander";
import {
	DEFAULT_CONCURRENCY,
	DEFAULT_DELETE_REGEX,
	DEFAULT_END_INDEX,
	DEFAULT_KEEP_MOST_RECENT,
	DEFAULT_KEEP_REGEX,
	DEFAULT_OLDER_THAN_DAYS,
	DEFAULT_START_INDEX,
	DEFAULT_TAGS_PER_PAGE,
	GitLabContainerRepositoryCleaner,
} from "./cleaner.js";
import { ConfigManager, type TokenStorage } from "./config.js";
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	RegistryRepositorySchema,
	RegistryRepositoryTagSchema,
} from "@gitbeaker/rest";
import {
	confirm,
	input,
	number,
	password,
	Separator,
	select,
} from "@inquirer/prompts";
import liveCheckbox from "./live-checkbox.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = path.join(__dirname, "../package.json");

const packageJson = await fs.readFile(packageJsonPath, "utf-8");
const packageData = JSON.parse(packageJson) as { version: string };
const version = packageData.version;

const configManager = new ConfigManager();

async function main() {
	const program = new Command();

	program.version(version);
	program.description(
		`GitLab Container Registry Cleaner ${version}\nClean tags from a container repository concurrently using given regex and age filter.\nSee [command] --help for more details.`,
	);

	// list
	const listCmd = program
		.command("list")
		.summary("List Container Repositories.");

	// list all
	listCmd
		.command("all")
		.description(
			"List all instance-wide Container Repositories using GitLab REST API /registry/repositories/:id " +
				"to list repository per ID in parallel from given start and end index. " +
				"May yield lots of 404 on server side as not each ID will exist.",
		)
		.option(
			"-s, --start-index <number>",
			"Repository ID index to start with",
			DEFAULT_START_INDEX.toString(),
		)
		.option(
			"-e, --end-index <number>",
			"Repository ID index to end with",
			DEFAULT_END_INDEX.toString(),
		)
		.option(
			"-c, --concurrency <number>",
			"Number of promises running concurrently when requesting GitLab API",
			DEFAULT_CONCURRENCY.toString(),
		)
		.option(
			"-o, --output <file>",
			"Output repositories list as JSON to file. By default will print to stdout.",
		)
		.action(actionListAllRepositories);

	listCmd
		.command("project")
		.description("List a project's Container Repositories.")
		.action(actionListProjectRepositories)
		.argument(
			"<project-id>",
			"Project ID or path such as '42' or full project path 'group/subgroup/project-name'",
		)
		.option(
			"-o, --output <file>",
			"Output repositories list as JSON to file. By default will print to stdout.",
		);

	listCmd
		.command("group")
		.description("List a group's Container Repositories.")
		.action(actionListGroupRepositories)
		.argument(
			"<group-id>",
			"Group ID or path such as '42' or full group or subgroup path 'group/subgroup'",
		)
		.option(
			"-o, --output <file>",
			"Output repositories list as JSON to file. By default will print to stdout.",
		);

	// cache
	const cacheCmd = program
		.command("cache")
		.summary("Manage the local repository cache.");

	cacheCmd
		.command("update")
		.description(
			"Fetch repositories from GitLab and update the local cache. " +
				"Uses the 'list all' strategy (ID range scan) by default.",
		)
		.option(
			"-s, --start-index <number>",
			"Repository ID index to start with",
			DEFAULT_START_INDEX.toString(),
		)
		.option(
			"-e, --end-index <number>",
			"Repository ID index to end with",
			DEFAULT_END_INDEX.toString(),
		)
		.option(
			"-c, --concurrency <number>",
			"Number of promises running concurrently when requesting GitLab API",
			DEFAULT_CONCURRENCY.toString(),
		)
		.action(actionCacheUpdate);

	cacheCmd
		.command("add")
		.description("Add a single repository to the cache by ID.")
		.argument("<repository-id>", "Container Repository ID")
		.action(actionCacheAdd);

	cacheCmd
		.command("clear")
		.description("Clear the local repository cache.")
		.action(actionCacheClear);

	cacheCmd
		.command("show")
		.description("Show cache status and contents.")
		.action(actionCacheShow);

	// config
	const configCmd = program.command("config").summary("Manage configuration.");

	configCmd
		.command("edit")
		.description("Interactively edit configuration (targets and preferences).")
		.action(actionConfigEdit);

	configCmd
		.command("show")
		.description("Show current configuration.")
		.action(actionConfigShow);

	configCmd
		.command("add-target")
		.description("Add a GitLab target host.")
		.argument("<host>", "GitLab host URL (e.g. https://gitlab.example.com)")
		.action(actionConfigAddTarget);

	// auth
	const authCmd = program
		.command("auth")
		.summary("Manage authentication with GitLab.");

	authCmd
		.command("login")
		.description(
			"Authenticate with a GitLab instance. " +
				"Stores your token in the config file by default, " +
				"or in your operating system's keyring with --use-keyring.",
		)
		.option("--hostname <host>", "GitLab host URL")
		.option("--token <token>", "GitLab personal access token")
		.option("--use-keyring", "Store token in OS keyring instead of config file")
		.option("--stdin", "Read token from standard input")
		.action(actionAuthLogin);

	authCmd
		.command("status")
		.description("Show authentication status for configured targets.")
		.action(actionAuthStatus);

	authCmd
		.command("logout")
		.description("Remove stored credentials for a GitLab instance.")
		.option("--hostname <host>", "GitLab host URL")
		.action(actionAuthLogout);

	// clean
	program
		.command("clean")
		.summary("Clean tags from a container repository.")
		.description(
			"Clean tags from a container repository concurrently using given regex and age filter. " +
				"Only tags matching BOTH regex and age will be deleted. " +
				"THIS IS A DESTRUCTIVE ACTION. Use with care.",
		)
		.argument(
			"[repository-id-or-path]",
			"Container Repository ID or path to cleanup.",
		)
		.option(
			"-k, --keep-regex <regex>",
			"Tags matching this regex will be kept. Match everything by default for safety.",
			DEFAULT_KEEP_REGEX,
		)
		.option(
			"-d, --delete-regex <regex>",
			"Tags matching this regex will be deleted. Do not match anything by default for safety .",
			DEFAULT_DELETE_REGEX,
		)
		.option(
			"-a, --older-than-days <number>",
			"Tags older than specified days will be deleted, all younger than N will be kept.",
			DEFAULT_OLDER_THAN_DAYS.toString(),
		)
		.option(
			"-c, --concurrency <number>",
			"Number of promises running concurrently when requesting GitLab API",
			DEFAULT_CONCURRENCY.toString(),
		)
		.option(
			"--tags-per-page <number>",
			"Number of tags to request per page when listing tags from GitLab API. Default is 50.",
			DEFAULT_TAGS_PER_PAGE.toString(),
		)
		.option("--no-dry-run", "Disable dry-run. Dry run is enabled by default.")
		.option(
			"-o, --output-tags <file>",
			"Output tag list to be deleted as JSON to specified file. Useful with dry-run to check nothing important will be deleted.",
		)
		.option(
			"-n, --keep-most-recent <number>",
			"Keep N most recent tags even if they match deletion criteria.",
			DEFAULT_KEEP_MOST_RECENT.toString(),
		)
		.option(
			"-j, --json-input <file>",
			"JSON file containing pre-fetched repository list. (deprecated: use 'cache' commands instead)",
		)
		.option(
			"-v, --verbose",
			"Enable verbose output, including details of tags to be deleted.",
		)
		.action(actionCleanRepository);

	// When invoked with no arguments, run the guided default flow
	if (process.argv.length <= 2) {
		await actionDefault();
		return;
	}

	await program.parseAsync();
}

async function actionDefault() {
	const hasConfig = await configManager.exists();
	const targets = await configManager.getTargets();

	if (!hasConfig || targets.length === 0) {
		console.log("🔧 First-time setup detected");
		console.log("   Let's configure your GitLab connection.\n");
		await actionConfigEdit();

		const updatedTargets = await configManager.getTargets();
		if (updatedTargets.length === 0) {
			console.log(
				"\nNo targets configured. Run again to set up, or use 'config edit'.",
			);
			return;
		}
	}

	const host = await resolveHost();

	// Check if token is configured
	const tokenStatus = await configManager.getTokenStatus(host);
	if (!tokenStatus.stored) {
		console.log("\n⚠️  No token configured for this target.");
		await promptForToken(host);
	}

	const cache = await configManager.loadCache(host);

	if (cache.length === 0) {
		console.log(
			"\nℹ️  Repository cache is empty. Populate it now with 'cache update', or specify a repository ID with 'clean <id>'.",
		);
		return;
	}

	console.log(`\nUsing ${cache.length} cached repositories from ${host}\n`);

	// Delegate to clean with no arguments (interactive selection from cache)
	const token = await resolveToken(host);
	const prefs = await configManager.getEffectivePreferences(host);
	const concurrency = prefs.defaultConcurrency ?? DEFAULT_CONCURRENCY;
	const choices = buildRepositoryChoices(cache);

	const cleaner = new GitLabContainerRepositoryCleaner({
		gitlabHost: host,
		gitlabToken: token,
		dryRun: false,
		concurrency,
	});

	const repositoryIds = await liveCheckbox({
		message: "Select repositories to clean:",
		choices,
		pageSize: 15,
		fetchLabels: createFetchLabels(cleaner, cache, host, concurrency),
	});

	if (repositoryIds.length === 0) {
		console.log("No repositories selected.");
		return;
	}

	const keepMostRecentN =
		prefs.defaultKeepMostRecent ?? DEFAULT_KEEP_MOST_RECENT;
	printCleanupSettings({
		keepRegex: "^$",
		deleteRegex: ".*",
		olderThanDays: DEFAULT_OLDER_THAN_DAYS,
		keepMostRecentN,
	});

	for (const repositoryId of repositoryIds) {
		await cleaner.cleanupContainerRepositoryTags(repositoryId, {
			keepRegex: "^$",
			deleteRegex: ".*",
			keepMostRecentN,
			confirmDelete: interactiveConfirmDelete,
		});

		// Refresh cached tag count after deletion
		const updatedRepo = await cleaner.getContainerRepository(repositoryId);
		await configManager.addToCache(host, updatedRepo);
	}
}

async function interactiveConfirmDelete(
	tags: RegistryRepositoryTagSchema[],
): Promise<boolean> {
	if (tags.length === 0) return true;

	console.log("\nTags to delete:");
	for (const tag of tags) {
		const date = tag.created_at
			? new Date(tag.created_at).toLocaleDateString()
			: "unknown date";
		console.log(`  - ${tag.name} (${date})`);
	}
	console.log("");

	return confirm({
		message: `Delete ${tags.length} tag${tags.length === 1 ? "" : "s"}?`,
		default: false,
	});
}

function groupRepositoriesByTopLevel(
	repositories: RegistryRepositorySchema[],
): [string, RegistryRepositorySchema[]][] {
	const grouped: Record<string, RegistryRepositorySchema[]> = {};
	for (const repo of repositories) {
		const topLevel = repo.path.split("/")[0] as string;
		if (!grouped[topLevel]) {
			grouped[topLevel] = [];
		}
		grouped[topLevel].push(repo);
	}
	return Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b));
}

function buildRepositoryChoices(repositories: RegistryRepositorySchema[]) {
	return groupRepositoriesByTopLevel(repositories)
		.sort(([a], [b]) => a.localeCompare(b))
		.flatMap(([group, repos]) => [
			new Separator(`── ${group} ──`),
			...repos
				.sort((a, b) => a.path.localeCompare(b.path))
				.map((repo) => ({
					name: makeRepoLabel(repo),
					value: repo.id,
				})),
		]);
}

function printCleanupSettings(settings: {
	keepRegex: string;
	deleteRegex: string;
	olderThanDays: number;
	keepMostRecentN: number;
}) {
	console.log("\n📋 Cleanup settings:");
	console.log(`   Delete regex:      ${settings.deleteRegex}`);
	console.log(`   Keep regex:        ${settings.keepRegex}`);
	console.log(`   Older than:        ${settings.olderThanDays} days`);
	console.log(`   Keep most recent:  ${settings.keepMostRecentN} tags`);
	console.log("");
}

function makeRepoLabel(repo: RegistryRepositorySchema): string {
	const subPath = repo.path.split("/").slice(1).join("/");
	const tags = repo.tags_count ?? "?";
	return `${subPath} (${tags} tags)`;
}

function createFetchLabels(
	cleaner: GitLabContainerRepositoryCleaner,
	cachedRepos: RegistryRepositorySchema[],
	host: string,
	concurrency: number,
): (
	onUpdate: (value: number, newName: string) => void,
	signal: AbortSignal,
) => Promise<void> {
	return async (onUpdate, signal) => {
		const freshRepos: RegistryRepositorySchema[] = [];
		for (let i = 0; i < cachedRepos.length; i += concurrency) {
			if (signal.aborted) break;
			const batch = cachedRepos.slice(i, i + concurrency);
			const results = await Promise.allSettled(
				batch.map((r) => cleaner.getContainerRepository(r.id)),
			);
			for (const result of results) {
				if (result.status === "fulfilled") {
					const repo = result.value;
					freshRepos.push(repo);
					onUpdate(repo.id, makeRepoLabel(repo));
				}
			}
		}
		// Merge fresh data into cache: update fetched repos, keep others as-is
		const freshById = new Map(freshRepos.map((r) => [r.id, r]));
		const merged = cachedRepos.map((r) => freshById.get(r.id) ?? r);
		await configManager.saveCache(host, merged);
	};
}

/**
 * Resolve the GitLab host, checking (in order):
 * 1. GITLAB_HOST environment variable
 * 2. Config file targets (prompt if multiple)
 * 3. Prompt for URL
 */
async function resolveHost(): Promise<string> {
	if (process.env.GITLAB_HOST) {
		return process.env.GITLAB_HOST;
	}

	const targets = await configManager.getTargets();

	if (targets.length === 1) {
		// biome-ignore lint/style/noNonNullAssertion: length check guarantees existence
		return targets[0]!.host;
	}

	if (targets.length > 1) {
		const host = await select({
			message: "Select a GitLab target:",
			choices: targets.map((t) => ({
				name: t.host,
				value: t.host,
			})),
		});
		return host;
	}

	// No targets configured — prompt for one
	console.log("No GitLab targets configured.\n");
	const host = await input({
		message: "Enter your GitLab instance URL:",
		validate: validateUrl,
	});
	await configManager.addTarget(host);
	console.log(`✅ Configuration saved to ${configManager.path}\n`);
	return host;
}

async function resolveToken(host: string): Promise<string> {
	const token = await configManager.getToken(host);
	if (token) return token;

	throw new Error(
		`No GitLab token found for ${host}. Set GITLAB_TOKEN environment variable, or run 'auth login' to store your token.\n` +
			`Create a personal access token with 'api' scope at:\n` +
			`  ${host}/-/user_settings/personal_access_tokens`,
	);
}

async function actionListAllRepositories(opts: {
	startIndex: string;
	endIndex: string;
	concurrency: string;
	output: string;
}) {
	const host = await resolveHost();
	const token = await resolveToken(host);

	const cleaner = new GitLabContainerRepositoryCleaner({
		gitlabHost: host,
		gitlabToken: token,
		concurrency: Number.parseInt(opts.concurrency, 10),
	});

	await cleaner.getContainerRepositoriesConcurrently(
		Number.parseInt(opts.startIndex, 10),
		Number.parseInt(opts.endIndex, 10),
		opts.output,
	);
}

async function actionCleanRepository(
	repositoryIdOrPath: string | undefined,
	opts: {
		keepRegex: string;
		deleteRegex: string;
		olderThanDays: string;
		tagsPerPage: string;
		concurrency: string;
		dryRun: boolean;
		outputTags?: string;
		keepMostRecent: string;
		jsonInput?: string;
		verbose: boolean;
	},
) {
	const host = await resolveHost();
	const token = await resolveToken(host);

	let repositoryIds: number[];
	let repositories: RegistryRepositorySchema[] | undefined;

	if (opts.jsonInput) {
		console.warn(
			"⚠️  The -j/--json-input flag is deprecated. Use 'cache update' to populate the local cache instead.",
		);
		const jsonData = await fs.readFile(opts.jsonInput, "utf-8");
		repositories = JSON.parse(jsonData) as Array<RegistryRepositorySchema>;
	} else {
		// Try loading from cache
		const cached = await configManager.loadCache(host);
		if (cached.length > 0) {
			repositories = cached;
		}
	}

	const interactive = repositories && !repositoryIdOrPath;
	const concurrency = Number.parseInt(opts.concurrency, 10);

	if (repositories) {
		if (!repositoryIdOrPath) {
			const choices = buildRepositoryChoices(repositories);
			const fetchCleaner = new GitLabContainerRepositoryCleaner({
				gitlabHost: host,
				gitlabToken: token,
				concurrency,
			});
			repositoryIds = await liveCheckbox({
				message: "Select repositories to clean:",
				choices,
				pageSize: 15,
				fetchLabels: createFetchLabels(
					fetchCleaner,
					repositories,
					host,
					concurrency,
				),
			});
		} else if (Number.isNaN(Number(repositoryIdOrPath))) {
			// Look up repository by path
			const repository = repositories.find(
				(repo) => repo.path === repositoryIdOrPath,
			);
			if (!repository) {
				throw new Error(
					`Repository with path "${repositoryIdOrPath}" not found in cache. Run 'cache update' or use a repository ID.`,
				);
			}
			repositoryIds = [repository.id];
		} else {
			repositoryIds = [Number(repositoryIdOrPath)];
		}
	} else {
		if (!repositoryIdOrPath) {
			throw new Error(
				"Cache is empty. Run 'cache update' first, or specify a repository ID directly.",
			);
		}
		if (Number.isNaN(Number(repositoryIdOrPath))) {
			throw new Error(
				"Repository path specified but no cache or JSON input available. Run 'cache update' or use -j to specify a JSON input file.",
			);
		}
		repositoryIds = [Number(repositoryIdOrPath)];
	}

	const effectiveKeepRegex =
		interactive && opts.keepRegex === DEFAULT_KEEP_REGEX
			? "^$"
			: opts.keepRegex;
	const effectiveDeleteRegex =
		interactive && opts.deleteRegex === DEFAULT_DELETE_REGEX
			? ".*"
			: opts.deleteRegex;
	const effectiveOlderThanDays = Number.parseInt(opts.olderThanDays, 10);
	const effectiveKeepMostRecent = Number.parseInt(opts.keepMostRecent, 10);

	if (interactive) {
		printCleanupSettings({
			keepRegex: effectiveKeepRegex,
			deleteRegex: effectiveDeleteRegex,
			olderThanDays: effectiveOlderThanDays,
			keepMostRecentN: effectiveKeepMostRecent,
		});
	}

	for (const repositoryId of repositoryIds) {
		const cleaner = new GitLabContainerRepositoryCleaner({
			gitlabHost: host,
			gitlabToken: token,
			dryRun: interactive ? false : opts.dryRun,
			concurrency,
			verbose: opts.verbose,
		});

		await cleaner.cleanupContainerRepositoryTags(repositoryId, {
			keepRegex: effectiveKeepRegex,
			deleteRegex: effectiveDeleteRegex,
			tagsPerPage: Number.parseInt(opts.tagsPerPage, 10),
			olderThanDays: effectiveOlderThanDays,
			outputTags: opts.outputTags,
			keepMostRecentN: effectiveKeepMostRecent,
			...(interactive ? { confirmDelete: interactiveConfirmDelete } : {}),
		});

		// Refresh cached tag count after deletion (skip for dry-run)
		if (interactive || !opts.dryRun) {
			const updatedRepo = await cleaner.getContainerRepository(repositoryId);
			await configManager.addToCache(host, updatedRepo);
		}
	}
}

async function actionListProjectRepositories(
	projectId: string | number,
	opts: { output?: string },
) {
	const host = await resolveHost();
	const token = await resolveToken(host);

	const cleaner = new GitLabContainerRepositoryCleaner({
		gitlabHost: host,
		gitlabToken: token,
		dryRun: true,
		concurrency: 1,
	});
	await cleaner.getProjectContainerRepositories(projectId, opts.output);
}

async function actionListGroupRepositories(
	groupId: string | number,
	opts: { output?: string },
) {
	const host = await resolveHost();
	const token = await resolveToken(host);

	const cleaner = new GitLabContainerRepositoryCleaner({
		gitlabHost: host,
		gitlabToken: token,
		dryRun: true,
		concurrency: 1,
	});
	await cleaner.getGroupContainerRepositories(groupId, opts.output);
}

async function actionCacheUpdate(opts: {
	startIndex: string;
	endIndex: string;
	concurrency: string;
}) {
	const host = await resolveHost();
	const token = await resolveToken(host);

	console.log("🔄 Updating repository cache...");

	const cleaner = new GitLabContainerRepositoryCleaner({
		gitlabHost: host,
		gitlabToken: token,
		concurrency: Number.parseInt(opts.concurrency, 10),
	});

	const repositories = await cleaner.getContainerRepositoriesConcurrently(
		Number.parseInt(opts.startIndex, 10),
		Number.parseInt(opts.endIndex, 10),
		undefined,
		{ quiet: true },
	);

	const cachePath = await configManager.saveCache(host, repositories);
	console.log(`✅ Cache updated with ${repositories.length} repositories`);
	console.log(`📁 Cache location: ${cachePath}`);
}

async function actionCacheAdd(repositoryId: string) {
	const host = await resolveHost();
	const token = await resolveToken(host);

	const id = Number.parseInt(repositoryId, 10);
	if (Number.isNaN(id)) {
		throw new Error("Repository ID must be a number.");
	}

	console.log(`🔍 Fetching repository ${id}...`);

	const cleaner = new GitLabContainerRepositoryCleaner({
		gitlabHost: host,
		gitlabToken: token,
	});

	const repo = await cleaner.getContainerRepository(id);
	await configManager.addToCache(host, repo);
	console.log(`✅ Added repository "${repo.path}" (ID: ${repo.id}) to cache`);
}

async function actionCacheClear() {
	const host = await resolveHost();
	await configManager.clearCache(host);
	console.log("✅ Cache cleared.");
}

async function actionCacheShow() {
	const host = await resolveHost();
	const info = await configManager.getCacheInfo(host);
	const repos = await configManager.loadCache(host);

	console.log(`📁 Cache location: ${info.path}`);
	console.log(`🕐 Last updated: ${info.lastUpdated ?? "never"}`);
	console.log(`📦 Repositories: ${info.count}`);

	if (repos.length > 0) {
		console.log("");
		for (const [group, groupRepos] of groupRepositoriesByTopLevel(repos)) {
			console.log(`${group}/`);
			for (const repo of groupRepos.sort((a, b) =>
				a.path.localeCompare(b.path),
			)) {
				console.log(
					`  ${repo.path} (ID: ${repo.id}, Tags: ${repo.tags_count ?? "?"})`,
				);
			}
		}
	}
}

function validateUrl(value: string): true | string {
	try {
		new URL(value);
		return true;
	} catch {
		return "Please enter a valid URL (e.g. https://gitlab.example.com)";
	}
}

async function promptForToken(host: string): Promise<void> {
	console.log(`\nCreate a personal access token with 'api' scope at:`);
	console.log(`  ${host}/-/user_settings/personal_access_tokens\n`);

	const token = await password({
		message: "Paste your GitLab token:",
		mask: "*",
		validate: (value) => (value.length > 0 ? true : "Token cannot be empty"),
	});

	let storage: TokenStorage = "config";
	const keyringAvailable = await configManager.isKeyringAvailable();
	if (keyringAvailable) {
		storage = await select({
			message: "Where should the token be stored?",
			choices: [
				{
					name: "Configuration file (default)",
					value: "config" as const,
					description: `Stored in ${configManager.path} (file permissions 600)`,
				},
				{
					name: "OS keyring",
					value: "keyring" as const,
					description:
						process.platform === "darwin"
							? "Stored in macOS Keychain"
							: "Stored via Secret Service (GNOME Keyring / KWallet)",
				},
			],
		});
	}

	// Verify the token works before saving
	const testCleaner = new GitLabContainerRepositoryCleaner({
		gitlabHost: host,
		gitlabToken: token,
	});
	try {
		await testCleaner.verifyAuth();
	} catch (e: unknown) {
		const message = e instanceof Error ? e.message : String(e);
		console.error(`\n❌ ${message}`);
		return;
	}

	await configManager.saveToken(host, token, storage);
	console.log(
		`✅ Token saved${storage === "keyring" ? " to keyring" : " to config file"}`,
	);

	if (process.env.GITLAB_TOKEN) {
		console.warn(
			"\n⚠️  GITLAB_TOKEN environment variable is set and will take precedence over the saved token.",
		);
		console.warn(
			"   Unset it (or remove it from your .env file) to use the token you just saved.",
		);
	}
}

async function verifyToken(host: string, token: string): Promise<void> {
	const cleaner = new GitLabContainerRepositoryCleaner({
		gitlabHost: host,
		gitlabToken: token,
	});
	await cleaner.verifyAuth();
}

async function actionAuthLogin(opts: {
	hostname?: string;
	token?: string;
	useKeyring?: boolean;
	stdin?: boolean;
}) {
	let host: string;
	if (opts.hostname) {
		host = opts.hostname;
		// Ensure target exists
		const target = await configManager.getTarget(host);
		if (!target) {
			await configManager.addTarget(host);
		}
	} else {
		host = await resolveHost();
	}

	const storage: TokenStorage = opts.useKeyring ? "keyring" : "config";

	if (opts.stdin) {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stdin) {
			chunks.push(chunk as Buffer);
		}
		const token = Buffer.concat(chunks).toString().trim();
		if (!token) {
			throw new Error("No token received on stdin.");
		}
		await verifyToken(host, token);
		await configManager.saveToken(host, token, storage);
		console.log(`✅ Token saved for ${host}`);
		return;
	}

	if (opts.token) {
		await verifyToken(host, opts.token);
		await configManager.saveToken(host, opts.token, storage);
		console.log(`✅ Token saved for ${host}`);
		return;
	}

	// Interactive flow
	await promptForToken(host);
}

async function actionAuthStatus() {
	const targets = await configManager.getTargets();
	if (targets.length === 0) {
		console.log(
			"No targets configured. Run 'auth login' or 'config edit' to get started.",
		);
		return;
	}

	for (const target of targets) {
		const status = await configManager.getTokenStatus(target.host);
		const symbol = status.stored ? "✅" : "❌";
		const sourceLabel =
			status.source === "env"
				? "GITLAB_TOKEN env var"
				: status.source === "keyring"
					? "OS keyring"
					: status.source === "config"
						? "config file"
						: "not set";
		console.log(`${symbol} ${target.host} — ${sourceLabel}`);
	}
}

async function actionAuthLogout(opts: { hostname?: string }) {
	let host: string;
	if (opts.hostname) {
		host = opts.hostname;
	} else {
		const targets = await configManager.getTargets();
		if (targets.length === 0) {
			console.log("No targets configured.");
			return;
		}
		host = await select({
			message: "Select a target to remove credentials from:",
			choices: targets.map((t) => ({ name: t.host, value: t.host })),
		});
	}

	const status = await configManager.getTokenStatus(host);
	if (!status.stored || status.source === "env") {
		console.log(
			status.source === "env"
				? "Token is set via GITLAB_TOKEN env var. Unset it in your shell environment."
				: "No stored credentials found.",
		);
		return;
	}

	await configManager.deleteToken(host);
	console.log(`✅ Credentials removed for ${host}`);
}

async function actionConfigEdit() {
	let done = false;
	while (!done) {
		const config = await configManager.load();
		const targets = config.targets;

		console.log("");
		const action = await select({
			message: "What would you like to configure?",
			choices: [
				{ name: "Add a GitLab target", value: "add-target" as const },
				...(targets.length > 0
					? [
							{
								name: "Set/update a target's token",
								value: "set-token" as const,
							},
							{
								name: "Edit a target's preferences",
								value: "edit-target" as const,
							},
							{ name: "Remove a target", value: "remove-target" as const },
						]
					: []),
				{
					name: "Edit global preferences",
					value: "edit-global" as const,
				},
				{ name: "Done", value: "done" as const },
			],
		});

		switch (action) {
			case "add-target": {
				const host = await input({
					message: "GitLab instance URL:",
					validate: validateUrl,
				});
				await configManager.addTarget(host);
				console.log(`✅ Added target ${host}`);

				const setToken = await confirm({
					message: "Set up a token for this target now?",
					default: true,
				});
				if (setToken) {
					await promptForToken(host);
				}
				break;
			}
			case "set-token": {
				const host = await select({
					message: "Select a target:",
					choices: targets.map((t) => ({ name: t.host, value: t.host })),
				});
				await promptForToken(host);
				break;
			}
			case "edit-target": {
				const host = await select({
					message: "Select a target to edit:",
					choices: targets.map((t) => ({ name: t.host, value: t.host })),
				});
				await promptEditPreferences(host);
				break;
			}
			case "remove-target": {
				const host = await select({
					message: "Select a target to remove:",
					choices: targets.map((t) => ({ name: t.host, value: t.host })),
				});
				const yes = await confirm({
					message: `Remove ${host} and its cache?`,
					default: false,
				});
				if (yes) {
					await configManager.removeTarget(host);
					console.log(`✅ Removed target ${host}`);
				}
				break;
			}
			case "edit-global": {
				await promptEditPreferences();
				break;
			}
			case "done": {
				done = true;
				break;
			}
		}
	}

	console.log(`\n📁 Configuration saved to ${configManager.path}`);
}

async function promptEditPreferences(host?: string) {
	const current = await configManager.getEffectivePreferences(host);
	const label = host ? host : "global";

	const concurrency = await number({
		message: `Default concurrency (${label}):`,
		default: current.defaultConcurrency ?? DEFAULT_CONCURRENCY,
		min: 1,
		max: 100,
	});

	const keepMostRecent = await number({
		message: `Default keep most recent N tags (${label}):`,
		default: current.defaultKeepMostRecent ?? DEFAULT_KEEP_MOST_RECENT,
		min: 0,
	});

	await configManager.updatePreferences(
		{
			defaultConcurrency: concurrency ?? DEFAULT_CONCURRENCY,
			defaultKeepMostRecent: keepMostRecent ?? DEFAULT_KEEP_MOST_RECENT,
		},
		host,
	);
	console.log(`✅ Updated ${label} preferences`);
}

async function actionConfigShow() {
	const exists = await configManager.exists();
	if (!exists) {
		console.log(
			"No configuration found. Run 'config edit' to create or update your configuration.",
		);
		return;
	}

	const config = await configManager.load();
	console.log(`📁 Config location: ${configManager.path}`);
	console.log("");

	if (config.preferences) {
		console.log("Global preferences:");
		console.log(
			`  Concurrency: ${config.preferences.defaultConcurrency ?? "default"}`,
		);
		console.log(
			`  Keep most recent: ${config.preferences.defaultKeepMostRecent ?? "default"}`,
		);
		console.log("");
	}

	if (config.targets.length === 0) {
		console.log("No targets configured.");
	} else {
		console.log("Targets:");
		for (const target of config.targets) {
			const status = await configManager.getTokenStatus(target.host);
			const tokenLabel =
				status.source === "env"
					? "env var"
					: status.source === "keyring"
						? "keyring"
						: status.source === "config"
							? "config file"
							: "not set";
			console.log(`  ${target.host}`);
			console.log(`    Token: ${status.stored ? "✅" : "❌"} (${tokenLabel})`);
			if (target.lastCacheUpdate) {
				console.log(`    Last cache update: ${target.lastCacheUpdate}`);
			}
			if (target.preferences) {
				if (target.preferences.defaultConcurrency !== undefined) {
					console.log(
						`    Concurrency: ${target.preferences.defaultConcurrency}`,
					);
				}
				if (target.preferences.defaultKeepMostRecent !== undefined) {
					console.log(
						`    Keep most recent: ${target.preferences.defaultKeepMostRecent}`,
					);
				}
			}
		}
	}
}

async function actionConfigAddTarget(host: string) {
	try {
		new URL(host);
	} catch {
		throw new Error(
			`Invalid URL: "${host}". Please provide a valid URL (e.g. https://gitlab.example.com)`,
		);
	}

	await configManager.addTarget(host);
	console.log(`✅ Added target ${host}`);
}

main().catch((e) => {
	console.error(e);
});
