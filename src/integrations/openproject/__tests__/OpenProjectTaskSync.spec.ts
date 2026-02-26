import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { OpenProjectService } from "../OpenProjectService"
import { OpenProjectTaskSync } from "../OpenProjectTaskSync"

declare const global: any

describe("OpenProjectService", () => {
	const log = vi.fn()

	beforeEach(() => {
		log.mockClear()
	})

	it("should return empty array and log when configuration is incomplete", async () => {
		const service = new OpenProjectService(log)

		// Missing baseUrl, apiToken, and userIdOrMe should short‑circuit
		const result = await service.fetchAssignedOpenTasks({
			// @ts-expect-error - intentional incomplete config for test
			baseUrl: "",
			apiToken: "",
			userIdOrMe: "",
		})

		expect(result).toEqual([])
		expect(log).toHaveBeenCalled()
	})

	it("should map OpenProject work packages into OpenProjectTask objects", async () => {
		const service = new OpenProjectService(log)

		const mockResponse = {
			_embedded: {
				elements: [
					{
						id: 123,
						subject: "Implement feature X",
						description: { raw: "Detailed description" },
						_embedded: {
							status: { name: "Open" },
							project: { name: "Demo Project" },
						},
						_links: {
							self: { href: "/api/v3/work_packages/123" },
						},
					},
				],
			},
		}

		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: "OK",
			json: () => Promise.resolve(mockResponse),
		})

		const originalFetch = global.fetch
		global.fetch = fetchMock

		try {
			const tasks = await service.fetchAssignedOpenTasks({
				baseUrl: "https://openproject.example.com",
				apiToken: "token",
				userIdOrMe: "me",
			})

			expect(fetchMock).toHaveBeenCalledTimes(1)
			expect(tasks).toHaveLength(1)
			expect(tasks[0]).toMatchObject({
				id: 123,
				subject: "Implement feature X",
				description: "Detailed description",
				status: "Open",
				projectName: "Demo Project",
			})
			expect(tasks[0].url).toContain("/work_packages/123")
		} finally {
			global.fetch = originalFetch
		}
	})
})

describe("OpenProjectTaskSync", () => {
	let originalSetInterval: any
	let originalClearInterval: any

	beforeEach(() => {
		originalSetInterval = global.setInterval
		originalClearInterval = global.clearInterval

		// Use real timers but spy so we can ensure cleanup
		global.setInterval = (...args: any[]) => originalSetInterval(...args)
		global.clearInterval = (...args: any[]) => originalClearInterval(...args)
	})

	afterEach(() => {
		global.setInterval = originalSetInterval
		global.clearInterval = originalClearInterval
	})

	it("should create Roo tasks for new OpenProject work packages", async () => {
		const createTask = vi.fn().mockResolvedValue(undefined)
		const provider = {
			createTask,
			log: vi.fn(),
		} as any

		const fetchAssignedOpenTasks = vi.fn().mockResolvedValue([
			{
				id: 1,
				subject: "Test task",
				description: "Do something important",
				status: "Open",
				projectName: "Demo",
				url: "https://openproject.example.com/api/v3/work_packages/1",
			},
		])

		const service = { fetchAssignedOpenTasks } as unknown as OpenProjectService

		const sync = new OpenProjectTaskSync({
			provider,
			service,
			log: vi.fn(),
			initialConfig: {
				enabled: true,
				baseUrl: "https://openproject.example.com",
				apiToken: "token",
				userIdOrMe: "me",
				pollIntervalMinutes: 10,
			},
		})

		// The initialConfig path triggers an immediate poll; wait a tick for it to complete.
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(fetchAssignedOpenTasks).toHaveBeenCalledTimes(1)
		expect(createTask).toHaveBeenCalledTimes(1)
		expect(createTask.mock.calls[0][0]).toContain("[OpenProject #1]")

		sync.dispose()
	})
})
