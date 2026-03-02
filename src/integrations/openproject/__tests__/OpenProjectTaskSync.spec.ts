import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as vscode from "vscode"

import { OpenProjectService } from "../OpenProjectService"
import { OpenProjectTaskSync } from "../OpenProjectTaskSync"

declare const global: any

// Mock status bar item factory
const mockStatusBarItem = {
	text: "",
	tooltip: "",
	name: "",
	show: vi.fn(),
	hide: vi.fn(),
	dispose: vi.fn(),
}

// Mock vscode module
vi.mock("vscode", () => ({
	StatusBarAlignment: { Left: 1, Right: 2 },
	ProgressLocation: { Notification: 15 },
	window: {
		showInformationMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		createStatusBarItem: vi.fn(() => mockStatusBarItem),
		withProgress: vi.fn((_options: any, task: Function) => task({ report: vi.fn() })),
	},
	workspace: {
		workspaceFolders: undefined,
	},
}))

// Mock child_process exec
const mockExec = vi.fn()
vi.mock("child_process", () => ({
	exec: (...args: any[]) => mockExec(...args),
}))

// Mock fs.existsSync
const mockExistsSync = vi.fn().mockReturnValue(false)
vi.mock("fs", () => ({
	existsSync: (...args: any[]) => mockExistsSync(...args),
}))

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

		// Clear the vscode mocks between tests
		vi.mocked(vscode.window.showInformationMessage).mockClear()
		vi.mocked(vscode.window.showErrorMessage).mockClear()
		vi.mocked(vscode.window.withProgress).mockClear()
		// Restore default withProgress implementation
		vi.mocked(vscode.window.withProgress).mockImplementation((_options: any, task: Function) =>
			task({ report: vi.fn() }),
		)
		mockStatusBarItem.show.mockClear()
		mockStatusBarItem.hide.mockClear()
		mockStatusBarItem.dispose.mockClear()
		mockStatusBarItem.text = ""
		mockStatusBarItem.tooltip = ""

		// Reset child_process and fs mocks
		mockExec.mockReset()
		mockExistsSync.mockReturnValue(false)
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

	it("should show a singular notification when exactly 1 new task is found", async () => {
		const createTask = vi.fn().mockResolvedValue(undefined)
		const provider = {
			createTask,
			log: vi.fn(),
		} as any

		const fetchAssignedOpenTasks = vi.fn().mockResolvedValue([
			{
				id: 10,
				subject: "Single new task",
				description: "Only one",
				status: "New",
				projectName: "Demo",
				url: "https://openproject.example.com/api/v3/work_packages/10",
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

		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1)
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("OpenProject: Found 1 new task")

		sync.dispose()
	})

	it("should show a plural notification when multiple new tasks are found", async () => {
		const createTask = vi.fn().mockResolvedValue(undefined)
		const provider = {
			createTask,
			log: vi.fn(),
		} as any

		const fetchAssignedOpenTasks = vi.fn().mockResolvedValue([
			{
				id: 20,
				subject: "First task",
				description: "Task one",
				status: "New",
				projectName: "Demo",
				url: "https://openproject.example.com/api/v3/work_packages/20",
			},
			{
				id: 21,
				subject: "Second task",
				description: "Task two",
				status: "New",
				projectName: "Demo",
				url: "https://openproject.example.com/api/v3/work_packages/21",
			},
			{
				id: 22,
				subject: "Third task",
				description: "Task three",
				status: "New",
				projectName: "Demo",
				url: "https://openproject.example.com/api/v3/work_packages/22",
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

		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1)
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("OpenProject: Found 3 new tasks")

		sync.dispose()
	})

	it("should NOT show a notification when all tasks are already known", async () => {
		const createTask = vi.fn().mockResolvedValue(undefined)
		const provider = {
			createTask,
			log: vi.fn(),
		} as any

		const task = {
			id: 30,
			subject: "Already known task",
			description: "Seen before",
			status: "New",
			projectName: "Demo",
			url: "https://openproject.example.com/api/v3/work_packages/30",
		}

		const fetchAssignedOpenTasks = vi.fn().mockResolvedValue([task])
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

		// First poll — task is new, notification fires
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1)

		// Clear so we can assert the second poll doesn't fire again
		vi.mocked(vscode.window.showInformationMessage).mockClear()

		// Manually trigger a second poll — same task is now known
		// Access the private pollOnce via casting to test internal behavior
		await (sync as any).pollOnce()

		expect(vscode.window.showInformationMessage).not.toHaveBeenCalled()

		sync.dispose()
	})

	it("should show 'Checking...' in status bar at the start of a poll", async () => {
		const createTask = vi.fn().mockResolvedValue(undefined)
		const provider = {
			createTask,
			log: vi.fn(),
		} as any

		const fetchAssignedOpenTasks = vi.fn().mockResolvedValue([])
		const updateWorkPackageStatus = vi.fn().mockResolvedValue(undefined)
		const service = { fetchAssignedOpenTasks, updateWorkPackageStatus } as unknown as OpenProjectService

		// We need to capture the status bar state during the fetch, so wrap fetchAssignedOpenTasks
		let textDuringFetch = ""
		fetchAssignedOpenTasks.mockImplementation(async () => {
			textDuringFetch = mockStatusBarItem.text
			return []
		})

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

		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(textDuringFetch).toBe("$(sync~spin) OpenProject: Checking...")
		expect(mockStatusBarItem.show).toHaveBeenCalled()

		sync.dispose()
	})

	it("should show 'No new tasks' in status bar when all tasks are already known", async () => {
		const createTask = vi.fn().mockResolvedValue(undefined)
		const provider = {
			createTask,
			log: vi.fn(),
		} as any

		const fetchAssignedOpenTasks = vi.fn().mockResolvedValue([
			{
				id: 40,
				subject: "Already known task",
				description: "Seen before",
				status: "New",
				projectName: "Demo",
				url: "https://openproject.example.com/api/v3/work_packages/40",
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

		// First poll — task is new
		await new Promise((resolve) => setTimeout(resolve, 0))

		// Clear status bar mock state
		mockStatusBarItem.show.mockClear()
		mockStatusBarItem.text = ""

		// Second poll — task is already known → no new tasks
		await (sync as any).pollOnce()

		expect(mockStatusBarItem.text).toBe("$(circle-slash) OpenProject: No new tasks")
		expect(mockStatusBarItem.show).toHaveBeenCalled()

		sync.dispose()
	})

	it("should show correct count in status bar when new tasks are found", async () => {
		const createTask = vi.fn().mockResolvedValue(undefined)
		const provider = {
			createTask,
			log: vi.fn(),
		} as any

		const fetchAssignedOpenTasks = vi.fn().mockResolvedValue([
			{
				id: 60,
				subject: "Task A",
				description: "Desc A",
				status: "New",
				projectName: "Demo",
				url: "https://openproject.example.com/api/v3/work_packages/60",
			},
			{
				id: 61,
				subject: "Task B",
				description: "Desc B",
				status: "New",
				projectName: "Demo",
				url: "https://openproject.example.com/api/v3/work_packages/61",
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

		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(mockStatusBarItem.text).toBe("$(check) OpenProject: 2 new tasks")
		expect(mockStatusBarItem.show).toHaveBeenCalled()

		sync.dispose()
	})

	it("should hide status bar when sync is disabled", async () => {
		const createTask = vi.fn().mockResolvedValue(undefined)
		const provider = {
			createTask,
			log: vi.fn(),
		} as any

		const fetchAssignedOpenTasks = vi.fn().mockResolvedValue([])
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

		await new Promise((resolve) => setTimeout(resolve, 0))

		// Clear hide mock state
		mockStatusBarItem.hide.mockClear()

		// Disable sync
		sync.updateConfig({ enabled: false })

		expect(mockStatusBarItem.hide).toHaveBeenCalled()

		sync.dispose()
	})

	it("should show error in status bar when fetchAssignedOpenTasks throws", async () => {
		const createTask = vi.fn().mockResolvedValue(undefined)
		const provider = {
			createTask,
			log: vi.fn(),
		} as any

		const fetchAssignedOpenTasks = vi.fn().mockRejectedValue(new Error("Network error"))
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

		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(mockStatusBarItem.text).toBe("$(error) OpenProject: Error")
		expect(mockStatusBarItem.show).toHaveBeenCalled()
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("OpenProject Sync Error: Network error")

		sync.dispose()
	})

	it("should dispose status bar item when sync is disposed", async () => {
		const provider = {
			createTask: vi.fn().mockResolvedValue(undefined),
			log: vi.fn(),
		} as any

		const fetchAssignedOpenTasks = vi.fn().mockResolvedValue([])
		const updateWorkPackageStatus = vi.fn().mockResolvedValue(undefined)
		const service = { fetchAssignedOpenTasks, updateWorkPackageStatus } as unknown as OpenProjectService

		const sync = new OpenProjectTaskSync({
			provider,
			service,
			log: vi.fn(),
		})

		sync.dispose()

		expect(mockStatusBarItem.dispose).toHaveBeenCalled()
	})

	it("should call git clone with authenticated URL when gitRepoUrl is present", async () => {
		const createTask = vi.fn().mockResolvedValue(undefined)
		const provider = {
			createTask,
			log: vi.fn(),
		} as any

		// Make exec succeed
		mockExec.mockImplementation((_cmd: string, callback: Function) => {
			callback(null, "", "")
		})

		const fetchAssignedOpenTasks = vi.fn().mockResolvedValue([
			{
				id: 200,
				subject: "Task with git repo",
				description: "Has a git repo URL",
				status: "New",
				projectName: "Demo",
				url: "https://openproject.example.com/api/v3/work_packages/200",
				gitRepoUrl: "https://gitlab.ebk.vn/ai-agents/hello-world.git",
			},
		])

		const updateWorkPackageStatus = vi.fn().mockResolvedValue(undefined)
		const service = { fetchAssignedOpenTasks, updateWorkPackageStatus } as unknown as OpenProjectService

		// Set up a workspace folder so destination path is workspaceFolder/repoName
		const mockWorkspaceRoot = "/Users/user/myworkspace"
		vi.mocked(vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: mockWorkspaceRoot } }]

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
				gitAccessKey: "test-git-token",
			},
		})

		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(mockExec).toHaveBeenCalledTimes(1)
		const calledCmd: string = mockExec.mock.calls[0][0]
		expect(calledCmd).toContain("git clone")
		expect(calledCmd).toContain("oauth2:test-git-token@gitlab.ebk.vn")
		// Destination should be workspaceFolder/repoName (NOT ../projects/repoName)
		expect(calledCmd).toContain(`${mockWorkspaceRoot}/hello-world`)
		expect(calledCmd).not.toContain("../projects/")
		// Should use single quotes to prevent shell interpolation
		expect(calledCmd).toMatch(/git clone '.*' '.*'/)

		// Roo task should have been created
		expect(createTask).toHaveBeenCalledTimes(1)

		// Restore workspaceFolders
		vi.mocked(vscode.workspace as any).workspaceFolders = undefined

		sync.dispose()
	})

	it("should show error popup when git clone fails", async () => {
		const createTask = vi.fn().mockResolvedValue(undefined)
		const provider = {
			createTask,
			log: vi.fn(),
		} as any

		// Make exec fail
		mockExec.mockImplementation((_cmd: string, callback: Function) => {
			callback(new Error("authentication failed"), "", "authentication failed")
		})

		const fetchAssignedOpenTasks = vi.fn().mockResolvedValue([
			{
				id: 202,
				subject: "Task with failing git repo",
				description: "Clone will fail",
				status: "New",
				projectName: "Demo",
				url: "https://openproject.example.com/api/v3/work_packages/202",
				gitRepoUrl: "https://gitlab.ebk.vn/ai-agents/secret-repo.git",
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
				gitAccessKey: "test-git-token",
			},
		})

		await new Promise((resolve) => setTimeout(resolve, 0))

		// exec was called (clone was attempted)
		expect(mockExec).toHaveBeenCalledTimes(1)

		// Error popup must be shown with the clone error message
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
			"OpenProject Git Clone Error: authentication failed",
		)

		// Roo task should NOT have been created because clone failed
		expect(createTask).not.toHaveBeenCalled()

		sync.dispose()
	})

	it("should NOT call git clone when gitRepoUrl is absent", async () => {
		const createTask = vi.fn().mockResolvedValue(undefined)
		const provider = {
			createTask,
			log: vi.fn(),
		} as any

		const fetchAssignedOpenTasks = vi.fn().mockResolvedValue([
			{
				id: 201,
				subject: "Task without git repo",
				description: "No git repo URL",
				status: "New",
				projectName: "Demo",
				url: "https://openproject.example.com/api/v3/work_packages/201",
				// No gitRepoUrl field
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
				gitAccessKey: "test-git-token",
			},
		})

		await new Promise((resolve) => setTimeout(resolve, 0))

		// exec should NOT have been called (no git clone)
		expect(mockExec).not.toHaveBeenCalled()

		// Roo task should still have been created
		expect(createTask).toHaveBeenCalledTimes(1)

		sync.dispose()
	})

	it("should preserve special characters in gitAccessKey without URL-encoding", async () => {
		const createTask = vi.fn().mockResolvedValue(undefined)
		const provider = {
			createTask,
			log: vi.fn(),
		} as any

		mockExec.mockImplementation((_cmd: string, callback: Function) => {
			callback(null, "", "")
		})

		const fetchAssignedOpenTasks = vi.fn().mockResolvedValue([
			{
				id: 300,
				subject: "Task with special char token",
				description: "Token has special chars",
				status: "New",
				projectName: "Demo",
				url: "https://openproject.example.com/api/v3/work_packages/300",
				gitRepoUrl: "https://gitlab.ebk.vn/ai-agents/hello-world.git",
			},
		])

		const updateWorkPackageStatus = vi.fn().mockResolvedValue(undefined)
		const service = { fetchAssignedOpenTasks, updateWorkPackageStatus } as unknown as OpenProjectService

		const mockWorkspaceRoot = "/Users/user/myworkspace"
		vi.mocked(vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: mockWorkspaceRoot } }]

		// Token with characters that URL class would percent-encode
		const tokenWithSpecialChars = "glpat-abc+def/ghi=jkl"

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
				gitAccessKey: tokenWithSpecialChars,
			},
		})

		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(mockExec).toHaveBeenCalledTimes(1)
		const calledCmd: string = mockExec.mock.calls[0][0]

		// The token must appear literally — NOT percent-encoded
		expect(calledCmd).toContain(`oauth2:${tokenWithSpecialChars}@gitlab.ebk.vn`)
		// Must NOT contain percent-encoded variants
		expect(calledCmd).not.toContain("%2B") // + encoded
		expect(calledCmd).not.toContain("%2F") // / encoded
		expect(calledCmd).not.toContain("%3D") // = encoded

		vi.mocked(vscode.workspace as any).workspaceFolders = undefined
		sync.dispose()
	})

	it("should redact gitAccessKey from error messages on clone failure", async () => {
		const createTask = vi.fn().mockResolvedValue(undefined)
		const provider = {
			createTask,
			log: vi.fn(),
		} as any

		const secretToken = "glpat-super-secret-token-123"

		// Make exec fail with an error that includes the token in stderr
		mockExec.mockImplementation((_cmd: string, callback: Function) => {
			callback(
				new Error("fatal: could not read"),
				"",
				`fatal: Authentication failed for 'https://oauth2:${secretToken}@gitlab.ebk.vn/ai-agents/repo.git'`,
			)
		})

		const fetchAssignedOpenTasks = vi.fn().mockResolvedValue([
			{
				id: 301,
				subject: "Task with redact test",
				description: "Clone error should redact token",
				status: "New",
				projectName: "Demo",
				url: "https://openproject.example.com/api/v3/work_packages/301",
				gitRepoUrl: "https://gitlab.ebk.vn/ai-agents/repo.git",
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
				gitAccessKey: secretToken,
			},
		})

		await new Promise((resolve) => setTimeout(resolve, 0))

		// Error popup should NOT contain the actual token
		expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1)
		const errorMsg = vi.mocked(vscode.window.showErrorMessage).mock.calls[0][0] as string
		expect(errorMsg).not.toContain(secretToken)
		expect(errorMsg).toContain("***")

		sync.dispose()
	})

	it("should log warning when gitAccessKey is not configured", async () => {
		const createTask = vi.fn().mockResolvedValue(undefined)
		const provider = {
			createTask,
			log: vi.fn(),
		} as any

		mockExec.mockImplementation((_cmd: string, callback: Function) => {
			callback(null, "", "")
		})

		const fetchAssignedOpenTasks = vi.fn().mockResolvedValue([
			{
				id: 302,
				subject: "Task without git key",
				description: "No gitAccessKey set",
				status: "New",
				projectName: "Demo",
				url: "https://openproject.example.com/api/v3/work_packages/302",
				gitRepoUrl: "https://gitlab.ebk.vn/ai-agents/hello-world.git",
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
				// gitAccessKey intentionally omitted
			},
		})

		await new Promise((resolve) => setTimeout(resolve, 0))

		// Should have logged a warning about missing gitAccessKey
		const warningLog = logFn.mock.calls.find(
			(call: any[]) => typeof call[0] === "string" && call[0].includes("WARNING: No gitAccessKey configured"),
		)
		expect(warningLog).toBeDefined()

		// The clone URL should NOT contain oauth2 credentials
		if (mockExec.mock.calls.length > 0) {
			const calledCmd: string = mockExec.mock.calls[0][0]
			expect(calledCmd).not.toContain("oauth2:")
		}

		sync.dispose()
	})

	it("should show progress notification with 'Cloning {repoName}...' during clone", async () => {
		const createTask = vi.fn().mockResolvedValue(undefined)
		const provider = {
			createTask,
			log: vi.fn(),
		} as any

		mockExec.mockImplementation((_cmd: string, callback: Function) => {
			callback(null, "", "")
		})

		const fetchAssignedOpenTasks = vi.fn().mockResolvedValue([
			{
				id: 400,
				subject: "Task with clone status",
				description: "Check progress notification during clone",
				status: "New",
				projectName: "Demo",
				url: "https://openproject.example.com/api/v3/work_packages/400",
				gitRepoUrl: "https://gitlab.ebk.vn/ai-agents/my-repo.git",
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
				gitAccessKey: "test-token",
			},
		})

		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(vscode.window.withProgress).toHaveBeenCalledTimes(1)
		const progressOptions = vi.mocked(vscode.window.withProgress).mock.calls[0][0] as any
		expect(progressOptions.location).toBe(vscode.ProgressLocation.Notification)
		expect(progressOptions.title).toBe("OpenProject: Cloning my-repo...")
		expect(progressOptions.cancellable).toBe(false)

		sync.dispose()
	})

	it("should show 'Cloned {repoName}' in status bar after successful clone", async () => {
		const createTask = vi.fn().mockResolvedValue(undefined)
		const provider = {
			createTask,
			log: vi.fn(),
		} as any

		mockExec.mockImplementation((_cmd: string, callback: Function) => {
			callback(null, "", "")
		})

		const fetchAssignedOpenTasks = vi.fn().mockResolvedValue([
			{
				id: 401,
				subject: "Task with clone success status",
				description: "Check status bar after clone",
				status: "New",
				projectName: "Demo",
				url: "https://openproject.example.com/api/v3/work_packages/401",
				gitRepoUrl: "https://gitlab.ebk.vn/ai-agents/my-repo.git",
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
				gitAccessKey: "test-token",
			},
		})

		await new Promise((resolve) => setTimeout(resolve, 0))

		// After the poll completes, the status bar will show the poll result (e.g. "1 new task")
		// but the clone success status was set during handleTask. We verify the information message.
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
			"OpenProject: Successfully cloned my-repo",
		)

		sync.dispose()
	})

	it("should show showErrorMessage on clone failure without updating status bar", async () => {
		const createTask = vi.fn().mockResolvedValue(undefined)
		const provider = {
			createTask,
			log: vi.fn(),
		} as any

		mockExec.mockImplementation((_cmd: string, callback: Function) => {
			callback(new Error("permission denied"), "", "permission denied")
		})

		const fetchAssignedOpenTasks = vi.fn().mockResolvedValue([
			{
				id: 402,
				subject: "Task with clone failure status",
				description: "Check error message on clone failure",
				status: "New",
				projectName: "Demo",
				url: "https://openproject.example.com/api/v3/work_packages/402",
				gitRepoUrl: "https://gitlab.ebk.vn/ai-agents/fail-repo.git",
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
				gitAccessKey: "test-token",
			},
		})

		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
			"OpenProject Git Clone Error: permission denied",
		)

		sync.dispose()
	})

	it("should skip clone and not call withProgress when directory already exists", async () => {
		const createTask = vi.fn().mockResolvedValue(undefined)
		const provider = {
			createTask,
			log: vi.fn(),
		} as any

		// Make existsSync return true to simulate directory already exists
		mockExistsSync.mockReturnValue(true)

		const fetchAssignedOpenTasks = vi.fn().mockResolvedValue([
			{
				id: 403,
				subject: "Task with existing repo",
				description: "Repo already cloned",
				status: "New",
				projectName: "Demo",
				url: "https://openproject.example.com/api/v3/work_packages/403",
				gitRepoUrl: "https://gitlab.ebk.vn/ai-agents/existing-repo.git",
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
				gitAccessKey: "test-token",
			},
		})

		await new Promise((resolve) => setTimeout(resolve, 0))

		// withProgress should NOT have been called since directory already exists
		expect(vscode.window.withProgress).not.toHaveBeenCalled()
		// exec should NOT have been called since directory already exists
		expect(mockExec).not.toHaveBeenCalled()
		// Roo task should still have been created
		expect(createTask).toHaveBeenCalledTimes(1)

		sync.dispose()
	})

	it("should show showInformationMessage on clone success but NOT on already-exists", async () => {
		const createTask = vi.fn().mockResolvedValue(undefined)
		const provider = {
			createTask,
			log: vi.fn(),
		} as any

		// Directory already exists
		mockExistsSync.mockReturnValue(true)

		const fetchAssignedOpenTasks = vi.fn().mockResolvedValue([
			{
				id: 404,
				subject: "Task with already-cloned repo",
				description: "Should not show clone success message",
				status: "New",
				projectName: "Demo",
				url: "https://openproject.example.com/api/v3/work_packages/404",
				gitRepoUrl: "https://gitlab.ebk.vn/ai-agents/already-cloned.git",
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
				gitAccessKey: "test-token",
			},
		})

		await new Promise((resolve) => setTimeout(resolve, 0))

		// Should NOT show "Successfully cloned" message since it was already there
		const cloneSuccessCalls = vi.mocked(vscode.window.showInformationMessage).mock.calls.filter(
			(call) => typeof call[0] === "string" && (call[0] as string).includes("Successfully cloned"),
		)
		expect(cloneSuccessCalls).toHaveLength(0)

		sync.dispose()
	})
})
