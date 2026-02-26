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

	it("should filter by status '=' with value '1' (New) instead of all open statuses", async () => {
		const service = new OpenProjectService(log)

		const mockResponse = {
			_embedded: {
				elements: [],
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
			await service.fetchAssignedOpenTasks({
				baseUrl: "https://openproject.example.com",
				apiToken: "token",
				userIdOrMe: "me",
			})

			expect(fetchMock).toHaveBeenCalledTimes(1)

			// Extract the URL that was called
			const calledUrl = fetchMock.mock.calls[0][0] as string
			const urlObj = new URL(calledUrl)
			const filtersParam = urlObj.searchParams.get("filters")
			expect(filtersParam).toBeTruthy()

			const filters = JSON.parse(filtersParam!)
			// Verify status filter uses "=" operator with value "1" (New)
			const statusFilter = filters.find((f: any) => f.status)
			expect(statusFilter).toBeDefined()
			expect(statusFilter.status.operator).toBe("=")
			expect(statusFilter.status.values).toEqual(["1"])
		} finally {
			global.fetch = originalFetch
		}
	})

	describe("updateWorkPackageStatus", () => {
		it("should PATCH the work package with the correct status link", async () => {
			const service = new OpenProjectService(log)

			const fetchMock = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				statusText: "OK",
			})

			const originalFetch = global.fetch
			global.fetch = fetchMock

			try {
				await service.updateWorkPackageStatus(
					{
						baseUrl: "https://openproject.example.com",
						apiToken: "my-api-token",
						userIdOrMe: "me",
					},
					42,
					7,
				)

				expect(fetchMock).toHaveBeenCalledTimes(1)

				const [url, options] = fetchMock.mock.calls[0]
				expect(url).toBe("https://openproject.example.com/api/v3/work_packages/42")
				expect(options.method).toBe("PATCH")
				expect(options.headers["Content-Type"]).toBe("application/json")
				expect(options.headers.Authorization).toContain("Basic ")

				const body = JSON.parse(options.body)
				expect(body._links.status.href).toBe("/api/v3/statuses/7")
			} finally {
				global.fetch = originalFetch
			}
		})

		it("should throw an error when the API returns a non-ok response", async () => {
			const service = new OpenProjectService(log)

			const fetchMock = vi.fn().mockResolvedValue({
				ok: false,
				status: 422,
				statusText: "Unprocessable Entity",
			})

			const originalFetch = global.fetch
			global.fetch = fetchMock

			try {
				await expect(
					service.updateWorkPackageStatus(
						{
							baseUrl: "https://openproject.example.com",
							apiToken: "my-api-token",
							userIdOrMe: "me",
						},
						42,
						7,
					),
				).rejects.toThrow("Failed to update work package 42 status: 422 Unprocessable Entity")
			} finally {
				global.fetch = originalFetch
			}
		})
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

		const updateWorkPackageStatus = vi.fn().mockResolvedValue(undefined)

		const service = { fetchAssignedOpenTasks, updateWorkPackageStatus } as unknown as OpenProjectService

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

	it("should update OpenProject work package status to In Progress after creating a Roo task", async () => {
		const createTask = vi.fn().mockResolvedValue(undefined)
		const provider = {
			createTask,
			log: vi.fn(),
		} as any

		const fetchAssignedOpenTasks = vi.fn().mockResolvedValue([
			{
				id: 99,
				subject: "Status update test",
				description: "Should trigger status update",
				status: "New",
				projectName: "Demo",
				url: "https://openproject.example.com/api/v3/work_packages/99",
			},
		])

		const updateWorkPackageStatus = vi.fn().mockResolvedValue(undefined)

		const service = { fetchAssignedOpenTasks, updateWorkPackageStatus } as unknown as OpenProjectService

		const logFn = vi.fn()
		const sync = new OpenProjectTaskSync({
			provider,
			service,
			log: logFn,
			initialConfig: {
				enabled: true,
				baseUrl: "https://openproject.example.com",
				apiToken: "token",
				userIdOrMe: "me",
				pollIntervalMinutes: 10,
			},
		})

		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(createTask).toHaveBeenCalledTimes(1)
		expect(updateWorkPackageStatus).toHaveBeenCalledTimes(1)
		expect(updateWorkPackageStatus).toHaveBeenCalledWith(
			{ baseUrl: "https://openproject.example.com", apiToken: "token", userIdOrMe: "me" },
			99,
			7, // "In Progress" status ID
		)

		sync.dispose()
	})

	it("should not fail Roo task creation if status update fails", async () => {
		const createTask = vi.fn().mockResolvedValue(undefined)
		const provider = {
			createTask,
			log: vi.fn(),
		} as any

		const fetchAssignedOpenTasks = vi.fn().mockResolvedValue([
			{
				id: 50,
				subject: "Status update failure test",
				description: "Status update will fail",
				status: "New",
				projectName: "Demo",
				url: "https://openproject.example.com/api/v3/work_packages/50",
			},
		])

		const updateWorkPackageStatus = vi.fn().mockRejectedValue(new Error("Network error"))

		const service = { fetchAssignedOpenTasks, updateWorkPackageStatus } as unknown as OpenProjectService

		const logFn = vi.fn()
		const sync = new OpenProjectTaskSync({
			provider,
			service,
			log: logFn,
			initialConfig: {
				enabled: true,
				baseUrl: "https://openproject.example.com",
				apiToken: "token",
				userIdOrMe: "me",
				pollIntervalMinutes: 10,
			},
		})

		await new Promise((resolve) => setTimeout(resolve, 0))

		// Roo task should still have been created
		expect(createTask).toHaveBeenCalledTimes(1)
		// Status update was attempted but failed
		expect(updateWorkPackageStatus).toHaveBeenCalledTimes(1)
		// Warning should have been logged
		const warningLog = logFn.mock.calls.find(
			(call: any[]) => typeof call[0] === "string" && call[0].includes("Warning: Failed to update status"),
		)
		expect(warningLog).toBeDefined()

		sync.dispose()
	})
})
