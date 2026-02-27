import type { DeckSlide } from "./deck-schema.js";

function formatHintForSlide(slide: DeckSlide | undefined): { hasBlocks: boolean; formatHint: string } {
	const hasBlocks = slide?.options?.some((o) => o.previewBlocks && o.previewBlocks.length > 0) ?? false;
	const formatHint = hasBlocks
		? "Use previewBlocks (array of typed blocks: html, mermaid, code, image) to match the existing options."
		: "Use previewHtml (raw HTML) or previewBlocks (array of typed blocks) to match the existing options.";
	return { hasBlocks, formatHint };
}

function optionTemplate(hasBlocks: boolean): string {
	return hasBlocks
		? JSON.stringify({
				label: "Option label",
				description: "Short rationale",
				aside: "Explanatory notes below the preview",
				previewBlocks: [{ type: "code", code: "...", lang: "ts" }],
				recommended: false,
			})
		: JSON.stringify({
				label: "Option label",
				description: "Short rationale",
				aside: "Explanatory notes below the preview",
				previewHtml: "<div class='pv-body'>...</div>",
				recommended: false,
			});
}

function modelHints(generateModel?: string, thinking?: string, action?: string): string {
	if (!generateModel) return "";
	const verb = action === "replace-options" ? "replace-options" : "add-option";
	let hint = `\nGenerate ${verb === "replace-options" ? "options " : ""}using deck_generate({ model: "${generateModel}", task: "..." }), then push with ${verb}.`;
	if (thinking && thinking !== "off") {
		hint += `\nUse thinking level: "${thinking}".`;
	}
	return hint;
}

export function buildGenerateMoreResult(slideId: string, slide: DeckSlide | undefined, prompt?: string, generateModel?: string, thinking?: string, count: number = 1): string {
	const title = slide?.title ?? slideId;
	const context = slide?.context ? `\nContext: ${slide.context}` : "";

	const existingLines: string[] = [];
	if (slide?.options && slide.options.length > 0) {
		for (const opt of slide.options) {
			let line = `- ${opt.label}`;
			if (opt.description) line += `: ${opt.description}`;
			if (opt.aside) line += ` — ${opt.aside.split("\n")[0]}`;
			existingLines.push(line);
		}
	}
	const existingText = existingLines.length > 0 ? existingLines.join("\n") : "(none)";

	const { hasBlocks, formatHint } = formatHintForSlide(slide);
	const template = optionTemplate(hasBlocks);
	const userInstructions = prompt ? `\nUser instructions: "${prompt}"` : "";
	
	const optionWord = count === 1 ? "option" : "options";
	const callInstructions = count === 1
		? `YOU MUST generate one distinctive additional option and call design_deck with add-option.`
		: `YOU MUST generate ${count} distinctive additional options. Call design_deck with add-option ${count} times (once per option).`;

	return (
		"The design deck is still open and waiting for your response.\n\n" +
		`User clicked "Generate ${count} ${optionWord}" for slide \"${title}\".${context}${userInstructions}\n\n` +
		`Existing options:\n${existingText}\n\n` +
		`${callInstructions} ` +
		`Do not skip this step or decide the user has enough options — they explicitly requested ${count === 1 ? "another one" : `${count} more`}.${modelHints(generateModel, thinking, "add-option")}\n\n` +
		`design_deck({\"action\":\"add-option\",\"slideId\":\"${slideId}\",\"option\":${JSON.stringify(template)}})\n\n` +
		`The option field must be a JSON string with: label, optional description, optional aside (explanatory notes below preview), and optional recommended.\n` +
		`${formatHint}` +
		(count > 1 ? `\n\nRemember: Call add-option ${count} times, each with a different option. Make each option distinctive.` : "")
	);
}

export function buildRegenerateResult(slideId: string, slide: DeckSlide | undefined, optionCount: number, prompt?: string, generateModel?: string, thinking?: string): string {
	const title = slide?.title ?? slideId;
	const context = slide?.context ? `\nContext: ${slide.context}` : "";

	const { hasBlocks, formatHint } = formatHintForSlide(slide);
	const template = optionTemplate(hasBlocks);
	const userInstructions = prompt ? `\nUser instructions: "${prompt}"` : "";

	return (
		"The design deck is still open and waiting for your response.\n\n" +
		`User clicked "Regenerate all" for slide \"${title}\".${context}${userInstructions}\n\n` +
		`YOU MUST generate ${optionCount} fresh, distinctive options and call design_deck with replace-options. ` +
		`Do not skip this step — the user explicitly requested regeneration.${modelHints(generateModel, thinking, "replace-options")}\n\n` +
		`design_deck({\"action\":\"replace-options\",\"slideId\":\"${slideId}\",\"options\":\"[${template}, ...]\"})` +
		`\n\nThe options field must be a JSON string containing an array of ${optionCount} option objects.\n` +
		`Each option needs: label, optional description, optional aside, optional recommended, and either previewHtml or previewBlocks.\n` +
		`${formatHint}\n\n` +
		`Make these options substantially different from what was shown before — the user wasn't satisfied with any of them.`
	);
}
