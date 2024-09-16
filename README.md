# GitLab Container Registry cleaner

CLI to list and cleanup your GitLab Container Registry and Container Repositories.

Contents:

- [What this is?](#what-this-is)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
  - [List Container Repositories for entire instance, groups or projects](#list-container-repositories-for-entire-instance-groups-or-projects)
  - [Cleanup Container Repositories](#cleanup-container-repositories)
  - [How do I know my Container Repository ID?](#how-do-i-know-my-container-repository-id)
  - [Example Options](#example-options)
  - [How does cleanup work?](#how-does-cleanup-work)
- [Development](#development)
- [Testing](#testing)
- [License](#license)

## What this is?

This tool helps you clean up the GitLab Container Registry by deleting tags that match a specified regex pattern.

- Interactive repository selection
- Multiple repository deletion in a single command
- Added option to keep/delete tags by age
- More verbose logging
- And: unit testing, code cleanup/formatting and refactoring

## Requirements

- Node 18+
- GitLab token with `api` scope

## Installation

Just run:

```
npx @gitlab-container-registry-cleaner/gitlab-container-registry-cleaner
```

Alternatively, you can also clone this repository and run:

```sh
npm i -g yarn
yarn
yarn build
./gitlab-container-registry-cleaner
```

## Configuration

Export environment variables to specify your GitLab server and token:

```sh
export GITLAB_HOST=https://gitlab.example.com
export GITLAB_TOKEN="xxx"
```

Alternatively, you can use a `.env` file to store those variables:

```sh
GITLAB_HOST=https://gitlab.example.com
GITLAB_TOKEN="xxx"
```

## Usage

We provide a wrapper around the CLI that makes it easier to use. You can run:

```sh
./gitlab-container-registry-cleaner
```

See below for more details on the commands.

### List Container Repositories for entire instance, groups or projects

The following command will list all instance-wide container repositories, checking 1 to 10000 repository IDs with a concurrency of 20 by default:

```sh
./gitlab-container-registry-cleaner list all
```

You can output them to a file so you can later look at the repository IDs:

```sh
./gitlab-container-registry-cleaner list all -o /tmp/repositories.json
```

You can also filter the repositories by providing a start and end ID, and a concurrency level. The concurrency level is the number of concurrent requests to GitLab API, and the below example checks 500 to 1000 with 10 concurrency (up to 10 requests in parallel):

```sh
./gitlab-container-registry-cleaner list all -s 500 -e 1000 -c 10 -o /tmp/repositories.json
```

Listing instance wide Container Repositories is done concurrently and may take some time. Internally, it calls GitLab REST API to check every repository ID between 1 and 10000 by default.

You can also list per group or per project:

```sh
./gitlab-container-registry-cleaner list project 42
./gitlab-container-registry-cleaner list project mygroup/myproject

./gitlab-container-registry-cleaner list group 666
./gitlab-container-registry-cleaner list group mygroup/mysubgroup
```

### Cleanup Container Repositories

Run cleanup for a project's Container Repository. Note that by default **cleanup will dry-run and regex won't match anything for safety reasons**.

Example usage:

```sh
# Cleanup repository 161
# keep tags matching releases
# Will dry-run by default
./gitlab-container-registry-cleaner clean 161 -k 'v?[0-9]+\.[0-9]+\.[0-9]+.*' -d '.*'

# Output JSON list of tags that would be deleted to a file
# Check their name and created date
./gitlab-container-registry-cleaner clean 161 -k 'v?[0-9]+\.[0-9]+\.[0-9]+.*' -d '.*' --output-tags /tmp/tags.json
cat /tmp/tags.json | jq '.[] | .name + "\t" + .created_at ' -r

# Once satisfied, run without dry-run
./gitlab-container-registry-cleaner clean 161 -k 'v?[0-9]+\.[0-9]+\.[0-9]+.*' -d '.*' --no-dry-run
```

### How do I know my Container Repository ID?

The Repository ID is visible in the URL when navigating to your project Container Repository in _Deploy > Container Registry > [repository name]_. The URL looks like:

``` sh
# Repository ID is 42
https://gitlab.mycompany.net/somegroup/myproject/container_registry/42
```

Note that this ID is not the same as the project ID!

Alternatively, use `./gitlab-container-registry-cleaner list` (see above) to generate the JSON file. Then you can pass that file to the clean command without any ID, which will show a list of repositories to choose from:

```sh
./gitlab-container-registry-cleaner list all -o /tmp/repositories.json
./gitlab-container-registry-cleaner clean -j /tmp/repositories.json
```

This might show something like the following, where you can select the repositories you want to clean:

```
? Select a repository to clean: (Press <space> to select, <a> to toggle all, <i> to invert selection, and <enter> to proceed)
 firstgroup
❯◯ foo/bar/example-project
 secondgroup
 ◯ analytics-project/apm-server
 ◯ analytics-project/elasticsearch
 ◯ analytics-project/grafana
 ◯ analytics-project/kibana
 ◯ analytics-project/logstash
 ◯ analytics-project/prometheus
(Use arrow keys to reveal more choices)
```

Press `enter` to clean the selected repositories.

### Example Options

Keep releases and remove everything else

```sh
-k 'v?[0-9]+\.[0-9]+\.[0-9]+.*' -d '.*'
```

Delete all tags starting with `dev-`. `$^` won't match anything:

```sh
-k '$^' -d '$dev-.*'
```

Delete all tags - USE WITH CARE:

```sh
-k '$^' -d '.*'
```

Delete all, but keep the most recent 10 tags:

```sh
-k '$^' -d '.*' -n 10
```

Keep the most recent 5 tags and delete everything older than 30 days:

```sh
-k '$^' -d '.*' -n 5 -a 30
```

### How does cleanup work?

Cleanup behavior is similar to [GitLab Registry cleanup policy](https://docs.gitlab.com/ee/user/packages/container_registry/reduce_container_registry_storage.html#how-the-cleanup-policy-works). Cleaner calls GitLab REST API concurrently such as:

- List all tags in repository with [_List registry repository tags_](https://docs.gitlab.com/ee/api/container_registry.html#list-registry-repository-tags)
- Filter out tags not matching keep regex, filter in tags matching delete regex
- Get tag details with [_Get details of a registry repository tag_](https://docs.gitlab.com/ee/api/container_registry.html#get-details-of-a-registry-repository-tag) as List registry repository tags only provide tag name, not creation date
- Filter in tags older than specified number of days
- Keep the most recent N tags if specified
- Delete 'em !

## Development

Run `yarn install` to install dependencies.

Run `yarn dev -- <command>` to start the dev version of the CLI with a given command.

Run `yarn build` to build the project into `dist`.

To release, run `yarn release`.

## Testing

Run `yarn test` to run the tests.

## License

Licensed under Apache License 2.0, see [LICENSE.txt](./LICENSE.txt) for more details.
