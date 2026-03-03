import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { exec } from "child_process"

import * as vscode from "vscode"

import type { ClineProvider } from "../../core/webview/ClineProvider"

import { OpenProjectService, type OpenProjectClientConfig, type OpenProjectTask } from "./OpenProjectService"

export interface OpenProjectTaskSyncConfig {
	enabled: boolean
	baseUrl?: string
	apiToken?: string
	userIdOrMe?: string
	pollIntervalMinutes: number
	gitAccessKey?: string
}

const DEFAULT_POLL_INTERVAL_MINUTES = 10
const STATUS_IN_PROGRESS = 7
const STATUS_ON_HOLD = 14
const STATUS_DEVELOPED = 8
const STATUS_MONITOR_INTERVAL_MS = 60_000
const STATUS_MONITOR_MAX_CONSECUTIVE_ERRORS = 3

export class OpenProjectTaskSync {
	private readonly provider: ClineProvider
	private readonly service: OpenProjectService
	private readonly log: (...args: unknown[]) => void

	private timer: ReturnType<typeof setInterval> | null = null
	private isPolling = false
	private statusBarItem: vscode.StatusBarItem

	private statusMonitorTimer: ReturnType<typeof setInterval> | null = null
	private statusMonitorTaskId: number | null = null
	private isStatusMonitorChecking = false
	private consecutiveStatusMonitorErrors = 0
	private wasTaskCancelled = false
	private lastCommentedMessageCount = 0

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
			hasGitAccessKey: !!this.config.gitAccessKey,
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

			this.log("[OpenProjectTaskSync] pollOnce() starting — fetching tasks...")

			const tasks = await this.service.fetchAssignedOpenTasks(clientConfig)

			this.log("[OpenProjectTaskSync] pollOnce() returned", tasks.length, "task(s)")

			for (const task of tasks) {
				this.log(
					`[OpenProjectTaskSync] Task summary — id=${task.id}, subject="${task.subject}", gitRepoUrl=${task.gitRepoUrl ?? "(undefined)"}`,
				)
			}

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
	/**
	 * Clone a git repository using the configured gitAccessKey for authentication.
	 * @returns The local path where the repo was cloned, or undefined if no URL provided.
	 */
	private async cloneGitRepo(gitRepoUrl: string): Promise<string> {
		this.log(`[OpenProjectTaskSync] cloneGitRepo() called — gitRepoUrl="${gitRepoUrl}"`)

		// Derive repo name from the URL (strip .git suffix)
		const repoName = path.basename(gitRepoUrl, ".git")

		// Sanitize repoName to prevent path traversal and special characters
		const safeDirName = repoName.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^\.+/, "")

		// Determine clone destination
		let destPath: string
		const workspaceFolders = vscode.workspace.workspaceFolders
		const hasWorkspace = !!(workspaceFolders && workspaceFolders.length > 0)
		this.log(`[OpenProjectTaskSync] cloneGitRepo() — workspace folder found: ${hasWorkspace}`)

		if (hasWorkspace) {
			const workspaceRoot = workspaceFolders![0].uri.fsPath
			this.log(`[OpenProjectTaskSync] cloneGitRepo() — workspace root: ${workspaceRoot}`)
			destPath = path.join(workspaceRoot, "projects", safeDirName)
		} else {
			destPath = path.join(os.homedir(), "roo-projects", safeDirName)
		}

		this.log(`[OpenProjectTaskSync] cloneGitRepo() — destPath: ${destPath}`)

		// Ensure the parent directory exists
		const parentDir = path.dirname(destPath)
		fs.mkdirSync(parentDir, { recursive: true })

		// Inject credentials into URL using string replacement to avoid
		// percent-encoding by the URL class (which mangles tokens containing
		// characters like +, =, /, etc., causing 401 errors on GitLab).
		const gitAccessKey = this.config.gitAccessKey
		let authenticatedUrl = gitRepoUrl

		this.log(
			`[OpenProjectTaskSync] gitAccessKey present: ${!!gitAccessKey}${gitAccessKey ? `, length: ${gitAccessKey.length}` : ""}`,
		)

		if (gitAccessKey) {
			authenticatedUrl = gitRepoUrl.replace(/^(https?:\/\/)/, `$1oauth2:${gitAccessKey}@`)
		} else {
			this.log("[OpenProjectTaskSync] WARNING: No gitAccessKey configured — clone will be unauthenticated")
		}

		// Check if the destination already exists — skip cloning if so
		const destExists = fs.existsSync(destPath)
		this.log(`[OpenProjectTaskSync] cloneGitRepo() — destPath already exists: ${destExists}`)
		if (destExists) {
			this.log(`[OpenProjectTaskSync] Repo already exists at ${destPath}, skipping clone.`)
			return destPath
		}

		// Redact the token from the logged command
		const redactedUrl = gitAccessKey ? authenticatedUrl.replace(gitAccessKey, "***REDACTED***") : authenticatedUrl
		this.log(`[OpenProjectTaskSync] cloneGitRepo() — executing: git clone '${redactedUrl}' '${destPath}'`)

		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `OpenProject: Cloning ${repoName}...`,
				cancellable: false,
			},
			async () => {
				await new Promise<void>((resolve, reject) => {
					// Use single quotes to prevent shell interpolation of special
					// characters ($, `, !, etc.) that may appear in the access token.
					exec(`git clone '${authenticatedUrl}' '${destPath}'`, (error, _stdout, stderr) => {
						if (error) {
							// Redact the token from error messages to avoid leaking secrets
							const safeStderr = gitAccessKey
								? (stderr || error.message).replace(
										new RegExp(gitAccessKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
										"***",
									)
								: stderr || error.message
							reject(new Error(safeStderr))
						} else {
							resolve()
						}
					})
				})
			},
		)

		this.log(`[OpenProjectTaskSync] Successfully cloned repo to ${destPath}`)
		vscode.window.showInformationMessage(`OpenProject: Successfully cloned ${repoName}`)
		return destPath
	}

	private async handleTask(task: OpenProjectTask, clientConfig: OpenProjectClientConfig): Promise<boolean> {
		this.log(
			`[OpenProjectTaskSync] handleTask() — task #${task.id}: gitRepoUrl=${task.gitRepoUrl ?? "(undefined)"}`,
		)

		// Clone the git repo if gitRepoUrl is present before creating the Roo task
		let clonedPath: string | undefined
		if (task.gitRepoUrl) {
			this.log(`[OpenProjectTaskSync] handleTask() — task #${task.id}: gitRepoUrl is present, will attempt clone`)
			try {
				clonedPath = await this.cloneGitRepo(task.gitRepoUrl)
			} catch (cloneError) {
				const cloneErrorMessage = cloneError instanceof Error ? cloneError.message : String(cloneError)
				this.log(`[OpenProjectTaskSync] Failed to clone repo for task #${task.id}: ${cloneErrorMessage}`)
				vscode.window.showErrorMessage(`OpenProject Git Clone Error: ${cloneErrorMessage}`)
				// Do not mark task as processed so it can be retried
				return false
			}
		} else {
			this.log(`[OpenProjectTaskSync] handleTask() — task #${task.id}: no gitRepoUrl, skipping clone`)
		}

		const prompt = this.buildTaskPrompt(task, clonedPath)

		this.log(`[OpenProjectTaskSync] Creating Roo task for OpenProject work package ${task.id} (${task.subject})`)

		try {
			await this.provider.createTask(prompt)

			// Update the work package status to "In Progress" (status ID 7) after successful Roo task creation.
			try {
				await this.service.updateWorkPackageStatus(clientConfig, task.id, STATUS_IN_PROGRESS)
				this.log(`[OpenProjectTaskSync] Updated OpenProject task #${task.id} status to In Progress`)
			} catch (statusError) {
				this.log(
					`[OpenProjectTaskSync] Warning: Failed to update status for task #${task.id}: ${statusError instanceof Error ? statusError.message : String(statusError)}`,
				)
			}

			this.startStatusMonitor(task, clientConfig)
		} catch (error) {
			this.log(
				`[OpenProjectTaskSync] Failed to create Roo task for OpenProject work package ${task.id}:`,
				error instanceof Error ? error.message : String(error),
			)
			return false
		}

		return true
	}

	private startStatusMonitor(task: OpenProjectTask, clientConfig: OpenProjectClientConfig): void {
		if (this.statusMonitorTaskId && this.statusMonitorTaskId !== task.id) {
			this.log(
				`[OpenProjectTaskSync] Status monitor already running for WP #${this.statusMonitorTaskId}; skipping monitor for #${task.id}`,
			)
			return
		}

		if (this.statusMonitorTimer) {
			this.stopStatusMonitor()
		}

		this.wasTaskCancelled = false
		this.statusMonitorTaskId = task.id
		this.statusMonitorTimer = setInterval(() => {
			void this.checkWorkPackageStatus(task, clientConfig)
		}, STATUS_MONITOR_INTERVAL_MS)
		this.log(`[OpenProjectTaskSync] Started status monitor for OpenProject WP #${task.id}`)
		void this.checkWorkPackageStatus(task, clientConfig)
	}

	private stopStatusMonitor(): void {
		if (this.statusMonitorTimer) {
			clearInterval(this.statusMonitorTimer)
			this.statusMonitorTimer = null
		}
		this.statusMonitorTaskId = null
		this.isStatusMonitorChecking = false
		this.consecutiveStatusMonitorErrors = 0
		this.lastCommentedMessageCount = 0
		this.wasTaskCancelled = false
	}

	private async checkWorkPackageStatus(task: OpenProjectTask, clientConfig: OpenProjectClientConfig): Promise<void> {
		if (this.statusMonitorTaskId !== task.id) {
			return
		}

		if (this.isStatusMonitorChecking) {
			this.log(`[OpenProjectTaskSync] Status monitor already checking for WP #${task.id}`)
			return
		}

		this.isStatusMonitorChecking = true

		try {
			const currentRooTask = this.provider.getCurrentTask()
			if (!currentRooTask) {
				this.log(`[OpenProjectTaskSync] Roo task for WP #${task.id} is no longer active`)

				// Task completed naturally (not cancelled by us)
				if (!this.wasTaskCancelled) {
					this.log(
						`[OpenProjectTaskSync] Roo task completed successfully; updating WP #${task.id} to Developed`,
					)

					try {
						await this.service.updateWorkPackageStatus(clientConfig, task.id, STATUS_DEVELOPED)
						this.log(
							`[OpenProjectTaskSync] Set OpenProject WP #${task.id} to Developed (ID ${STATUS_DEVELOPED})`,
						)
					} catch (statusError) {
						this.log(
							`[OpenProjectTaskSync] Warning: Failed to set WP #${task.id} to Developed: ${statusError instanceof Error ? statusError.message : String(statusError)}`,
						)
					}

					try {
						await this.service.addComment(
							clientConfig,
							task.id,
							`✅ Roo agent completed task successfully.\nWork package has been moved to **Developed**.`,
						)
					} catch (commentError) {
						this.log(
							`[OpenProjectTaskSync] Warning: Failed to post completion comment on WP #${task.id}: ${commentError instanceof Error ? commentError.message : String(commentError)}`,
						)
					}

					this.statusBarItem.text = `$(check) OpenProject: WP #${task.id} developed`
					this.statusBarItem.tooltip = `Task completed — work package moved to Developed`
					this.statusBarItem.show()
				}

				this.stopStatusMonitor()
				return
			}

			// Post progress comment if there are new messages since the last comment
			await this.postProgressComment(task, clientConfig, currentRooTask)

			const { statusId, statusName } = await this.service.fetchWorkPackageStatus(clientConfig, task.id)
			this.consecutiveStatusMonitorErrors = 0

			if (statusId === STATUS_IN_PROGRESS) {
				this.log(`[OpenProjectTaskSync] WP #${task.id} still In Progress (${statusName})`)
				return
			}

			this.log(
				`[OpenProjectTaskSync] WP #${task.id} status changed to ${statusName} (ID ${statusId}); cancelling Roo task`,
			)
			this.wasTaskCancelled = true
			await this.cancelRooTask(task, statusName)

			try {
				await this.service.updateWorkPackageStatus(clientConfig, task.id, STATUS_ON_HOLD)
				this.log(`[OpenProjectTaskSync] Set OpenProject WP #${task.id} to On Hold`)
			} catch (statusError) {
				this.log(
					`[OpenProjectTaskSync] Warning: Failed to set WP #${task.id} to On Hold: ${statusError instanceof Error ? statusError.message : String(statusError)}`,
				)
			}

			this.statusBarItem.text = `$(circle-slash) OpenProject: WP #${task.id} on hold`
			this.statusBarItem.tooltip = `Work package status changed to ${statusName}`
			this.statusBarItem.show()

			this.stopStatusMonitor()
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			this.consecutiveStatusMonitorErrors += 1
			this.log(
				`[OpenProjectTaskSync] Error polling status for WP #${task.id} (attempt ${this.consecutiveStatusMonitorErrors}): ${errorMessage}`,
			)
			if (this.consecutiveStatusMonitorErrors >= STATUS_MONITOR_MAX_CONSECUTIVE_ERRORS) {
				this.log(
					`[OpenProjectTaskSync] Giving up on status monitor for WP #${task.id} after ${this.consecutiveStatusMonitorErrors} errors`,
				)
				this.stopStatusMonitor()
			}
		} finally {
			this.isStatusMonitorChecking = false
		}
	}

	/**
	 * Post a progress comment to the OpenProject work package summarizing
	 * what the Roo agent is currently doing. Extracts the latest assistant
	 * messages from the Roo task's clineMessages.
	 */
	private async postProgressComment(
		task: OpenProjectTask,
		clientConfig: OpenProjectClientConfig,
		rooTask: {
			clineMessages?: Array<{ type?: string; say?: string; text?: string }>
			todoList?: Array<{ status: string; id: string; content: string }>
		},
	): Promise<void> {
		try {
			const messages = rooTask.clineMessages ?? []
			const currentCount = messages.length

			// Only comment if there are new messages since last time
			if (currentCount <= this.lastCommentedMessageCount) {
				this.log(`[OpenProjectTaskSync] No new messages since last comment for WP #${task.id}`)
				return
			}

			// Collect the latest assistant "say" messages since last comment
			const newMessages = messages.slice(this.lastCommentedMessageCount)
			const assistantTexts: string[] = []

			for (const msg of newMessages) {
				if (msg.type === "say" && msg.say === "text" && msg.text) {
					// Truncate very long messages
					const truncated = msg.text.length > 300 ? msg.text.slice(0, 300) + "…" : msg.text
					assistantTexts.push(truncated)
				}
			}

			if (assistantTexts.length === 0) {
				// No meaningful text messages, just update the counter
				this.lastCommentedMessageCount = currentCount
				return
			}

			// Build a progress comment
			const lines: string[] = []
			lines.push(`🤖 **Roo Agent Progress Update**`)
			lines.push("")

			// Include todo list if available
			const todoList = rooTask.todoList
			if (todoList && todoList.length > 0) {
				lines.push("**Task checklist:**")
				for (const item of todoList) {
					const check = item.status === "completed" ? "✅" : item.status === "in_progress" ? "🔄" : "⬜"
					lines.push(`${check} ${item.content}`)
				}
				lines.push("")
			}

			lines.push("**Recent activity:**")
			// Show at most the last 3 assistant messages to keep comments concise
			const recentTexts = assistantTexts.slice(-3)
			for (const text of recentTexts) {
				lines.push(`> ${text.replace(/\n/g, "\n> ")}`)
				lines.push("")
			}

			lines.push(`_Agent is still running…_`)

			const comment = lines.join("\n")

			await this.service.addComment(clientConfig, task.id, comment)
			this.log(`[OpenProjectTaskSync] Posted progress comment on WP #${task.id}`)
			this.lastCommentedMessageCount = currentCount
		} catch (error) {
			// Non-critical — don't let comment failures break the monitor
			this.log(
				`[OpenProjectTaskSync] Warning: Failed to post progress comment on WP #${task.id}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	private async cancelRooTask(task: OpenProjectTask, statusName: string): Promise<void> {
		const currentRooTask = this.provider.getCurrentTask()
		if (!currentRooTask) {
			this.log(`[OpenProjectTaskSync] cancelRooTask(): no active Roo task for WP #${task.id}`)
			return
		}

		try {
			await this.provider.cancelTask()
			const humanStatus = statusName || "<unknown>"
			vscode.window.showInformationMessage(
				`OpenProject: Work package #${task.id} changed status to ${humanStatus}, cancelling Roo task and putting it on hold`,
			)
			this.log(`[OpenProjectTaskSync] Roo task for WP #${task.id} cancelled via status monitor`)
		} catch (error) {
			this.log(
				`[OpenProjectTaskSync] Failed to cancel Roo task for WP #${task.id}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	/**
	 * Build the natural-language task prompt that Roo will see from an OpenProject task.
	 */
	private buildTaskPrompt(task: OpenProjectTask, clonedPath?: string): string {
		const lines: string[] = []

		lines.push(`[OpenProject #${task.id}] ${task.subject}`)

		if (task.status) {
			lines.push(`(status: ${task.status})`)
		}

		if (task.description) {
			lines.push("")
			lines.push(task.description)
		}

		if (clonedPath) {
			// Convert absolute path to a relative path from the workspace root
			const workspaceFolders = vscode.workspace.workspaceFolders
			let displayPath = clonedPath
			if (workspaceFolders && workspaceFolders.length > 0) {
				const workspaceRoot = workspaceFolders[0].uri.fsPath
				if (clonedPath.startsWith(workspaceRoot)) {
					displayPath = path.relative(workspaceRoot, clonedPath)
				}
			}
			lines.push("")
			lines.push(`Source code: ${displayPath}`)
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
		this.stopStatusMonitor()
		this.statusBarItem.dispose()
	}
}
