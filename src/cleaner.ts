import { Gitlab, RegistryRepositorySchema, CondensedRegistryRepositoryTagSchema, RegistryRepositoryTagSchema } from '@gitbeaker/rest';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import * as fs from 'fs';

export const DEFAULT_KEEP_REGEX = ".*"
export const DEFAULT_DELETE_REGEX = "^$"

export class GitLabContainerRepositoryCleaner {

    gl: InstanceType<typeof Gitlab<false>> 

    // Max number of promises running in parallel
    // May be less number of objects to manipulate exceed concurrency
    concurrency: number

    // Enable dry run mode
    // If true, only read operation are performed
    dryRun: boolean

    constructor(dryRun=true, concurrency=20){
        this.gl = new Gitlab({
            token: process.env.GITLAB_TOKEN || "",
            host:process.env.GITLAB_HOST || "",
        }) 

        this.dryRun = dryRun
        this.concurrency = concurrency
    }

    /**
     * Get Container Repositories in a range of ID. Look for repository for each ID in range concurrently using GitLab API:
     * a 404 indicated repository does not exists, otherwise repository data is returned. 
     * @param startIndex repository ID to start from
     * @param endIndex repository ID to end by
     * @param concurrent number of promises awaited concurrently
     */
    public async getContainerRepositoriesConcurrently(startIndex=1, endIndex=1000, output=""){

        if (!output){
            console.info("You didn't specify an output path to write results. By default results will be shown on stdout.")
            console.info("Output may be long, it's possible your console buffer won't show everything.")  
            console.info("This command may run for a long time and some result may be lost.")  
            console.info("Use -o flag to specify a file such as -o /tmp/repositories.json")
            console.info("")
            
            await this.promptUser("Press CTRL+C to interrupt or ENTER to continue...")
        }

        const totalLength = endIndex - startIndex + 1
        const repositoryIds = [ ...Array(totalLength).keys() ].map( i => i+startIndex);

        console.info(`🔭 Requesting container repository IDs [${startIndex}-${endIndex}] concurrency ${this.concurrency}`)

        let repositoriesPromises : Promise<RegistryRepositorySchema[]>[] = []
        for (let i = 0; i <= this.concurrency-1; i++){
            const repositoriesProm = this.getContainerRepositories(repositoryIds, totalLength)
            repositoriesPromises.push(repositoriesProm)
        }

        let repositories : RegistryRepositorySchema[] = []
        for (const repositoryProm of repositoriesPromises){
            const partialRepositories = await repositoryProm
            repositories = repositories.concat(partialRepositories)
        }

        console.info(`   Found ${repositories.length} repositories`)
        
        if(output){
            console.info(`📝 Writing repository list as JSON to ${output}`)
            this.writeDataJsonToFile(output, repositories)
        } else {
            console.info(``)
            console.info(repositories)
            console.info(``)
            console.info(`Repositories have been outputted to stdout. Use -o to write results as JSON to file.`)
        }
    }


    /**
     * Used by getContainerRepositoriesConcurrently Promises to fetch repositories from array
     * Each Promise run this function
     */
    private async getContainerRepositories(repositoryIds: number[], totalLength: number){

        const result : RegistryRepositorySchema[] = []

        while (repositoryIds.length > 0){
            
            const repoId = repositoryIds.pop()
            
            if (repoId !== undefined){

                if (repositoryIds.length % 100 == 0){
                    console.info(`  Checking container repository IDs ${totalLength-repositoryIds.length}/${totalLength}...`)
                }

                try {
                    const repo = await this.gl.ContainerRegistry.showRepository(repoId, {tagsCount: true})
                    result.push(repo)
                } catch(e: any) {
                    const status = e?.cause?.response?.status
                    if ( status != 404 && status != 403){
                        console.error(`Non-404 error listing repository ID ${repoId}`, e)
                    }
                }
            }
        }

        return result
        
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
    private async getRepositoryTagsConcurrently(repository: RegistryRepositorySchema, tagPerPage=50){

        const tagCount = repository.tags_count!
        const pageTotal = Math.ceil(tagCount / tagPerPage)
        const pages = [ ...Array(pageTotal).keys() ].map( i => i+1);

        console.info(`🔭 Listing ${tagCount} tags (${pageTotal} pages, ${tagPerPage} / page)`)

        // Run all promises in parallel and fetch result later
        let tagListPromises : Promise<CondensedRegistryRepositoryTagSchema[]>[] = []
        for (let promiseIndex = 0; promiseIndex < this.concurrency; promiseIndex++){

            const tagListProm = this.getRepositoryTagsForPages(repository.project_id, repository.id, pages, tagPerPage, pageTotal)
            tagListPromises.push(tagListProm)
        }

        let allTags : CondensedRegistryRepositoryTagSchema[] = []
        for (const tagListProm of tagListPromises){
            const tags = await tagListProm
            allTags = allTags.concat(tags)
        }

        console.info(`   Found ${allTags.length} tags`)

        return allTags
    }


    /**
     * Fetch Container Repository tags for the given pages sequentially. 
     * Used by promises of getRepositoryTagsConcurrently
     */
    private async getRepositoryTagsForPages(projectId: number, repositoryId: number, pages: number[], perPage: number, totalPages: number){
        
        let result: CondensedRegistryRepositoryTagSchema[] = []
        while(pages.length > 0){
            const page = pages.pop()

            if(page !== undefined){

                if (pages.length % 10 == 0){
                    console.info(`   Listing Container Repository tags page ${totalPages-pages.length}/${totalPages}...`)
                }

                const tags = await this.gl.ContainerRegistry.allTags(projectId, repositoryId, { page: page, perPage: perPage })
                result = result.concat(tags)
            }
        }

        return result
    }

    public async cleanupContainerRepositoryTags(
        repositoryId: number, 
        keepTagRegex = DEFAULT_KEEP_REGEX, 
        deleteTagRegex = DEFAULT_DELETE_REGEX,
        olderThanDays = 90,
        tagPerPage = 50,
        outputTagsToFile = ""
    ){

        console.info(`🧹 Cleaning image tags for repository ${repositoryId}. Keep tags matching '${keepTagRegex}' and delete tags older than ${olderThanDays} days. (dry-run: ${this.dryRun})`)

        // warn user if parameters doesn't make sense or forgot to disable safety
        if (keepTagRegex == DEFAULT_KEEP_REGEX || deleteTagRegex == DEFAULT_DELETE_REGEX){
            console.warn(``)
            console.warn(`🤔 Hey, looks like you kept default keep and/or delete regex. By default, these regex won't mach anything for safety reasons.`)
            console.warn(`   You'll probably want to use -k and -d flags to specify regex against which tags must match to be deleted.`)
            console.warn(`   Example to keep release tags and delete everything else: -k 'v?[0-9]+[\-\.][0-9]+[\-\.][0-9]+.*' -d '.*'`)
            console.warn(``)
            
            await this.promptUser("Press ENTER to continue...")
        }

        const now = new Date()

        // retrieve all tags
        const repository = await this.getContainerRepository(repositoryId)
        const projectId = repository.project_id
        const allTags = await this.getRepositoryTagsConcurrently(repository, tagPerPage)

        // filter out tags matching keep regex

        console.log("🕸️  Filtering tag names with regex...")
        const regexFilteredTags = this.filterTagsRegex(allTags, keepTagRegex, deleteTagRegex)

        console.info(`   Found ${regexFilteredTags.length} tags matching '${deleteTagRegex}' but not matching '${keepTagRegex}'`)

        console.info(`👴 Checking tag creation date to filter out tags younger than ${olderThanDays} days`)

        const deleteTags = await this.filterTagsCreationDate(projectId, repositoryId, regexFilteredTags, olderThanDays)
        const deleteTagCount = deleteTags.length

        console.info(`💀 Found ${deleteTagCount} tags to delete`)

        if (outputTagsToFile){
            console.info(`📝 Writing tag list to ${outputTagsToFile}`)
            await this.writeDataJsonToFile(outputTagsToFile, deleteTags)
        }

        // Delete tags in parallel
        if (this.dryRun) {
            console.info(`🔥 [DRY-RUN] Would delete ${deleteTagCount} tags`)
        } else {
            console.info(`🔥 Deleting ${deleteTagCount} tags...`)
        }
        
        this.deleteTagsConcurrently(projectId, repositoryId, deleteTags)

        if (this.dryRun) {
            console.info(`✅ [DRY-RUN] Would have deleted ${deleteTagCount} tags`)
        } else {
            console.info(`✅ Deleted ${deleteTagCount} tags !`)
        }
    }

    private async getContainerRepository(id: number){
        return this.gl.ContainerRegistry.showRepository(id, { tagsCount: true})
    }

    /**
     * Filter tags based on regex. All tags matching regex are kept.
     * Return tags to remove.
     */
    private filterTagsRegex(tags: CondensedRegistryRepositoryTagSchema[], keepTagRegexStr: string, deleteTagRegexStr: string){
        const keepTagRegex = new RegExp(keepTagRegexStr)
        const deleteTagRegex = new RegExp(deleteTagRegexStr)
        
        let deleteCandidate : CondensedRegistryRepositoryTagSchema[] = []

        // filter out tags matching keepTagRegex
        deleteCandidate = tags.filter(t => !keepTagRegex.test(t.name))

        // filter in tags matching removeTagRegex
        return deleteCandidate.filter(t => deleteTagRegex.test(t.name))
    }

    private async getTagDetailsConcurrently(projectId: number, repositoryId: number, tags: CondensedRegistryRepositoryTagSchema[]){

        const detailedTagsPromises : Promise<RegistryRepositoryTagSchema[]>[] = []
        const totalTags = tags.length
        for (let promiseIndex = 0; promiseIndex < this.concurrency; promiseIndex++){
            const tagDetailProm = this.getTagDetails(projectId, repositoryId, tags, totalTags)
            detailedTagsPromises.push(tagDetailProm)
        }

        let result : RegistryRepositoryTagSchema[] = []
        for (const tagDetailProm of detailedTagsPromises){
            const detailedTags = await tagDetailProm
            result = result.concat(detailedTags)
        }

        return result
    }

    /**
     * Used by getTagDetailsConcurrently Promises to fetch tags from array
     */
     private async getTagDetails(projectId: number, repositoryId: number, tags: CondensedRegistryRepositoryTagSchema[], totalTags: number){

        let result : RegistryRepositoryTagSchema[] = []

        while(tags.length > 0){

            const t = tags.pop()

            if (t !== undefined){

                if (tags.length % 100 == 0){
                    console.info(`   Fetching tag details ${totalTags-tags.length}/${totalTags}...`)
                }
    
                try {
                    const tagDetails = await this.gl.ContainerRegistry.showTag(projectId, repositoryId, t.name)
                    result.push(tagDetails)
                } catch(e: any){
                    const status = e?.cause?.response?.status
                    if ( status != 404){
                        console.error(`Non-404 error getting tag ${t.name}`, e)
                    }
                }       
            }

        }

        return result
    }

    private async filterTagsCreationDate(
        projectId: number, 
        repositoryId: number, 
        tags: CondensedRegistryRepositoryTagSchema[], 
        olderThanDays: number
    ){
        const now = new Date()

        const detailedTags = await this.getTagDetailsConcurrently(projectId, repositoryId, tags)

        // check all tags for creation date
        const deleteTags = detailedTags.filter(t => {
            const createdDate = new Date(t.created_at)
            const tagAgeDays = (now.getTime() - createdDate.getTime()) / (1000 * 3600 * 24)

            return tagAgeDays > olderThanDays
        })

        return deleteTags
    }

    private async deleteTagsConcurrently(projectId: number, repositoryId: number, tags:  RegistryRepositoryTagSchema[]){
        const deleteTagsPromises : Promise<void>[] = []
        const tagTotal = tags.length
        for (let promiseIndex = 0; promiseIndex < this.concurrency; promiseIndex++){
            const delTagProm = this.deleteTags(projectId, repositoryId, tags, tagTotal)
            deleteTagsPromises.push(delTagProm)
        }

        for(const delTagProm of deleteTagsPromises){
            await delTagProm
        }
    }

    /**
     * Used by deleteTagsConcurrently to delete tags from array
     */
    private async deleteTags(projectId: number, repositoryId: number, tags: RegistryRepositoryTagSchema[], tagTotal: number){

        while(tags.length > 0){
            const tag = tags.pop()

            if(tag !== undefined){

                if (tags.length % 100 == 0){
                    console.info(`    Deleting tag ${tagTotal-tags.length}/${tagTotal}...`)
                }
    
                if(!this.dryRun){
                    await this.gl.ContainerRegistry.removeTag(projectId, repositoryId, tag.name)
                } 
            }   
        }
    }

    private async writeDataJsonToFile(outputTagsToFile: string, data: any){
        fs.writeFileSync(outputTagsToFile, JSON.stringify(data, undefined, "  "))
    }

    private async promptUser(msg: string){
        const rl = readline.createInterface({ input, output });
        const answer = await rl.question(msg);
        rl.close();
    }

}



