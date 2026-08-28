/**
 * ask — interactive clarifying questions for specs & tasks
 *
 * Registers:
 *   - ask           : one question, multiple-choice options + free-text input
 *   - questionnaire : several questions at once (tabbed navigation)
 *   - /ask          : manual smoke test of the question UI
 *
 * Design notes (Claude Code AskUserQuestion / OpenCode Question.ask pattern):
 *   - Blocking UI: the tool call pauses the agent loop until the user answers.
 *   - Options plus a "Type something." free-text row, multi-select, skip,
 *     context notes, and number-key quick pick.
 *   - Prompt guidance teaches the model WHEN to ask: spec gaps, ambiguity,
 *     and decision points that materially change the outcome — and to batch
 *     related questions instead of asking one at a time.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	OTHER_LABEL,
	formatAnswers,
	runQuestionnaire,
	type AskQuestion,
	type AskResult,
} from "./ui";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const OptionSchema = Type.Object({
	value: Type.String({ description: "Machine-readable value returned when selected" }),
	label: Type.String({ description: "Label shown to the user" }),
	description: Type.Optional(Type.String({ description: "Optional description shown under the label" })),
});

const CommonFields = {
	context: Type.Optional(Type.String({ description: "Optional context/note shown above the question" })),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow typing a custom answer (default true)" })),
	multiSelect: Type.Optional(Type.Boolean({ description: "Allow multiple selections (default false)" })),
	required: Type.Optional(Type.Boolean({ description: "Whether the user must answer (default true)" })),
};

const AskParams = Type.Object({
	prompt: Type.String({ description: "The question to ask the user" }),
	options: Type.Optional(
		Type.Array(OptionSchema, { description: "Answer options (may be empty for free-text only)" }),
	),
	...CommonFields,
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique id for this question" }),
	label: Type.Optional(
		Type.String({ description: "Short tab label, e.g. 'Scope', 'Priority' (defaults to Q1, Q2, …)" }),
	),
	prompt: Type.String({ description: "The question text" }),
	options: Type.Optional(
		Type.Array(OptionSchema, { description: "Answer options (may be empty for free-text only)" }),
	),
	...CommonFields,
});

const QuestionnaireParams = Type.Object({
	title: Type.Optional(Type.String({ description: "Optional questionnaire title shown in the tab bar" })),
	questions: Type.Array(QuestionSchema, { description: "Questions to ask the user (2–5 recommended)" }),
});

// ---------------------------------------------------------------------------
// Result formatting for the LLM
// ---------------------------------------------------------------------------

function buildAnswerText(r: AskResult): string {
	if (r.cancelled) {
		return "User cancelled. Proceed with your best documented assumption and state it clearly.";
	}
	const lines = r.questionAnswers.map((a) => {
		if (a.skipped) return `${a.questionLabel}: user skipped`;
		const parts = a.values.map((v) =>
			v.wasCustom ? `user wrote: "${v.label}"` : `user selected: ${v.index}. ${v.label}`,
		);
		return `${a.questionLabel}: ${parts.join("; ")}`;
	});
	return lines.join("\n");
}

function nonTuiResult(questions: AskQuestion[], mode: string) {
	return {
		content: [
			{
				type: "text" as const,
				text:
					`[ask] Interactive question UI is unavailable in ${mode} mode. ` +
					`Ask the user this in plain text and wait for their answer:\n` +
					questions.map((q) => `- ${q.prompt}`).join("\n"),
			},
		],
		details: { questions, answer: null, reason: `non-tui (${mode})` },
	};
}

// ---------------------------------------------------------------------------
// Shared tool skeleton
// ---------------------------------------------------------------------------

const sharedPromptGuidelines = [
	"Use ask (or questionnaire for several at once) whenever a spec, feature request, or task has any ambiguity, gap, or decision point you cannot resolve confidently — not just when a wrong guess would be costly. When in doubt, ask: a 30-second answer beats minutes of rework.",
	"Provide 2–5 concrete options when possible; users can always type a custom answer instead.",
	"Ask about preferences, scope, constraints, or tradeoffs — never facts already present in the conversation, files, or project, and never re-ask anything already answered.",
	"When you find yourself leaning toward a guess, ask instead. Reserve silent assumptions for details so trivial that either choice is clearly fine — and always state those assumptions explicitly.",
	"If you have several questions, batch them into one questionnaire call (2–5 questions) instead of asking one at a time.",
];

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function askExtension(pi: ExtensionAPI) {
	// ---- tool: ask (single question) ---------------------------------------
	pi.registerTool({
		name: "ask",
		label: "Ask",
		description:
			"Ask the user a clarifying question with multiple-choice options and free-text input. " +
			"The terminal UI pauses the agent until the user answers. " +
			"Use whenever a spec or task has any ambiguity, gap, or decision point you cannot resolve confidently — prefer asking over guessing.",
		promptSnippet: "Ask the user a clarifying question with selectable options and free-text input",
		promptGuidelines: sharedPromptGuidelines,
		parameters: AskParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const question: AskQuestion = {
				id: "q1",
				prompt: params.prompt,
				context: params.context,
				options: params.options ?? [],
				allowOther: params.allowOther,
				multiSelect: params.multiSelect,
				required: params.required,
			};

			if (question.options.length === 0 && question.allowOther === false) {
				return {
					content: [
						{
							type: "text",
							text: "Cannot ask: no options provided and free-text input is disabled (allowOther=false).",
						},
					],
					details: { question, answer: null, error: "no options and allowOther=false" },
				};
			}

			if (ctx.mode !== "tui") {
				return nonTuiResult([question], ctx.mode);
			}

			const result = await runQuestionnaire(ctx, [question]);
			return { content: [{ type: "text", text: buildAnswerText(result) }], details: result };
		},

		renderCall(args, theme, _context) {
			const opts = Array.isArray(args.options) ? (args.options as { label: string }[]) : [];
			let text = theme.fg("toolTitle", theme.bold("ask "));
			text += theme.fg("text", String(args.prompt ?? ""));
			if (opts.length) {
				const labels = [...opts.map((o, i) => `${i + 1}. ${o.label}`), OTHER_LABEL];
				text += `\n${theme.fg("dim", "  Options: " + labels.join(", "))}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as AskResult | undefined;
			if (!details) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "", 0, 0);
			}
			if (details.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			const lines = details.questionAnswers.map((a) => {
				if (a.skipped) return theme.fg("dim", `${a.questionLabel}: skipped`);
				const parts = a.values.map((v) =>
					v.wasCustom
						? `${theme.fg("muted", "(wrote) ")}${theme.fg("accent", v.label)}`
						: `${theme.fg("success", "✓ ")}${theme.fg("accent", v.label)}`,
				);
				return `${theme.fg("dim", a.questionLabel + ": ")}${parts.join("  ")}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	// ---- tool: questionnaire (multiple questions) --------------------------
	pi.registerTool({
		name: "questionnaire",
		label: "Questionnaire",
		description:
			"Ask the user multiple questions at once, each with multiple-choice options and free-text input, " +
			"shown as a tabbed questionnaire. Use whenever a spec has several gaps or decision points to resolve " +
			"in one go — prefer asking over guessing. The terminal UI pauses the agent until the user submits.",
		promptSnippet: "Ask the user several clarifying questions at once with options and free-text input",
		promptGuidelines: sharedPromptGuidelines,
		parameters: QuestionnaireParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.questions.length === 0) {
				return {
					content: [{ type: "text", text: "Cannot ask: no questions provided." }],
					details: { questions: [], answer: null, error: "empty questions" },
				};
			}

			const questions: AskQuestion[] = params.questions.map((q) => ({
				id: q.id,
				label: q.label,
				prompt: q.prompt,
				context: q.context,
				options: q.options ?? [],
				allowOther: q.allowOther,
				multiSelect: q.multiSelect,
				required: q.required,
			}));

			if (ctx.mode !== "tui") {
				return nonTuiResult(questions, ctx.mode);
			}

			const result = await runQuestionnaire(ctx, questions, { title: params.title });
			return { content: [{ type: "text", text: buildAnswerText(result) }], details: result };
		},

		renderCall(args, theme, _context) {
			const qs = (Array.isArray(args.questions) ? args.questions : []) as {
				label?: string;
				id?: string;
			}[];
			const labels = qs.map((q) => q.label ?? q.id).filter(Boolean).join(", ");
			let text = theme.fg("toolTitle", theme.bold("questionnaire "));
			text += theme.fg("muted", `${qs.length} question${qs.length !== 1 ? "s" : ""}`);
			if (labels) text += theme.fg("dim", ` (${labels})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as AskResult | undefined;
			if (!details) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "", 0, 0);
			}
			if (details.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			const lines = details.questionAnswers.map((a) => {
				if (a.skipped)
					return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.questionLabel)}: ${theme.fg("dim", "skipped")}`;
				const parts = a.values.map((v) =>
					v.wasCustom
						? `${theme.fg("muted", "(wrote) ")}${theme.fg("accent", v.label)}`
						: `${v.index}. ${theme.fg("accent", v.label)}`,
				);
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.questionLabel)}: ${parts.join(", ")}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	// ---- command: /ask (manual UI smoke test) ------------------------------
	pi.registerCommand("ask", {
		description: "Open the interactive question UI (demo question; pass text to customize the prompt)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Interactive question UI requires TUI mode", "warning");
				return;
			}
			const result = await runQuestionnaire(ctx, [
				{
					id: "demo",
					prompt: args?.trim() || "Which database should this project use?",
					options: [
						{ value: "postgres", label: "PostgreSQL", description: "Reliable, battle-tested" },
						{ value: "sqlite", label: "SQLite", description: "Zero-config, single file" },
						{ value: "mongodb", label: "MongoDB", description: "Document store" },
					],
				},
			]);
			ctx.ui.notify(result.cancelled ? "Demo cancelled" : `Demo answered: ${formatAnswers(result)}`, "info");
		},
	});
}
