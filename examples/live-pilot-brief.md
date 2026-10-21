Build the first visible slice of Night Shift in the prepared React/TypeScript web UI pilot. This is a small live coding proof for Frontier Orchestrator, not the full task-board release.

Use exactly two ordered stages:

1. Implement a responsive, dark task-board shell. Show one h1 named "Night Shift", a textbox labelled "New task", an "Add task" button, and filter buttons "All", "Active", and "Completed". Keep the interface readable at desktop and mobile widths with no horizontal overflow. The existing `layout` check must pass and capture both screenshots.
2. Perform final verification of the approved layout criteria using the same `layout` check, inspect its desktop/mobile screenshots, and fix any remaining layout issue within `src/`.

Keep source edits within `src/`. Dependencies, HTML entry point, TypeScript configuration, and the protected check are already prepared. Do not add packages, backend services, authentication, external assets, fonts, or network access. The add/filter controls may be visual only in this small proof; working interactions and persistence belong to the later full pilot. Completion requires the protected check and a separate Codex review of the actual diff and screenshots.
