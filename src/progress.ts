// A write takes seconds and, until now, said nothing until it finished: a
// comment fill that stalls on the page looked exactly like a program that had
// hung. Progress goes to stderr as one JSON line per step, so stdout keeps its
// single-envelope contract and a caller that does not ask for progress is
// unaffected.

export interface Step {
	step: string;
	at: string;
	elapsed_ms: number;
	detail?: Record<string, unknown>;
}

export type Reproduce = (step: string, detail?: Record<string, unknown>) => void;

const started = new Map<string, number>();

// A no-op is the default so every operation can call it without branching.
export const quiet: Reproduce = () => undefined;

export function progressTo(write: (line: string) => unknown): Reproduce {
	const key = `${process.pid}`;
	return (step, detail) => {
		const now = Date.now();
		const began = started.get(key) ?? now;
		started.set(key, began);
		const line: Step = { step, at: new Date(now).toISOString(), elapsed_ms: now - began };
		if (detail) line.detail = detail;
		write(`${JSON.stringify({ progress: line })}\n`);
	};
}
