"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const cleaner_1 = require("./cleaner");
async function main() {
    const program = new commander_1.Command();
    program
        .command("list")
        .summary("List all container repositories.")
        .description("List all container repositories using GitLab REST API /registry/repositories/:id " +
        "to list repository per ID in parallel from given start and end index. " +
        "May yields lots of 404 on server side as not each ID will exists.")
        .option("-s, --start-index <number>", "Repository ID index to start with", "1")
        .option("-e, --end-index <number>", "Repository ID index to end with", "10000")
        .option("-c, --concurrency <number>", "Number of promises running concurrently when requesting GitLab API", "20")
        .action(action_list_repositories);
    program.command("clean")
        .summary("Clean tags from a container repository.")
        .description("Clean tags from a container repository concurrently using given regex and age filter. " +
        "Only tags matching BOTH regex and age will be deleted. " +
        "THIS IS A DESTRUCTIVE ACTION. Use with care.")
        .argument("project-id")
        .argument("registry-id")
        .option("-r, --keep-regex <regex>", "Tags matching this regex will be deleted. Do not match anything by default.", ".*")
        .option("-a, --older-than-days <number>", "Tags older than days will be deleted.", "90")
        .option("-c, --concurrency <number>", "Number of promises running concurrently when requesting GitLab API", "20")
        .option("--no-dry-run", "Disable dry-run. Dry run is enabled by default.")
        .action(action_clean_repository);
    await program.parseAsync();
}
async function action_list_repositories(opts) {
    const cleaner = new cleaner_1.GitLabContainerRepositoryCleaner(true, Number.parseInt(opts.concurrency));
    const repos = await cleaner.getContainerRepositoriesConcurrently(Number.parseInt(opts.startIndex), Number.parseInt(opts.endIndex));
    console.info(JSON.stringify(repos));
}
async function action_clean_repository(projectId, repositoryId, opts) {
    const cleaner = new cleaner_1.GitLabContainerRepositoryCleaner(!opts.noDryRun, Number.parseInt(opts.concurrency));
    await cleaner.cleanupContainerRepositoryTags(Number.parseInt(projectId), Number.parseInt(repositoryId), opts.keepRegex, Number.parseInt(opts.olderThanDays), 50);
}
main().catch(e => {
    console.error(e);
});
