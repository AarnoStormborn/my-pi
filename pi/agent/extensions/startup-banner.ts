import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { VERSION, APP_NAME } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import * as https from "node:https";

const DEFAULT_SVG_URL = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/pi-coding-agent.svg";
const SVG_LOCAL_PATH = path.join(homedir(), ".pi", "agent", "pi-coding-agent.svg");

// 4x4 matrix representation from the official Pi SVG vector geometry
const DEFAULT_PI_MATRIX = [
	[1, 1, 1, 0],
	[1, 0, 1, 0],
	[1, 1, 0, 1],
	[1, 0, 0, 1],
];

/**
 * Ensures SVG exists locally
 */
async function ensureSvgFile(): Promise<string> {
	if (fs.existsSync(SVG_LOCAL_PATH)) {
		try {
			return fs.readFileSync(SVG_LOCAL_PATH, "utf-8");
		} catch {
			// fallback
		}
	}

	return new Promise((resolve) => {
		https.get(DEFAULT_SVG_URL, (res) => {
			let data = "";
			res.on("data", (chunk) => (data += chunk));
			res.on("end", () => {
				try {
					fs.mkdirSync(path.dirname(SVG_LOCAL_PATH), { recursive: true });
					fs.writeFileSync(SVG_LOCAL_PATH, data, "utf-8");
				} catch {
					// ignore
				}
				resolve(data);
			});
		}).on("error", () => {
			resolve("");
		});
	});
}

/**
 * Parses SVG vector paths into terminal pixel blocks
 */
function parseSvgToAscii(svgContent: string): string[] {
	const matrix = DEFAULT_PI_MATRIX;
	const charWidth = 4;
	const lines: string[] = [];

	for (let r = 0; r < matrix.length; r++) {
		const row = matrix[r].map((cell) => (cell ? "█".repeat(charWidth) : " ".repeat(charWidth))).join("");
		lines.push(row);
		lines.push(row);
	}

	return lines;
}

function getGitBranch(cwd: string): { branch: string; isDirty: boolean } | null {
	try {
		const branch = execSync("git rev-parse --abbrev-ref HEAD", {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
			encoding: "utf-8",
		}).trim();
		if (!branch) return null;

		let isDirty = false;
		try {
			const status = execSync("git status --porcelain", {
				cwd,
				stdio: ["ignore", "pipe", "ignore"],
				encoding: "utf-8",
			}).trim();
			isDirty = status.length > 0;
		} catch {
			// ignore
		}

		return { branch, isDirty };
	} catch {
		return null;
	}
}

function formatCwd(cwd: string): string {
	const home = homedir();
	if (cwd === home) return "~";
	if (cwd.startsWith(home)) {
		return `~${cwd.slice(home.length)}`;
	}
	return cwd;
}

interface McpServerInfo {
	name: string;
	enabled: boolean;
}

/**
 * Shrink a provider/model string to its last 2 slash-separated terms.
 * e.g. `commandcode/google/gemini-3.7-flash` -> `google/gemini-3.7-flash`
 */
function shortenModel(modelStr: string): string {
	const parts = modelStr.split("/");
	if (parts.length <= 2) return modelStr;
	return parts.slice(-2).join("/");
}

/** Compact token formatting (matches Pi footer style: 12.3k, 245k, 1.2M). */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

interface SessionUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

/** Sum token/cost usage across all session entries (mirrors Pi footer logic). */
function getSessionUsageTotals(ctx: ExtensionContext): SessionUsageTotals | null {
	const totals: SessionUsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let found = false;

	for (const entry of ctx.sessionManager.getEntries()) {
		let usage: any;
		if (entry.type === "message" && (entry as any).message?.role === "assistant") {
			usage = (entry as any).message.usage;
		} else if (entry.type === "message" && (entry as any).message?.role === "toolResult" && (entry as any).message?.usage) {
			usage = (entry as any).message.usage;
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && (entry as any).usage) {
			usage = (entry as any).usage;
		}
		if (!usage) continue;
		found = true;
		totals.input += usage.input || 0;
		totals.output += usage.output || 0;
		totals.cacheRead += usage.cacheRead || 0;
		totals.cacheWrite += usage.cacheWrite || 0;
		totals.cost += usage.cost?.total || 0;
	}

	return found ? totals : null;
}

/** Human label for Pi harness run modes. */
function formatMode(mode: string): string {
	switch (mode) {
		case "tui":
			return "interactive";
		case "rpc":
			return "rpc";
		case "json":
			return "json";
		case "print":
			return "print";
		default:
			return mode;
	}
}

function getMcpServers(cwd: string): McpServerInfo[] {
	const servers: McpServerInfo[] = [];
	try {
		const adapterPath = path.join(homedir(), ".pi", "agent", "npm", "node_modules", "pi-mcp-adapter", "dist", "config.js");
		if (fs.existsSync(adapterPath)) {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const { loadMcpConfig } = require(adapterPath);
			const config = loadMcpConfig(undefined, cwd);
			if (config && config.mcpServers) {
				for (const [name, def] of Object.entries(config.mcpServers as Record<string, { disabled?: boolean }>)) {
					servers.push({
						name,
						enabled: def && def.disabled !== true,
					});
				}
			}
		}
	} catch {
		// Fallback: check cache file
		try {
			const cachePath = path.join(homedir(), ".pi", "agent", "mcp-cache.json");
			if (fs.existsSync(cachePath)) {
				const cache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
				if (cache && cache.servers) {
					for (const name of Object.keys(cache.servers)) {
						servers.push({ name, enabled: true });
					}
				}
			}
		} catch {
			// ignore
		}
	}
	return servers;
}

function padAnsi(str: string, targetWidth: number): string {
	const vis = visibleWidth(str);
	if (vis >= targetWidth) {
		return sliceByColumn(str, 0, targetWidth, true);
	}
	return str + " ".repeat(targetWidth - vis);
}

export default function (pi: ExtensionAPI) {
	let bannerMode: "sticky-top" | "header" = "sticky-top";
	let svgLogoLines: string[] = [];
	let activeOverlayHandle: { hide: () => void; isHidden: () => boolean } | null = null;
	let overlayTui: any = null;
	let mcpPollTimer: ReturnType<typeof setInterval> | null = null;
	let lastMcpSnapshot = "";

	/** Snapshot of MCP enabled/disabled state (name sorted) for change detection. */
	function mcpSnapshotKey(ctx: ExtensionContext): string {
		return getMcpServers(ctx.cwd)
			.map((s) => `${s.name}:${s.enabled ? 1 : 0}`)
			.sort()
			.join("|");
	}

	function stopMcpPolling() {
		if (mcpPollTimer) {
			clearInterval(mcpPollTimer);
			mcpPollTimer = null;
		}
	}

	/** Poll MCP state and re-render the banner when the list changes
	 *  (e.g. after `/mcp disable` / `/mcp enable`). */
	function startMcpPolling(ctx: ExtensionContext) {
		stopMcpPolling();
		lastMcpSnapshot = mcpSnapshotKey(ctx);
		mcpPollTimer = setInterval(() => {
			if (!overlayTui) return;
			const snapshot = mcpSnapshotKey(ctx);
			if (snapshot !== lastMcpSnapshot) {
				lastMcpSnapshot = snapshot;
				overlayTui.requestRender();
			}
		}, 2000);
	}

	function buildBannerLines(ctx: ExtensionContext, theme: Theme, width: number): string[] {
		if (svgLogoLines.length === 0) {
			if (fs.existsSync(SVG_LOCAL_PATH)) {
				try {
					const svg = fs.readFileSync(SVG_LOCAL_PATH, "utf-8");
					svgLogoLines = parseSvgToAscii(svg);
				} catch {
					svgLogoLines = parseSvgToAscii("");
				}
			} else {
				svgLogoLines = parseSvgToAscii("");
			}
		}

		// Responsive fallback for very narrow terminals
		if (width < 50) {
			return [
				`${theme.bold(theme.fg("accent", APP_NAME))} ${theme.fg("dim", `v${VERSION}`)}`,
				theme.fg("muted", formatCwd(ctx.cwd)),
				theme.fg("dim", "─".repeat(width)),
			];
		}

		const gitInfo = getGitBranch(ctx.cwd);
		const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
		const thinkingLevel = ctx.thinkingLevel ? ` (${ctx.thinkingLevel})` : "";
		const formattedCwd = formatCwd(ctx.cwd);

		const gitText = gitInfo
			? `${theme.fg("success", gitInfo.branch)}${gitInfo.isDirty ? "" : theme.fg("dim", " (clean)")}`
			: theme.fg("dim", "not a git repo");

		// Session stats: usage totals + context usage + run mode
		const usageTotals = getSessionUsageTotals(ctx);
		const contextUsage = ctx.getContextUsage ? ctx.getContextUsage() : undefined;
		const contextWindow = contextUsage?.contextWindow ?? 0;
		const contextTokens = contextUsage?.tokens ?? null;
		const contextPercent =
			contextUsage?.percent !== undefined && contextUsage?.percent !== null
				? `${contextUsage.percent.toFixed(1)}%`
				: "?";
		const contextDisplay = contextWindow > 0
			? `${contextPercent} / ${formatTokens(contextWindow)}${contextUsage?.tokens === null ? " (compacted)" : ""}`
			: contextPercent;

		// Compact usage line: ↑input ↓output Rcache (Wcache) $cost
		const usageParts: string[] = [];
		if (usageTotals) {
			if (usageTotals.input || usageTotals.output) {
				usageParts.push(
					`↑${formatTokens(usageTotals.input)} · ↓${formatTokens(usageTotals.output)}`,
				);
			}
			if (usageTotals.cacheRead > 0) usageParts.push(`R${formatTokens(usageTotals.cacheRead)}`);
			if (usageTotals.cacheWrite > 0) usageParts.push(`W${formatTokens(usageTotals.cacheWrite)}`);
			if (usageTotals.cost > 0) usageParts.push(`$${usageTotals.cost.toFixed(3)}`);
		}
		const usageDisplay = usageParts.length > 0 ? usageParts.join(" ") : theme.fg("dim", "—");

		// Column 2: Session & Model Details
		const detailsColumnLines = [
			`${theme.bold(theme.fg("accent", "Pi Coding Agent"))}  ${theme.fg("dim", `v${VERSION}`)}`,
			"",
			`${theme.fg("muted", "Directory:")}  ${theme.fg("accent", formattedCwd)}`,
			`${theme.fg("muted", "Git:")}        ${gitText}`,
			`${theme.fg("muted", "Model:")}      ${theme.bold(shortenModel(currentModel))}${theme.fg("dim", thinkingLevel)}`,
			`${theme.fg("muted", "Context:")}    ${contextDisplay}`,
			`${theme.fg("muted", "Usage:")}      ${usageDisplay}`,
			`${theme.fg("muted", "Mode:")}       ${theme.fg("accent", formatMode(ctx.mode))}`,
			"",
			theme.fg("dim", "Type / for commands, ! for shell, Ctrl+C to clear"),
		];

		// Column 3: MCP Servers (up to 5 servers)
		const mcpServers = getMcpServers(ctx.cwd).slice(0, 5);
		const mcpColumnLines: string[] = [
			theme.bold(theme.fg("muted", "MCP Servers")),
			"",
		];

		if (mcpServers.length === 0) {
			mcpColumnLines.push(theme.fg("dim", "No servers configured"));
		} else {
			for (const server of mcpServers) {
				const dot = server.enabled ? theme.fg("success", "●") : theme.fg("error", "○");
				const statusText = server.enabled ? theme.fg("success", "enabled") : theme.fg("error", "disabled");
				mcpColumnLines.push(`${dot} ${server.name} ${theme.fg("dim", `(${statusText})`)}`);
			}
		}

		const maxLines = Math.max(svgLogoLines.length, detailsColumnLines.length, mcpColumnLines.length);
		const lines: string[] = [""];

		// Vertically center the 8-row logo within the taller banner columns
		// (adds padding from the top so the logo is centered, not top-aligned)
		const logoRows = svgLogoLines.length;
		const logoTopPad = maxLines > logoRows ? Math.floor((maxLines - logoRows) / 2) : 0;

		// Column width allocations (Column 1: tight ~24 columns with centered logo; Column 3: MCP ~33% width)
		const hasMcpColumn = width >= 90;
		const logoColWidth = Math.min(26, Math.max(20, Math.floor(width * 0.24)));
		const mcpWidth = hasMcpColumn ? Math.min(36, Math.floor(width * 0.33)) : 0;
		const detailsWidth = hasMcpColumn
			? Math.max(20, width - logoColWidth - mcpWidth - 8)
			: Math.max(20, width - logoColWidth - 4);

		// Calculate horizontal padding to center the 16-character logo inside logoColWidth
		const logoContentWidth = 16;
		const leftPad = Math.max(2, Math.floor((logoColWidth - logoContentWidth) / 2));

		for (let i = 0; i < maxLines; i++) {
			const logoIndex = i - logoTopPad;
			const rawLogo =
				logoIndex >= 0 && logoIndex < svgLogoLines.length ? svgLogoLines[logoIndex] : "                ";
			const centeredLogo = " ".repeat(leftPad) + theme.fg("accent", rawLogo);
			const paddedLogo = padAnsi(centeredLogo, logoColWidth);
			const paddedDetails = padAnsi(detailsColumnLines[i] || "", detailsWidth);

			if (hasMcpColumn) {
				const paddedMcp = padAnsi(mcpColumnLines[i] || "", mcpWidth);
				lines.push(`${paddedLogo}  │  ${paddedDetails}  │  ${paddedMcp}`);
			} else {
				lines.push(`${paddedLogo}  │  ${paddedDetails}`);
			}
		}

		// Horizontal ruler line extending all the way to the terminal width
		lines.push(theme.fg("dim", "─".repeat(width)));
		lines.push("");

		return lines;
	}

	function applyBanner(ctx: ExtensionContext) {
		if (ctx.mode !== "tui") return;

		// Clean up any existing overlay
		if (activeOverlayHandle) {
			try {
				activeOverlayHandle.hide();
			} catch {
				// ignore
			}
			activeOverlayHandle = null;
		}

		if (bannerMode === "sticky-top") {
			// Clear normal scrollable header
			ctx.ui.setHeader(undefined);

			// Render as nonCapturing overlay anchored at top of terminal screen
			void ctx.ui.custom(
				(tui, theme, _kb, _done) => {
					overlayTui = tui;
					return {
						render(width: number) {
							return buildBannerLines(ctx, theme, width);
						},
						invalidate() {},
					};
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "top-center",
						row: 0,
						col: 0,
						width: "100%",
						nonCapturing: true,
					},
					onHandle: (handle) => {
						activeOverlayHandle = handle;
					},
				},
			);

			// Watch MCP server list so enable/disable toggles refresh the banner
			startMcpPolling(ctx);
		} else {
			// Header mode (scrolls with transcript)
			stopMcpPolling();
			ctx.ui.setHeader((_tui, theme: Theme) => {
				return {
					render(width: number): string[] {
						return buildBannerLines(ctx, theme, width);
					},
					invalidate() {},
				};
			});
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		await ensureSvgFile();
		applyBanner(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		if (overlayTui) {
			overlayTui.requestRender();
		}
	});

	// Refresh stats (usage, context, mode) as the session progresses
	for (const eventName of ["turn_end", "message_end", "agent_settled"] as const) {
		pi.on(eventName, async (_event, _ctx) => {
			if (overlayTui) {
				overlayTui.requestRender();
			}
		});
	}

	pi.on("session_shutdown", async () => {
		stopMcpPolling();
	});

	pi.registerCommand("banner", {
		description: "Configure banner mode: /banner [sticky|top|off]",
		handler: async (args, ctx) => {
			const choice = args.trim().toLowerCase();
			if (choice === "off") {
				stopMcpPolling();
				if (activeOverlayHandle) {
					activeOverlayHandle.hide();
					activeOverlayHandle = null;
				}
				ctx.ui.setHeader(undefined);
				ctx.ui.notify("Banner disabled", "info");
			} else if (choice === "top" || choice === "header" || choice === "scroll") {
				bannerMode = "header";
				applyBanner(ctx);
				ctx.ui.notify("Banner set to top (scrollable header)", "info");
			} else if (choice === "sticky" || choice === "sticky-top" || choice === "fixed") {
				bannerMode = "sticky-top";
				applyBanner(ctx);
				ctx.ui.notify("Banner set to sticky top of screen", "info");
			} else {
				bannerMode = bannerMode === "sticky-top" ? "header" : "sticky-top";
				applyBanner(ctx);
				ctx.ui.notify(`Banner switched to ${bannerMode} mode`, "info");
			}
		},
	});
}
