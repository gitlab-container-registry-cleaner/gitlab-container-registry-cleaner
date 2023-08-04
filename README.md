# GitLab Container Registry cleaner

CLI to list and cleanup your GitLab Container Registry and Container Repositories.

## Usage

Requirements:

- Node 18+
- GitLab token with `api` scope

Export environment variables to specify your GitLab server and token:

```sh
export GITLAB_HOST=https://gitlab.awesomecompany.net
export GITLAB_TOKEN="xxx" 
```

### List Container Repositories instance-wide

```sh
# Check all Container Repository from 1 to 10000 with a concurrency of 20 by default
./gitlab-container-registry-cleaner list 

# Customize concurrency and ID range
# Example to check between ID 500-1000 with 10 concurrency (up to 10 requests in parallel)
# Output result to /tmp/repositories.json
./gitlab-container-registry-cleaner list -s 500 -e 1000 -c 10 -o /tmp/repositories.json
```

### Cleanup Container Repositories

Run cleanup for a project's Container Repository. Note that by default **cleanup will dry-run and regex won't match anything for safety reasons**. 

Example usage:

```sh
# Clean repository 161 of project 486, keep tags matching releases
# Will dry-run by default
./gitlab-container-registry-cleaner clean -p 486 -r 161 -k 'v?[0-9]+\.[0-9]+\.[0-9]+.*' -d '.*'

# Output JSON list of tags that would be deleted to a file
# Check their name and created date
./gitlab-container-registry-cleaner clean -p 486 -r 161 -k 'v?[0-9]+\.[0-9]+\.[0-9]+.*' -d '.*' --output-tags /tmp/tags.json
cat /tmp/tags.json | jq '.[] | .name + "\t" + .created_at ' -r

# Once satisfied, run without dry-run
./gitlab-container-registry-cleaner clean -p 486 -r 161 -k 'v?[0-9]+\.[0-9]+\.[0-9]+.*' -d '.*' --no-dry-run
```

Example keep/delete regex you can use:

```sh
# Keep releases and remove everything else
-k 'v?[0-9]+\.[0-9]+\.[0-9]+.*' -d '.*'

# Delete all tags starting with `dev-`
# '$^' won't match anything
-k '$^' -d '$dev-.*'

# Delete all tags - USE WITH CARE
-k '$^' -d '.*'
```

Cleanup behavior is similar to [GitLab Registry cleanup policy](https://docs.gitlab.com/ee/user/packages/container_registry/reduce_container_registry_storage.html#how-the-cleanup-policy-works). Cleaner calls GitLab REST API concurrently such as:

- List all tags in repository with [_List registry repository tags_](https://docs.gitlab.com/ee/api/container_registry.html#list-registry-repository-tags)
- Filter out tags not matching keep regex, filter in tags matching delete regex
- Get tag details with [_Get details of a registry repository tag_](https://docs.gitlab.com/ee/api/container_registry.html#get-details-of-a-registry-repository-tag) as List registry repository tags only provide tag name, not creation date
- Filter in tags older than specified number of days 
- Delete 'em !

