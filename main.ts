import { Gitlab } from '@gitbeaker/rest';
import { gitlab_client, get_container_repositories_parallel, get_all_repository_tags, delete_container_repository_tags } from "./lib/gitlab";

async function main(){
    // get_all_container_registries()
    delete_container_repository_tags(341, 197)
}

main().catch(e => {
    console.error(e)
})