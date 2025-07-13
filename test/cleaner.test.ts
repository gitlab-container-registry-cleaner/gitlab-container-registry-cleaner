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

describe("Cleaner", () => {
	const _fakeTag = (name: string, projectId: number, createdAt?: string) => ({
		name,
		path: `my-group/my-project-${projectId}`,
		location: `gitlab.com/my-group/my-project-${projectId}`,
		revision: "XXXX",
		short_revision: "XXXX",
		digest: "XXXX",
		created_at: "2024-01-01T00:00:00Z",
		total_size: 1000,
		...(createdAt && { created_at: createdAt }),
	});

	const _condensedTag = (
		tag: RegistryRepositoryTagSchema,
	): CondensedRegistryRepositoryTagSchema => ({
		name: tag.name,
		path: tag.path,
		location: tag.location,
	});

	const FAKE_PROJECTS: CondensedProjectSchema[] = [
		...[1, 2, 3].map(
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
		),
	];

	const FAKE_TAGS: Record<number, RegistryRepositoryTagSchema[]> = {
		1: [
			_fakeTag("v1.0.0", 1, "2024-01-01T00:00:00Z"),
			_fakeTag("v1.1.0", 1, "2024-02-01T00:00:00Z"),
			_fakeTag("v1.2.0", 1, "2024-03-01T00:00:00Z"),
			_fakeTag("v1.3.0", 1, "2024-04-01T00:00:00Z"),
			_fakeTag("v1.4.0", 1, "2024-05-01T00:00:00Z"),
		],
		2: [
			// unused
		],
		3: [
			_fakeTag("release-1.0.0", 3, "2024-01-01T00:00:00Z"),
			_fakeTag("dev-build-123", 3, "2024-02-01T00:00:00Z"),
			_fakeTag("release-1.1.0", 3, "2024-03-01T00:00:00Z"),
			_fakeTag("dev-build-456", 3, "2024-04-01T00:00:00Z"),
		],
	} as const;

	beforeAll(() => {
		vi.useFakeTimers();
		vi.setSystemTime("2024-06-01T00:00:00Z");
	});

	afterAll(() => {
		vi.useRealTimers();
	});

	let cleaner: GitLabContainerRepositoryCleaner;
	let currentFakeProjects: CondensedProjectSchema[] = [];
	let currentFakeTags: Record<number, RegistryRepositoryTagSchema[]> = {};

	beforeEach(() => {
		currentFakeProjects = [...FAKE_PROJECTS];
		currentFakeTags = { ...FAKE_TAGS };
		cleaner = new GitLabContainerRepositoryCleaner({
			gitlabHost: "https://gitlab.com",
			gitlabToken: "token",
			dryRun: true,
			verbose: true,
		});
	});

	const handlers = [
		http.get("https://gitlab.com/api/v4/projects", () => {
			return HttpResponse.json(FAKE_PROJECTS);
		}),
		http.get(
			"https://gitlab.com/api/v4/registry/repositories/:repositoryId",
			({ params }) => {
				const repoId = params.repositoryId as unknown as number;
				return HttpResponse.json({
					id: repoId,
					name: `Project ${repoId}`,
					path_with_namespace: `my-group/my-project-${repoId}`,
					visibility: "public",
					path: `my-group/my-project-${repoId}`,
					project_id: repoId, // for simplicity, we use the repo id as the project id
					location: `gitlab.com/my-group/my-project-${repoId}`,
					created_at: "2024-01-01T00:00:00Z",
					cleanup_policy_started_at: "2024-01-02T00:00:00Z",
					// ...(params.tagsCount && {
					// 	tags_count: FAKE_TAGS[repoId]?.length ?? 0,
					// }),
					tags_count: FAKE_TAGS[repoId]?.length ?? 0,
					...(params.tags && {
						tags: FAKE_TAGS[repoId]?.map(_condensedTag) ?? [],
					}),
				} as RegistryRepositorySchema);
			},
		),
		http.get(
			"https://gitlab.com/api/v4/projects/:projectId/registry/repositories/:repositoryId/tags",
			({ params }) => {
				const projectId = Number(params.projectId);
				return HttpResponse.json(
					FAKE_TAGS[projectId]?.map(_condensedTag) ?? [],
				);
			},
		),
		http.get(
			"https://gitlab.com/api/v4/projects/:projectId/registry/repositories/:repositoryId/tags/:tagName",
			({ params }) => {
				const projectId = Number(params.projectId);
				const tagName = params.tagName as string;
				const tag = FAKE_TAGS[projectId]?.find((t) => t.name === tagName);
				if (tag) {
					return HttpResponse.json(tag);
				}
				return new HttpResponse(null, { status: 404 });
			},
		),
		http.delete(
			"https://gitlab.com/api/v4/projects/:projectId/registry/repositories/:repositoryId/tags/:tagName",
			({ params }) => {
				const projectId = Number(params.projectId);
				const tagName = params.tagName as string;
				const tag = FAKE_TAGS[projectId]?.find((t) => t.name === tagName);
				if (tag !== undefined) {
					// biome-ignore lint/style/noNonNullAssertion: <explanation>
					currentFakeTags[projectId] = currentFakeTags[projectId]!.filter(
						(t) => t.name !== tagName,
					);
					return new HttpResponse(null, { status: 204 });
				}
				return new HttpResponse(null, { status: 404 });
			},
		),
	];

	const server = setupServer(...handlers);

	beforeAll(() => server.listen());
	afterEach(() => server.resetHandlers());
	afterAll(() => server.close());

	// Helper method for checking expected and not expected tags
	const checkExpectedAndNotExpectedTags = (
		tagsToDelete: RegistryRepositoryTagSchema[],
		expectedTags: RegistryRepositoryTagSchema[],
		notExpectedTags: RegistryRepositoryTagSchema[],
	) => {
		for (const expectedTag of expectedTags) {
			expect(tagsToDelete).toContainEqual(
				expect.objectContaining({
					name: expectedTag.name,
					created_at: expectedTag.created_at,
				}),
			);
		}

		for (const notExpectedTag of notExpectedTags) {
			expect(tagsToDelete).not.toContainEqual(
				expect.objectContaining({
					name: notExpectedTag.name,
					created_at: notExpectedTag.created_at,
				}),
			);
		}
	};

	it("should getContainerRepositoriesConcurrently", async () => {
		const cleaner = new GitLabContainerRepositoryCleaner({
			gitlabHost: "https://gitlab.com",
			gitlabToken: "token",
		});
		const repositories = await cleaner.getContainerRepositoriesConcurrently(
			1,
			5,
		);
		expect(repositories).toBeDefined();
		expect(repositories.length).toBeGreaterThan(0);
	});

	it("should keep the last N tags when cleaning up", async () => {
		// @ts-expect-error Private method
		const spy = vi.spyOn(cleaner, "deleteTagsConcurrently");

		await cleaner.cleanupContainerRepositoryTags(1, {
			keepMostRecentN: 2,
			olderThanDays: 0,
			keepRegex: "^$",
			deleteRegex: ".*",
		});

		expect(spy).toHaveBeenCalledTimes(1);
		// @ts-expect-error Undefined type
		const [projectId, repositoryId, tagsToDelete] = spy.mock.calls[0];

		expect(projectId).toBe(1);
		expect(repositoryId).toBe(1);
		expect(tagsToDelete).toHaveLength(3);

		const expectedTags = [
			FAKE_TAGS[1]?.[0],
			FAKE_TAGS[1]?.[1],
			FAKE_TAGS[1]?.[2],
		] as RegistryRepositoryTagSchema[];

		const notExpectedTags = [
			FAKE_TAGS[1]?.[3],
			FAKE_TAGS[1]?.[4],
		] as RegistryRepositoryTagSchema[];

		checkExpectedAndNotExpectedTags(
			tagsToDelete,
			expectedTags,
			notExpectedTags,
		);
	});

	it("should delete tags older than specified days", async () => {
		// @ts-expect-error Private method
		const spy = vi.spyOn(cleaner, "deleteTagsConcurrently");

		await cleaner.cleanupContainerRepositoryTags(1, {
			keepMostRecentN: 0,
			olderThanDays: 45,
			keepRegex: "^$",
			deleteRegex: ".*",
		});

		expect(spy).toHaveBeenCalledTimes(1);
		const [projectId, repositoryId, tagsToDelete] = spy.mock.calls[0];

		expect(projectId).toBe(1);
		expect(repositoryId).toBe(1);
		expect(tagsToDelete).toHaveLength(4);

		const expectedTags = [
			FAKE_TAGS[1]?.[0],
			FAKE_TAGS[1]?.[1],
			FAKE_TAGS[1]?.[2],
			FAKE_TAGS[1]?.[3],
		] as RegistryRepositoryTagSchema[];

		const notExpectedTags = [
			FAKE_TAGS[1]?.[4],
		] as RegistryRepositoryTagSchema[];

		checkExpectedAndNotExpectedTags(
			tagsToDelete,
			expectedTags,
			notExpectedTags,
		);
	});

	it("should keep tags matching the keep regex", async () => {
		// @ts-expect-error Private method
		const spy = vi.spyOn(cleaner, "deleteTagsConcurrently");

		await cleaner.cleanupContainerRepositoryTags(3, {
			keepMostRecentN: 0,
			olderThanDays: 0,
			keepRegex: "release-.*",
			deleteRegex: ".*",
		});

		expect(spy).toHaveBeenCalledTimes(1);
		const [projectId, repositoryId, tagsToDelete] = spy.mock.calls[0];

		expect(projectId).toBe(3);
		expect(repositoryId).toBe(3);
		expect(tagsToDelete).toHaveLength(2);

		const expectedTags = [
			FAKE_TAGS[3]?.[1],
			FAKE_TAGS[3]?.[3],
		] as RegistryRepositoryTagSchema[];

		const notExpectedTags = [
			FAKE_TAGS[3]?.[0],
			FAKE_TAGS[3]?.[2],
		] as RegistryRepositoryTagSchema[];

		checkExpectedAndNotExpectedTags(
			tagsToDelete,
			expectedTags,
			notExpectedTags,
		);
	});

	it("should delete tags matching the delete regex", async () => {
		// @ts-expect-error Private method
		const spy = vi.spyOn(cleaner, "deleteTagsConcurrently");

		await cleaner.cleanupContainerRepositoryTags(1, {
			keepMostRecentN: 0,
			olderThanDays: 0,
			keepRegex: "^$",
			deleteRegex: "v1\\.[13]\\.0",
		});

		expect(spy).toHaveBeenCalledTimes(1);
		const [projectId, repositoryId, tagsToDelete] = spy.mock.calls[0];

		expect(projectId).toBe(1);
		expect(repositoryId).toBe(1);
		expect(tagsToDelete).toHaveLength(2);

		const expectedTags = [
			FAKE_TAGS[1]?.[1],
			FAKE_TAGS[1]?.[3],
		] as RegistryRepositoryTagSchema[];

		const notExpectedTags = [
			FAKE_TAGS[1]?.[0],
			FAKE_TAGS[1]?.[2],
			FAKE_TAGS[1]?.[4],
		] as RegistryRepositoryTagSchema[];

		checkExpectedAndNotExpectedTags(
			tagsToDelete,
			expectedTags,
			notExpectedTags,
		);
	});

	it("should keep tags matching the keep regex and delete the rest", async () => {
		// @ts-expect-error Private method
		const spy = vi.spyOn(cleaner, "deleteTagsConcurrently");

		await cleaner.cleanupContainerRepositoryTags(1, {
			keepMostRecentN: 1,
			olderThanDays: 30,
			keepRegex: "v1\\.[02]\\.0",
			deleteRegex: ".*",
		});

		expect(spy).toHaveBeenCalledTimes(1);
		const [projectId, repositoryId, tagsToDelete] = spy.mock.calls[0];

		expect(projectId).toBe(1);
		expect(repositoryId).toBe(1);
		expect(tagsToDelete).toHaveLength(2);

		const expectedTags = [
			FAKE_TAGS[1]?.[1],
			FAKE_TAGS[1]?.[3],
		] as RegistryRepositoryTagSchema[];

		const notExpectedTags = [
			FAKE_TAGS[1]?.[0],
			FAKE_TAGS[1]?.[2],
			FAKE_TAGS[1]?.[4],
		] as RegistryRepositoryTagSchema[];

		checkExpectedAndNotExpectedTags(
			tagsToDelete,
			expectedTags,
			notExpectedTags,
		);
	});
});
