import * as vscode from "vscode"

import type { ClineProvider } from "../../core/webview/ClineProvider"

import { OpenProjectService, type OpenProjectClientConfig, type OpenProjectTask } from "./OpenProjectService"

export interface OpenProjectTaskSyncConfig {
	enabled: boolean
	baseUrl?: string
	apiToken?: string
	userIdOrMe?: string
	pollIntervalMinutes: number
}

const DEFAULT_POLL_INTERVAL_MINUTES = 10

export class OpenProjectTaskSync {
	private readonly provider: ClineProvider
	private readonly service: OpenProjectService
	private readonly log: (...args: unknown[]) => void

	private timer: ReturnType<typeof setInterval> | null = null
	private isPolling = false
	private knownTaskIds = new Set<number>()
	private statusBarItem: vscode.StatusBarItem

	private config: OpenProjectTaskSyncConfig = {
		enabled: false,
		pollIntervalMinutes: DEFAULT_POLL_INTERVAL_MINUTES,
	}

	constructor(options: {
		provider: ClineProvider
		service?: OpenProjectService
		log?: (...args: unknown[]) => void
		initialConfig?: Partial<OpenProjectTaskSyncConfig>
	}) {
		this.provider = options.provider
		this.service = options.service ?? new OpenProjectService(options.log)
		const baseLogger =
			options.log ??
			((...args: unknown[]) => {
				// Fallback to provider.log but keep the type signature flexible.
				;(this.provider.log as any)(...args)
			})
		this.log = (...args: unknown[]) => baseLogger(...args)

		this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
		this.statusBarItem.name = "OpenProject Sync"

		if (options.initialConfig) {
			this.updateConfig(options.initialConfig)
		}
	}

	/**
	 * Update configuration and restart polling if necessary.
	 */
	public updateConfig(partial: Partial<OpenProjectTaskSyncConfig>): void {
		this.config = {
			...this.config,
			...partial,
			pollIntervalMinutes:
				partial.pollIntervalMinutes ?? this.config.pollIntervalMinutes ?? DEFAULT_POLL_INTERVAL_MINUTES,
		}

		this.log("[OpenProjectTaskSync] Updated config:", {
			enabled: this.config.enabled,
			baseUrl: this.config.baseUrl,
			userIdOrMe: this.config.userIdOrMe,
			pollIntervalMinutes: this.config.pollIntervalMinutes,
		})

		this.resetTimer()
	}

	/**
	 * Reset the internal polling timer based on the current configuration.
	 */
	private resetTimer(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = null
		}

		if (!this.config.enabled) {
			this.log("[OpenProjectTaskSync] Disabled; polling timer cleared.")
			this.statusBarItem.hide()
			return
		}

		const intervalMinutes = this.config.pollIntervalMinutes || DEFAULT_POLL_INTERVAL_MINUTES
		const intervalMs = Math.max(1, intervalMinutes) * 60 * 1000

		this.timer = setInterval(() => {
			void this.pollOnce().catch((error) => {
				this.log(
					"[OpenProjectTaskSync] Unhandled error during poll:",
					error instanceof Error ? error.message : String(error),
				)
			})
		}, intervalMs)

		this.log("[OpenProjectTaskSync] Polling started with interval (ms):", intervalMs)

		// Optionally perform an immediate poll on enable.
		void this.pollOnce().catch((error) => {
			this.log(
				"[OpenProjectTaskSync] Initial poll error:",
				error instanceof Error ? error.message : String(error),
			)
		})
	}

	/**
	 * Perform a single polling cycle.
	 */
	private async pollOnce(): Promise<void> {
		if (this.isPolling) {
			this.log("[OpenProjectTaskSync] Poll already in progress; skipping.")
			return
		}

		if (!this.config.enabled) {
			this.log("[OpenProjectTaskSync] Poll skipped because sync is disabled.")
			this.statusBarItem.hide()
			return
		}

		const { baseUrl, apiToken, userIdOrMe } = this.config
		if (!baseUrl || !apiToken || !userIdOrMe) {
			this.log("[OpenProjectTaskSync] Poll skipped due to incomplete configuration.")
			this.statusBarItem.text = "$(warning) OpenProject: Config incomplete"
			this.statusBarItem.tooltip = "OpenProject sync is missing required configuration."
			this.statusBarItem.show()
			return
		}

		this.statusBarItem.text = "$(sync~spin) OpenProject: Checking..."
		this.statusBarItem.tooltip = "Checking for new OpenProject tasks..."
		this.statusBarItem.show()

		this.isPolling = true

		try {
			const clientConfig: OpenProjectClientConfig = {
				baseUrl,
				apiToken,
				userIdOrMe,
			}

			const tasks = await this.service.fetchAssignedOpenTasks(clientConfig)

			this.log("[OpenProjectTaskSync] Retrieved tasks from OpenProject:", tasks.length)

			let newTaskCount = 0
			for (const task of tasks) {
				const wasNew = await this.handleTask(task, clientConfig)
				if (wasNew) newTaskCount++
			}

			const timestamp = new Date().toLocaleTimeString()
			if (newTaskCount > 0) {
				const plural = newTaskCount === 1 ? "task" : "tasks"
				this.statusBarItem.text = `$(check) OpenProject: ${newTaskCount} new ${plural}`
				this.statusBarItem.tooltip = `Found ${newTaskCount} new ${plural} at ${timestamp}`
				this.statusBarItem.show()
				vscode.window.showInformationMessage(`OpenProject: Found ${newTaskCount} new ${plural}`)
			} else {
				this.statusBarItem.text = `$(circle-slash) OpenProject: No new tasks`
				this.statusBarItem.tooltip = `Last checked: ${timestamp}. No new tasks found.`
				this.statusBarItem.show()
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			this.log("[OpenProjectTaskSync] Error while polling OpenProject:", errorMessage)
			this.statusBarItem.text = `$(error) OpenProject: Error`
			this.statusBarItem.tooltip = `Error: ${errorMessage}`
			this.statusBarItem.show()
			vscode.window.showErrorMessage(`OpenProject Sync Error: ${errorMessage}`)
		} finally {
			this.isPolling = false
		}
	}

	/**
	 * Handle a single OpenProject task. Currently we only create a Roo task
	 * for tasks we haven't seen before in this session.
	 * @returns `true` if the task was newly created, `false` if it was skipped (already known).
	 */
	private async handleTask(task: OpenProjectTask, clientConfig: OpenProjectClientConfig): Promise<boolean> {
		if (this.knownTaskIds.has(task.id)) {
			return false
		}

		this.knownTaskIds.add(task.id)

		const prompt = this.buildTaskPrompt(task)

		this.log(`[OpenProjectTaskSync] Creating Roo task for OpenProject work package ${task.id} (${task.subject})`)

		try {
			await this.provider.createTask(prompt)

			// Update the work package status to "In Progress" (status ID 7) after successful Roo task creation.
			try {
				await this.service.updateWorkPackageStatus(clientConfig, task.id, 7) // 7 = "In Progress"
				this.log(`[OpenProjectTaskSync] Updated OpenProject task #${task.id} status to In Progress`)
			} catch (statusError) {
				this.log(
					`[OpenProjectTaskSync] Warning: Failed to update status for task #${task.id}: ${statusError instanceof Error ? statusError.message : String(statusError)}`,
				)
			}
		} catch (error) {
			this.log(
				`[OpenProjectTaskSync] Failed to create Roo task for OpenProject work package ${task.id}:`,
				error instanceof Error ? error.message : String(error),
			)
			return false
		}

		return true
	}

	/**
	 * Build the natural-language task prompt that Roo will see from an OpenProject task.
	 */
	private buildTaskPrompt(task: OpenProjectTask): string {
		const lines: string[] = []

		lines.push(`[OpenProject #${task.id}] ${task.subject}`)

		const statusParts: string[] = []
		if (task.status) {
			statusParts.push(`status: ${task.status}`)
		}
		if (task.projectName) {
			statusParts.push(`project: ${task.projectName}`)
		}
		if (statusParts.length) {
			lines.push(`(${statusParts.join(", ")})`)
		}

		if (task.description) {
			lines.push("")
			lines.push(task.description)
		}

		if (task.url) {
			lines.push("")
			lines.push(`OpenProject link: ${task.url}`)
		}

		return lines.join("\n")
	}

	public dispose(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = null
		}
		this.knownTaskIds.clear()
		this.statusBarItem.dispose()
	}
}
