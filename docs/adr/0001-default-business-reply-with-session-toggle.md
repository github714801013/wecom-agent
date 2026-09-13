# Default Business Reply Mode with Session Toggle

All agent replies are post-processed through an LLM to produce business-friendly language by default. Users can toggle to Dev Mode (`/dev`) to see raw technical answers, and toggle back (`/business`). Mode switches reformat the last answer immediately without re-running the agent pipeline.

This decision trades one extra LLM call per reply for dramatically improved readability for non-technical users. The toggle is session-scoped (not per-message) to reduce friction during extended debugging sessions. Error replies are excluded from rewriting to preserve diagnostic information.

## Considered Options

- **Per-bot config toggle** — rejected because all bots serve the same user base; a global default with per-session override is simpler
- **Per-message `/dev` prefix** — rejected because users doing multi-turn debugging would have to prefix every message
- **System prompt injection** (rewrite in one pass) — rejected because mixing formatting instructions into the main prompt degrades answer quality; post-processing is cleaner
