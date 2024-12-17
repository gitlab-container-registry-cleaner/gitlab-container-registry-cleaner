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
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RegistryRepositorySchema } from "@gitbeaker/rest";
import { Separator, checkbox } from "@inquirer/prompts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = path.join(__dirname, "../package.json");

const packageJson = await fs.readFile(packageJsonPath, "utf-8");
const packageData = JSON.parse(packageJson) as { version: string };
const version = packageData.version;

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
			"JSON file containing pre-fetched repository list.",
		)
		.option(
			"-v, --verbose",
			"Enable verbose output, including details of tags to be deleted.",
		)
		.action(actionCleanRepository);

	await program.parseAsync();
}

async function actionListAllRepositories(opts: {
	startIndex: string;
	endIndex: string;
	concurrency: string;
	output: string;
}) {
	checkEnvironment();

	const cleaner = new GitLabContainerRepositoryCleaner({
		concurrency: Number.parseInt(opts.concurrency),
	});

	await cleaner.getContainerRepositoriesConcurrently(
		Number.parseInt(opts.startIndex),
		Number.parseInt(opts.endIndex),
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
	checkEnvironment();

	let repositoryIds: number[];

	if (opts.jsonInput) {
		const jsonData = await fs.readFile(opts.jsonInput, "utf-8");
		const repositories = JSON.parse(
			jsonData,
		) as Array<RegistryRepositorySchema>;

		// User has not specified a repository ID or path
		if (!repositoryIdOrPath) {
			// Group repositories by their top-level path component
			const groupedRepos: Record<string, RegistryRepositorySchema[]> = {};
			for (const repo of repositories) {
				const pathComponents = repo.path.split("/");
				const topLevel = pathComponents[0] as string;
				if (!groupedRepos[topLevel]) {
					groupedRepos[topLevel] = [];
				}
				groupedRepos[topLevel].push(repo);
			}

			// Create choices array
			const choices = Object.entries(groupedRepos)
				.sort(([a], [b]) => a.localeCompare(b))
				.flatMap(([group, repos]) => [
					new Separator(group),
					...repos
						.sort((a, b) => a.path.localeCompare(b.path))
						.map((repo) => ({
							name: repo.path.split("/").slice(1).join("/"),
							value: repo.id,
							description: `ID: ${repo.id}, Tags: ${repo.tags_count}`,
						})),
				]);

			repositoryIds = await checkbox({
				message: "Select a repository to clean:",
				choices,
				pageSize: 15,
			});
		} else if (Number.isNaN(Number(repositoryIdOrPath))) {
			// Look up repository ID from JSON file
			const repository = repositories.find(
				(repo) => repo.path === repositoryIdOrPath,
			);
			if (!repository) {
				throw new Error(
					`Repository with path "${repositoryIdOrPath}" not found in JSON file.`,
				);
			}
			repositoryIds = [repository.id];
		} else {
			repositoryIds = [Number(repositoryIdOrPath)];
		}
	} else {
		if (!repositoryIdOrPath) {
			throw new Error(
				"Repository ID or path is required when JSON input is not provided.",
			);
		}
		if (Number.isNaN(Number(repositoryIdOrPath))) {
			throw new Error(
				"Repository path specified but JSON input file is not provided. Use -j option to specify JSON input file.",
			);
		}
		repositoryIds = [Number(repositoryIdOrPath)];
	}

	for (const repositoryId of repositoryIds) {
		const cleaner = new GitLabContainerRepositoryCleaner({
			dryRun: opts.dryRun,
			concurrency: Number.parseInt(opts.concurrency),
			verbose: opts.verbose,
		});

		await cleaner.cleanupContainerRepositoryTags(repositoryId, {
			keepRegex: opts.keepRegex,
			deleteRegex: opts.deleteRegex,
			tagsPerPage: Number.parseInt(opts.tagsPerPage),
			olderThanDays: Number.parseInt(opts.olderThanDays),
			outputTags: opts.outputTags,
			keepMostRecentN: Number.parseInt(opts.keepMostRecent),
		});
	}
}

async function actionListProjectRepositories(projectId: string | number, opts: { output?: string }) {
	const cleaner = new GitLabContainerRepositoryCleaner({
		dryRun: true,
		concurrency: 1,
	});
	await cleaner.getProjectContainerRepositories(projectId, opts.output);
}

async function actionListGroupRepositories(groupId: string | number, opts: { output?: string }) {
	const cleaner = new GitLabContainerRepositoryCleaner({
		dryRun: true,
		concurrency: 1,
	});
	await cleaner.getGroupContainerRepositories(groupId, opts.output);
}

function checkEnvironment() {
	if (!process.env.GITLAB_HOST) {
		console.error(
			"GITLAB_HOST environment variable is not set. You must specify a GitLab instance to use.",
		);
		console.error(
			'Example: `export GITLAB_HOST="https://gitlab.com"` or `export GITLAB_HOST="https://gitlab.mycompany.org`',
		);
		process.exit(1);
	}

	if (!process.env.GITLAB_TOKEN) {
		console.error(
			"GITLAB_TOKEN environment variable is not set. You need to provide a token with api scope to access GitLab REST API.",
		);
		console.error(
			"See https://docs.gitlab.com/ee/user/profile/personal_access_tokens.html",
		);
		process.exit(2);
	}
}

main().catch((e) => {
	console.error(e);
});
