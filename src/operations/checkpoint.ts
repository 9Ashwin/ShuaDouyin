import { createHash } from "node:crypto";
import { CliError } from "../errors.ts";
import type { Plan } from "./plan.ts";

// What the caller decided about one batch, written down with its reasons.
//
// The plan says what a good candidate looks like; a checkpoint says which
// candidates met which part of that, and what to do next. Without it the only
// record of a round is what works were seen — which cannot answer whether
// anything was found, so "no progress" and "progress" look the same.
//
// Everything here is the caller's assessment. The tool checks the shape and that
// the evidence cited exists and belongs to this round; it cannot check whether
// the conclusion is true, and it does not try.

export type CriterionStatus = "supported" | "not_supported" | "unknown";
export type RouteKind = "memory" | "search" | "feed" | "person" | "relationship" | "ai_lead";
export type NextStep = "continue" | "change_route" | "finish";

const ROUTES: RouteKind[] = ["memory", "search", "feed", "person", "relationship", "ai_lead"];
const STATUSES: CriterionStatus[] = ["supported", "not_supported", "unknown"];
const NEXT: NextStep[] = ["continue", "change_route", "finish"];

export interface Evidence {
	source: string;
	entity_ref: string;
}

export interface Assessment {
	entity_ref: string;
	shortlisted: boolean;
	excluded: boolean;
	exclude_reason: string | null;
	criteria: { id: string; status: CriterionStatus; sources: Evidence[]; note: string }[];
	next_action: string | null;
}

export interface Checkpoint {
	version: 1;
	checkpoint_id: string;
	route: { kind: RouteKind; query: string | null; target: string | null; reason: string };
	observation_sources: string[];
	diagnostic_sources: string[];
	assessments: Assessment[];
	next: { step: NextStep; reason: string; query: string | null; target: string | null };
}

const ENTITY = /^(?:work|person|finding|followup):[A-Za-z0-9_-]{1,200}$/;
const EVENT = /^event:[A-Za-z0-9_-]{1,64}:[A-Za-z0-9-]{1,64}$/;

function fail(message: string, hint?: string): never {
	throw new CliError("invalid_argument", message, hint ? { hint } : undefined);
}

function list<T>(value: unknown, maximum: number, name: string): T[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) fail(`${name} must be an array`);
	if (value.length > maximum) fail(`${name} must contain at most ${maximum} entries`);
	return value as T[];
}

/**
 * Validate a checkpoint against the round's plan.
 *
 * The plan's criterion ids are the whole point of the reference: a checkpoint
 * citing a criterion the plan does not have would be evidence for a question
 * nobody asked, so that is refused rather than stored.
 */
export function parseCheckpoint(raw: unknown, plan: Plan | undefined): Checkpoint {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("Checkpoint must be a JSON object");
	const value = raw as Record<string, unknown>;
	const known = new Set([
		"version",
		"checkpoint_id",
		"route",
		"observation_sources",
		"diagnostic_sources",
		"assessments",
		"next",
	]);
	const unknown = Object.keys(value).filter((key) => !known.has(key));
	if (unknown.length) fail(`Unknown checkpoint field(s): ${unknown.join(", ")}`, `Accepted: ${[...known].join(", ")}`);
	if (value.version !== 1) fail("Checkpoint version must be 1");

	const id = typeof value.checkpoint_id === "string" ? value.checkpoint_id.trim() : "";
	if (!id || id.length > 200) fail("checkpoint_id must be 1..200 characters");

	const routeValue = value.route;
	if (!routeValue || typeof routeValue !== "object" || Array.isArray(routeValue))
		fail("route must be an object with kind and reason");
	const route = routeValue as Record<string, unknown>;
	if (!ROUTES.includes(route.kind as RouteKind)) fail(`route.kind must be one of ${ROUTES.join(", ")}`);
	const routeReason = typeof route.reason === "string" ? route.reason.trim() : "";
	if (!routeReason) fail("route.reason must say why this route was chosen");

	const observationSources = list<string>(value.observation_sources, 100, "observation_sources");
	const diagnosticSources = list<string>(value.diagnostic_sources, 20, "diagnostic_sources");
	for (const source of [...observationSources, ...diagnosticSources])
		if (typeof source !== "string" || !EVENT.test(source))
			fail(`"${String(source)}" is not an event reference`, "Use the event:<account>:<id> form a command returns.");

	const assessmentValues = list<unknown>(value.assessments, 20, "assessments");
	const criteriaIDs = new Set((plan?.criteria ?? []).map((entry) => entry.id));
	const seenEntities = new Set<string>();
	const assessments: Assessment[] = assessmentValues.map((entry, index) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(`assessments[${index}] must be an object`);
		const item = entry as Record<string, unknown>;
		const entity = typeof item.entity_ref === "string" ? item.entity_ref : "";
		if (!ENTITY.test(entity)) fail(`assessments[${index}].entity_ref must be like work:<id> or person:<id>`);
		// A batch that assesses the same entity twice is a caller bug that would
		// double-count the delivered total.
		if (seenEntities.has(entity)) fail(`assessments[${index}] assesses ${entity} more than once`);
		seenEntities.add(entity);
		const excluded = item.excluded === true;
		const excludeReason = typeof item.exclude_reason === "string" ? item.exclude_reason.trim() : "";
		// An exclusion with no reason cannot be revisited, which is the whole point
		// of recording it.
		if (excluded && !excludeReason) fail(`assessments[${index}].exclude_reason is required when excluded is true`);
		const criteriaValues = list<unknown>(item.criteria, 20, `assessments[${index}].criteria`);
		if (plan && criteriaValues.length !== plan.criteria.length)
			fail(
				`assessments[${index}].criteria must assess all ${plan.criteria.length} plan criteria`,
				"A partial assessment cannot be told apart from one that forgot a criterion.",
			);
		const criteria = criteriaValues.map((criterionValue, criterionIndex) => {
			if (!criterionValue || typeof criterionValue !== "object" || Array.isArray(criterionValue))
				fail(`assessments[${index}].criteria[${criterionIndex}] must be an object`);
			const criterion = criterionValue as Record<string, unknown>;
			const criterionID = typeof criterion.id === "string" ? criterion.id : "";
			if (plan && !criteriaIDs.has(criterionID)) fail(`criterion "${criterionID}" is not in the plan`);
			if (!STATUSES.includes(criterion.status as CriterionStatus))
				fail(`criterion "${criterionID}" status must be one of ${STATUSES.join(", ")}`);
			const sources = list<unknown>(criterion.sources, 20, `criterion ${criterionID} sources`).map((sourceValue) => {
				if (!sourceValue || typeof sourceValue !== "object" || Array.isArray(sourceValue))
					fail(`criterion "${criterionID}" sources must be objects`);
				const source = sourceValue as Record<string, unknown>;
				if (typeof source.source !== "string" || !EVENT.test(source.source))
					fail(`criterion "${criterionID}" source must be an event:<account>:<id> reference`);
				if (typeof source.entity_ref !== "string" || !ENTITY.test(source.entity_ref))
					fail(`criterion "${criterionID}" source needs an entity_ref`);
				return { source: source.source as string, entity_ref: source.entity_ref as string };
			});
			// supported and not_supported are claims about evidence; unknown is the
			// absence of one. A claim with nothing behind it is the thing this
			// command exists to stop.
			if (criterion.status !== "unknown" && !sources.length)
				fail(
					`criterion "${criterionID}" is ${String(criterion.status)} but cites no source`,
					"Use unknown when the evidence is missing rather than asserting it.",
				);
			return {
				id: criterionID,
				status: criterion.status as CriterionStatus,
				sources,
				note: typeof criterion.note === "string" ? criterion.note : "",
			};
		});
		return {
			entity_ref: entity,
			shortlisted: item.shortlisted === true,
			excluded,
			exclude_reason: excluded ? excludeReason : null,
			criteria,
			next_action: typeof item.next_action === "string" ? item.next_action : null,
		};
	});

	const nextValue = value.next;
	if (!nextValue || typeof nextValue !== "object" || Array.isArray(nextValue))
		fail("next must be an object with step and reason");
	const next = nextValue as Record<string, unknown>;
	if (!NEXT.includes(next.step as NextStep)) fail(`next.step must be one of ${NEXT.join(", ")}`);
	const nextReason = typeof next.reason === "string" ? next.reason.trim() : "";
	if (!nextReason) fail("next.reason must say why");
	// A batch with no observations and no diagnostics did not look at anything.
	// Allowing it to carry assessments would let a caller invent a batch.
	if (!observationSources.length && !diagnosticSources.length && assessments.length)
		fail(
			"A checkpoint with no sources cannot carry assessments",
			"Record what was observed, or submit an empty batch.",
		);
	if (!observationSources.length && !diagnosticSources.length && next.step !== "finish")
		fail("A checkpoint with no sources can only finish", "There is nothing to continue from.");

	return {
		version: 1,
		checkpoint_id: id,
		route: {
			kind: route.kind as RouteKind,
			query: typeof route.query === "string" ? route.query : null,
			target: typeof route.target === "string" ? route.target : null,
			reason: routeReason,
		},
		observation_sources: observationSources,
		diagnostic_sources: diagnosticSources,
		assessments,
		next: {
			step: next.step as NextStep,
			reason: nextReason,
			query: typeof next.query === "string" ? next.query : null,
			target: typeof next.target === "string" ? next.target : null,
		},
	};
}

/** A stable digest of what the caller submitted, for the idempotency check. */
export function checkpointIdentity(checkpoint: Checkpoint): string {
	return createHash("sha256").update(JSON.stringify(checkpoint)).digest("hex");
}

/** Whether this assessment is a qualified delivery under the plan. */
export function qualifies(assessment: Assessment, plan: Plan | undefined): boolean {
	if (!plan || assessment.excluded) return false;
	return plan.criteria.every((criterion) => {
		const found = assessment.criteria.find((entry) => entry.id === criterion.id);
		return found?.status === "supported" && found.sources.length > 0;
	});
}
