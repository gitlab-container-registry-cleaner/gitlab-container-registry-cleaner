import * as fs from "node:fs";
import { stdin } from "node:process";
import * as readline from "node:readline/promises";
import {
	type CondensedRegistryRepositoryTagSchema,
	Gitlab,
	type RegistryRepositorySchema,
	type RegistryRepositoryTagSchema,
} from "@gitbeaker/rest";
import semver from "semver";

export const DEFAULT_KEEP_REGEX = ".*";
export const DEFAULT_DELETE_REGEX = "^$";
export const DEFAULT_CONCURRENCY = 20;

export const DEFAULT_TAGS_PER_PAGE = 50;
export const DEFAULT_START_INDEX = 1;
export const DEFAULT_END_INDEX = 10000;
export const DEFAULT_OLDER_THAN_DAYS = 90;
export const DEFAULT_KEEP_MOST_RECENT = 0;

export interface GitLabContainerRepositoryCleanerOptions {
	dryRun: boolean;
	concurrency: number;
	verbose: boolean;
	gitlabHost: string;
	gitlabToken: string;
}

export interface CleanupContainerRepositoryTagsOptions {
	keepRegex: string;
	deleteRegex: string;
	olderThanDays: number;
	tagsPerPage: number;
	outputTags: string;
	keepMostRecentN: number;
}

export class GitLabContainerRepositoryCleaner {
	gl: InstanceType<typeof Gitlab<false>>;

	// Max number of promises running in parallel
	// May be less number of objects to manipulate exceed concurrency
	concurrency: number;

	// Enable dry run mode
	// If true, only read operation are performed
	dryRun: boolean;

	// Enable verbose output
	verbose: boolean;

	/**
	 * Create a new GitLabContainerRepositoryCleaner instance,
	 *
	 * @param options
	 */
	constructor(options: Partial<GitLabContainerRepositoryCleanerOptions> = {}) {
		this.gl = new Gitlab({
			token: options.gitlabToken || process.env.GITLAB_TOKEN || "",
			host: options.gitlabHost || process.env.GITLAB_HOST || "",
		});

		this.dryRun = options.dryRun ?? false;
		this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
		this.verbose = options.verbose ?? false;
	}

	/**
	 * Get Container Repositories in a range of ID. Look for repository for each ID in range concurrently using GitLab API:
	 * a 404 indicated repository does not exists, otherwise repository data is returned.
	 * @param startIndex repository ID to start from
	 * @param endIndex repository ID to end by
	 * @param outputFile path to write results as JSON
	 */
	public async getContainerRepositoriesConcurrently(
		startIndex = DEFAULT_START_INDEX,
		endIndex = DEFAULT_END_INDEX,
		outputFile: string | undefined = undefined,
	): Promise<RegistryRepositorySchema[]> {
		if (!outputFile || outputFile === "") {
			console.log(
				"You didn't specify an output path to write results. By default results will be shown on stdout.",
			);
			console.log(
				"Output may be long, it's possible your console buffer won't show everything.",
			);
			console.log(
				"This command may run for a long time and some results may be lost.",
			);
			console.log(
				"Use -o flag to specify a file such as -o /tmp/repositories.json",
			);
			console.log("");

			if (stdin.isTTY && process.env.NODE_ENV !== "test") {
				await this.promptUser(
					"Press CTRL+C to interrupt or ENTER to continue...",
				);
			} else {
				console.log(
					"Non-interactive environment detected. Continuing without prompt.",
				);
			}
		}

		if (startIndex > endIndex) {
			throw new Error("Start index is greater than end index");
		}

		const totalLength = endIndex - startIndex + 1;
		const repositoryIds = [...Array(totalLength).keys()].map(
			(i) => i + startIndex,
		);

		console.log(
			`🔭 Requesting container repository IDs [${startIndex}-${endIndex}] with concurrency ${this.concurrency}`,
		);

		const repositories: RegistryRepositorySchema[] = [];

		// Process repos in batches of size this.concurrency
		let totalFetched = 0;
		for (let i = 0; i < repositoryIds.length; i += this.concurrency) {
			const batch = repositoryIds.slice(i, i + this.concurrency);
			const batchPromises = batch.map((repositoryId) =>
				this.getContainerRepositories(repositoryId),
			);

			console.log(
				`   Fetching ${batch.length} repositories, ${totalFetched}/${totalLength} done`,
			);
			const batchResults = await Promise.allSettled(batchPromises);
			totalFetched += batch.length;
			for (const result of batchResults) {
				if (result.status === "fulfilled") {
					repositories.push(result.value);
				} // we ignore errors for now (invalid IDs)
			}
		}

		if (repositories.length === 0) {
			throw new Error(
				"   No repositories found. Maybe try again with a different ID range?",
			);
		}

		console.log(`   Found ${repositories.length} repositories`);

		if (outputFile) {
			console.log(`📝 Writing repository list as JSON to ${outputFile}`);
			this.writeDataJsonToFile(outputFile, repositories);
		} else {
			console.log("");
			console.log(repositories);
			console.log("");
			console.log(
				"   Repositories have been written to stdout. Use -o to write results as JSON to file.",
			);
		}

		return repositories;
	}

	/**
	 * Fetch a single Container Repository by ID
	 */
	private async getContainerRepositories(repositoryId: number) {
		return this.gl.ContainerRegistry.showRepository(repositoryId, {
			tagsCount: true,
		});
	}

	public async getProjectContainerRepositories(
		projectId: string | number,
		outputFile?: string,
	) {
		const repos = await this.gl.ContainerRegistry.allRepositories({
			projectId: projectId,
			tagsCount: true,
		});

		if (outputFile) {
			console.log(`📝 Writing repository list as JSON to ${outputFile}`);
			this.writeDataJsonToFile(outputFile, repos);
		} else {
			console.log(repos);
		}

		return repos;
	}

	public async getGroupContainerRepositories(
		groupId: string | number,
		outputFile?: string,
	) {
		const repos = await this.gl.ContainerRegistry.allRepositories({
			groupId: groupId,
			tagsCount: true,
		});

		if (outputFile) {
			console.log(`📝 Writing repository list as JSON to ${outputFile}`);
			this.writeDataJsonToFile(outputFile, repos);
		} else {
			console.log(repos);
		}

		return repos;
	}

	/**
	 * Get all tags of a Project's Container Repository. Uses GitLab API pagination to run concurrent requests across multiple Promises,
	 * each Promises having a range of pages to fetch.
	 *
	 * @param repository
	 * @param tagsPerPage number of tags per page
	 * @returns
	 */
	private async getRepositoryTagsConcurrently(
		repository: RegistryRepositorySchema,
		tagsPerPage = 50,
	) {
		const tagCount = repository.tags_count ?? 0;
		const pageTotal = Math.ceil(tagCount / tagsPerPage);
		const pages = [...Array(pageTotal).keys()].map((i) => i + 1);

		console.log(
			`🔭 Listing ${tagCount} tags (${pageTotal} pages, ${tagsPerPage} tags per page)`,
		);

		const result: CondensedRegistryRepositoryTagSchema[] = [];

		// Process pages in batches of size this.concurrency
		for (let i = 0; i < pages.length; i += this.concurrency) {
			const batch = pages.slice(i, i + this.concurrency);
			const batchPromises = batch.map((page) =>
				this.getRepositoryTagsForPages(
					repository.project_id,
					repository.id,
					page,
					tagsPerPage,
				),
			);

			const batchResults = await Promise.all(batchPromises);
			result.push(...batchResults.flat());

			console.log(`   Fetched ${result.length}/${tagCount} tags...`);
		}

		console.log(`   Found ${result.length} tags`);

		return result;
	}

	/**
	 * Fetch Container Repository tags for the given pages.
	 */
	private async getRepositoryTagsForPages(
		projectId: number,
		repositoryId: number,
		page: number,
		perPage: number,
	) {
		return await this.gl.ContainerRegistry.allTags(projectId, repositoryId, {
			page: page,
			perPage: perPage,
		});
	}

	public async cleanupContainerRepositoryTags(
		repositoryId: number,
		options: Partial<CleanupContainerRepositoryTagsOptions> = {},
	) {
		const {
			keepRegex = DEFAULT_KEEP_REGEX,
			deleteRegex = DEFAULT_DELETE_REGEX,
			olderThanDays = DEFAULT_OLDER_THAN_DAYS,
			tagsPerPage = DEFAULT_TAGS_PER_PAGE,
			outputTags = "",
			keepMostRecentN = DEFAULT_KEEP_MOST_RECENT,
		} = options;

		// retrieve repository details first
		const repository = await this.gl.ContainerRegistry.showRepository(
			repositoryId,
			{
				tagsCount: true,
			},
		);

		console.log(
			`🧹 Cleaning image tags for repository ${repository.path} (ID: ${repositoryId}). Keep tags matching '${keepRegex}' and delete tags older than ${olderThanDays} days. Keeping ${keepMostRecentN} most recent tags. (dry-run: ${this.dryRun})`,
		);

		// warn user if parameters doesn't make sense or forgot to disable safety
		if (
			keepRegex === DEFAULT_KEEP_REGEX ||
			deleteRegex === DEFAULT_DELETE_REGEX
		) {
			console.warn("");
			console.warn(
				`🤔 Hey, looks like you kept default keep and/or delete regex. By default, these regex won't mach anything for safety reasons.`,
			);
			console.warn(
				`   You'll probably want to use -k and -d flags to specify regex against which tags must match to be deleted.`,
			);
			console.warn(
				`   Example to keep release tags and delete everything else: -k 'v?[0-9]+[-.][0-9]+[-.][0-9]+.*' -d '.*'`,
			);
			console.warn("");

			await this.promptUser("Press ENTER to continue...");
		}

		// retrieve all tags
		const projectId: number = Number.parseInt(
			repository.project_id as unknown as string,
			10,
		); // FIXME: GitLab returns a string, wrong type def
		const allTags = await this.getRepositoryTagsConcurrently(
			repository,
			tagsPerPage,
		);

		// filter out tags matching keep regex
		console.log("🕸️  Filtering tag names with regex...");
		const regexFilteredTags = this.filterTagsRegex(
			allTags,
			keepRegex,
			deleteRegex,
		);

		console.log(
			`   Found ${regexFilteredTags.length} tags matching '${deleteRegex}' but not matching '${keepRegex}'`,
		);

		console.log(
			`👴 Checking tag creation date to filter out tags younger than ${olderThanDays} days`,
		);

		const deleteTags = await this.filterTagsCreationDate(
			projectId,
			repositoryId,
			regexFilteredTags,
			olderThanDays,
			keepMostRecentN,
		);
		const deleteTagCount = deleteTags.length;

		console.log(`💀 Found ${deleteTagCount} tags to delete`);

		if (outputTags) {
			console.log(`📝 Writing tag list to ${outputTags}`);
			this.writeDataJsonToFile(outputTags, deleteTags);
		}

		// Delete tags in parallel
		if (this.dryRun) {
			console.log(`🔥 [DRY-RUN] Would delete ${deleteTagCount} tags`);
		} else {
			console.log(`🔥 Deleting ${deleteTagCount} tags...`);
		}

		this.deleteTagsConcurrently(projectId, repositoryId, deleteTags);

		if (this.dryRun) {
			console.log(`✅ [DRY-RUN] Would have deleted ${deleteTagCount} tags`);
		} else {
			console.log(`✅ Deleted ${deleteTagCount} tags!`);
		}
		console.log("🔄 Done!\n");
	}

	/**
	 * Filter tags based on regex. All tags matching regex are kept.
	 * Return tags to remove.
	 */
	private filterTagsRegex(
		tags: CondensedRegistryRepositoryTagSchema[],
		keepRegexStr: string,
		deleteRegexStr: string,
	) {
		const keepRegex = new RegExp(keepRegexStr);
		const deleteRegex = new RegExp(deleteRegexStr);

		let deleteCandidate: CondensedRegistryRepositoryTagSchema[] = [];

		// filter out tags matching keepRegex
		deleteCandidate = tags.filter((t) => !keepRegex.test(t.name));

		// filter in tags matching removeTagRegex
		return deleteCandidate.filter((t) => deleteRegex.test(t.name));
	}

	private async getTagDetailsConcurrently(
		projectId: number,
		repositoryId: number,
		tags: CondensedRegistryRepositoryTagSchema[],
	) {
		console.log(`🔭 Fetching tag details for ${tags.length} tags`);

		// Split tags into chunks that we can fetch concurrently
		const chunkSize = Math.ceil(tags.length / this.concurrency);
		const chunks = [];
		for (let i = 0; i < tags.length; i += chunkSize) {
			chunks.push(tags.slice(i, i + chunkSize));
		}

		const detailedTagsPromises = chunks.map((chunk) =>
			this.getTagDetails(projectId, repositoryId, chunk),
		);

		const results = await Promise.all(detailedTagsPromises);
		const result = results.flat();

		if (result.length !== tags.length) {
			console.warn(
				`⚠️ Fetched tag details for ${result.length} tags, expected ${tags.length}`,
			);
		}

		return result;
	}

	// Update the getTagDetails function to work with chunks
	private async getTagDetails(
		projectId: number,
		repositoryId: number,
		tagChunk: CondensedRegistryRepositoryTagSchema[],
	) {
		const result: RegistryRepositoryTagSchema[] = [];

		for (const t of tagChunk) {
			// if (result.length % 10 == 0){
			//     console.log(`   Fetching tag details ${result.length}/${tagChunk.length} in this chunk...`)
			// }

			try {
				const tagDetails = await this.gl.ContainerRegistry.showTag(
					projectId,
					repositoryId,
					t.name,
				);
				result.push(tagDetails);
				// biome-ignore lint/suspicious/noExplicitAny: error handling
			} catch (e: any) {
				const status = e?.cause?.response?.status;
				if (status && status !== 404) {
					console.error(
						`Non-404 error listing tag ${t.name} in repository ${repositoryId}`,
					);
				} else {
					console.warn(`Tag ${t.name} not found via GitLab API`);
				}
			}
		}

		return result;
	}

	/**
	 * Sort tags by semantic version (newest first)
	 * Extracts version from tag name and compares using semver
	 */
	private sortBySemver(
		tags: RegistryRepositoryTagSchema[],
	): RegistryRepositoryTagSchema[] {
		return [...tags].sort((a, b) => {
			// Try to coerce tag names to valid semver versions
			// This handles formats like "v1.2.3", "foo-v1.2.3", "1.2.3", etc.
			const versionA = semver.coerce(a.name);
			const versionB = semver.coerce(b.name);

			// If both have valid semver versions, compare them (newest first)
			if (versionA && versionB) {
				return semver.rcompare(versionA, versionB); // rcompare = reverse compare (newest first)
			}

			// If only one has a version, prioritize it
			if (versionA) return -1;
			if (versionB) return 1;

			// Fall back to alphabetical sorting (newest first)
			return b.name.localeCompare(a.name);
		});
	}

	private async filterTagsCreationDate(
		projectId: number,
		repositoryId: number,
		tags: CondensedRegistryRepositoryTagSchema[],
		olderThanDays: number,
		keepMostRecentN: number,
	) {
		const now = new Date();

		const detailedTags = await this.getTagDetailsConcurrently(
			projectId,
			repositoryId,
			tags,
		);

		if (detailedTags.length === 0 && tags.length > 0) {
			console.warn("");
			console.warn(
				"⚠️  GitLab API failed to fetch tag details (known issue with OCI manifests)",
			);
			console.warn(
				"   https://gitlab.com/gitlab-org/gitlab/-/issues/388865#note_1552979298",
			);
			console.warn("");

			// Convert to expected format
			const fallbackTags = tags.map((t) => ({
				name: t.name,
				path: t.path,
				location: t.location,
				created_at: new Date().toISOString(), // Dummy date
			})) as RegistryRepositoryTagSchema[];

			// If older-than-days is requested, we can't apply it
			if (olderThanDays > 0) {
				console.warn(
					`   Cannot apply --older-than-days=${olderThanDays} without creation dates.`,
				);
				console.warn("   Age-based filtering will be skipped.");
			}

			// Try to sort by semver for keep-most-recent
			if (keepMostRecentN > 0) {
				console.warn(
					`   Attempting to keep ${keepMostRecentN} most recent tags using semantic versioning...`,
				);

				// Sort by semver (newest first)
				const sorted = this.sortBySemver(fallbackTags);

				// Keep the most recent N tags
				const tagsToKeep = sorted.slice(0, keepMostRecentN);
				const tagsToDelete = sorted.slice(keepMostRecentN);

				console.warn(
					`   Keeping ${tagsToKeep.length} tags based on semver sorting.`,
				);
				console.warn("");

				return tagsToDelete;
			}

			console.warn(
				"   Proceeding with regex-only filtering (all matching tags will be deleted).",
			);
			console.warn("");

			return fallbackTags;
		}

		// Sort tags by creation date, newest first
		detailedTags.sort(
			(a, b) =>
				new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
		);

		// Keep the most recent N tags
		const tagsToKeep = detailedTags.slice(0, keepMostRecentN);
		const tagsToConsiderForDeletion = detailedTags.slice(keepMostRecentN);

		// Check remaining tags for creation date
		const deleteTags = tagsToConsiderForDeletion.filter((t) => {
			const createdDate = new Date(t.created_at);
			const tagAgeDays =
				(now.getTime() - createdDate.getTime()) / (1000 * 3600 * 24);

			return tagAgeDays > olderThanDays;
		});

		if (this.verbose) {
			console.log("\nTags to be deleted:");
			for (const tag of deleteTags) {
				console.log(`  - ${tag.name} (${tag.created_at})`);
			}
			console.log("\n Tags to be kept:");
			for (const tag of tagsToKeep) {
				console.log(`  - ${tag.name} (${tag.created_at})`);
			}
			console.log("");
		}

		console.log(`ℹ️  Kept ${tagsToKeep.length} most recent tags`);
		console.log(`ℹ️  Filtered ${deleteTags.length} tags to delete based on age`);
		return deleteTags;
	}

	private async deleteTagsConcurrently(
		projectId: number,
		repositoryId: number,
		tags: RegistryRepositoryTagSchema[],
	) {
		const chunkSize = Math.ceil(tags.length / this.concurrency);
		const chunks = [];
		for (let i = 0; i < tags.length; i += chunkSize) {
			chunks.push(tags.slice(i, i + chunkSize));
		}

		const deleteTagsPromises = chunks.map((chunk) =>
			this.deleteTags(projectId, repositoryId, chunk),
		);

		await Promise.all(deleteTagsPromises);
	}

	private async deleteTags(
		projectId: number,
		repositoryId: number,
		tags: RegistryRepositoryTagSchema[],
	) {
		for (const tag of tags) {
			if (this.dryRun) {
				console.log(`[DRY-RUN] Would delete tag ${tag.name}`);
			} else {
				await this.gl.ContainerRegistry.removeTag(
					projectId,
					repositoryId,
					tag.name,
				);
			}
		}
	}

	private writeDataJsonToFile(outputTagsToFile: string, data: unknown) {
		const jsonString = JSON.stringify(data, undefined, "  ");
		fs.writeFileSync(outputTagsToFile, jsonString);
	}

	private async promptUser(msg: string): Promise<string> {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		const answer = await rl.question(msg);
		rl.close();
		return answer;
	}
}
