# Keyword controls implementation plan

Goal: Refresh all Sif keywords, delete one, or replace one without repeating competitor research.
Architecture: A KeywordManager serializes edits with the existing runner queue. Keyword-only jobs run in separate per-job directories; validation swaps the keyword bank only after success. Server-generated versioned reports and previous-result snapshots keep exports consistent and preserve old work.
Tech stack: Node native HTTP, file-backed TaskStore, Codex executor, vanilla JS.

Constraints: Keep serial resource-checked execution and two browser tabs. Never change production task data during tests. Keep all accepted keywords verbatim with Sif provenance. Exclude rejected terms (case/space normalized). Single replacement keeps every other keyword and competitors unchanged. Keyword edits invalidate titles; user regenerates using saved templates. Failure/login/cancel retains the current bank and report, and retry keeps keyword-only intent.

1. Tests first: HTTP delete/refresh/replace, validation of busy/deleted/unknown terms and origin; atomic failure, persisted exclusions, revision report and title invalidation.
2. Implement lib/keywords.mjs and routes. Use immutable operation directories and a task pointer swap; preserve prior result snapshots.
3. Tests first: actual fake-executor runner integration, rejected words/provenance/duplicates, failed or partial collection, login/cancel/resource/restoration and resume paths. Add keyword-only prompt/run-directory branch without changing ordinary workflows.
4. UI: refresh-all and per-row delete/replace; pending notices, disabled active controls, current counts and title regenerate action. Mobile DOM interaction tests against isolated data.
5. Full npm suite and syntax checks, independent code review, safe deployment at task boundary, production health/data retention verification, GitHub source sync.
