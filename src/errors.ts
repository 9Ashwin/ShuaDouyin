export type ErrorType = "validation" | "authentication" | "browser" | "state" | "execution" | "internal";

export class CliError extends Error {
	readonly code: string;
	readonly type: ErrorType;
	readonly hint: string;
	readonly details?: unknown;

	constructor(code: string, message: string, options: { hint?: string; details?: unknown; cause?: unknown } = {}) {
		super(message, { cause: options.cause });
		this.name = "CliError";
		this.code = code;
		this.type = category(code);
		this.hint = options.hint ?? "";
		this.details = options.details;
	}
}

function category(code: string): ErrorType {
	if (code === "invalid_argument") return "validation";
	if (code === "login_required" || code === "verification_required") return "authentication";
	if (["browser_not_running", "browser_unavailable", "chrome_not_found", "timeout"].includes(code)) return "browser";
	if (["delivery_uncertain", "decision_uncertain", "idempotency_conflict", "network_unavailable"].includes(code))
		return "execution";
	if (
		[
			"selector_changed",
			"recipient_unavailable",
			"identity_mismatch",
			"draft_conflict",
			"busy",
			"state_corrupt",
			"not_found",
			"unsupported_page",
			"unsupported_media",
			"editor_not_ready",
			"already_exists",
			"revision_required",
			"revision_conflict",
			// The bot has no persona yet. This is the installation's own state, not a
			// failure of the command, and it is answered by asking the owner.
			"setup_required",
			"account_mismatch",
			"migration_pending",
			// A gate that refused because of the installation's own recorded
			// state: paused, quota reached. Not an internal failure.
			"state",
		].includes(code)
	)
		return "state";
	return "internal";
}

export function normalizeError(error: unknown): CliError {
	if (error instanceof CliError) return error;
	if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
		return new CliError(error.name === "AbortError" ? "cancelled" : "timeout", error.message, { cause: error });
	return new CliError("internal", error instanceof Error ? error.message : "Unexpected local failure", {
		cause: error,
	});
}

export function errorExit(error: CliError): number {
	if (error.code === "cancelled") return 130;
	switch (error.type) {
		case "validation":
			return 2;
		case "authentication":
			return 3;
		case "browser":
			return 4;
		case "state":
			return 5;
		case "execution":
			return 6;
		default:
			return 1;
	}
}

export function errorData(error: unknown) {
	const problem = normalizeError(error);
	return {
		type: problem.type,
		code: problem.code,
		message: problem.message,
		...(problem.hint ? { hint: problem.hint } : {}),
		retryable: false,
		...(problem.details === undefined ? {} : { details: problem.details }),
	};
}

export function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
