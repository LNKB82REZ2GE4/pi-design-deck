import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { loadSettings } from "./settings.js";
import { startDeckServer, type DeckServerHandle, type ModelInfo } from "./deck-server.js";
import { isDeckOption, validateDeckConfig, validateSavedDeck } from "./deck-schema.js";
import { buildGenerateMoreResult, buildRegenerateResult } from "./generate-prompts.js";

async function openUrl(pi: ExtensionAPI, url: string, browser?: string): Promise<void> {
	const platform = os.platform();
	let result;
	if (platform === "darwin") {
		if (browser) {
			result = await pi.exec("open", ["-a", browser, url]);
		} else {
			result = await pi.exec("open", [url]);
		}
	} else if (platform === "win32") {
		if (browser) {
			result = await pi.exec("cmd", ["/c", "start", "", browser, url]);
		} else {
			result = await pi.exec("cmd", ["/c", "start", "", url]);
		}
	} else {
		if (browser) {
			result = await pi.exec(browser, [url]);
		} else {
			result = await pi.exec("xdg-open", [url]);
		}
	}
	if (result.code !== 0) {
		throw new Error(result.stderr || `Failed to open browser (exit code ${result.code})`);
	}
}

interface DeckDetails {
	status: "completed" | "cancelled" | "generate-more" | "aborted" | "error";
	url: string;
	selections?: Record<string, string>;
	slideId?: string;
	reason?: string;
}

interface DeckToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: DeckDetails;
}

let activeDeckServer: {
	handle: DeckServerHandle;
	currentResolve: ((result: DeckToolResult) => void) | null;
} | null = null;

let activeDeckIdleTimer: NodeJS.Timeout | null = null;
let pendingDeckResult: DeckToolResult | null = null;
let restoreDeckThinking: (() => void) | null = null;

const DECK_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

const DeckParams = Type.Object(
	{
		slides: Type.Optional(
			Type.String({
				description:
					"JSON string of deck config. Each slide has id, title, context?, columns? (1|2|3, omit for auto-layout), and options[]. " +
					"Each option has label, description?, aside?, recommended?, and either previewHtml (raw HTML string) or " +
					"previewBlocks (array of typed blocks: {type:'html',content}, {type:'mermaid',content,theme?}, " +
					"{type:'code',code,lang}, {type:'image',src,alt,caption?}). Exactly one of previewHtml or previewBlocks required per option.",
			})
		),
		action: Type.Optional(
			Type.Union([
				Type.Literal("add-option", { description: "Push a single generated option into a running deck session" }),
				Type.Literal("replace-options", { description: "Replace all options for a slide with fresh alternatives" }),
			])
		),
		slideId: Type.Optional(
			Type.String({ description: "Target slide ID (required with action: 'add-option' or 'replace-options')" })
		),
		option: Type.Optional(
			Type.String({
				description:
					"JSON string of one deck option with label and either previewHtml or previewBlocks (required with action: 'add-option')",
			})
		),
		options: Type.Optional(
			Type.String({
				description:
					"JSON string of array of deck options (required with action: 'replace-options')",
			})
		),
	},
	{ additionalProperties: false }
);

function expandHome(value: string): string {
	if (value === "~") {
		return os.homedir();
	}
	// Handle both Unix (/) and Windows (\) separators for user convenience
	if (value.startsWith("~/") || value.startsWith("~\\")) {
		return path.join(os.homedir(), value.slice(2));
	}
	return value;
}

const DEFAULT_THEME_HOTKEY = "mod+shift+l";

function clearDeckIdleTimer(): void {
	if (activeDeckIdleTimer) {
		clearTimeout(activeDeckIdleTimer);
		activeDeckIdleTimer = null;
	}
}

function cleanupActiveDeck(): void {
	clearDeckIdleTimer();
	if (restoreDeckThinking) {
		restoreDeckThinking();
		restoreDeckThinking = null;
	}
	if (!activeDeckServer) return;
	try {
		activeDeckServer.handle.close();
	} catch {}
	activeDeckServer = null;
}

function cleanupActiveDeckAndStoreResult(result: DeckToolResult): void {
	if (!activeDeckServer) return;
	if (activeDeckServer.currentResolve) {
		const resolve = activeDeckServer.currentResolve;
		cleanupActiveDeck();
		resolve(result);
	} else {
		pendingDeckResult = result;
		cleanupActiveDeck();
	}
}

function armDeckIdleTimer(): void {
	clearDeckIdleTimer();
	activeDeckIdleTimer = setTimeout(() => {
		if (!activeDeckServer) return;
		const url = activeDeckServer.handle.url;
		cleanupActiveDeckAndStoreResult({
			content: [{ type: "text", text: "Design deck closed after 5 minutes of inactivity." }],
			details: { status: "cancelled", url, reason: "idle-timeout" },
		});
	}, DECK_IDLE_TIMEOUT_MS);
}

function blockOnDeck(): Promise<DeckToolResult> {
	if (!activeDeckServer) {
		return Promise.resolve({
			content: [{ type: "text", text: "No active design deck session." }],
			details: { status: "error", url: "" },
		});
	}
	clearDeckIdleTimer();
	return new Promise((resolve) => {
		activeDeckServer!.currentResolve = resolve;
	});
}

function attachDeckAbortHandler(signal: AbortSignal | undefined): void {
	if (!signal) return;
	const abortHandler = () => {
		if (!activeDeckServer) return;
		const url = activeDeckServer.handle.url;
		cleanupActiveDeckAndStoreResult({
			content: [{ type: "text", text: "Design deck was aborted." }],
			details: { status: "aborted", url },
		});
	};
	signal.addEventListener("abort", abortHandler, { once: true });
}

function formatDeckSelections(selections: Record<string, string>): string {
	const entries = Object.entries(selections);
	if (entries.length === 0) return "(none)";
	return entries.map(([key, value]) => `- ${key}: ${value}`).join("\n");
}

export default function (pi: ExtensionAPI) {

	pi.registerTool({
		name: "design_deck",
		label: "Design Deck",
		description:
			"Present a multi-slide design deck with visual options for decisions. " +
			"Slides JSON: { title?, slides: [{ id, title, context?, columns?, options }] }. " +
			"When the user requests more options, tool returns generate-more instructions — " +
			'call design_deck with action:"add-option" to push into the live deck. ' +
			"previewBlocks for code/architecture comparisons, previewHtml for custom UI mockups.",
		parameters: DeckParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!ctx.hasUI) {
				throw new Error(
					"design_deck requires interactive mode with browser support. " +
						"Cannot run in headless/RPC/print mode."
				);
			}

			const p = params as Record<string, unknown>;

			if (p.action === "add-option") {
				if (typeof p.slideId !== "string" || p.slideId.trim() === "") {
					activeDeckServer?.handle.cancelGenerate();
					return {
						content: [{ type: "text", text: 'add-option requires slideId (string). Example: { action: "add-option", slideId: "arch", option: "<JSON string>" }' }],
						details: { status: "error", url: activeDeckServer?.handle.url ?? "" },
					};
				}
				if (typeof p.option !== "string" || p.option.trim() === "") {
					activeDeckServer?.handle.cancelGenerate();
					return {
						content: [{ type: "text", text: 'add-option requires option (JSON string with label and either previewHtml or previewBlocks).' }],
						details: { status: "error", url: activeDeckServer?.handle.url ?? "" },
					};
				}
			} else if (p.action === "replace-options") {
				if (typeof p.slideId !== "string" || p.slideId.trim() === "") {
					activeDeckServer?.handle.cancelGenerate();
					return {
						content: [{ type: "text", text: 'replace-options requires slideId (string).' }],
						details: { status: "error", url: activeDeckServer?.handle.url ?? "" },
					};
				}
				if (typeof p.options !== "string" || p.options.trim() === "") {
					activeDeckServer?.handle.cancelGenerate();
					return {
						content: [{ type: "text", text: 'replace-options requires options (JSON array string).' }],
						details: { status: "error", url: activeDeckServer?.handle.url ?? "" },
					};
				}
			} else if (typeof p.slides !== "string" || p.slides.trim() === "") {
				return {
					content: [{
						type: "text",
						text:
							"design_deck requires one of:\n\n" +
							'1. Start a new deck: { slides: "<JSON string of { title?, slides: [{ id, title, options }] }>" }\n' +
							'2. Add option to running deck: { action: "add-option", slideId: "...", option: "<JSON string>" }\n\n' +
							"Each option needs label + either previewHtml (raw HTML) or previewBlocks (array of {type, ...} blocks).\n" +
							"Block types: html, mermaid, code, image.",
					}],
					details: { status: "error", url: "" },
				};
			}

			if (p.action === "add-option") {
				if (pendingDeckResult) {
					const result = pendingDeckResult;
					pendingDeckResult = null;
					return result;
				}

				if (!activeDeckServer) {
					return {
						content: [
							{
								type: "text",
								text: "No active design deck session. Start a new deck before adding options.",
							},
						],
						details: { status: "error", url: "" },
					};
				}

				if (activeDeckServer.currentResolve !== null) {
					return {
						content: [
							{
								type: "text",
								text: "Design deck is not waiting for a generated option right now.",
							},
						],
						details: { status: "error", url: activeDeckServer.handle.url },
					};
				}

				const slideId = p.slideId as string;
				const option = p.option as string;

				let parsedOption: unknown;
				try {
					parsedOption = JSON.parse(option);
				} catch (err) {
					activeDeckServer.handle.cancelGenerate();
					const message = err instanceof Error ? err.message : String(err);
					const snippet = option.length > 300 ? option.slice(0, 300) + "..." : option;
					return {
						content: [{ type: "text", text: `Invalid option JSON: ${message}\n\nReceived:\n${snippet}\n\nFix the JSON and call design_deck add-option again.` }],
						details: { status: "error", url: activeDeckServer.handle.url },
					};
				}

				if (!isDeckOption(parsedOption)) {
					activeDeckServer.handle.cancelGenerate();
					return {
						content: [{ type: "text", text: "Option is invalid — needs label (string) and either previewHtml (non-empty string) or previewBlocks (non-empty array). Fix and call design_deck add-option again." }],
						details: { status: "error", url: activeDeckServer.handle.url },
					};
				}

				try {
					activeDeckServer.handle.pushOption(slideId, parsedOption);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return {
						content: [{ type: "text", text: `Failed to push option: ${message}` }],
						details: { status: "error", url: activeDeckServer.handle.url },
					};
				}

				if (onUpdate) {
					onUpdate({
						content: [{ type: "text", text: `Pushed new option to slide ${slideId}.` }],
						details: { status: "generate-more", url: activeDeckServer.handle.url, slideId },
					});
				}
				attachDeckAbortHandler(signal);
				return blockOnDeck();
			}

			if (p.action === "replace-options") {
				if (pendingDeckResult) {
					const result = pendingDeckResult;
					pendingDeckResult = null;
					return result;
				}

				if (!activeDeckServer) {
					return {
						content: [{ type: "text", text: "No active design deck session. Start a new deck before replacing options." }],
						details: { status: "error", url: "" },
					};
				}

				if (activeDeckServer.currentResolve !== null) {
					return {
						content: [{ type: "text", text: "Design deck is not waiting for regenerated options right now." }],
						details: { status: "error", url: activeDeckServer.handle.url },
					};
				}

				const slideId = p.slideId as string;
				const optionsStr = p.options as string;

				let parsedOptions: unknown;
				try {
					parsedOptions = JSON.parse(optionsStr);
				} catch (err) {
					activeDeckServer.handle.cancelGenerate();
					const message = err instanceof Error ? err.message : String(err);
					const snippet = optionsStr.length > 300 ? optionsStr.slice(0, 300) + "..." : optionsStr;
					return {
						content: [{ type: "text", text: `Invalid options JSON: ${message}\n\nReceived:\n${snippet}\n\nFix the JSON and call design_deck replace-options again.` }],
						details: { status: "error", url: activeDeckServer.handle.url },
					};
				}

				if (!Array.isArray(parsedOptions)) {
					activeDeckServer.handle.cancelGenerate();
					return {
						content: [{ type: "text", text: "options must be a JSON array of deck options. Fix and call design_deck replace-options again." }],
						details: { status: "error", url: activeDeckServer.handle.url },
					};
				}

				for (const opt of parsedOptions) {
					if (!isDeckOption(opt)) {
						activeDeckServer.handle.cancelGenerate();
						return {
							content: [{ type: "text", text: "One or more options in the array are invalid — each needs label and either previewHtml or previewBlocks. Fix and call design_deck replace-options again." }],
							details: { status: "error", url: activeDeckServer.handle.url },
						};
					}
				}

				try {
					activeDeckServer.handle.replaceSlideOptions(slideId, parsedOptions);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return {
						content: [{ type: "text", text: `Failed to replace options: ${message}` }],
						details: { status: "error", url: activeDeckServer.handle.url },
					};
				}

				if (onUpdate) {
					onUpdate({
						content: [{ type: "text", text: `Replaced ${parsedOptions.length} options for slide ${slideId}.` }],
						details: { status: "generate-more", url: activeDeckServer.handle.url, slideId },
					});
				}
				attachDeckAbortHandler(signal);
				return blockOnDeck();
			}

			pendingDeckResult = null;

			if (activeDeckServer) {
				return {
					content: [
						{
							type: "text",
							text: "A design deck is already active. Complete or cancel it before starting another.",
						},
					],
					details: { status: "error", url: activeDeckServer.handle.url },
				};
			}

			const slides = p.slides as string;

			let configData: unknown;
			let savedSelections: Record<string, string> | undefined;
			try {
				configData = JSON.parse(slides);
			} catch {
				const expanded = expandHome(slides);
				const absolutePath = path.isAbsolute(expanded) ? expanded : path.join(ctx.cwd, slides);
				if (!fs.existsSync(absolutePath)) {
					throw new Error(`Invalid slides: not valid JSON and file not found at ${absolutePath}`);
				}
				const content = fs.readFileSync(absolutePath, "utf-8");
				let fileData: unknown;
				try {
					fileData = JSON.parse(content);
				} catch (parseErr) {
					const message = parseErr instanceof Error ? parseErr.message : String(parseErr);
					throw new Error(`Invalid JSON in saved deck file: ${message}`);
				}
				const raw = fileData as Record<string, unknown>;
				if (raw.config && typeof raw.config === "object") {
					const saved = validateSavedDeck(fileData);
					configData = saved.config;
					savedSelections = Object.keys(saved.selections).length > 0 ? saved.selections : undefined;
					const snapshotDir = path.dirname(absolutePath);
					for (const slide of saved.config.slides) {
						for (const option of slide.options) {
							if (!option.previewBlocks) continue;
							for (const block of option.previewBlocks) {
								if (block.type === "image" && !path.isAbsolute(block.src)) {
									block.src = path.join(snapshotDir, block.src);
								}
							}
						}
					}
				} else {
					configData = fileData;
				}
			}
			const config = validateDeckConfig(configData);

			const settings = loadSettings();
			const sessionId = randomUUID();
			const sessionToken = randomUUID();

			if (signal?.aborted) {
				return {
					content: [{ type: "text", text: "Design deck was aborted." }],
					details: { status: "aborted", url: "" },
				};
			}

			const handleSubmit = (selections: Record<string, string>) => {
				if (!activeDeckServer) return;
				const url = activeDeckServer.handle.url;
				cleanupActiveDeckAndStoreResult({
					content: [
						{
							type: "text",
							text: `Design deck completed.\n\nSelections:\n${formatDeckSelections(selections)}`,
						},
					],
					details: { status: "completed", url, selections },
				});
			};

			const handleCancel = (reason?: "user" | "stale" | "aborted") => {
				if (!activeDeckServer) return;
				const url = activeDeckServer.handle.url;
				cleanupActiveDeckAndStoreResult({
					content: [
						{
							type: "text",
							text:
								reason === "stale"
									? "Design deck session ended due to lost heartbeat."
									: "Design deck was cancelled.",
						},
					],
					details: { status: "cancelled", url, reason },
				});
			};

			const handleGenerateMore = (slideId: string, prompt?: string, model?: string, thinking?: string) => {
				if (!activeDeckServer?.currentResolve) return;
				const resolve = activeDeckServer.currentResolve;
				activeDeckServer.currentResolve = null;
				armDeckIdleTimer();
				const slide = config.slides.find((s) => s.id === slideId);
				const effectiveModel = model === undefined ? loadSettings().generateModel : (model || undefined);
				if (thinking && !effectiveModel) {
					pi.setThinkingLevel(thinking as "off" | "minimal" | "low" | "medium" | "high" | "xhigh");
				}
				resolve({
					content: [{ type: "text", text: buildGenerateMoreResult(slideId, slide, prompt, effectiveModel, thinking) }],
					details: {
						status: "generate-more",
						url: activeDeckServer.handle.url,
						slideId,
					},
				});
			};

			const handleRegenerateSlide = (slideId: string, prompt?: string, model?: string, thinking?: string) => {
				if (!activeDeckServer?.currentResolve) return;
				const resolve = activeDeckServer.currentResolve;
				activeDeckServer.currentResolve = null;
				armDeckIdleTimer();
				const slide = config.slides.find((s) => s.id === slideId);
				const optionCount = slide?.options?.length || 2;
				const effectiveModel = model === undefined ? loadSettings().generateModel : (model || undefined);
				if (thinking && !effectiveModel) {
					pi.setThinkingLevel(thinking as "off" | "minimal" | "low" | "medium" | "high" | "xhigh");
				}
				resolve({
					content: [{ type: "text", text: buildRegenerateResult(slideId, slide, optionCount, prompt, effectiveModel, thinking) }],
					details: {
						status: "generate-more",
						url: activeDeckServer.handle.url,
						slideId,
					},
				});
			};

			const themeConfig = settings.theme ?? {};
			const snapshotDir = settings.snapshotDir ? expandHome(settings.snapshotDir) : undefined;

			const currentModelStr = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;
			const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map((m) => ({
				provider: m.provider,
				id: m.id,
				name: m.name,
				reasoning: m.reasoning,
			}));

			const originalThinking = pi.getThinkingLevel();
			restoreDeckThinking = () => pi.setThinkingLevel(originalThinking);

			const serverHandle = await startDeckServer(
				{
					config,
					sessionToken,
					sessionId,
					cwd: ctx.cwd,
					port: settings.port,
					theme: {
						mode: themeConfig.mode ?? "dark",
						toggleHotkey: themeConfig.toggleHotkey ?? DEFAULT_THEME_HOTKEY,
					},
					savedSelections,
					snapshotDir,
					autoSaveOnSubmit: settings.autoSaveOnSubmit ?? true,
					models: {
						current: currentModelStr,
						available: availableModels,
						defaultModel: settings.generateModel ?? null,
						currentThinking: originalThinking,
						currentModelReasoning: ctx.model?.reasoning ?? false,
					},
				},
				{
					onSubmit: handleSubmit,
					onCancel: handleCancel,
					onGenerateMore: handleGenerateMore,
					onRegenerateSlide: handleRegenerateSlide,
				}
			);

			activeDeckServer = { handle: serverHandle, currentResolve: null };
			attachDeckAbortHandler(signal);

			if (onUpdate) {
				onUpdate({
					content: [{ type: "text", text: "Design deck server started." }],
					details: { status: "generate-more", url: serverHandle.url },
				});
			}

			try {
				await openUrl(pi, serverHandle.url, settings.browser);
			} catch (err) {
				cleanupActiveDeck();
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(`Failed to open browser: ${message}`);
			}

			return blockOnDeck();
		},

		renderCall(args, theme) {
			const data = args as { action?: string; slideId?: string; slides?: string };
			if (data.action === "add-option") {
				return new Text(
					theme.fg("toolTitle", theme.bold(`Design Deck: add option (${data.slideId || "unknown"})`)),
					0,
					0
				);
			}
			if (data.action === "replace-options") {
				return new Text(
					theme.fg("toolTitle", theme.bold(`Design Deck: replace options (${data.slideId || "unknown"})`)),
					0,
					0
				);
			}
			if (typeof data.slides === "string" && data.slides.trim()) {
				try {
					const parsed = JSON.parse(data.slides) as { slides?: unknown[] };
					if (Array.isArray(parsed.slides)) {
						return new Text(theme.fg("toolTitle", theme.bold(`Design Deck: ${parsed.slides.length} slides`)), 0, 0);
					}
				} catch {
					// JSON incomplete during streaming - fall through
				}
			}
			return new Text(theme.fg("toolTitle", theme.bold("Design Deck")), 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as DeckDetails | undefined;
			if (!details) return new Text("Design Deck", 0, 0);

			if (details.status === "generate-more") {
				const slide = details.slideId ? ` (${details.slideId})` : "";
				return new Text(theme.fg("warning", `GENERATE-MORE${slide}`), 0, 0);
			}

			if (details.status === "completed") {
				const count = details.selections ? Object.keys(details.selections).length : 0;
				return new Text(theme.fg("success", `COMPLETED (${count} selections)`), 0, 0);
			}

			if (details.status === "cancelled") {
				const reason = details.reason ? ` (${details.reason})` : "";
				return new Text(theme.fg("warning", `CANCELLED${reason}`), 0, 0);
			}

			if (details.status === "aborted") {
				return new Text(theme.fg("error", "ABORTED"), 0, 0);
			}

			return new Text(theme.fg("error", "ERROR"), 0, 0);
		},
	});

	pi.on("session_shutdown", () => {
		pendingDeckResult = null;
		cleanupActiveDeck();
	});
}
