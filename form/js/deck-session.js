// ─── NETWORK ─────────────────────────────────────────────────

async function postJson(path, payload) {
	const response = await fetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});

	if (!response.ok) {
		let message = `Request failed (${response.status})`;
		try {
			const data = await response.json();
			if (data && typeof data.error === "string") {
				message = data.error;
			}
		} catch {}
		throw new Error(message);
	}

	try {
		return await response.json();
	} catch {
		return { ok: true };
	}
}

// ─── SAVE/SNAPSHOT ───────────────────────────────────────────

let saveToastTimer = null;

function showSaveToast(message, isError) {
	const toast = document.getElementById("save-toast");
	if (!toast) return;
	if (saveToastTimer) { clearTimeout(saveToastTimer); saveToastTimer = null; }
	toast.textContent = message;
	toast.className = `save-toast ${isError ? "error" : "success"}`;
	toast.style.animation = "none";
	toast.offsetHeight;
	toast.style.animation = "";
	saveToastTimer = setTimeout(() => { toast.classList.add("hidden"); saveToastTimer = null; }, 3000);
}

async function saveDeck() {
	if (isClosed) return;
	try {
		const result = await postJson("/save", { token: sessionToken, selections });
		if (result.ok) showSaveToast(`Saved to ${result.relativePath}`);
		else showSaveToast(result.error || "Save failed", true);
	} catch {
		showSaveToast("Save failed", true);
	}
}

// ─── SESSION LIFECYCLE ───────────────────────────────────────

function closeEvents() {
	if (events) {
		events.close();
		events = null;
	}
}

function stopHeartbeat() {
	if (heartbeatTimer) {
		clearInterval(heartbeatTimer);
		heartbeatTimer = null;
	}
}

function disableDeckInteractions() {
	if (btnBack) btnBack.disabled = true;
	if (btnNext) btnNext.disabled = true;
	document.querySelectorAll(".btn-gen-more, .btn-regen").forEach((button) => {
		button.disabled = true;
	});
	document.querySelectorAll(".gen-prompt").forEach((input) => {
		input.disabled = true;
	});
	document.querySelectorAll(".model-pill, .model-list-item, .model-default-check").forEach((el) => {
		el.disabled = true;
	});
}

async function submitDeck() {
	if (isClosed || isSubmitting) return;
	const allDone = slides.every((slide) => !!selections[slide.id]);
	if (!allDone) {
		updateSummary();
		return;
	}

	isSubmitting = true;
	const submitButton = document.getElementById("btn-generate");
	if (submitButton) {
		submitButton.textContent = "Submitting...";
		submitButton.disabled = true;
	}

	try {
		await postJson("/submit", { token: sessionToken, selections });
		clearSelectionsStorage();
		isClosed = true;
		if (submitButton) {
			submitButton.textContent = "Submitted";
			submitButton.style.background = "var(--dk-status-success)";
		}
		stopHeartbeat();
		closeEvents();
		disableDeckInteractions();
		clearPendingGenerates();
		showCloseOverlay("submitted");
	} catch {
		isSubmitting = false;
		if (submitButton) {
			submitButton.textContent = "Submit Selections";
		}
		updateSummary();
	}
}

// ─── CONFIRM BAR & CLOSE OVERLAY ─────────────────────────────

let confirmBarTimeout = null;

function hasAnySelections() {
	return Object.keys(selections).length > 0;
}

function showConfirmBar() {
	const bar = document.getElementById("confirm-bar");
	if (!bar) return;
	bar.classList.add("visible");

	clearConfirmBarTimeout();
	confirmBarTimeout = setTimeout(() => hideConfirmBar(), 5000);
}

function hideConfirmBar() {
	const bar = document.getElementById("confirm-bar");
	if (bar) bar.classList.remove("visible");
	clearConfirmBarTimeout();
}

function clearConfirmBarTimeout() {
	if (confirmBarTimeout) {
		clearTimeout(confirmBarTimeout);
		confirmBarTimeout = null;
	}
}

function handleEscape() {
	if (isClosed) return;

	const bar = document.getElementById("confirm-bar");
	if (bar && bar.classList.contains("visible")) {
		cancelDeck("user");
		return;
	}

	if (hasAnySelections()) {
		showConfirmBar();
		return;
	}

	cancelDeck("user");
}

function showCloseOverlay(reason) {
	const overlay = document.getElementById("close-overlay");
	const content = document.getElementById("close-overlay-content");
	if (!overlay || !content) return;

	const messages = {
		submitted: { text: "Selections sent to agent. You can close this tab.", cls: "close-reason-success" },
		user: { text: "Deck cancelled. You can close this tab.", cls: "close-reason-warn" },
		stale: { text: "Session ended — lost connection.", cls: "close-reason-error" },
		aborted: { text: "Session was ended by the agent.", cls: "close-reason-error" },
		closed: { text: "Session was closed.", cls: "close-reason-error" },
	};

	const msg = messages[reason] || messages.closed;
	content.textContent = msg.text;
	overlay.className = `deck-close-overlay visible ${msg.cls}`;
	if (reason === "submitted" || reason === "user") {
		setTimeout(() => { window.close(); }, 800);
	}
}

function cancelDeck(reason) {
	if (isClosed) return;
	isClosed = true;
	hideConfirmBar();
	stopHeartbeat();
	closeEvents();
	disableDeckInteractions();
	clearPendingGenerates();
	showCloseOverlay(reason);
	postJson("/cancel", { token: sessionToken, reason, selections }).catch(() => {});
}

function sendCancelBeacon() {
	if (isClosed || !sessionToken) return;
	const payload = JSON.stringify({ token: sessionToken, reason: "user", selections });
	if (navigator.sendBeacon) {
		navigator.sendBeacon("/cancel", new Blob([payload], { type: "application/json" }));
		return;
	}
	fetch("/cancel", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: payload,
		keepalive: true,
	}).catch(() => {});
}

function startHeartbeat() {
	if (!sessionToken) return;

	const ping = () => {
		if (isClosed) return;
		postJson("/heartbeat", { token: sessionToken }).catch(() => {});
	};

	ping();
	heartbeatTimer = setInterval(ping, 5000);
}

// ─── GENERATE MORE ───────────────────────────────────────────

function clearPendingGenerates() {
	for (const [slideId, pending] of pendingGenerate.entries()) {
		if (pending.isRegen) {
			restoreRegenButton(slideId);
		} else {
			restoreGenerateButton(slideId);
		}
	}
}

function restoreGenerateButton(slideId) {
	const pending = pendingGenerate.get(slideId);
	if (!pending || pending.isRegen) return;

	if (pending.skeleton && pending.skeleton.parentElement) {
		pending.skeleton.remove();
	}
	pending.button.classList.remove("loading");
	const plus = pending.button.querySelector(".btn-gen-plus");
	if (plus) plus.textContent = "+";
	if (pending.button.childNodes[1]) {
		pending.button.childNodes[1].textContent = pending.originalText;
	}
	if (pending.input && !isClosed) pending.input.disabled = false;

	pendingGenerate.delete(slideId);
}

function updateDimmedStateAfterInsert(slideElement, slideId, insertedOption) {
	const selected = selections[slideId];
	if (!selected) return;
	insertedOption.classList.add("dimmed");
	const selectedEl = Array.from(slideElement.querySelectorAll(".option")).find(
		(el) => el.dataset.value === selected
	);
	if (selectedEl) {
		selectedEl.classList.add("selected");
	}
}

function insertGeneratedOption(slideId, option) {
	const slide = slides.find((entry) => entry.id === slideId);
	if (!slide) return;
	slide.options.push(option);

	const slideElement = document.querySelector(`.slide[data-id="${CSS.escape(slideId)}"]`);
	if (!slideElement) return;

	const optionsGrid = slideElement.querySelector(".options");
	if (!optionsGrid) return;

	optionsGrid.className = `options ${optionCountClass(slide.options.length, slide.columns)}`;

	const optionCard = createOptionCard(option, slideId, true);
	optionsGrid.appendChild(optionCard);
	updateDimmedStateAfterInsert(slideElement, slideId, optionCard);
	equalizeBlockHeights(slideElement);

	const pick = slideElement.querySelector(".slide-pick");
	if (pick) pick.innerHTML = optionHint(slide.options.length);

	if (current === totalSlides - 1) {
		updateSummary();
	}
}

function replaceSlideOptions(slideId, newOptions) {
	const slide = slides.find((entry) => entry.id === slideId);
	if (!slide) return;

	slide.options = newOptions;

	delete selections[slideId];
	saveSelectionsToStorage();

	const slideElement = document.querySelector(`.slide[data-id="${CSS.escape(slideId)}"]`);
	if (!slideElement) return;

	const optionsGrid = slideElement.querySelector(".options");
	if (!optionsGrid) return;

	optionsGrid.innerHTML = "";
	optionsGrid.style.opacity = "";
	optionsGrid.style.pointerEvents = "";
	optionsGrid.className = `options ${optionCountClass(newOptions.length, slide.columns)}`;

	newOptions.forEach((option) => {
		const card = createOptionCard(option, slideId, false);
		optionsGrid.appendChild(card);
	});

	equalizeBlockHeights(slideElement);

	const pick = slideElement.querySelector(".slide-pick");
	if (pick) pick.innerHTML = optionHint(newOptions.length);

	if (current === totalSlides - 1) {
		updateSummary();
	}
}

function connectEvents() {
	if (!sessionToken) return;
	events = new EventSource(`/events?session=${encodeURIComponent(sessionToken)}`);

	events.addEventListener("new-option", (event) => {
		let payload;
		try {
			payload = JSON.parse(event.data);
		} catch {
			return;
		}
		if (!payload || typeof payload.slideId !== "string" || !payload.option) {
			return;
		}
		restoreGenerateButton(payload.slideId);
		insertGeneratedOption(payload.slideId, payload.option);
	});

	events.addEventListener("generate-failed", (event) => {
		let payload;
		try {
			payload = JSON.parse(event.data);
		} catch {
			return;
		}
		if (payload && typeof payload.slideId === "string") {
			restoreGenerateButton(payload.slideId);
			if (payload.reason === "timeout") {
				showSaveToast("Generation timed out — try again", true);
			}
		}
	});

	events.addEventListener("replace-options", (event) => {
		let payload;
		try {
			payload = JSON.parse(event.data);
		} catch {
			return;
		}
		if (!payload || typeof payload.slideId !== "string" || !Array.isArray(payload.options)) {
			return;
		}
		restoreRegenButton(payload.slideId);
		replaceSlideOptions(payload.slideId, payload.options);
	});

	events.addEventListener("regenerate-failed", (event) => {
		let payload;
		try {
			payload = JSON.parse(event.data);
		} catch {
			return;
		}
		if (payload && typeof payload.slideId === "string") {
			restoreRegenButton(payload.slideId);
			if (payload.reason === "timeout") {
				showSaveToast("Regeneration timed out — try again", true);
			}
		}
	});

	events.addEventListener("deck-close", (event) => {
		isClosed = true;
		hideConfirmBar();
		stopHeartbeat();
		closeEvents();
		disableDeckInteractions();
		clearPendingGenerates();
		let reason = "closed";
		try {
			const payload = JSON.parse(event.data);
			if (payload && payload.reason) reason = payload.reason;
			if (payload && payload.reason === "submitted") {
				const submitButton = document.getElementById("btn-generate");
				if (submitButton) {
					submitButton.textContent = "Submitted";
					submitButton.disabled = true;
				}
			}
		} catch {}
		showCloseOverlay(reason);
	});
}

async function generateMore(button, slideId, input) {
	if (isClosed || pendingGenerate.size > 0) return;

	const slideElement = document.querySelector(`.slide[data-id="${CSS.escape(slideId)}"]`);
	if (!slideElement) return;
	const optionsGrid = slideElement.querySelector(".options");
	if (!optionsGrid) return;

	const slide = slides.find((entry) => entry.id === slideId);
	if (!slide) return;

	const prompt = input ? input.value.trim() : "";
	if (input) input.value = "";

	const skeleton = createElement("div", "option-skeleton");
	optionsGrid.appendChild(skeleton);

	const originalText = button.childNodes[1] ? button.childNodes[1].textContent || "" : "";
	button.classList.add("loading");
	const plus = button.querySelector(".btn-gen-plus");
	if (plus) plus.textContent = "";
	if (button.childNodes[1]) button.childNodes[1].textContent = " Generating...";
	if (input) input.disabled = true;

	pendingGenerate.set(slideId, { button, skeleton, originalText, input });

	try {
		const body = { token: sessionToken, slideId };
		if (prompt) body.prompt = prompt;
		if (hasModelBar) {
			body.model = selectedModel;
			if (!selectedModel) body.thinking = selectedThinking;
		}
		await postJson("/generate-more", body);
	} catch {
		restoreGenerateButton(slideId);
	}
}

async function regenerateSlide(button, slideId) {
	if (isClosed || pendingGenerate.size > 0) return;

	const slideElement = document.querySelector(`.slide[data-id="${CSS.escape(slideId)}"]`);
	if (!slideElement) return;
	const optionsGrid = slideElement.querySelector(".options");
	if (!optionsGrid) return;

	const slide = slides.find((entry) => entry.id === slideId);
	if (!slide) return;

	const genRow = slideElement.querySelector(".gen-row");
	const input = genRow ? genRow.querySelector(".gen-prompt") : null;
	const prompt = input ? input.value.trim() : "";
	if (input) input.value = "";

	optionsGrid.style.opacity = "0.4";
	optionsGrid.style.pointerEvents = "none";

	const originalText = button.textContent || "";
	button.classList.add("loading");
	button.disabled = true;
	button.textContent = "↻ Regenerating...";
	if (input) input.disabled = true;

	const genMoreBtn = slideElement.querySelector(".btn-gen-more");
	if (genMoreBtn) genMoreBtn.disabled = true;

	pendingGenerate.set(slideId, { button, originalText, input, isRegen: true, optionsGrid, genMoreBtn });

	try {
		const body = { token: sessionToken, slideId };
		if (prompt) body.prompt = prompt;
		if (hasModelBar) {
			body.model = selectedModel;
			if (!selectedModel) body.thinking = selectedThinking;
		}
		await postJson("/regenerate-slide", body);
	} catch {
		restoreRegenButton(slideId);
	}
}

function restoreRegenButton(slideId) {
	const pending = pendingGenerate.get(slideId);
	if (!pending || !pending.isRegen) return;
	pendingGenerate.delete(slideId);

	const { button, originalText, input, optionsGrid, genMoreBtn } = pending;
	if (button) {
		button.classList.remove("loading");
		button.disabled = false;
		button.textContent = originalText || "↻ Regenerate all";
	}
	if (input) input.disabled = false;
	if (optionsGrid) {
		optionsGrid.style.opacity = "";
		optionsGrid.style.pointerEvents = "";
	}
	if (genMoreBtn) genMoreBtn.disabled = false;
}

// ─── INITIALIZATION ──────────────────────────────────────────

function initFooterControls() {
	if (btnBack) {
		btnBack.addEventListener("click", () => navigate(-1));
	}
	if (btnNext) {
		btnNext.addEventListener("click", () => navigate(1));
	}
}

function initConfirmBar() {
	const cancelBtn = document.getElementById("confirm-cancel");
	const keepBtn = document.getElementById("confirm-keep");
	if (cancelBtn) cancelBtn.addEventListener("click", () => cancelDeck("user"));
	if (keepBtn) keepBtn.addEventListener("click", () => hideConfirmBar());
}

function initSaveShortcut() {
	const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
	document.querySelectorAll(".mod-key").forEach((el) => {
		el.textContent = isMac ? "⌘" : "Ctrl";
	});
	document.addEventListener("keydown", (e) => {
		const mod = isMac ? e.metaKey : e.ctrlKey;
		if (mod && e.key === "s") {
			e.preventDefault();
			saveDeck();
		}
	});
}

function hideLoadingOverlay() {
	const loader = document.getElementById("deck-loading");
	if (loader) {
		loader.classList.add("fade-out");
		setTimeout(() => loader.remove(), 300);
	}
}

function init() {
	initTheme();
	setMetaLabel();
	renderSlides();
	restoreSelections();
	initFooterControls();
	initConfirmBar();
	initSaveShortcut();
	showSlide(0);
	startHeartbeat();
	connectEvents();
	fetchModels().then((data) => {
		if (data) initModelBar(data);
	});

	document.addEventListener("keydown", handleKeydown);
	window.addEventListener("beforeunload", sendCancelBeacon);

	// Hide loading overlay after a brief moment for smooth transition
	requestAnimationFrame(() => {
		requestAnimationFrame(() => hideLoadingOverlay());
	});
}

init();
