Build Night Shift, a polished personal task board in the prepared React/TypeScript starter.
Use four stages in this order:

1. Layout: responsive, dark, readable interface with one h1 named "Night Shift", a textbox labelled "New task", an "Add task" button and filter buttons "All", "Active", "Completed". Use the layout check.
2. Interactions: adding a task clears the input; reject blank tasks; each task has a checkbox whose accessible name is its text; completion and the three filters work. Use the interactions check.
3. Persistence and accessibility: save tasks and completion in localStorage, restore after reload, Enter adds a task, Space toggles a focused checkbox. Use one main landmark and a live region for task counts/status. Handle invalid saved data without crashing. Use the persistence check.
4. Final integration verification: run all four checks, inspect desktop/mobile screenshots, and review all approved criteria. Fix any remaining issue within src/.

Keep source edits within src/. Dependencies, HTML entry point, TypeScript config, and baseline checks are already prepared. Do not request a backend, authentication, new packages, external images, fonts, or network access. No horizontal overflow at desktop or mobile widths. Make sensible visual choices without asking for design feedback. Completion means the behavior works, checks pass, and Codex has reviewed the evidence. Passing the baseline checks alone is not a complete accessibility audit.
