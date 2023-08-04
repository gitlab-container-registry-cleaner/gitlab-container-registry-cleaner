"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitLabContainerRepositoryCleaner = exports.DEFAULT_DELETE_REGEX = exports.DEFAULT_KEEP_REGEX = void 0;
const rest_1 = require("@gitbeaker/rest");
const readline = __importStar(require("node:readline/promises"));
const node_process_1 = require("node:process");
const fs = __importStar(require("fs"));
exports.DEFAULT_KEEP_REGEX = ".*";
exports.DEFAULT_DELETE_REGEX = "^$";
class GitLabContainerRepositoryCleaner {
    gl;
    // Max number of promises running in parallel
    // May be less number of objects to manipulate exceed concurrency
    concurrency;
    // Enable dry run mode
    // If true, only read operation are performed
    dryRun;
    constructor(dryRun = true, concurrency = 20) {
        this.gl = new rest_1.Gitlab({
            token: process.env.GITLAB_TOKEN || "",
            host: process.env.GITLAB_HOST || "",
        });
        this.dryRun = dryRun;
        this.concurrency = concurrency;
    }
    /**
     * Get Container Repositories in a range of ID. Look for repository for each ID in range concurrently using GitLab API:
     * a 404 indicated repository does not exists, otherwise repository data is returned.
     * @param startIndex repository ID to start from
     * @param endIndex repository ID to end by
     * @param concurrent number of promises awaited concurrently
     */
    async getContainerRepositoriesConcurrently(startIndex = 1, endIndex = 1000, output = "") {
        if (!output) {
            console.info("You didn't specify an output path to write results. By default results will be shown on stdout.");
            console.info("Output may be long, it's possible your console buffer won't show everything.");
            console.info("This command may run for a long time and some result may be lost.");
            console.info("Use -o flag to specify a file such as -o /tmp/repositories.json");
            console.info("");
            await this.promptUser("Press CTRL+C to interrupt or ENTER to continue...");
        }
        const totalLength = endIndex - startIndex + 1;
        const repositoryIds = [...Array(totalLength).keys()].map(i => i + startIndex);
        console.info(`🔭 Requesting container repository IDs [${startIndex}-${endIndex}] concurrency ${this.concurrency}`);
        let repositoriesPromises = [];
        for (let i = 0; i <= this.concurrency - 1; i++) {
            const repositoriesProm = this.getContainerRepositories(repositoryIds, totalLength);
            repositoriesPromises.push(repositoriesProm);
        }
        let repositories = [];
        for (const repositoryProm of repositoriesPromises) {
            const partialRepositories = await repositoryProm;
            repositories = repositories.concat(partialRepositories);
        }
        console.info(`   Found ${repositories.length} repositories`);
        if (output) {
            console.info(`📝 Writing repository list as JSON to ${output}`);
            this.writeDataJsonToFile(output, repositories);
        }
        else {
            console.info(``);
            console.info(repositories);
            console.info(``);
            console.info(`Repositories have been outputted to stdout. Use -o to write results as JSON to file.`);
        }
    }
    /**
     * Used by getContainerRepositoriesConcurrently Promises to fetch repositories from array
     * Each Promise run this function
     */
    async getContainerRepositories(repositoryIds, totalLength) {
        const result = [];
        while (repositoryIds.length > 0) {
            const repoId = repositoryIds.pop();
            if (repoId !== undefined) {
                if (repositoryIds.length % 100 == 0) {
                    console.info(`  Checking container repository IDs ${totalLength - repositoryIds.length}/${totalLength}...`);
                }
                try {
                    const repo = await this.gl.ContainerRegistry.showRepository(repoId, { tagsCount: true });
                    result.push(repo);
                }
                catch (e) {
                    const status = e?.cause?.response?.status;
                    if (status != 404 && status != 403) {
                        console.error(`Non-404 error listing repository ID ${repoId}`, e);
                    }
                }
            }
        }
        return result;
    }
    async getProjectContainerRepositories(projectId) {
        const repos = await this.gl.ContainerRegistry.allRepositories({ projectId: projectId, tagsCount: true });
        console.info(repos);
    }
    async getGroupContainerRepositories(groupId) {
        const repos = await this.gl.ContainerRegistry.allRepositories({ groupId: groupId, tagsCount: true });
        console.info(repos);
    }
    /**
     * Get all tags of a Project's Container Repository. Uses GitLab API pagination to run concurrent requests across multiple Promises,
     * each Promises having a range of pages to fetch.
     *
     * @param projectId
     * @param repositoryId
     * @param tagPerPage number of tags per page
     * @returns
     */
    async getRepositoryTagsConcurrently(repository, tagPerPage = 50) {
        const tagCount = repository.tags_count;
        const pageTotal = Math.ceil(tagCount / tagPerPage);
        const pages = [...Array(pageTotal).keys()].map(i => i + 1);
        console.info(`🔭 Listing ${tagCount} tags (${pageTotal} pages, ${tagPerPage} / page)`);
        // Run all promises in parallel and fetch result later
        let tagListPromises = [];
        for (let promiseIndex = 0; promiseIndex < this.concurrency; promiseIndex++) {
            const tagListProm = this.getRepositoryTagsForPages(repository.project_id, repository.id, pages, tagPerPage, pageTotal);
            tagListPromises.push(tagListProm);
        }
        let allTags = [];
        for (const tagListProm of tagListPromises) {
            const tags = await tagListProm;
            allTags = allTags.concat(tags);
        }
        console.info(`   Found ${allTags.length} tags`);
        return allTags;
    }
    /**
     * Fetch Container Repository tags for the given pages sequentially.
     * Used by promises of getRepositoryTagsConcurrently
     */
    async getRepositoryTagsForPages(projectId, repositoryId, pages, perPage, totalPages) {
        let result = [];
        while (pages.length > 0) {
            const page = pages.pop();
            if (page !== undefined) {
                if (pages.length % 10 == 0) {
                    console.info(`   Listing Container Repository tags page ${totalPages - pages.length}/${totalPages}...`);
                }
                const tags = await this.gl.ContainerRegistry.allTags(projectId, repositoryId, { page: page, perPage: perPage });
                result = result.concat(tags);
            }
        }
        return result;
    }
    async cleanupContainerRepositoryTags(repositoryId, keepTagRegex = exports.DEFAULT_KEEP_REGEX, deleteTagRegex = exports.DEFAULT_DELETE_REGEX, olderThanDays = 90, tagPerPage = 50, outputTagsToFile = "") {
        console.info(`🧹 Cleaning image tags for repository ${repositoryId}. Keep tags matching '${keepTagRegex}' and delete tags older than ${olderThanDays} days. (dry-run: ${this.dryRun})`);
        // warn user if parameters doesn't make sense or forgot to disable safety
        if (keepTagRegex == exports.DEFAULT_KEEP_REGEX || deleteTagRegex == exports.DEFAULT_DELETE_REGEX) {
            console.warn(``);
            console.warn(`🤔 Hey, looks like you kept default keep and/or delete regex. By default, these regex won't mach anything for safety reasons.`);
            console.warn(`   You'll probably want to use -k and -d flags to specify regex against which tags must match to be deleted.`);
            console.warn(`   Example to keep release tags and delete everything else: -k 'v?[0-9]+[\-\.][0-9]+[\-\.][0-9]+.*' -d '.*'`);
            console.warn(``);
            await this.promptUser("Press ENTER to continue...");
        }
        const now = new Date();
        // retrieve all tags
        const repository = await this.getContainerRepository(repositoryId);
        const projectId = repository.project_id;
        const allTags = await this.getRepositoryTagsConcurrently(repository, tagPerPage);
        // filter out tags matching keep regex
        console.log("🕸️  Filtering tag names with regex...");
        const regexFilteredTags = this.filterTagsRegex(allTags, keepTagRegex, deleteTagRegex);
        console.info(`   Found ${regexFilteredTags.length} tags matching '${deleteTagRegex}' but not matching '${keepTagRegex}'`);
        console.info(`👴 Checking tag creation date to filter out tags younger than ${olderThanDays} days`);
        const deleteTags = await this.filterTagsCreationDate(projectId, repositoryId, regexFilteredTags, olderThanDays);
        const deleteTagCount = deleteTags.length;
        console.info(`💀 Found ${deleteTagCount} tags to delete`);
        if (outputTagsToFile) {
            console.info(`📝 Writing tag list to ${outputTagsToFile}`);
            await this.writeDataJsonToFile(outputTagsToFile, deleteTags);
        }
        // Delete tags in parallel
        if (this.dryRun) {
            console.info(`🔥 [DRY-RUN] Would delete ${deleteTagCount} tags`);
        }
        else {
            console.info(`🔥 Deleting ${deleteTagCount} tags...`);
        }
        this.deleteTagsConcurrently(projectId, repositoryId, deleteTags);
        if (this.dryRun) {
            console.info(`✅ [DRY-RUN] Would have deleted ${deleteTagCount} tags`);
        }
        else {
            console.info(`✅ Deleted ${deleteTagCount} tags !`);
        }
    }
    async getContainerRepository(id) {
        return this.gl.ContainerRegistry.showRepository(id, { tagsCount: true });
    }
    /**
     * Filter tags based on regex. All tags matching regex are kept.
     * Return tags to remove.
     */
    filterTagsRegex(tags, keepTagRegexStr, deleteTagRegexStr) {
        const keepTagRegex = new RegExp(keepTagRegexStr);
        const deleteTagRegex = new RegExp(deleteTagRegexStr);
        let deleteCandidate = [];
        // filter out tags matching keepTagRegex
        deleteCandidate = tags.filter(t => !keepTagRegex.test(t.name));
        // filter in tags matching removeTagRegex
        return deleteCandidate.filter(t => deleteTagRegex.test(t.name));
    }
    async getTagDetailsConcurrently(projectId, repositoryId, tags) {
        const detailedTagsPromises = [];
        const totalTags = tags.length;
        for (let promiseIndex = 0; promiseIndex < this.concurrency; promiseIndex++) {
            const tagDetailProm = this.getTagDetails(projectId, repositoryId, tags, totalTags);
            detailedTagsPromises.push(tagDetailProm);
        }
        let result = [];
        for (const tagDetailProm of detailedTagsPromises) {
            const detailedTags = await tagDetailProm;
            result = result.concat(detailedTags);
        }
        return result;
    }
    /**
     * Used by getTagDetailsConcurrently Promises to fetch tags from array
     */
    async getTagDetails(projectId, repositoryId, tags, totalTags) {
        let result = [];
        while (tags.length > 0) {
            const t = tags.pop();
            if (t !== undefined) {
                if (tags.length % 100 == 0) {
                    console.info(`   Fetching tag details ${totalTags - tags.length}/${totalTags}...`);
                }
                try {
                    const tagDetails = await this.gl.ContainerRegistry.showTag(projectId, repositoryId, t.name);
                    result.push(tagDetails);
                }
                catch (e) {
                    const status = e?.cause?.response?.status;
                    if (status != 404) {
                        console.error(`Non-404 error getting tag ${t.name}`, e);
                    }
                }
            }
        }
        return result;
    }
    async filterTagsCreationDate(projectId, repositoryId, tags, olderThanDays) {
        const now = new Date();
        const detailedTags = await this.getTagDetailsConcurrently(projectId, repositoryId, tags);
        // check all tags for creation date
        const deleteTags = detailedTags.filter(t => {
            const createdDate = new Date(t.created_at);
            const tagAgeDays = (now.getTime() - createdDate.getTime()) / (1000 * 3600 * 24);
            return tagAgeDays > olderThanDays;
        });
        return deleteTags;
    }
    async deleteTagsConcurrently(projectId, repositoryId, tags) {
        const deleteTagsPromises = [];
        const tagTotal = tags.length;
        for (let promiseIndex = 0; promiseIndex < this.concurrency; promiseIndex++) {
            const delTagProm = this.deleteTags(projectId, repositoryId, tags, tagTotal);
            deleteTagsPromises.push(delTagProm);
        }
        for (const delTagProm of deleteTagsPromises) {
            await delTagProm;
        }
    }
    /**
     * Used by deleteTagsConcurrently to delete tags from array
     */
    async deleteTags(projectId, repositoryId, tags, tagTotal) {
        while (tags.length > 0) {
            const tag = tags.pop();
            if (tag !== undefined) {
                if (tags.length % 100 == 0) {
                    console.info(`    Deleting tag ${tagTotal - tags.length}/${tagTotal}...`);
                }
                if (!this.dryRun) {
                    await this.gl.ContainerRegistry.removeTag(projectId, repositoryId, tag.name);
                }
            }
        }
    }
    async writeDataJsonToFile(outputTagsToFile, data) {
        fs.writeFileSync(outputTagsToFile, JSON.stringify(data, undefined, "  "));
    }
    async promptUser(msg) {
        const rl = readline.createInterface({ input: node_process_1.stdin, output: node_process_1.stdout });
        const answer = await rl.question(msg);
        rl.close();
    }
}
exports.GitLabContainerRepositoryCleaner = GitLabContainerRepositoryCleaner;
