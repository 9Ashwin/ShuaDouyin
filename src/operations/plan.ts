import { CliError } from "../errors.ts";

// What this round is for, in a shape a caller can check afterwards.
//
// A round used to record only a budget: how many works, how many minutes. That
// says when to stop but not what was being looked for, so "done" was whatever
// the caller felt like, and an interrupted round could not be resumed without
// the previous session's conversation.
//
// The plan is written once and never edited. Changing what counts as done
// halfway through is how a caller that is not finding anything quietly lowers
// the bar, so a different plan needs a different round.

export type Mode = "research" | "people" | "followup" | "explore";
export type Unit = "person" | "finding" | "work" | "followup";

const MODES: Mode[] = ["research", "people", "followup", "explore"];
const UNITS: Unit[] = ["person", "finding", "work", "followup"];

export interface Criterion {
	id: string;
	description: string;
}

export interface PlanPolicy {
	batch_size: number;
	max_inspections_per_batch: number;
	max_no_progress_batches: number;
	max_route_changes: number;
	max_browser_calls: number;
}

export interface Plan {
	version: 1;
	mode: Mode;
	objective: string;
	deliverable: { unit: Unit; target: number };
	criteria: Criterion[];
	constraints: string[];
	policy: PlanPolicy;
}

const TEXT_LIMIT = 2000;

function bounded(value: unknown, minimum: number, maximum: number, name: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum)
		throw new CliError("invalid_argument", `${name} must be an integer from ${minimum} to ${maximum}`);
	return value;
}

function text(value: unknown, name: string, limit = TEXT_LIMIT): string {
	if (typeof value !== "string" || !value.trim())
		throw new CliError("invalid_argument", `${name} must be a non-empty string`);
	if (Array.from(value).length > limit)
		throw new CliError("invalid_argument", `${name} must be at most ${limit} characters`);
	return value.trim();
}

/**
 * Validate a plan document.
 *
 * Every field is checked before anything is stored. An unknown key is refused
 * rather than ignored: a caller that misspells `max_route_changes` would
 * otherwise get a round that silently uses the default and never changes route,
 * and nothing in the output would say why.
 */
export function parsePlan(raw: unknown): Plan {
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		throw new CliError("invalid_argument", "Plan must be a JSON object");
	const value = raw as Record<string, unknown>;
	const known = new Set(["version", "mode", "objective", "deliverable", "criteria", "constraints", "policy"]);
	const unknown = Object.keys(value).filter((key) => !known.has(key));
	if (unknown.length)
		throw new CliError("invalid_argument", `Unknown plan field(s): ${unknown.join(", ")}`, {
			hint: `Accepted fields are ${[...known].join(", ")}`,
		});
	if (value.version !== 1)
		throw new CliError("invalid_argument", "Plan version must be 1", {
			hint: "A plan from another version is not readable here; write a new one.",
		});
	if (!MODES.includes(value.mode as Mode))
		throw new CliError("invalid_argument", `mode must be one of ${MODES.join(", ")}`);
	const objective = text(value.objective, "objective");

	const deliverable = value.deliverable;
	if (!deliverable || typeof deliverable !== "object" || Array.isArray(deliverable))
		throw new CliError("invalid_argument", "deliverable must be an object with unit and target");
	const unit = (deliverable as Record<string, unknown>).unit;
	if (!UNITS.includes(unit as Unit))
		throw new CliError("invalid_argument", `deliverable.unit must be one of ${UNITS.join(", ")}`);
	const target = bounded((deliverable as Record<string, unknown>).target, 1, 100, "deliverable.target");

	if (!Array.isArray(value.criteria) || value.criteria.length < 1 || value.criteria.length > 10)
		throw new CliError("invalid_argument", "criteria must contain 1 to 10 entries");
	const seen = new Set<string>();
	const criteria: Criterion[] = value.criteria.map((entry, index) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry))
			throw new CliError("invalid_argument", `criteria[${index}] must be an object`);
		const item = entry as Record<string, unknown>;
		// An id is what a checkpoint cites later, so it has to be usable as a
		// reference: unique within the plan and stable across a resume.
		const id = text(item.id, `criteria[${index}].id`, 64);
		if (seen.has(id)) throw new CliError("invalid_argument", `criteria id "${id}" appears more than once`);
		seen.add(id);
		return { id, description: text(item.description, `criteria[${index}].description`) };
	});

	const constraints = value.constraints ?? [];
	if (!Array.isArray(constraints) || constraints.length > 20)
		throw new CliError("invalid_argument", "constraints must be an array of at most 20 strings");
	const constraintList = constraints.map((entry, index) => text(entry, `constraints[${index}]`));

	const rawPolicy = value.policy;
	if (!rawPolicy || typeof rawPolicy !== "object" || Array.isArray(rawPolicy))
		throw new CliError("invalid_argument", "policy must be an object");
	const policyValue = rawPolicy as Record<string, unknown>;
	const batch = bounded(policyValue.batch_size, 1, 20, "policy.batch_size");
	const policy: PlanPolicy = {
		batch_size: batch,
		// Inspecting more than the batch means inspecting something twice.
		max_inspections_per_batch: bounded(
			policyValue.max_inspections_per_batch,
			0,
			batch,
			"policy.max_inspections_per_batch",
		),
		max_no_progress_batches: bounded(policyValue.max_no_progress_batches, 1, 10, "policy.max_no_progress_batches"),
		max_route_changes: bounded(policyValue.max_route_changes, 0, 10, "policy.max_route_changes"),
		max_browser_calls: bounded(policyValue.max_browser_calls, 1, 1000, "policy.max_browser_calls"),
	};

	return {
		version: 1,
		mode: value.mode as Mode,
		objective,
		deliverable: { unit: unit as Unit, target },
		criteria,
		constraints: constraintList,
		policy,
	};
}

/**
 * A canonical string for comparing two plans.
 *
 * Key order does not matter — JSON produced by two different writers is the same
 * plan — but criterion ids and their text are part of the identity: adding,
 * removing or rewording a criterion is a different round, not a resume.
 */
export function planIdentity(plan: Plan): string {
	return JSON.stringify({
		version: plan.version,
		mode: plan.mode,
		objective: plan.objective,
		deliverable: plan.deliverable,
		criteria: plan.criteria
			.map((entry) => [entry.id, entry.description])
			.sort((left, right) => (left[0] ?? "").localeCompare(right[0] ?? "")),
		constraints: plan.constraints,
		policy: plan.policy,
	});
}
