# GitLab Container Registry Cleaner

A CLI tool for cleaning up GitLab Container Registries. It deletes container image tags based on regex patterns, age, and recency filters — with concurrent API requests for speed.

- Interactive guided flow with repository selection and confirmation prompts
- Regex-based keep/delete filters with age and recency thresholds
- Concurrent API requests for fast scanning and cleanup
- Multi-target support for managing several GitLab instances
- Secure token storage (config file or OS keyring)
- Dry-run by default in scripting mode for safety

## Quick Start

Requires Node 22+ and a GitLab personal access token with `api` scope.

```sh
npx gitlab-container-registry-cleaner
```

On first run, the tool guides you through connecting to your GitLab instance. Once set up, populate your local repository cache and start cleaning:

```sh
npx gitlab-container-registry-cleaner cache update
npx gitlab-container-registry-cleaner clean
```

## How It Works

Running `clean` with a populated cache opens an interactive selector showing your repositories grouped by top-level namespace, with tag counts:

```
? Select repositories to clean:
 ── mygroup ──
❯○ myproject/web (12 tags)
 ○ myproject/api (5 tags)
 ── othergroup ──
 ○ analytics/grafana (23 tags)
 ○ analytics/prometheus (8 tags)
  Refreshing tag counts… (2/4)
↑↓ navigate · space select · a all · i invert · ⏎ submit
```

After selecting repositories, the tool shows which tags will be deleted and asks for confirmation before each repository:

```
📋 Cleanup settings:
   Delete regex:      .*
   Keep regex:        ^$
   Older than:        90 days
   Keep most recent:  0 tags

🧹 Cleaning image tags for repository mygroup/myproject/web (ID: 42). ...
...
💀 Found 3 tags to delete

Tags to delete:
  - dev-abc123 (12/1/2024)
  - feature-xyz (11/15/2024)
  - old-build (10/3/2024)

? Delete 3 tags? (y/N)
```

Under the hood, cleanup follows a pipeline similar to [GitLab's built-in cleanup policy](https://docs.gitlab.com/ee/user/packages/container_registry/reduce_container_registry_storage.html#how-the-cleanup-policy-works):

1. List all tags in the repository
2. Filter out tags matching the keep regex, filter in tags matching the delete regex
3. Fetch tag details to get creation dates (falls back to semver sorting when the API returns 404, a known issue with OCI manifests)
4. Remove tags newer than the age threshold
5. Protect the N most recent remaining tags
6. Delete matching tags (or show what would be deleted in dry-run mode)

## Safety Model

The tool behaves differently depending on how it's invoked.

**Interactive mode** (no arguments, or `clean` without a repository ID) is designed for hands-on use:

- Dry-run is off — deletions happen after you confirm
- Defaults are permissive: delete regex matches everything (`.*`), keep regex matches nothing (`^$`)
- You see the full tag list and confirm before each repository
- Safety comes from the confirmation prompt

**Non-interactive mode** (`clean <id> [options]`) is designed for scripting and CI/CD:

- Dry-run is on by default — nothing is deleted unless you pass `--no-dry-run`
- Defaults are safe: keep regex matches everything (`.*`), delete regex matches nothing (`^$`)
- You must explicitly set `-k` and `-d` to target specific tags
- Safety comes from dry-run

## Authentication

The guided flow handles auth setup using GitLab Personal Access tokens on first run. You can also manage your tokens directly:

```sh
# Interactive login (prompts for host and token)
npx gitlab-container-registry-cleaner auth login

# Non-interactive login
npx gitlab-container-registry-cleaner auth login --hostname https://gitlab.example.com --token glpat-xxx

# Read token from stdin (useful in CI)
echo "glpat-xxx" | npx gitlab-container-registry-cleaner auth login --hostname https://gitlab.example.com --stdin

# Store token in OS keyring instead of config file
npx gitlab-container-registry-cleaner auth login --use-keyring
```

By default, tokens are stored in the config file. On macOS and Linux, you can optionally use the OS keyring (macOS Keychain or GNOME Keyring / KDE Wallet).

```sh
npx gitlab-container-registry-cleaner auth status   # check token status
npx gitlab-container-registry-cleaner auth logout    # remove stored credentials
```

Note that environment variables take precedence over stored tokens:

```sh
export GITLAB_HOST=https://gitlab.example.com
export GITLAB_TOKEN="glpat-xxx"
```

These can also be placed in a `.env` file.

## Configuration

Configuration is stored in `$XDG_CONFIG_HOME/gitlab-registry-cleaner/config.yaml` (defaults to `~/.config/gitlab-registry-cleaner/config.yaml`).

```sh
npx gitlab-container-registry-cleaner config edit    # interactive menu
npx gitlab-container-registry-cleaner config show    # view current config
```

You can manage multiple GitLab hosts. Each target has its own cache and optional preference overrides:

```sh
npx gitlab-container-registry-cleaner config add-target https://gitlab.example.com
npx gitlab-container-registry-cleaner config add-target https://gitlab.other.com
```

When multiple targets exist, the tool prompts you to pick one. A typical config file looks like:

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

## Commands

### `cache` — Manage the Local Repository Cache

The cache stores repository metadata per GitLab host and persists between runs.

```sh
npx gitlab-container-registry-cleaner cache update              # scan and cache all repositories
npx gitlab-container-registry-cleaner cache update -s 500 -e 1000 -c 10  # custom ID range and concurrency
npx gitlab-container-registry-cleaner cache add 161             # add a single repository by ID
npx gitlab-container-registry-cleaner cache show                # view cached repositories
npx gitlab-container-registry-cleaner cache clear               # clear the cache
```

### `clean` — Delete Tags from Container Repositories

With no arguments (and a populated cache), starts the interactive flow shown above. With a repository ID, runs in non-interactive mode with dry-run enabled:

```sh
# Dry-run: keep release tags, delete everything else
npx gitlab-container-registry-cleaner clean 161 -k 'v?[0-9]+\.[0-9]+\.[0-9]+.*' -d '.*'

# Export tags that would be deleted
npx gitlab-container-registry-cleaner clean 161 -k 'v?[0-9]+\.[0-9]+\.[0-9]+.*' -d '.*' --output-tags /tmp/tags.json

# Actually delete (disable dry-run)
npx gitlab-container-registry-cleaner clean 161 -k 'v?[0-9]+\.[0-9]+\.[0-9]+.*' -d '.*' --no-dry-run
```

Common filter patterns:

```sh
# Keep release tags, delete everything else
-k 'v?[0-9]+\.[0-9]+\.[0-9]+.*' -d '.*'

# Delete all tags starting with dev-
-k '^$' -d '^dev-.*'

# Delete all tags (use with care!)
-k '^$' -d '.*'

# Delete all, but keep the 10 most recent
-k '^$' -d '.*' -n 10

# Keep 5 most recent, delete everything older than 30 days
-k '^$' -d '.*' -n 5 -a 30
```

### `list` — List Container Repositories

```sh
npx gitlab-container-registry-cleaner list all                           # instance-wide (scans IDs 1–10000)
npx gitlab-container-registry-cleaner list all -s 500 -e 1000 -c 10 -o /tmp/repos.json
npx gitlab-container-registry-cleaner list project 42                    # by project ID
npx gitlab-container-registry-cleaner list project mygroup/myproject     # by project path
npx gitlab-container-registry-cleaner list group 666                     # by group ID
npx gitlab-container-registry-cleaner list group mygroup/mysubgroup      # by group path
```

### Finding Your Container Repository ID

The easiest way is `cache update` followed by `clean` — the interactive selector shows all repositories. Alternatively, find the ID in the GitLab UI under _Deploy > Container Registry > [repository name]_:

```
https://gitlab.example.com/mygroup/myproject/container_registry/42
                                                                ^^
```

This is the Container Repository ID, not the project ID.

## Contributing

See [DEVELOPERS.md](./DEVELOPERS.md) for development setup, testing, and release instructions.

## License

Licensed under Apache License 2.0, see [LICENSE.txt](./LICENSE.txt) for more details.
