# Changelog

## [Unreleased]

## [0.1.0] - 2026-02-23

### Added
- **Design Deck tool** (`design_deck`): Multi-slide visual option picker for design decisions. Each slide presents 2-4 options with high-fidelity HTML previews. Users select one option per slide and submit. Persistent server architecture keeps the browser open across tool re-invocations, enabling the generate-more loop without page reloads.
- **Generate-more loop**: Users can request additional options from the agent. Clicking "Generate another option" resolves the tool without closing the server. The agent generates a new option and re-invokes `design_deck` with `action: "add-option"` to push it into the live deck via SSE. Skeleton placeholder with shimmer animation shown during generation.
- **Preview blocks**: `previewBlocks` array as an alternative to raw `previewHtml`. Four typed block types: `html`, `mermaid` (Mermaid.js), `code` (Prism.js syntax highlighting), and `image` (served from disk via temp assets directory). Exactly one of `previewHtml` or `previewBlocks` required per option.
- **Option aside**: Optional `aside` field renders explanatory text below the preview. HTML-escaped with `\n` to `<br>` conversion. Truncated to 120 chars in summary cards.
- **Mermaid.js integration**: CDN-loaded Mermaid v11 with dark-mode base theme. Per-block theme overrides. Async rendering with ready-queue.
- **Prism.js integration**: CDN-loaded Prism with autoloader for on-demand language grammars.
- **Image asset serving**: `/assets/` route with UUID-named temp directory, path traversal guard, cleanup on close.
- **Slide columns**: `columns` property (1, 2, or 3) for layout control. Smart column rebalancing to minimize orphans.
- **Light/dark/auto theme**: CSS custom properties, toggle hotkey, localStorage persistence, `prefers-color-scheme` support.
- **Save/load snapshots**: `Cmd+S` manual save, auto-save on submit/cancel, reload from file path with pre-populated selections.
- **Heartbeat watchdog**: 60s grace period for lost browser connections. `beforeunload` beacon on tab close.
- **Idle timeout**: 5-minute timer after generate-more. Closes deck if the agent doesn't respond.
- **Abort handling**: Agent abort signal cleanly closes the deck at any point in the lifecycle.
- **Keyboard navigation**: Arrow keys, Space/Enter selection, number keys 1-9, Escape confirmation bar.
- **ARIA accessibility**: `role="radiogroup"`, `aria-checked`, `aria-live`, roving tabindex, `:focus-visible` outlines.
- **Slash commands**: `/deck`, `/deck-plan`, `/deck-discover` prompt templates.
- **Bundled skill**: `design-deck` skill with format reference, preview guidance, and generate-more patterns.
- **48 schema tests**: Covering config validation, `isDeckOption`, saved deck loading, block types, edge cases.

### Fixed
- **Generate-more failure recovery**: `pushOption` errors now clear `pendingGenerate` state and push `generate-failed` SSE event.
- **`isDeckOption` deep block validation**: Validates each `previewBlocks` entry, not just array presence.
- **Atomic settings writes**: Temp-file + rename pattern for `saveGenerateModel()` and settings migration.
