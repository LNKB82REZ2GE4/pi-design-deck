// ─── STATE & CONFIGURATION ───────────────────────────────────

const deckData = window.__DECK_DATA__ || {};
const config =
	deckData && typeof deckData === "object" && deckData.config && typeof deckData.config === "object"
		? deckData.config
		: { slides: [] };

const sessionToken = typeof deckData.sessionToken === "string" ? deckData.sessionToken : "";

const slides = Array.isArray(config.slides)
	? config.slides.map((slide) => ({
			...slide,
			options: Array.isArray(slide.options) ? [...slide.options] : [],
		}))
	: [];

const totalSlides = slides.length + 1;
let current = 0;
let events = null;
let heartbeatTimer = null;
let isClosed = false;
let isSubmitting = false;

const selections = {};
const pendingGenerate = new Map();
let selectedModel = "";
let selectedThinking = "off";
let hasModelBar = false;

// DOM references
const progressFill = document.getElementById("progress-fill");
const slidesWrap = document.getElementById("slides-wrap");
const btnBack = document.getElementById("btn-back");
const btnNext = document.getElementById("btn-next");

// ─── UTILITIES ───────────────────────────────────────────────

function createElement(tag, className, text) {
	const el = document.createElement(tag);
	if (className) el.className = className;
	if (text !== undefined) el.textContent = text;
	return el;
}

function escapeHtml(str) {
	return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function equalizeBlockHeights(container) {
	const types = ["mermaid", "code", "html", "image"];
	for (const type of types) {
		const blocks = container.querySelectorAll(`.preview-block-${type}`);
		if (blocks.length < 2) continue;
		blocks.forEach((b) => { b.style.height = ""; });
		let maxH = 0;
		blocks.forEach((b) => { maxH = Math.max(maxH, b.offsetHeight); });
		if (maxH > 0) blocks.forEach((b) => { b.style.height = maxH + "px"; });
	}
}

function setMetaLabel() {
	const deckTitle = document.getElementById("deck-title");
	if (!deckTitle) return;
	const title = typeof config.title === "string" && config.title ? config.title : "Design Decisions";
	const cwd = typeof deckData.cwd === "string" ? deckData.cwd : "";
	const gitBranch = typeof deckData.gitBranch === "string" ? deckData.gitBranch : "";
	if (cwd) {
		deckTitle.textContent = `${title} - ${cwd}${gitBranch ? ` (${gitBranch})` : ""}`;
		return;
	}
	deckTitle.textContent = title;
}

// ─── THEME SYSTEM ────────────────────────────────────────────

const themeConfig = deckData && typeof deckData === "object" && deckData.theme && typeof deckData.theme === "object" ? deckData.theme : {};
const themeMode = typeof themeConfig.mode === "string" ? themeConfig.mode : "dark";
const themeToggleHotkey = typeof themeConfig.toggleHotkey === "string" ? themeConfig.toggleHotkey : "";
const THEME_OVERRIDE_KEY = "pi-deck-theme-override";

function getSystemTheme() {
	return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function getStoredThemeOverride() {
	try {
		const value = localStorage.getItem(THEME_OVERRIDE_KEY);
		return value === "light" || value === "dark" ? value : null;
	} catch { return null; }
}

function setStoredThemeOverride(value) {
	try {
		if (!value) { localStorage.removeItem(THEME_OVERRIDE_KEY); return; }
		localStorage.setItem(THEME_OVERRIDE_KEY, value);
	} catch {}
}

function getEffectiveTheme() {
	const override = getStoredThemeOverride();
	if (override) return override;
	if (themeMode === "auto") return getSystemTheme();
	return themeMode;
}

function applyTheme(mode) {
	document.documentElement.dataset.theme = mode;
	document.documentElement.style.colorScheme = mode;
	const meta = document.querySelector('meta[name="theme-color"]');
	if (meta) meta.content = mode === "light" ? "#f8f8f8" : "#18181e";
}

function toggleTheme() {
	const currentTheme = getEffectiveTheme();
	const next = currentTheme === "dark" ? "light" : "dark";
	if (themeMode === "auto") {
		setStoredThemeOverride(next === getSystemTheme() ? null : next);
	} else {
		setStoredThemeOverride(next);
	}
	applyTheme(next);
}

function parseHotkey(value) {
	if (!value) return null;
	const parts = value.toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
	if (parts.length === 0) return null;
	const key = parts[parts.length - 1];
	const mods = parts.slice(0, -1);
	const hotkey = { key, mod: false, shift: false, alt: false };
	mods.forEach((m) => {
		if (m === "mod" || m === "cmd" || m === "meta" || m === "ctrl" || m === "control") hotkey.mod = true;
		else if (m === "shift") hotkey.shift = true;
		else if (m === "alt" || m === "option") hotkey.alt = true;
	});
	return key ? hotkey : null;
}

function matchesHotkey(event, hotkey) {
	if (event.key.toLowerCase() !== hotkey.key) return false;
	const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
	const modPressed = isMac ? event.metaKey : event.ctrlKey;
	if (hotkey.mod !== modPressed) return false;
	if (hotkey.shift !== event.shiftKey) return false;
	if (hotkey.alt !== event.altKey) return false;
	if (!hotkey.mod && (event.metaKey || event.ctrlKey)) return false;
	if (!hotkey.shift && event.shiftKey) return false;
	if (!hotkey.alt && event.altKey) return false;
	return true;
}

function initTheme() {
	applyTheme(getEffectiveTheme());

	if (themeMode === "auto") {
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		media.addEventListener("change", () => {
			if (!getStoredThemeOverride()) applyTheme(getSystemTheme());
		});
	}

	const hotkey = parseHotkey(themeToggleHotkey);
	if (hotkey) {
		const shortcut = document.getElementById("theme-shortcut");
		if (shortcut) {
			const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
			const parts = [];
			if (hotkey.mod) parts.push(isMac ? "⌘" : "Ctrl");
			if (hotkey.shift) parts.push("Shift");
			if (hotkey.alt) parts.push(isMac ? "Option" : "Alt");
			parts.push(hotkey.key.length === 1 ? hotkey.key.toUpperCase() : hotkey.key);
			shortcut.innerHTML = parts.map((p) => `<kbd>${p}</kbd>`).join("") + " Theme";
			shortcut.classList.remove("hidden");
		}
		document.addEventListener("keydown", (event) => {
			if (matchesHotkey(event, hotkey)) { event.preventDefault(); toggleTheme(); }
		});
	}
}

// ─── SELECTION PERSISTENCE ────────────────────────────────────

const SELECTIONS_KEY = `pi-deck-${typeof deckData.sessionId === "string" ? deckData.sessionId : "unknown"}`;

function saveSelectionsToStorage() {
	try { localStorage.setItem(SELECTIONS_KEY, JSON.stringify(selections)); } catch {}
}

function loadSelectionsFromStorage() {
	try {
		const saved = localStorage.getItem(SELECTIONS_KEY);
		return saved ? JSON.parse(saved) : null;
	} catch { return null; }
}

function clearSelectionsStorage() {
	try { localStorage.removeItem(SELECTIONS_KEY); } catch {}
}
