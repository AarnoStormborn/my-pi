/**
 * ask — interactive question UI
 *
 * Shared blocking custom component used by the `ask` and `questionnaire` tools.
 * Renders an options list with "Type something." free-text input, supporting:
 *  - single or multiple questions (tabbed navigation for >1)
 *  - single- or multi-select (Space/Enter toggle)
 *  - skip for optional questions, context notes, number-key quick pick
 *
 * The component replaces the editor until `done()` is called, which blocks the
 * agent loop — same pattern as Claude Code's AskUserQuestion / OpenCode Question.ask.
 */

import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	parseKey,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";

export interface AskOption {
	value: string;
	label: string;
	description?: string;
}

export interface AskQuestion {
	id: string;
	label?: string; // short tab label (defaults to Q1, Q2, ...)
	prompt: string; // full question text
	context?: string; // optional note shown above the question
	options: AskOption[]; // choices (may be empty for free-text only)
	allowOther?: boolean; // show "Type something." (default true)
	multiSelect?: boolean; // pick multiple (default false)
	required?: boolean; // must be answered before submit (default true)
	defaultIndex?: number; // 0-based cursor start (default 0)
}

export interface AnswerValue {
	value: string;
	label: string;
	wasCustom: boolean;
	index?: number; // 1-based option number
}

export interface QuestionAnswer {
	questionId: string;
	questionLabel: string;
	values: AnswerValue[];
	skipped: boolean;
}

export interface AskResult {
	questions: AskQuestion[];
	questionAnswers: QuestionAnswer[];
	cancelled: boolean;
	cancelledAt?: string; // question id where the user cancelled
}

export const OTHER_LABEL = "Type something.";

interface StoredAnswer {
	indices: Set<number>;
	custom?: string;
}

type Row =
	| { kind: "option"; option: AskOption; index: number }
	| { kind: "other" }
	| { kind: "skip" }
	| { kind: "done" };

export function normalizeQuestions(raw: AskQuestion[]): AskQuestion[] {
	return raw.map((q, i) => ({
		...q,
		label: q.label ?? `Q${i + 1}`,
		allowOther: q.allowOther !== false,
		multiSelect: q.multiSelect === true,
		required: q.required !== false,
		defaultIndex: q.defaultIndex ?? 0,
	}));
}

export function buildResult(questions: AskQuestion[], answers: Map<string, StoredAnswer>): AskResult {
	const questionAnswers: QuestionAnswer[] = questions.map((q) => {
		const stored = answers.get(q.id);
		const values: AnswerValue[] = [];
		if (stored) {
			for (const i of [...stored.indices].sort((a, b) => a - b)) {
				values.push({ value: q.options[i].value, label: q.options[i].label, wasCustom: false, index: i + 1 });
			}
			if (stored.custom !== undefined) {
				values.push({ value: stored.custom, label: stored.custom, wasCustom: true });
			}
		}
		return {
			questionId: q.id,
			questionLabel: q.label ?? q.id,
			values,
			skipped: !stored || values.length === 0,
		};
	});
	return { questions, questionAnswers, cancelled: false };
}

/** Compact human-readable summary, e.g. for notifications. */
export function formatAnswers(r: AskResult): string {
	if (r.cancelled) return "cancelled";
	const lines = r.questionAnswers.map((a) => {
		if (a.skipped) return `${a.questionLabel}: skipped`;
		const parts = a.values.map((v) => (v.wasCustom ? `(wrote) ${v.label}` : `${v.index}. ${v.label}`));
		return `${a.questionLabel}: ${parts.join(", ")}`;
	});
	return lines.join(" · ") || "no answers";
}

export interface QuestionnaireOptions {
	title?: string;
}

export async function runQuestionnaire(
	ctx: ExtensionContext,
	raw: AskQuestion[],
	opts?: QuestionnaireOptions,
): Promise<AskResult> {
	const questions = normalizeQuestions(raw);
	const cancelledResult: AskResult = { questions, questionAnswers: [], cancelled: true };

	if (ctx.mode !== "tui") return cancelledResult;

	const title = opts?.title;
	const isMulti = questions.length > 1;
	const tabCount = isMulti ? questions.length + 1 : 1; // questions + Submit tab

	const result = await ctx.ui.custom<AskResult>((tui, theme, _kb, done) => {
		// ---- state ----
		let currentTab = 0;
		let optionIndex = 0;
		let editId: string | null = null;
		let cachedLines: string[] | undefined;
		const answers = new Map<string, StoredAnswer>();

		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		const editor = new Editor(tui, editorTheme);

		// ---- helpers ----
		function currentQuestion(): AskQuestion | undefined {
			return isMulti && currentTab === questions.length ? undefined : questions[currentTab];
		}

		function stored(id: string): StoredAnswer {
			let s = answers.get(id);
			if (!s) {
				s = { indices: new Set() };
				answers.set(id, s);
			}
			return s;
		}

		function rowsFor(q: AskQuestion): Row[] {
			const rows: Row[] = q.options.map((option, index) => ({ kind: "option", option, index }));
			if (q.allowOther) rows.push({ kind: "other" });
			if (!q.required) rows.push({ kind: "skip" });
			if (q.multiSelect) rows.push({ kind: "done" });
			return rows;
		}

		function isAnswered(q: AskQuestion): boolean {
			const s = answers.get(q.id);
			return !!s && (s.indices.size > 0 || (s.custom !== undefined && s.custom.length > 0));
		}

		function doneValid(q: AskQuestion): boolean {
			return !q.required || isAnswered(q);
		}

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function submit(cancelled: boolean, atId?: string) {
			if (cancelled) {
				done({ questions, questionAnswers: [], cancelled: true, cancelledAt: atId });
				return;
			}
			done(buildResult(questions, answers));
		}

		function goToTab(t: number) {
			currentTab = t;
			const qq = currentQuestion();
			optionIndex = qq ? Math.max(0, Math.min(qq.defaultIndex ?? 0, rowsFor(qq).length - 1)) : 0;
			editId = qq && qq.options.length === 0 && qq.allowOther ? qq.id : null;
			if (editId) editor.setText(stored(editId).custom ?? "");
			refresh();
		}

		function advance() {
			if (!isMulti) {
				submit(false);
				return;
			}
			if (currentTab < questions.length - 1) goToTab(currentTab + 1);
			else goToTab(questions.length);
		}

		function selectSingle(q: AskQuestion, i: number) {
			const s = stored(q.id);
			s.indices.clear();
			s.indices.add(i);
			s.custom = undefined;
			advance();
		}

		function toggle(q: AskQuestion, i: number) {
			const s = stored(q.id);
			if (s.indices.has(i)) s.indices.delete(i);
			else s.indices.add(i);
			refresh();
		}

		// ---- editor submit (free-text answer) ----
		editor.onSubmit = (value) => {
			if (!editId) return;
			const qq = questions.find((x) => x.id === editId);
			if (!qq) {
				editId = null;
				refresh();
				return;
			}
			const s = stored(qq.id);
			const trimmed = value.trim();
			if (trimmed) {
				s.custom = trimmed;
				s.indices.clear();
				editId = null;
				editor.setText("");
				if (qq.multiSelect) refresh();
				else advance();
			} else {
				// empty submit → back to options
				s.custom = undefined;
				editId = null;
				editor.setText("");
				refresh();
			}
		};

		// ---- input ----
		function handleInput(data: string) {
			if (editId) {
				if (matchesKey(data, Key.escape)) {
					editId = null;
					editor.setText("");
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			const qq = currentQuestion();

			if (isMulti) {
				if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
					goToTab((currentTab + 1) % tabCount);
					return;
				}
				if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
					goToTab((currentTab - 1 + tabCount) % tabCount);
					return;
				}
			}

			// submit tab (multi-question only)
			if (isMulti && currentTab === questions.length) {
				if (matchesKey(data, Key.enter)) {
					const missing = questions.filter((x) => x.required && !isAnswered(x));
					if (missing.length === 0) submit(false);
					else refresh();
				} else if (matchesKey(data, Key.escape)) {
					submit(true);
				}
				return;
			}

			if (!qq) return;
			const rows = rowsFor(qq);
			if (rows.length === 0) return;

			if (matchesKey(data, Key.up)) {
				optionIndex = Math.max(0, optionIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = Math.min(rows.length - 1, optionIndex + 1);
				refresh();
				return;
			}

			// number keys: pick / toggle option directly
			const pk = parseKey(data);
			if (pk && /^[1-9]$/.test(pk)) {
				const i = Number(pk) - 1;
				if (i < qq.options.length) {
					if (qq.multiSelect) toggle(qq, i);
					else selectSingle(qq, i);
				}
				return;
			}

			if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
				const row = rows[optionIndex];
				if (!row) return;
				if (row.kind === "other") {
					editId = qq.id;
					editor.setText(stored(qq.id).custom ?? "");
					refresh();
					return;
				}
				if (row.kind === "skip") {
					if (isMulti) advance();
					else submit(false); // single question: user chose not to answer
					return;
				}
				if (row.kind === "done") {
					if (doneValid(qq)) advance();
					else refresh();
					return;
				}
				if (row.kind === "option") {
					if (qq.multiSelect) toggle(qq, row.index);
					else selectSingle(qq, row.index);
				}
				return;
			}

			if (matchesKey(data, Key.escape)) submit(true, qq.id);
		}

		// ---- render ----
		function render(width: number): string[] {
			if (cachedLines) return cachedLines;

			const lines: string[] = [];
			const renderWidth = Math.max(1, width);

			function addWrapped(text: string) {
				lines.push(...wrapTextWithAnsi(text, renderWidth));
			}

			function addWrappedWithPrefix(prefix: string, text: string) {
				const prefixWidth = visibleWidth(prefix);
				if (prefixWidth >= renderWidth) {
					addWrapped(prefix + text);
					return;
				}
				const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
				const continuationPrefix = " ".repeat(prefixWidth);
				for (let i = 0; i < wrapped.length; i++) {
					lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
				}
			}

			lines.push(theme.fg("accent", "─".repeat(renderWidth)));

			if (title) {
				addWrappedWithPrefix(" ", theme.fg("accent", theme.bold(title)));
				lines.push("");
			}

			// tab bar (multi-question only)
			if (isMulti) {
				const tabs: string[] = [];
				for (let i = 0; i < questions.length; i++) {
					const active = i === currentTab;
					const answered = isAnswered(questions[i]);
					const box = answered ? "■" : "□";
					const color: ThemeColor = answered ? "success" : "muted";
					const text = ` ${box} ${questions[i].label} `;
					tabs.push(`${active ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(color, text)} `);
				}
				const submitActive = currentTab === questions.length;
				const allDone = questions.every((x) => doneValid(x));
				const submitText = " ✓ Submit ";
				tabs.push(
					submitActive
						? theme.bg("selectedBg", theme.fg("text", submitText))
						: theme.fg(allDone ? "success" : "dim", submitText),
				);
				addWrappedWithPrefix(" ", tabs.join(""));
				lines.push("");
			}

			const qq = currentQuestion();
			const editingThis = editId !== null && qq !== undefined && editId === qq.id;
			const submitTab = isMulti && currentTab === questions.length;

			if (submitTab) {
				addWrappedWithPrefix(" ", theme.fg("accent", theme.bold("Ready to submit")));
				lines.push("");
				for (const q of questions) {
					const a = answers.get(q.id);
					let summary: string;
					if (!a || (a.indices.size === 0 && a.custom === undefined)) {
						summary = theme.fg("dim", `${q.label}: (skipped)`);
					} else {
						const parts: string[] = [];
						for (const i of [...a.indices].sort((x, y) => x - y)) {
							parts.push(`${i + 1}. ${q.options[i].label}`);
						}
						if (a.custom !== undefined) parts.push(`(wrote) ${a.custom}`);
						summary = `${theme.fg("muted", `${q.label}: `)}${theme.fg("text", parts.join(", "))}`;
					}
					addWrappedWithPrefix(" ", summary);
				}
				lines.push("");
				const missing = questions.filter((x) => x.required && !isAnswered(x));
				if (missing.length > 0) {
					addWrappedWithPrefix(
						" ",
						theme.fg("warning", `Unanswered: ${missing.map((x) => x.label).join(", ")}`),
					);
				} else {
					addWrappedWithPrefix(" ", theme.fg("success", "Press Enter to submit"));
				}
			} else if (qq) {
				if (qq.context) {
					addWrappedWithPrefix(" ", theme.fg("muted", qq.context));
					lines.push("");
				}
				addWrappedWithPrefix(" ", theme.fg("text", qq.prompt));
				lines.push("");

				const rows = rowsFor(qq);
				for (let i = 0; i < rows.length; i++) {
					const row = rows[i];
					const selected = i === optionIndex;
					const prefix = selected ? theme.fg("accent", "> ") : "  ";
					let label: string;
					let color: ThemeColor = "text";

					if (row.kind === "option") {
						if (qq.multiSelect) {
							const checked = stored(qq.id).indices.has(row.index);
							label = `${checked ? "[x]" : "[ ]"} ${row.index + 1}. ${row.option.label}`;
							color = checked ? "success" : selected ? "accent" : "text";
						} else {
							label = `${row.index + 1}. ${row.option.label}`;
							color = selected ? "accent" : "text";
						}
						addWrappedWithPrefix(prefix, theme.fg(color, label));
						if (row.option.description) {
							addWrappedWithPrefix("     ", theme.fg("muted", row.option.description));
						}
					} else if (row.kind === "other") {
						const custom = stored(qq.id).custom;
						if (custom !== undefined) {
							label = `✎ ${custom}`;
							color = "accent";
						} else {
							label = qq.multiSelect ? "[ ] Type something." : OTHER_LABEL;
							color = selected ? "accent" : "text";
						}
						if (editingThis) {
							label += " ✎";
							color = "accent";
						}
						addWrappedWithPrefix(prefix, theme.fg(color, label));
					} else if (row.kind === "skip") {
						label = "— Skip (no answer)";
						color = selected ? "warning" : "dim";
						addWrappedWithPrefix(prefix, theme.fg(color, label));
					} else if (row.kind === "done") {
						const s = stored(qq.id);
						const n = s.indices.size + (s.custom !== undefined ? 1 : 0);
						label = n > 0 ? `✓ Done (${n} selected)` : "✓ Done";
						color = doneValid(qq) ? (selected ? "accent" : "success") : "dim";
						addWrappedWithPrefix(prefix, theme.fg(color, label));
						if (!doneValid(qq) && selected) {
							addWrappedWithPrefix("     ", theme.fg("warning", "Select at least one option"));
						}
					}
				}

				if (editingThis) {
					lines.push("");
					addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
					for (const line of editor.render(Math.max(1, renderWidth - 2))) {
						lines.push(` ${line}`);
					}
				}
			}

			lines.push("");
			if (editingThis) {
				addWrappedWithPrefix(" ", theme.fg("dim", "Enter to submit • Esc to go back"));
			} else if (submitTab) {
				addWrappedWithPrefix(" ", theme.fg("dim", "Enter to submit • Esc to cancel"));
			} else {
				const parts = [
					isMulti ? "Tab/←→ navigate" : "",
					"↑↓ move",
					qq?.multiSelect ? "Space/Enter toggle" : "Enter select",
					qq && qq.options.length > 0 ? "1-9 pick" : "",
					"Esc cancel",
				].filter(Boolean);
				addWrappedWithPrefix(" ", theme.fg("dim", parts.join(" • ")));
			}
			lines.push(theme.fg("accent", "─".repeat(renderWidth)));

			cachedLines = lines;
			return lines;
		}

		// open editor immediately for free-text-only questions
		const first = questions[0];
		if (first && first.options.length === 0 && first.allowOther) {
			editId = first.id;
			editor.setText("");
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	});

	return result ?? cancelledResult;
}
