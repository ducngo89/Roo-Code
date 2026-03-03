export interface OpenProjectClientConfig {
	baseUrl: string
	apiToken: string
	userIdOrMe: string
}

export interface OpenProjectTask {
	id: number
	subject: string
	description: string
	status?: string
	url: string
	gitRepoUrl?: string
}

export class OpenProjectService {
	private log: (...args: unknown[]) => void

	constructor(log?: (...args: unknown[]) => void) {
		this.log = log || console.log
	}

	/**
	 * Fetch OpenProject work packages assigned to the configured user and still open.
	 * This method is intentionally conservative and only maps the fields we actually use.
	 */
	public async fetchAssignedOpenTasks(config: OpenProjectClientConfig): Promise<OpenProjectTask[]> {
		const { baseUrl, apiToken, userIdOrMe } = config

		if (!baseUrl || !apiToken || !userIdOrMe) {
			this.log(
				"[OpenProjectService] Missing configuration. baseUrl, apiToken, and userIdOrMe are required to fetch tasks.",
			)
			return []
		}

		// Ensure base URL has no trailing slash for consistent URL building.
		const normalizedBaseUrl = baseUrl.replace(/\/+$/, "")

		// Filters: assigned_to = userIdOrMe ("me" or numeric ID), status = "New" (ID 1).
		// Using operator "=" with value "1" to match only "New" status work packages.
		// See OpenProject API docs for /api/v3/work_packages filters.
		const filters = encodeURIComponent(
			JSON.stringify([
				{ assigned_to: { operator: "=", values: [userIdOrMe] } },
				{ status: { operator: "=", values: ["1"] } },
			]),
		)

		const url = `${normalizedBaseUrl}/api/v3/work_packages?filters=${filters}`

		// OpenProject uses Basic auth with "apikey" as the literal username and the API token as the password.
		const authHeader = `Basic ${Buffer.from(`apikey:${apiToken}`).toString("base64")}`

		this.log("[OpenProjectService] Fetching assigned open tasks from:", url)

		let response: Response
		try {
			response = await fetch(url, {
				method: "GET",
				headers: {
					Authorization: authHeader,
					Accept: "application/hal+json, application/json",
				},
			})
		} catch (error) {
			this.log(
				"[OpenProjectService] Network error while fetching tasks:",
				error instanceof Error ? error.message : String(error),
			)
			throw error
		}

		if (!response.ok) {
			const bodyText = await response.text().catch(() => "")
			this.log(
				`[OpenProjectService] Failed to fetch tasks: ${response.status} ${response.statusText} ${bodyText}`,
			)
			throw new Error(
				`OpenProject API error: ${response.status} ${response.statusText}${
					bodyText ? ` - ${bodyText.slice(0, 200)}` : ""
				}`,
			)
		}

		let data: any
		try {
			data = await response.json()
		} catch (error) {
			this.log(
				"[OpenProjectService] Failed to parse JSON response:",
				error instanceof Error ? error.message : String(error),
			)
			throw error
		}

		const elements: any[] = data?._embedded?.elements ?? []

		this.log("[OpenProjectService] Total work packages in response:", elements.length)

		// Log the first work package raw structure for debugging custom field access
		if (elements.length > 0) {
			const firstWp = elements[0]
			const topLevelKeys = Object.keys(firstWp).filter(
				(k) => k.startsWith("customField") || k.startsWith("custom_field"),
			)
			this.log("[OpenProjectService] First WP top-level custom field keys:", JSON.stringify(topLevelKeys))
			const linksKeys = firstWp._links
				? Object.keys(firstWp._links).filter((k) => k.startsWith("customField") || k.startsWith("custom_field"))
				: []
			this.log("[OpenProjectService] First WP _links custom field keys:", JSON.stringify(linksKeys))
		}

		if (!Array.isArray(elements)) {
			this.log("[OpenProjectService] Unexpected response shape: missing _embedded.elements array")
			return []
		}

		const tasks: OpenProjectTask[] = elements.map((wp: any) => {
			const id = typeof wp.id === "number" ? wp.id : Number(wp.id)
			const subject = typeof wp.subject === "string" ? wp.subject : ""
			const description = wp.description?.raw ?? ""
			const status =
				wp._embedded?.status?.name ?? wp.status?.name ?? (typeof wp.status === "string" ? wp.status : undefined)

			const selfHref: string | undefined = wp._links?.self?.href
			let url = ""
			try {
				// Some OpenProject installations return absolute URLs, some relative.
				url = selfHref ? new URL(selfHref, `${normalizedBaseUrl}/`).toString() : normalizedBaseUrl
			} catch {
				url = normalizedBaseUrl
			}

			// Log customField3 diagnostic info for every work package
			this.log(
				`[OpenProjectService] WP #${id} customField3 (top-level):`,
				JSON.stringify(wp.customField3 ?? null),
			)
			this.log(
				`[OpenProjectService] WP #${id} _links.customField3:`,
				JSON.stringify(wp._links?.customField3 ?? null),
			)

			// Extract git repository URL from customField3.title if present.
			// Check both top-level (some API versions) and _links (HAL+JSON standard).
			const rawGitUrl = wp.customField3?.title ?? wp._links?.customField3?.title
			const gitRepoUrl: string | undefined =
				typeof rawGitUrl === "string" && rawGitUrl.trim() ? rawGitUrl.trim() : undefined

			this.log(`[OpenProjectService] WP #${id} extracted gitRepoUrl:`, gitRepoUrl ?? "(undefined)")

			const task: OpenProjectTask = {
				id,
				subject,
				description,
				status,
				url,
				gitRepoUrl,
			}

			this.log(`[OpenProjectService] WP #${id} final task object:`, JSON.stringify(task))

			return task
		})

		return tasks
	}

	/**
	 * Update the status of a work package in OpenProject.
	 * Typically used to move a task to "In Progress" (status ID 7) after pickup.
	 *
	 * OpenProject requires a `lockVersion` in the PATCH body to prevent concurrent
	 * edit conflicts (HTTP 409). We fetch the current work package first to obtain it.
	 */
	public async updateWorkPackageStatus(
		config: OpenProjectClientConfig,
		workPackageId: number,
		statusId: number,
	): Promise<void> {
		const normalizedBaseUrl = config.baseUrl.replace(/\/+$/, "")
		const url = `${normalizedBaseUrl}/api/v3/work_packages/${workPackageId}`
		const auth = Buffer.from(`apikey:${config.apiToken}`).toString("base64")
		const authHeaders = {
			Authorization: `Basic ${auth}`,
			Accept: "application/hal+json, application/json",
		}

		// Step 1: GET the current work package to obtain lockVersion.
		this.log(`[OpenProjectService] Fetching lockVersion for WP #${workPackageId}`)
		const getResponse = await fetch(url, {
			method: "GET",
			headers: authHeaders,
		})

		if (!getResponse.ok) {
			throw new Error(
				`Failed to fetch work package ${workPackageId} for lockVersion: ${getResponse.status} ${getResponse.statusText}`,
			)
		}

		const wpData = await getResponse.json()
		const lockVersion = (wpData as any).lockVersion

		this.log(`[OpenProjectService] WP #${workPackageId} lockVersion:`, lockVersion)

		// Step 2: PATCH with the lockVersion to avoid 409 Conflict.
		const response = await fetch(url, {
			method: "PATCH",
			headers: {
				...authHeaders,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				lockVersion,
				_links: {
					status: {
						href: `/api/v3/statuses/${statusId}`,
					},
				},
			}),
		})

		if (!response.ok) {
			throw new Error(
				`Failed to update work package ${workPackageId} status: ${response.status} ${response.statusText}`,
			)
		}
	}
}
