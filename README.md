# GitLab Container Registry cleaner

CLI to list and cleanup your GitLab Container Registry and Container Repositories.

Contents:

- [What this is?](#what-this-is)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
  - [Persistent Configuration](#persistent-configuration)
  - [Multiple GitLab Targets](#multiple-gitlab-targets)
  - [Authentication](#authentication)
  - [Environment Variables](#environment-variables)
- [Usage](#usage)
  - [Repository Cache](#repository-cache)
  - [List Container Repositories](#list-container-repositories-for-entire-instance-groups-or-projects)
  - [Cleanup Container Repositories](#cleanup-container-repositories)
  - [How do I know my Container Repository ID?](#how-do-i-know-my-container-repository-id)
  - [Example Options](#example-options)
  - [Interactive vs Non-interactive Mode](#interactive-vs-non-interactive-mode)
  - [How does cleanup work?](#how-does-cleanup-work)
- [Development](#development)
- [Testing](#testing)
- [License](#license)

## What this is?

A CLI tool for cleaning up GitLab Container Registries. It deletes container image tags based on regex patterns, age, and recency filters — with concurrent API requests for speed.

- Interactive repository selection from a local cache
- Multiple repository cleanup in a single session
- Regex-based keep/delete filters with age and recency thresholds
- Multi-target support for managing several GitLab instances
- Secure token storage (config file or OS keyring)
- Dry-run by default for safety

## Requirements

- Node 20+
- GitLab token with `api` scope

## Installation

Just run:

```
npx gitlab-container-registry-cleaner
```

Alternatively, you can also clone this repository and run:

```sh
npm i -g yarn
yarn
yarn build
./gitlab-container-registry-cleaner
```

## Configuration

### Persistent Configuration

The tool stores its configuration in a YAML file following the XDG Base Directory specification:

- `$XDG_CONFIG_HOME/gitlab-registry-cleaner/config.yaml` (defaults to `~/.config/gitlab-registry-cleaner/config.yaml`)

On first run, the tool will prompt you to set up your GitLab host. You can also manage the full configuration interactively:

```sh
./gitlab-container-registry-cleaner config edit
```

This opens a menu where you can add/remove GitLab targets and edit preferences (concurrency, keep most recent). To view the current configuration:

```sh
./gitlab-container-registry-cleaner config show
```

### Multiple GitLab Targets

You can configure multiple GitLab hosts. Each target can have its own preferences and maintains a separate repository cache:

```sh
./gitlab-container-registry-cleaner config add-target https://gitlab.example.com
./gitlab-container-registry-cleaner config add-target https://gitlab.other.com
```

When multiple targets are configured, the tool will prompt you to select one. If only one target exists, it is used automatically.

The configuration file looks like this:

```yaml
preferences:
  defaultConcurrency: 20
  defaultKeepMostRecent: 0
targets:
  - host: https://gitlab.example.com
    lastCacheUpdate: "2025-10-01T12:00:00Z"
    preferences:
      defaultConcurrency: 50
  - host: https://gitlab.other.com
```

Per-target preferences override global preferences.

### Authentication

Authenticate with a GitLab instance using `auth login`. This stores your personal access token so you don't need to export it every time. The tool guides you to create a token with the required `api` scope.

```sh
# Interactive login (prompts for host and token)
./gitlab-container-registry-cleaner auth login

# Non-interactive login
./gitlab-container-registry-cleaner auth login --hostname https://gitlab.example.com --token glpat-xxx

# Read token from stdin (useful in scripts)
echo "glpat-xxx" | ./gitlab-container-registry-cleaner auth login --hostname https://gitlab.example.com --stdin

# Store token in OS keyring instead of config file
./gitlab-container-registry-cleaner auth login --use-keyring
```

By default, tokens are stored in the config file (with restrictive file permissions `0600`). On macOS and Linux, you can optionally store tokens in your operating system's keyring (macOS Keychain or GNOME Keyring / KDE Wallet via Secret Service).

Check authentication status across all targets:

```sh
./gitlab-container-registry-cleaner auth status
```

Remove stored credentials:

```sh
./gitlab-container-registry-cleaner auth logout
```

### Environment Variables

Environment variables take precedence over stored tokens. If `GITLAB_TOKEN` is set, it is used regardless of what is stored in the config file or keyring:

```sh
export GITLAB_TOKEN="xxx"
```

`GITLAB_HOST` can also be set as an environment variable, which takes precedence over the config file:

```sh
export GITLAB_HOST=https://gitlab.example.com
```

You can use a `.env` file to store these variables:

```sh
GITLAB_HOST=https://gitlab.example.com
GITLAB_TOKEN="xxx"
```

## Usage

Running the tool with no arguments starts a guided flow that walks you through setup (if needed) and interactive repository selection:

```sh
./gitlab-container-registry-cleaner
```

On first run, it will prompt you to configure a GitLab host and token. On subsequent runs, it uses your cached repositories for interactive cleanup. See below for individual commands.

### Repository Cache

Instead of manually saving and passing JSON files, you can use the built-in repository cache. The cache is stored per GitLab host and persists between runs.

Populate the cache by scanning repositories:

```sh
./gitlab-container-registry-cleaner cache update
```

You can customize the scan range and concurrency:

```sh
./gitlab-container-registry-cleaner cache update -s 500 -e 1000 -c 10
```

Add a single repository by ID:

```sh
./gitlab-container-registry-cleaner cache add 161
```

View cached repositories:

```sh
./gitlab-container-registry-cleaner cache show
```

Clear the cache:

```sh
./gitlab-container-registry-cleaner cache clear
```

Once the cache is populated, the `clean` command will automatically use it for interactive repository selection:

```sh
./gitlab-container-registry-cleaner clean
```

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

The easiest way is to use `cache update` to populate your local cache, then run `clean` without arguments for interactive selection:

```sh
./gitlab-container-registry-cleaner cache update
./gitlab-container-registry-cleaner clean
```

This shows a grouped list of repositories where you can select the ones you want to clean:

```
? Select repositories to clean: (Press <space> to select, <a> to toggle all, <i> to invert selection, and <enter> to proceed)
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

The Repository ID is also visible in the URL when navigating to your project Container Repository in _Deploy > Container Registry > [repository name]_:

```sh
# Repository ID is 42
https://gitlab.mycompany.net/somegroup/myproject/container_registry/42
```

Note that this ID is not the same as the project ID!

You can also use `list` commands to output a JSON file and pass it with `-j` (deprecated in favor of the cache):

```sh
./gitlab-container-registry-cleaner list all -o /tmp/repositories.json
./gitlab-container-registry-cleaner clean -j /tmp/repositories.json
```

### Example Options

Keep releases and remove everything else

```sh
-k 'v?[0-9]+\.[0-9]+\.[0-9]+.*' -d '.*'
```

Delete all tags starting with `dev-`. `$^` won't match anything:

```sh
-k '^$' -d '^dev-.*'
```

Delete all tags - USE WITH CARE:

```sh
-k '^$' -d '.*'
```

Delete all, but keep the most recent 10 tags:

```sh
-k '^$' -d '.*' -n 10
```

Keep the most recent 5 tags and delete everything older than 30 days:

```sh
-k '^$' -d '.*' -n 5 -a 30
```

### Interactive vs Non-interactive Mode

The tool behaves differently depending on how it is invoked. This is important to understand for safe usage.

**Non-interactive mode** (`clean <id> [options]`) is designed for scripting and CI/CD:

- Dry-run is enabled by default — nothing is deleted unless you pass `--no-dry-run`
- Regex defaults are safe: keep regex matches everything (`.*`), delete regex matches nothing (`^$`)
- You must explicitly set `-k` and `-d` to target specific tags
- No confirmation prompt — the dry-run flag is your safety net

**Interactive mode** (run with no arguments, or `clean` with no repository ID when cache is populated):

- Dry-run is disabled — deletions happen after you confirm
- Regex defaults are permissive: keep regex matches nothing (`^$`), delete regex matches everything (`.*`)
- You select repositories from a checkbox list
- Before deletion, you see the full list of tags and must confirm each repository
- Safety comes from the confirmation prompt, not from dry-run

In short: non-interactive mode is safe-by-default (opt _in_ to delete), while interactive mode is permissive-by-default (opt _out_ via confirmation).

### How does cleanup work?

Cleanup behavior is similar to [GitLab Registry cleanup policy](https://docs.gitlab.com/ee/user/packages/container_registry/reduce_container_registry_storage.html#how-the-cleanup-policy-works). Cleaner calls GitLab REST API concurrently:

- List all tags in the repository
- Filter out tags matching keep regex, filter in tags matching delete regex
- Fetch tag details to get creation dates (falls back to semver sorting if the API returns 404, a known issue with OCI manifests)
- Filter by age: only delete tags older than the specified number of days
- Keep the N most recent tags if specified
- Delete matching tags (or show what would be deleted in dry-run mode)

## Development

Run `yarn install` to install dependencies.

Run `yarn dev -- <command>` to start the dev version of the CLI with a given command.

Run `yarn build` to build the project into `dist`.

To release, run `yarn release`.

## Testing

Run `yarn test` to run the tests.

Tests use [vitest](https://vitest.dev/) with [msw](https://mswjs.io/) to mock the GitLab API. The test suite exercises the public interface only — no spying on private methods. Instead, HTTP DELETE calls are tracked through the mock server to verify which tags would actually be removed.

The cleaner tests are organized by mode:

- **Authentication** — verifies early failure on invalid/insufficient tokens
- **Non-interactive cleanup** — tests dry-run behavior, regex filtering, age filtering, and recency (keep N most recent)
- **Interactive cleanup** — tests the `confirmDelete` callback: declined confirmation prevents deletion, accepted confirmation proceeds, and the correct tags are passed to the callback
- **Semver fallback** — tests graceful degradation when the GitLab API returns 404 for tag details (OCI manifest issue), falling back to semver-based sorting

## License

Licensed under Apache License 2.0, see [LICENSE.txt](./LICENSE.txt) for more details.
