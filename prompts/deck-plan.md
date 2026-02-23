---
description: Analyze a plan/PRD and present design & architecture options
---
Load the `design-deck` skill for the full format reference. Then read and analyze the plan or PRD at `$1`. Also read the actual codebase files it references — in full — to understand the real state of the code, not just what the plan assumes.

Identify the key design and architecture decisions embedded in the plan. For each decision point, build a slide with 2-4 concrete options that are faithful to the plan's goals but offer genuinely different approaches. Mix preview types as appropriate: mermaid diagrams for architecture, code blocks for API design, HTML for UI mockups, images if available.

Each option should include concise `aside` text explaining trade-offs relative to the plan's constraints. Mark recommendations when you have a clear opinion, and reference specific plan sections in your reasoning.

Order slides from foundational decisions to aesthetic ones. Present everything via `design_deck`. The selections become the implementation contract.

Ultrathink.

${@:2}
