import type {
	CondensedProjectSchema,
	CondensedRegistryRepositoryTagSchema,
	RegistryRepositorySchema,
	RegistryRepositoryTagSchema,
} from "@gitbeaker/rest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { GitLabContainerRepositoryCleaner } from "../src/cleaner.js";

/**
 * These tests exercise the public interface of GitLabContainerRepositoryCleaner
 * against a mock GitLab API (msw). Instead of spying on private methods, we
 * track actual HTTP DELETE calls to verify which tags would be removed.
 *
 * The tool has two usage modes, configured by the CLI layer (main.ts):
 *
 * NON-INTERACTIVE (CLI with explicit arguments):
 *   - dryRun: true by default (safe — must opt out with --no-dry-run)
 *   - keepRegex: ".*" (matches everything — nothing deleted by default)
 *   - deleteRegex: "^$" (matches nothing — nothing deleted by default)
 *   - No confirmation prompt
 *   - User must explicitly set -k and -d regex to delete anything
 *
 * INTERACTIVE (no arguments, or `clean` with cache):
 *   - dryRun: false (deletion happens after explicit user confirmation)
 *   - keepRegex: "^$" (matches nothing — all tags are candidates)
 *   - deleteRegex: ".*" (matches everything — all tags are candidates)
 *   - confirmDelete callback shows tags and asks for confirmation
 *   - Safety comes from the confirmation prompt, not from dry-run
 */

describe("Cleaner", () => {
	const fakeTag = (
		name: string,
		projectId: number,
		createdAt = "2024-01-01T00:00:00Z",
	): RegistryRepositoryTagSchema =>
		({
			name,
			path: `my-group/my-project-${projectId}`,
			location: `gitlab.com/my-group/my-project-${projectId}`,
			revision: "XXXX",
			short_revision: "XXXX",
			digest: "XXXX",
			created_at: createdAt,
			total_size: 1000,
		}) as RegistryRepositoryTagSchema;

	const condensed = (
		tag: RegistryRepositoryTagSchema,
	): CondensedRegistryRepositoryTagSchema => ({
		name: tag.name,
		path: tag.path,
		location: tag.location,
	});

	const FAKE_PROJECTS: CondensedProjectSchema[] = [1, 2, 3].map(
		(i) =>
			({
				id: i,
				description: `Project ${i}`,
				name: `Project ${i}`,
				path_with_namespace: `my-group/my-project-${i}`,
				visibility: "public",
				web_url: `https://gitlab.com/my-group/my-project-${i}`,
				path: `my-group/my-project-${i}`,
			}) as CondensedProjectSchema,
	);

	const FAKE_TAGS: Record<number, RegistryRepositoryTagSchema[]> = {
		1: [
			fakeTag("v1.0.0", 1, "2024-01-01T00:00:00Z"),
			fakeTag("v1.1.0", 1, "2024-02-01T00:00:00Z"),
			fakeTag("v1.2.0", 1, "2024-03-01T00:00:00Z"),
			fakeTag("v1.3.0", 1, "2024-04-01T00:00:00Z"),
			fakeTag("v1.4.0", 1, "2024-05-01T00:00:00Z"),
		],
		2: [],
		3: [
			fakeTag("release-1.0.0", 3, "2024-01-01T00:00:00Z"),
			fakeTag("dev-build-123", 3, "2024-02-01T00:00:00Z"),
			fakeTag("release-1.1.0", 3, "2024-03-01T00:00:00Z"),
			fakeTag("dev-build-456", 3, "2024-04-01T00:00:00Z"),
		],
		4: [
			fakeTag("foo-v1.34.2", 4, "2024-01-01T00:00:00Z"),
			fakeTag("foo-v1.35.0", 4, "2024-01-15T00:00:00Z"),
			fakeTag("foo-v1.37.3", 4, "2024-02-01T00:00:00Z"),
			fakeTag("foo-v1.39.2", 4, "2024-03-01T00:00:00Z"),
			fakeTag("foo-v1.40.1", 4, "2024-04-01T00:00:00Z"),
			fakeTag("foo-v1.41.0", 4, "2024-05-01T00:00:00Z"),
			fakeTag("foo-latest", 4, "2024-05-15T00:00:00Z"),
		],
	} as const;

	// Track HTTP DELETE calls to verify deletion behavior
	let deletedTags: { projectId: number; tagName: string }[];

	const handlers = [
		http.get("https://gitlab.com/api/v4/metadata", () => {
			return HttpResponse.json({ version: "17.0.0", revision: "abc123" });
		}),
		http.get("https://gitlab.com/api/v4/projects", () => {
			return HttpResponse.json(FAKE_PROJECTS);
		}),
		http.get(
			"https://gitlab.com/api/v4/registry/repositories/:repositoryId",
			({ params }) => {
				const repoId = Number(params.repositoryId);
				if (!FAKE_TAGS[repoId]) {
					return new HttpResponse(null, { status: 404 });
				}
				return HttpResponse.json({
					id: repoId,
					name: `Project ${repoId}`,
					path: `my-group/my-project-${repoId}`,
					project_id: repoId,
					location: `gitlab.com/my-group/my-project-${repoId}`,
					created_at: "2024-01-01T00:00:00Z",
					tags_count: FAKE_TAGS[repoId]?.length ?? 0,
				} as RegistryRepositorySchema);
			},
		),
		http.get(
			"https://gitlab.com/api/v4/projects/:projectId/registry/repositories/:repositoryId/tags",
			({ params }) => {
				const projectId = Number(params.projectId);
				return HttpResponse.json(
					FAKE_TAGS[projectId]?.map(condensed) ?? [],
				);
			},
		),
		http.get(
			"https://gitlab.com/api/v4/projects/:projectId/registry/repositories/:repositoryId/tags/:tagName",
			({ params }) => {
				const projectId = Number(params.projectId);
				const tagName = params.tagName as string;

				// Simulate OCI manifest issue for repository 4
				if (projectId === 4) {
					return new HttpResponse(null, { status: 404 });
				}

				const tag = FAKE_TAGS[projectId]?.find((t) => t.name === tagName);
				if (tag) return HttpResponse.json(tag);
				return new HttpResponse(null, { status: 404 });
			},
		),
		http.delete(
			"https://gitlab.com/api/v4/projects/:projectId/registry/repositories/:repositoryId/tags/:tagName",
			({ params }) => {
				const projectId = Number(params.projectId);
				const tagName = params.tagName as string;
				deletedTags.push({ projectId, tagName });
				return new HttpResponse(null, { status: 204 });
			},
		),
	];

	const server = setupServer(...handlers);

	beforeAll(() => {
		vi.useFakeTimers();
		vi.setSystemTime("2024-06-01T00:00:00Z");
		server.listen();
	});

	beforeEach(() => {
		deletedTags = [];
	});

	afterEach(() => server.resetHandlers());

	afterAll(() => {
		vi.useRealTimers();
		server.close();
	});

	// --- Authentication ---

	describe("Authentication", () => {
		it("should reject an invalid token (401)", async () => {
			server.use(
				http.get("https://gitlab.com/api/v4/metadata", () => {
					return new HttpResponse(null, { status: 401 });
				}),
			);
			const cleaner = new GitLabContainerRepositoryCleaner({
				gitlabHost: "https://gitlab.com",
				gitlabToken: "bad-token",
			});
			await expect(cleaner.verifyAuth()).rejects.toThrow(
				/authentication failed.*revoked/i,
			);
		});

		it("should reject insufficient permissions (403)", async () => {
			server.use(
				http.get("https://gitlab.com/api/v4/metadata", () => {
					return new HttpResponse(null, { status: 403 });
				}),
			);
			const cleaner = new GitLabContainerRepositoryCleaner({
				gitlabHost: "https://gitlab.com",
				gitlabToken: "limited-token",
			});
			await expect(cleaner.verifyAuth()).rejects.toThrow(
				/authentication failed.*permissions/i,
			);
		});
	});

	// --- Listing ---

	describe("Listing repositories", () => {
		it("should list repositories in an ID range", async () => {
			const cleaner = new GitLabContainerRepositoryCleaner({
				gitlabHost: "https://gitlab.com",
				gitlabToken: "token",
			});
			const repos = await cleaner.getContainerRepositoriesConcurrently(
				1,
				5,
			);
			expect(repos.length).toBeGreaterThan(0);
		});
	});

	// --- Cleanup: non-interactive mode defaults ---
	// Non-interactive mode uses dryRun: true and safe regex defaults.
	// The user must explicitly set regex patterns and --no-dry-run to delete.

	describe("Non-interactive cleanup (dryRun: true)", () => {
		it("should not issue any DELETE requests in dry-run mode", async () => {
			const cleaner = new GitLabContainerRepositoryCleaner({
				gitlabHost: "https://gitlab.com",
				gitlabToken: "token",
				dryRun: true,
			});

			await cleaner.cleanupContainerRepositoryTags(1, {
				keepMostRecentN: 0,
				olderThanDays: 0,
				keepRegex: "^$",
				deleteRegex: ".*",
			});

			expect(deletedTags).toHaveLength(0);
		});

		it("should keep the N most recent tags", async () => {
			const cleaner = new GitLabContainerRepositoryCleaner({
				gitlabHost: "https://gitlab.com",
				gitlabToken: "token",
				dryRun: false,
			});

			await cleaner.cleanupContainerRepositoryTags(1, {
				keepMostRecentN: 2,
				olderThanDays: 0,
				keepRegex: "^$",
				deleteRegex: ".*",
			});

			const deleted = deletedTags.map((d) => d.tagName);
			// v1.4.0 and v1.3.0 are the 2 most recent; the other 3 get deleted
			expect(deleted).toHaveLength(3);
			expect(deleted).toContain("v1.0.0");
			expect(deleted).toContain("v1.1.0");
			expect(deleted).toContain("v1.2.0");
			expect(deleted).not.toContain("v1.3.0");
			expect(deleted).not.toContain("v1.4.0");
		});

		it("should delete tags older than N days", async () => {
			const cleaner = new GitLabContainerRepositoryCleaner({
				gitlabHost: "https://gitlab.com",
				gitlabToken: "token",
				dryRun: false,
			});

			await cleaner.cleanupContainerRepositoryTags(1, {
				keepMostRecentN: 0,
				olderThanDays: 45,
				keepRegex: "^$",
				deleteRegex: ".*",
			});

			const deleted = deletedTags.map((d) => d.tagName);
			// v1.4.0 (May 1) is only 31 days old at June 1 — kept
			expect(deleted).toHaveLength(4);
			expect(deleted).toContain("v1.0.0");
			expect(deleted).toContain("v1.1.0");
			expect(deleted).toContain("v1.2.0");
			expect(deleted).toContain("v1.3.0");
			expect(deleted).not.toContain("v1.4.0");
		});

		it("should keep tags matching keep regex", async () => {
			const cleaner = new GitLabContainerRepositoryCleaner({
				gitlabHost: "https://gitlab.com",
				gitlabToken: "token",
				dryRun: false,
			});

			await cleaner.cleanupContainerRepositoryTags(3, {
				keepMostRecentN: 0,
				olderThanDays: 0,
				keepRegex: "release-.*",
				deleteRegex: ".*",
			});

			const deleted = deletedTags.map((d) => d.tagName);
			expect(deleted).toHaveLength(2);
			expect(deleted).toContain("dev-build-123");
			expect(deleted).toContain("dev-build-456");
			expect(deleted).not.toContain("release-1.0.0");
			expect(deleted).not.toContain("release-1.1.0");
		});

		it("should only delete tags matching delete regex", async () => {
			const cleaner = new GitLabContainerRepositoryCleaner({
				gitlabHost: "https://gitlab.com",
				gitlabToken: "token",
				dryRun: false,
			});

			await cleaner.cleanupContainerRepositoryTags(1, {
				keepMostRecentN: 0,
				olderThanDays: 0,
				keepRegex: "^$",
				deleteRegex: "v1\\.[13]\\.0",
			});

			const deleted = deletedTags.map((d) => d.tagName);
			expect(deleted).toHaveLength(2);
			expect(deleted).toContain("v1.1.0");
			expect(deleted).toContain("v1.3.0");
			expect(deleted).not.toContain("v1.0.0");
			expect(deleted).not.toContain("v1.2.0");
			expect(deleted).not.toContain("v1.4.0");
		});

		it("should combine keep regex, age, and recency filters", async () => {
			const cleaner = new GitLabContainerRepositoryCleaner({
				gitlabHost: "https://gitlab.com",
				gitlabToken: "token",
				dryRun: false,
			});

			await cleaner.cleanupContainerRepositoryTags(1, {
				keepMostRecentN: 1,
				olderThanDays: 30,
				keepRegex: "v1\\.[02]\\.0",
				deleteRegex: ".*",
			});

			const deleted = deletedTags.map((d) => d.tagName);
			// v1.0.0 and v1.2.0 match keep regex — kept
			// v1.4.0 is the most recent — kept
			// v1.1.0 and v1.3.0 are old enough and don't match keep — deleted
			expect(deleted).toHaveLength(2);
			expect(deleted).toContain("v1.1.0");
			expect(deleted).toContain("v1.3.0");
		});
	});

	// --- Cleanup: interactive mode defaults ---
	// Interactive mode uses dryRun: false, permissive regex, and a confirmDelete callback.
	// Safety relies on the confirmation prompt, not dry-run.

	describe("Interactive cleanup (dryRun: false, confirmDelete)", () => {
		it("should not delete when confirmation is declined", async () => {
			const cleaner = new GitLabContainerRepositoryCleaner({
				gitlabHost: "https://gitlab.com",
				gitlabToken: "token",
				dryRun: false,
			});

			await cleaner.cleanupContainerRepositoryTags(1, {
				keepMostRecentN: 0,
				olderThanDays: 0,
				keepRegex: "^$",
				deleteRegex: ".*",
				confirmDelete: async () => false,
			});

			expect(deletedTags).toHaveLength(0);
		});

		it("should delete when confirmation is accepted", async () => {
			const cleaner = new GitLabContainerRepositoryCleaner({
				gitlabHost: "https://gitlab.com",
				gitlabToken: "token",
				dryRun: false,
			});

			await cleaner.cleanupContainerRepositoryTags(1, {
				keepMostRecentN: 0,
				olderThanDays: 0,
				keepRegex: "^$",
				deleteRegex: ".*",
				confirmDelete: async () => true,
			});

			expect(deletedTags).toHaveLength(5);
		});

		it("should pass the correct tags to the confirmation callback", async () => {
			const cleaner = new GitLabContainerRepositoryCleaner({
				gitlabHost: "https://gitlab.com",
				gitlabToken: "token",
				dryRun: false,
			});

			let confirmedTags: RegistryRepositoryTagSchema[] = [];
			await cleaner.cleanupContainerRepositoryTags(1, {
				keepMostRecentN: 2,
				olderThanDays: 0,
				keepRegex: "^$",
				deleteRegex: ".*",
				confirmDelete: async (tags) => {
					confirmedTags = tags;
					return false;
				},
			});

			const names = confirmedTags.map((t) => t.name);
			expect(names).toHaveLength(3);
			expect(names).toContain("v1.0.0");
			expect(names).toContain("v1.1.0");
			expect(names).toContain("v1.2.0");
		});
	});

	// --- Semver fallback (OCI manifest issue) ---
	// When GitLab returns 404 for tag details (OCI manifests), the cleaner
	// falls back to semver-based sorting instead of creation date sorting.

	describe("Semver fallback (OCI manifest issue)", () => {
		it("should fall back to semver sorting when tag details return 404", async () => {
			const cleaner = new GitLabContainerRepositoryCleaner({
				gitlabHost: "https://gitlab.com",
				gitlabToken: "token",
				dryRun: false,
			});

			await cleaner.cleanupContainerRepositoryTags(4, {
				keepMostRecentN: 3,
				olderThanDays: 90,
				keepRegex: "^$",
				deleteRegex: ".*",
			});

			const deleted = deletedTags.map((d) => d.tagName);
			// Keeps 3 newest by semver: v1.41.0, v1.40.1, v1.39.2
			// Deletes: v1.37.3, v1.35.0, v1.34.2, foo-latest (non-semver sorts last)
			expect(deleted).toHaveLength(4);
			expect(deleted).toContain("foo-v1.34.2");
			expect(deleted).toContain("foo-v1.35.0");
			expect(deleted).toContain("foo-v1.37.3");
			expect(deleted).toContain("foo-latest");
			expect(deleted).not.toContain("foo-v1.41.0");
			expect(deleted).not.toContain("foo-v1.40.1");
			expect(deleted).not.toContain("foo-v1.39.2");
		});

		it("should apply regex filtering before semver fallback", async () => {
			const cleaner = new GitLabContainerRepositoryCleaner({
				gitlabHost: "https://gitlab.com",
				gitlabToken: "token",
				dryRun: false,
			});

			await cleaner.cleanupContainerRepositoryTags(4, {
				keepMostRecentN: 2,
				olderThanDays: 0,
				keepRegex: "^$",
				deleteRegex: "foo-v.*",
			});

			const deleted = deletedTags.map((d) => d.tagName);
			// foo-latest doesn't match delete regex — excluded before semver
			// Keeps 2 newest semver: v1.41.0, v1.40.1
			expect(deleted).toHaveLength(4);
			expect(deleted).toContain("foo-v1.34.2");
			expect(deleted).toContain("foo-v1.35.0");
			expect(deleted).toContain("foo-v1.37.3");
			expect(deleted).toContain("foo-v1.39.2");
			expect(deleted).not.toContain("foo-v1.41.0");
			expect(deleted).not.toContain("foo-v1.40.1");
			expect(deleted).not.toContain("foo-latest");
		});

		it("should delete all tags when keepMostRecentN=0 with semver fallback", async () => {
			const cleaner = new GitLabContainerRepositoryCleaner({
				gitlabHost: "https://gitlab.com",
				gitlabToken: "token",
				dryRun: false,
			});

			await cleaner.cleanupContainerRepositoryTags(4, {
				keepMostRecentN: 0,
				olderThanDays: 0,
				keepRegex: "^$",
				deleteRegex: ".*",
			});

			expect(deletedTags).toHaveLength(7);
		});
	});
});
