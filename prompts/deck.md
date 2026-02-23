---
description: Present visual design options via design deck
---
Load the `design-deck` skill for the full format reference. Analyze the current codebase and context, and present concrete visual options using `design_deck`.

Read relevant files aggressively first so you understand the real constraints before generating options. If there's a plan or PRD, read it in full along with every codebase file it references — understand the actual state of the code, not just what the document assumes. Then identify the key design and architecture decisions and present options for each.

Build 1 slide per decision with 2-4 genuinely distinct options — not tiny variants. Order slides foundational to aesthetic. Use the right preview format for the content: `previewBlocks` with code/mermaid/image blocks for technical comparisons, `previewHtml` with hand-rolled inline styles for UI mockups. Each UI option should look like a different designer made it — vary structure, typography, and spacing philosophy, not just colors.

Include concise `aside` text for trade-off summaries. Mark a recommendation when you have a clear opinion.

If the request is genuinely ambiguous or underspecified and no plan or PRD exists, interview me in depth first — but don't force discovery when you already have what you need.

The selections become the implementation contract. Ultrathink.

$@
