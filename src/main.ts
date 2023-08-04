import { Command } from 'commander';
import { GitLabContainerRepositoryCleaner } from './cleaner';

async function main(){
    const program = new Command();

    program
        .command("list")
        .summary("List all container repositories.")
        .description(
            "List all container repositories using GitLab REST API /registry/repositories/:id " +
            "to list repository per ID in parallel from given start and end index. " +
            "May yields lots of 404 on server side as not each ID will exists.")
        .option("-s, --start-index <number>", "Repository ID index to start with", "1")
        .option("-e, --end-index <number>", "Repository ID index to end with", "10000")
        .option("-c, --concurrency <number>", "Number of promises running concurrently when requesting GitLab API", "20")
        .option("-o, --output <file>", "Output repositorie list as JSON to file. By default will print to stdout.")
        .action(actionListRepositories)

    program.command("clean")
        .summary("Clean tags from a container repository.")
        .description(
            "Clean tags from a container repository concurrently using given regex and age filter. " +
            "Only tags matching BOTH regex and age will be deleted. " +
            "THIS IS A DESTRUCTIVE ACTION. Use with care.")
        .argument("<repository-id>", "Container Repository ID to cleanup.")
        .option("-k, --keep-regex <regex>", "Tags matching this regex will be kept. Match everything by default for satefy.", ".*")
        .option("-d, --delete-regex <regex>", "Tags matching this regex will be deleted. Do not match anything by default for safety .", "^$")
        .option("-a, --older-than-days <number>", "Tags older than days will be deleted.", "90")
        .option("-c, --concurrency <number>", "Number of promises running concurrently when requesting GitLab API", "20")
        .option("--no-dry-run", "Disable dry-run. Dry run is enabled by default.")
        .option("-o, --output-tags <file>", "Output tag list to be deleted as JSON to specified file. Useful with dry-run to check nothing important will be deleted.")
        .action(actionCleanRepository)

    await program.parseAsync()

}

async function actionListRepositories(opts: {startIndex: string, endIndex: string, concurrency: string, output: string}) {

    checkEnvironment()

    const cleaner = new GitLabContainerRepositoryCleaner(true, Number.parseInt(opts.concurrency))

    const repos = await cleaner.getContainerRepositoriesConcurrently(
        Number.parseInt(opts.startIndex),
        Number.parseInt(opts.endIndex),
        opts.output
    )
}

async function actionCleanRepository(repositoryId: string, opts: { 
        keepRegex: string, 
        deleteRegex: string,
        olderThanDays: string, 
        concurrency: string, 
        dryRun: boolean,
        outputTags?: string
    }){

    checkEnvironment()

    const cleaner = new GitLabContainerRepositoryCleaner(opts.dryRun, Number.parseInt(opts.concurrency))
    
    await cleaner.cleanupContainerRepositoryTags(
        Number.parseInt(repositoryId),
        opts.keepRegex, 
        opts.deleteRegex,
        Number.parseInt(opts.olderThanDays),
        50,
        opts.outputTags
    )
}

function checkEnvironment(){
    if (!process.env.GITLAB_HOST) {
        console.error("GITLAB_HOST environment variable is not set. You must specify a GitLab instance to use.")
        console.error('Example: `export GITLAB_HOST="https://gitlab.com"` or `export GITLAB_HOST="https://gitlab.mycompany.org`')
        process.exit(1)
    }

    if (!process.env.GITLAB_TOKEN) {
        console.error("GITLAB_TOKEN environment variable is not set. You need to provide a token with api scope to access GitLab REST API.")
        console.error("See https://docs.gitlab.com/ee/user/profile/personal_access_tokens.html")
        process.exit(2)
    } 

}

main().catch(e => {
    console.error(e)
})
