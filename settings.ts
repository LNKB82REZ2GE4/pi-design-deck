import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

export interface DeckThemeSettings {
	mode?: "auto" | "light" | "dark";
	toggleHotkey?: string;
}

export interface DesignDeckSettings {
	port?: number;
	browser?: string;
	theme?: DeckThemeSettings;
	snapshotDir?: string;
	autoSaveOnSubmit?: boolean;
	generateModel?: string;
}

export function loadSettings(): DesignDeckSettings {
	try {
		const data = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as Record<string, unknown>;
		const designDeck = data.designDeck;
		if (designDeck && typeof designDeck === "object" && !Array.isArray(designDeck)) {
			return designDeck as DesignDeckSettings;
		}

		const interview = data.interview;
		if (interview && typeof interview === "object" && !Array.isArray(interview)) {
			const oldModel = (interview as Record<string, unknown>).deckGenerateModel;
			if (typeof oldModel === "string" && oldModel.trim() !== "") {
				const nextDesignDeck: Record<string, unknown> = { generateModel: oldModel };
				data.designDeck = nextDesignDeck;
				delete (interview as Record<string, unknown>).deckGenerateModel;
				const tempFile = SETTINGS_PATH + ".tmp";
				writeFileSync(tempFile, JSON.stringify(data, null, 2) + "\n");
				renameSync(tempFile, SETTINGS_PATH);
				return nextDesignDeck as DesignDeckSettings;
			}
		}
		return {};
	} catch {
		return {};
	}
}

export function saveGenerateModel(model: string | null): void {
	let data: Record<string, unknown> = {};
	try {
		data = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
	} catch {}
	if (!data.designDeck || typeof data.designDeck !== "object" || Array.isArray(data.designDeck)) {
		data.designDeck = {};
	}
	const designDeck = data.designDeck as Record<string, unknown>;
	if (model) {
		designDeck.generateModel = model;
	} else {
		delete designDeck.generateModel;
	}
	const tempFile = SETTINGS_PATH + ".tmp";
	writeFileSync(tempFile, JSON.stringify(data, null, 2) + "\n");
	renameSync(tempFile, SETTINGS_PATH);
}
