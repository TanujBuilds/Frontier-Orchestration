# Mosaic full-page project details

Owner asks to streamline navigation: recent project rows should open a full detail page instead of a narrow inspector, with the current version saved first. Continue Codex-only.

Design: preserve charcoal/cyan typography and viewer-only semantics. Keep global navigation; dedicate the entire content area to project details. A visible Back to Recent/History/etc returns to the originating list and scroll/focus. Project heading and assignment selector give context; Summary, Changes and Evidence use full width and preserve per-task tabs, scroll and disclosures. Current work, History and Projects remain usable. No OS full-screen mode switch, new execution controls, provider changes or guessed chat links.

Checkpoint: GitHub annotated tag mosaic-desktop-v1.1.0-before-full-page pins accepted9e7236f; existing immutable1.1.0 app retained. Install new immutable1.2.0 at same Dock path, retain1.1.0 for restoration. Restoration changes only viewer app, never database/spending.

- [ ] Define protected behavior regression before UI edits: full-page navigation, project assignment switching, tabs, return origin/scroll/focus, refresh preservation and empty states.
- [ ] Implement one project detail route, full-width layout, clearer project context and consistent task entry points; preserve runtime/native credential boundaries.
- [ ] Run focused app suites and native build/sign/bundle; actual protected sandbox checks. Inspect wide/compact native app, keyboard navigation, long content and return behavior. One independent read-only reviewer; fix important findings with regressions.
- [ ] Native finish, accept and checked integrate through coordinator. Package/install1.2.0 preserving previous app, Dock/service/current state; verify installed UI. Push source branch, retain checkpoint tag; record restoration instructions and private memory.

Limits: one new Codex-only goal2hours, one task90minutes, attempts3,2 operator decisions,1 independent reviewer reservation, no DeepSeek calls. Previous allowances closed. No unrelated goals touched, no coordinator restart.
