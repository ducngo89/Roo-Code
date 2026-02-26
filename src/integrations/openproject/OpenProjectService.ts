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
	projectName?: string
	url: string
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

		// Filters: assigned_to = userIdOrMe ("me" or numeric ID), status = open ("o" operator).
		// See OpenProject API docs for /api/v3/work_packages filters.
		const filters = encodeURIComponent(
			JSON.stringify([
				{ assigned_to: { operator: "=", values: [userIdOrMe] } },
				{ status: { operator: "o", values: [""] } },
			]),
		)

		const url = `${normalizedBaseUrl}/api/v3/work_packages?filters=${filters}`

		// OpenProject typically uses Basic auth with the API token as the username and an empty password.
		const authHeader = `Basic ${Buffer.from(`${apiToken}:`).toString("base64")}`

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
			const projectName =
				wp._embedded?.project?.name ??
				(typeof wp.project === "object" && typeof wp.project.name === "string" ? wp.project.name : undefined)

			const selfHref: string | undefined = wp._links?.self?.href
			let url = ""
			try {
				// Some OpenProject installations return absolute URLs, some relative.
				url = selfHref ? new URL(selfHref, `${normalizedBaseUrl}/`).toString() : normalizedBaseUrl
			} catch {
				url = normalizedBaseUrl
			}

			return {
				id,
				subject,
				description,
				status,
				projectName,
				url,
			}
		})

		return tasks
	}
}
