import { Gitlab, RegistryRepositorySchema, CondensedRegistryRepositoryTagSchema, RegistryRepositoryTagSchema } from '@gitbeaker/rest';

export class GitLabContainerRepositoryCleaner {

    gl: InstanceType<typeof Gitlab<false>> 

    constructor(){
        this.gl = new Gitlab({
            token: process.env.GITLAB_TOKEN || "",
            host:process.env.GITLAB_HOST || "",
        }) 
    }

    /**
     * Get Container Repositories in a range of ID. Look for repository for each ID in range concurrently using GitLab API:
     * a 404 indicated repository does not exists, otherwise repository data is returned. 
     * @param startIndex repository ID to start from
     * @param endIndex repository ID to end by
     * @param concurrent number of promises awaited concurrently
     */
    public async getContainerRepositoriesConcurrently(startIndex=1, endIndex=1000, concurrent=10){

        // distribute requests across multiple asynchronous operations
        // divide calls between Promises and wait for them at the end
        const requestCount = endIndex - startIndex + 1
        const requestPerThread = Math.round(requestCount / concurrent)

        console.info(`Requesting container repository ID [${startIndex}-${endIndex}] with parallelism ${concurrent} (${requestPerThread} req / thread).`)

        let repositoriesPromises : Promise<RegistryRepositorySchema[]>[] = []

        for (let i = 0; i <= concurrent-1; i++){
            const threadStartIndex = i * requestPerThread
            const threadEndIndex = threadStartIndex + requestPerThread
            
            const repositoriesProm = this.getContainerRepositories(threadStartIndex, threadEndIndex)
            repositoriesPromises.push(repositoriesProm)
        }

        let repositories : RegistryRepositorySchema[] = []
        for (const repositoryProm of repositoriesPromises){
            const partialRepositories = await repositoryProm
            repositories = repositories.concat(partialRepositories)
        }

        console.info(`Found ${repositories.length} repositories`)

        return repositories
        
    }


    /**
     * Used by getContainerRepositoriesConcurrently Promises to fetch repositories sequentially
     * Each Promise run this function
     */
    private async getContainerRepositories(startIndex: number, endIndex: number){

        console.info(`Listing repositories [${startIndex}-${endIndex}]`)

        let result : RegistryRepositorySchema[] = []
        for (let i = startIndex; i < endIndex; i++){
            try {
                const repo = await this.gl.ContainerRegistry.showRepository(i, {tagsCount: true})
                result.push(repo)
            } catch(e: any) {
                const status = e?.cause?.response?.status
                if ( status != 404 && status != 403){
                    console.error(`Non-404 error listing repository ID ${i}`, e)
                }
            }
        }

        console.info(`Listed repositories [${startIndex}-${endIndex}]`)

        return result
    }

    /**
     * Get all tags of a Project's Container Repository. Uses GitLab API pagination to run concurrent requests across multiple Promises,
     * each Promises having a range of pages to fetch.
     * 
     * @param projectId 
     * @param repositoryId 
     * @param maxConcurrent maximum number of Promises awaited in parallel. If number of page to list is too small, each Promise will get 1 page to fetch.
     * @param tagPerPage number of tags per page
     * @returns 
     */
    private async getRepositoryTagsConcurrently(projectId: number, repositoryId: number, maxConcurrent=20, tagPerPage=50){

        const repo = await this.gl.ContainerRegistry.showRepository(repositoryId, { tagsCount: true})

        // even pages across Promises considering parallelism and tag per pages
        const tagCount = repo.tags_count!
        const pageCount = Math.ceil(tagCount / tagPerPage)
        const parallelism = Math.min(maxConcurrent, pageCount)
        const pagePerPromise = Math.round(pageCount / parallelism)

        console.info(`Listing ${tagCount} tags with ${parallelism} Promises, ${pageCount} pages (${tagPerPage} / page) and ${pagePerPromise} page per Promises`)

        // Run all promises in parallel and fetch result later
        let tagListPromises : Promise<CondensedRegistryRepositoryTagSchema[]>[] = []
        for (let promiseIndex = 0; promiseIndex < parallelism; promiseIndex++){
            const startPage = promiseIndex * pagePerPromise + 1
            const endPage = startPage + pagePerPromise

            const tagListProm = this.getRepositoryTagsForPages(projectId, repositoryId, startPage, endPage, tagPerPage)
            tagListPromises.push(tagListProm)
        }

        let allTags : CondensedRegistryRepositoryTagSchema[] = []
        for (const tagListProm of tagListPromises){
            const tags = await tagListProm
            allTags = allTags.concat(tags)
        }

        console.info(`Found ${allTags.length} tags`)

        return allTags
    }


    /**
     * Fetch Container Repository tags for the given pages sequentially. 
     * Used by promises of getRepositoryTagsConcurrently
     */
    private async getRepositoryTagsForPages(projectId: number, repositoryId: number, startPage: number, endPage: number, perPage: number){

        console.info(`Listing tags page [${startPage}-${endPage-1}]`)

        let result: CondensedRegistryRepositoryTagSchema[] = []
        for (let page = startPage; page < endPage; page++){
            const tags = await this.gl.ContainerRegistry.allTags(projectId, repositoryId, { page: page, perPage: perPage })
            result = result.concat(tags)
        }

        console.info(`Listed tags page [${startPage}-${endPage}]`)

        return result
    }

    public async cleanupContainerRepositoryTags(
        projectId: number, 
        repositoryId: number, 
        keepTagRegex = '^(latest|master|dev|dev_tested|v?[0-9]+[\-\.][0-9]+[\-\.][0-9]+.*)$', 
        olderThanDays = 7,
        dryRun=true,
        concurrent = 10,
        tagPerPage = 50
    ){

        const now = new Date()

        // retrieve all tags
        const allTags = await this.getRepositoryTagsConcurrently(projectId, repositoryId, concurrent, tagPerPage)

        // filter out tags matching keep regex
        const regexFilteredTags = this.filterTagsRegex(allTags, keepTagRegex)

        console.info(`Found ${regexFilteredTags.length} tags matching regex '${keepTagRegex}'`)

        // filter out tags younger than days
        const deleteTags = await this.filterTagsCreationDate(projectId, repositoryId, regexFilteredTags, olderThanDays, concurrent)

        console.info(`Found ${deleteTags.length} tags to delete.`)

        // Delete tags in parallel
        console.info(`Deleting ${deleteTags.length}...`)

        this.deleteTagsConcurrently(projectId, repositoryId, deleteTags, concurrent)

        console.info(`Deleted ${deleteTags.length}`)
    }

    /**
     * Filter tags based on regex. All tags matching regex are kept.
     * Return tags to remove.
     */
    private filterTagsRegex(tags: CondensedRegistryRepositoryTagSchema[], keepTagRegex: string){
        const tagRegex = new RegExp(keepTagRegex)
        return tags.filter(t => !tagRegex.test(t.name))
    }

    private async filterTagsCreationDate(
        projectId: number, 
        repositoryId: number, 
        tags: CondensedRegistryRepositoryTagSchema[], 
        olderThanDays: number, 
        concurrent: number, 
    ){
        const now = new Date()

        // CondensedRegistryRepositoryTagSchema does not contain creation date
        // Fetch all tags details concurrently
        const tagPerPromise = Math.round(tags.length / concurrent)
        const detailedTagsPromises : Promise<RegistryRepositoryTagSchema[]>[] = []
        for (let promiseIndex = 0; promiseIndex < concurrent; promiseIndex++){
            const tagIndexStart = promiseIndex * tagPerPromise
            const tagIndexEnd = tagIndexStart + tagPerPromise - 1

            const tagDetailProm = this.getTagDetails(projectId, repositoryId, tags.slice(tagIndexStart, tagIndexEnd))
            detailedTagsPromises.push(tagDetailProm)
        }

        let regexMatchingTagDetails : RegistryRepositoryTagSchema[] = []
        for (const tagDetailProm of detailedTagsPromises){
            const detailedTags = await tagDetailProm
            regexMatchingTagDetails = regexMatchingTagDetails.concat(detailedTags)
        }

        // check all tags for creation date
        const deleteTags = regexMatchingTagDetails.filter(t => {
            const createdDate = new Date(t.created_at)
            const tagAgeDays = (now.getTime() - createdDate.getTime()) / (1000 * 3600 * 24)

            return tagAgeDays > olderThanDays
        })

        return deleteTags
    }

    private async getTagDetails(projectId: number, repositoryId: number, tags: CondensedRegistryRepositoryTagSchema[]){

        console.info(`Getting details for ${tags.length} tags`)

        let result : RegistryRepositoryTagSchema[] = []
        for(const t of tags){
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

        return result
    }

    private async deleteTagsConcurrently(projectId: number, repositoryId: number, tags:  RegistryRepositoryTagSchema[], concurrent: number){
        const deleteTagPerPromise = Math.round(tags.length / concurrent)
        const deleteTagsPromises : Promise<void>[] = []
        for (let promiseIndex = 0; promiseIndex < concurrent; promiseIndex++){
            const delTagStartIndex = promiseIndex * deleteTagPerPromise
            const delTagEndIndex = delTagStartIndex + deleteTagPerPromise
            const delTagSlice = tags.slice(delTagStartIndex, delTagEndIndex)

            const delTagProm = this.deleteTags(projectId, repositoryId, delTagSlice)
            deleteTagsPromises.push(delTagProm)
        }

        for(const delTagProm of deleteTagsPromises){
            await delTagProm
        }
    }

    /**
     * Delete given tags in sequence
     * @param projectId 
     * @param repositoryId 
     * @param tags 
     * @param dryRun 
     */
    private async deleteTags(projectId: number, repositoryId: number, tags: RegistryRepositoryTagSchema[], dryRun=true){

        for(const t of tags){
            if(!dryRun){
                console.debug(`Deleting ${t.name}`)
                await this.gl.ContainerRegistry.removeTag(projectId, repositoryId, t.name)
            } else {
                console.debug(`[DRY-RUN] Would delete ${t.name}`)
            }
            
        }
    }

}



