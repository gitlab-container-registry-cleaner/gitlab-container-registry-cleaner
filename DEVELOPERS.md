# Developer Guide

## Setup

Clone the repository and install dependencies:

```sh
npm i -g yarn
yarn install
```

Run `yarn dev -- <command>` to start the dev version of the CLI with a given command.

Run `yarn build` to build the project into `dist`.

## Testing

Run `yarn test` to run the tests.

Tests use [vitest](https://vitest.dev/) with [msw](https://mswjs.io/) to mock the GitLab API. The test suite exercises the public interface only — no spying on private methods. Instead, HTTP DELETE calls are tracked through the mock server to verify which tags would actually be removed.

The cleaner tests are organized by mode:

- **Authentication** — verifies early failure on invalid/insufficient tokens
- **Non-interactive cleanup** — tests dry-run behavior, regex filtering, age filtering, and recency (keep N most recent)
- **Interactive cleanup** — tests the `confirmDelete` callback: declined confirmation prevents deletion, accepted confirmation proceeds, and the correct tags are passed to the callback
- **Semver fallback** — tests graceful degradation when the GitLab API returns 404 for tag details (OCI manifest issue), falling back to semver-based sorting

## Releasing

Run `yarn release` to build and publish a new version.
