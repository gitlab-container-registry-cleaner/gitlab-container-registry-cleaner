import { Gitlab, RegistryRepositorySchema, CondensedRegistryRepositoryTagSchema, RegistryRepositoryTagSchema } from '@gitbeaker/rest';

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
    public async getContainerRepositoriesConcurrently(startIndex=1, endIndex=1000){

        const totalLength = endIndex - startIndex + 1
        const repositoryIds = [ ...Array(totalLength).keys() ].map( i => i+startIndex);

        console.info(`Requesting container repository IDs [${startIndex}-${endIndex}] concurrency ${this.concurrency}`)

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

        console.info(`Found ${repositories.length} repositories`)
        return repositories
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
                    console.info(`Checking container repository IDs ${totalLength-repositoryIds.length}/${totalLength}...`)
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
    private async getRepositoryTagsConcurrently(projectId: number, repositoryId: number, tagPerPage=50){

        const repo = await this.gl.ContainerRegistry.showRepository(repositoryId, { tagsCount: true})

        const tagCount = repo.tags_count!
        const pageTotal = Math.ceil(tagCount / tagPerPage)
        const pages = [ ...Array(pageTotal).keys() ].map( i => i+1);

        console.info(`Listing ${tagCount} tags (${pageTotal} pages, ${tagPerPage} / page)`)

        // Run all promises in parallel and fetch result later
        let tagListPromises : Promise<CondensedRegistryRepositoryTagSchema[]>[] = []
        for (let promiseIndex = 0; promiseIndex < this.concurrency; promiseIndex++){

            const tagListProm = this.getRepositoryTagsForPages(projectId, repositoryId, pages, tagPerPage, pageTotal)
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
    private async getRepositoryTagsForPages(projectId: number, repositoryId: number, pages: number[], perPage: number, totalPages: number){
        
        let result: CondensedRegistryRepositoryTagSchema[] = []
        while(pages.length > 0){
            const page = pages.pop()

            if(page !== undefined){

                if (pages.length % 10 == 0){
                    console.info(`Listing Container Repository tags page ${totalPages-pages.length}/${totalPages}...`)
                }

                const tags = await this.gl.ContainerRegistry.allTags(projectId, repositoryId, { page: page, perPage: perPage })
                result = result.concat(tags)
            }
        }

        return result
    }

    public async cleanupContainerRepositoryTags(
        projectId: number, 
        repositoryId: number, 
        keepTagRegex = '.*', 
        removeTagRegex = "^$",
        olderThanDays = 7,
        tagPerPage = 50
    ){

        const now = new Date()

        // retrieve all tags
        const allTags = await this.getRepositoryTagsConcurrently(projectId, repositoryId, tagPerPage)

        // filter out tags matching keep regex
        const regexFilteredTags = this.filterTagsRegex(allTags, keepTagRegex, removeTagRegex)

        console.info(`Found ${regexFilteredTags.length} tags matching '${removeTagRegex}' but not matching '${keepTagRegex}'`)

        // filter out tags younger than days
        const deleteTags = await this.filterTagsCreationDate(projectId, repositoryId, regexFilteredTags, olderThanDays)
        const deleteTagCount = deleteTags.length

        console.info(`Found ${deleteTagCount} tags created ${olderThanDays} days ago or earlier`)

        // Delete tags in parallel
        console.info(`Deleting ${deleteTagCount} (dry-run: ${this.dryRun})`)

        this.deleteTagsConcurrently(projectId, repositoryId, deleteTags)

        console.info(`Deleted ${deleteTagCount} tags`)
    }

    /**
     * Filter tags based on regex. All tags matching regex are kept.
     * Return tags to remove.
     */
    private filterTagsRegex(tags: CondensedRegistryRepositoryTagSchema[], keepTagRegexStr: string, removeTagRegexStr: string){
        const keepTagRegex = new RegExp(keepTagRegexStr)
        const removeTagRegex = new RegExp(removeTagRegexStr)
        
        let deleteCandidate : CondensedRegistryRepositoryTagSchema[] = []

        // filter out tags matching keepTagRegex
        deleteCandidate = tags.filter(t => !keepTagRegex.test(t.name))

        // filter in tags matching removeTagRegex
        return deleteCandidate.filter(t => removeTagRegex.test(t.name))
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
                    console.info(`Fetch tag details ${totalTags-tags.length}/${totalTags}...`)
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
                    console.info(`Deleting tag ${tagTotal-tags.length}/${tagTotal}...`)
                }
    
                if(!this.dryRun){
                    // await this.gl.ContainerRegistry.removeTag(projectId, repositoryId, t.name)
                } 
            }   
        }
    }

}



