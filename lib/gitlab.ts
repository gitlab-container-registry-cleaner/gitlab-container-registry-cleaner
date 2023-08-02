import { Gitlab, RegistryRepositorySchema, CondensedRegistryRepositoryTagSchema, RegistryRepositoryTagSchema } from '@gitbeaker/rest';

export function gitlab_client(){
    return new Gitlab({
        token: process.env.GITLAB_TOKEN || "",
        host:process.env.GITLAB_HOST || "",
    }) 
}

/**
 * Get Container Repositories in a range of ID. Look for repository for each ID in range in parallel using GitLab API:
 * a 404 indicated repository does not exists, otherwise repository data is returned. 
 * @param startIndex repository ID to start from
 * @param endIndex repository ID to end by
 * @param parallel number of promises awaited in parallel
 */
export async function get_container_repositories_parallel(startIndex=1, endIndex=1000, parallel=10){

    // distribute requests across multiple asynchronous operations
    // divide calls between Promises and wait for them at the end
    const requestCount = endIndex - startIndex + 1
    const requestPerThread = Math.round(requestCount / parallel)

    console.info(`Requesting container repository ID [${startIndex}-${endIndex}] with parallelism ${parallel} (${requestPerThread} req / thread).`)

    let repositoriesPromises : Promise<RegistryRepositorySchema[]>[] = []

    for (let i = 0; i <= parallel-1; i++){
        const threadStartIndex = i * requestPerThread
        const threadEndIndex = threadStartIndex + requestPerThread
        
        const repositoriesProm = get_container_repositories(threadStartIndex, threadEndIndex)
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
 * Like get_container_repositories_parallel() but not parallel.
 */
export async function get_container_repositories(startIndex: number, endIndex: number){
    const gl = gitlab_client()

    console.info(`Listing repositories [${startIndex}-${endIndex}]`)

    let result : RegistryRepositorySchema[] = []
    for (let i = startIndex; i < endIndex; i++){
        try {
            const repo = await gl.ContainerRegistry.showRepository(i, {tagsCount: true})
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
 * Get all container repository tags. Uses GitLab API pagination to parallelize requests across multiple Promises,
 * each Promises having a range of pages to fetch.
 * 
 * @param projectId 
 * @param repositoryId 
 * @param maxParallelism maximum number of Promises awaited in parallel. If number of page to list is too small, each Promise will get 1 page to fetch.
 * @param tagPerPage number of tags per page
 * @returns 
 */
export async function get_all_repository_tags(projectId: number, repositoryId: number, maxParallelism=20, tagPerPage=50){
    const gl = gitlab_client()

    const repo = await gl.ContainerRegistry.showRepository(repositoryId, { tagsCount: true})

    // even pages across Promises considering parallelism and tag per pages
    const tagCount = repo.tags_count!
    const pageCount = Math.ceil(tagCount / tagPerPage)
    const parallelism = Math.min(maxParallelism, pageCount)
    const pagePerPromise = Math.round(pageCount / parallelism)

    console.info(`Listing ${tagCount} tags with ${parallelism} Promises, ${pageCount} pages (${tagPerPage} / page) and ${pagePerPromise} page per Promises`)

    // Run all promises in parallel and fetch result later
    let tagListPromises : Promise<CondensedRegistryRepositoryTagSchema[]>[] = []
    for (let promiseIndex = 0; promiseIndex < parallelism; promiseIndex++){
        const startPage = promiseIndex * pagePerPromise + 1
        const endPage = startPage + pagePerPromise

        const tagListProm = get_repository_tags_for_pages(projectId, repositoryId, startPage, endPage, tagPerPage)
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
 * Fetch Container Repository tags for the given pages without parallelism
 * @param projectId 
 * @param repositoryId 
 * @param startPage 
 * @param endPage 
 * @param perPage 
 * @returns 
 */
async function get_repository_tags_for_pages(projectId: number, repositoryId: number, startPage: number, endPage: number, perPage: number){
    const gl = gitlab_client()

    console.info(`Listing tags page [${startPage}-${endPage-1}]`)

    let result: CondensedRegistryRepositoryTagSchema[] = []
    for (let page = startPage; page < endPage; page++){
        const tags = await gl.ContainerRegistry.allTags(projectId, repositoryId, { page: page, perPage: perPage })
        result = result.concat(tags)
    }

    console.info(`Listed tags page [${startPage}-${endPage}]`)

    return result
}

export async function delete_container_repository_tags(projectId: number, 
        repositoryId: number, 
        keepTagRegex = '^(latest|master|dev|dev_tested|v?[0-9]+[\-\.][0-9]+[\-\.][0-9]+.*)$', 
        olderThanDays = 7,
        dryRun=true,
        parallelism = 10,
        tagPerPage = 50
    ){

    const now = new Date()
    const allTags = await get_all_repository_tags(projectId, repositoryId, parallelism, tagPerPage)

    // check all tags for regex
    const tagRegex = new RegExp(keepTagRegex)
    let matchRegexTags : CondensedRegistryRepositoryTagSchema[] = []

    for (const tag of allTags){
        if (!tagRegex.test(tag.name)){
            matchRegexTags.push(tag)
        }
    }

    console.info(`Found ${matchRegexTags.length} tags matching regex '${keepTagRegex}'`)

    // check date for all tags matching regex
    const tagPerPromise = Math.round(matchRegexTags.length / parallelism)
    const detailedTagsPromises : Promise<RegistryRepositoryTagSchema[]>[] = []
    for (let promiseIndex = 0; promiseIndex < parallelism; promiseIndex++){
        const tagIndexStart = promiseIndex * tagPerPromise
        const tagIndexEnd = tagIndexStart + tagPerPromise - 1

        const tagDetailProm = get_tag_details(projectId, repositoryId, matchRegexTags.slice(tagIndexStart, tagIndexEnd))
        detailedTagsPromises.push(tagDetailProm)
    }

    let regexMatchingTagDetails : RegistryRepositoryTagSchema[] = []
    for (const tagDetailProm of detailedTagsPromises){
        const detailedTags = await tagDetailProm
        regexMatchingTagDetails = regexMatchingTagDetails.concat(detailedTags)
    }

    // check all tags for creation date
    // those tags then both match regex and age to be deleted
    const deleteTags : RegistryRepositoryTagSchema[] = []
    for (const tag of regexMatchingTagDetails){
        const createdDate = new Date(tag.created_at)
        const tagAgeDays = (now.getTime() - createdDate.getTime()) / (1000 * 3600 * 24)

        if (tagAgeDays > olderThanDays){
            deleteTags.push(tag)
        }
    }

    console.info(`Found ${deleteTags.length} tags to delete.`)

    // Delete tags in parallel
    const deleteTagPerPromise = Math.round(deleteTags.length / parallelism)
    const deleteTagsPromises : Promise<void>[] = []
    for (let promiseIndex = 0; promiseIndex < parallelism; promiseIndex++){
        const delTagStartIndex = promiseIndex * deleteTagPerPromise
        const delTagEndIndex = delTagStartIndex + deleteTagPerPromise
        const delTagSlice = deleteTags.slice(delTagStartIndex, delTagEndIndex)

        const delTagProm = delete_tags_sequentially(projectId, repositoryId, delTagSlice)
        deleteTagsPromises.push(delTagProm)
    }

    for(const delTagProm of deleteTagsPromises){
        await delTagProm
    }
}

async function get_tag_details(projectId: number, repositoryId: number, tags: CondensedRegistryRepositoryTagSchema[]){
    const gl = gitlab_client()

    console.info(`Getting details for ${tags.length} tags`)

    let result : RegistryRepositoryTagSchema[] = []
    for(const t of tags){
        try {
            const tagDetails = await gl.ContainerRegistry.showTag(projectId, repositoryId, t.name)
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

/**
 * Delete given tags in sequence
 * @param projectId 
 * @param repositoryId 
 * @param tags 
 * @param dryRun 
 */
async function delete_tags_sequentially(projectId: number, repositoryId: number, tags: RegistryRepositoryTagSchema[], dryRun=true){
    const gl = gitlab_client()

    for(const t of tags){
        if(!dryRun){
            console.debug(`Deleting ${t.name}`)
            await gl.ContainerRegistry.removeTag(projectId, repositoryId, t.name)
        } else {
            console.debug(`[DRY-RUN] Would delete ${t.name}`)
        }
        
    }
}