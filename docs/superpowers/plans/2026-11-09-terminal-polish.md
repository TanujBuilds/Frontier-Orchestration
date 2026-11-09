# Terminal visual polish

The owner asked for a nicer-looking terminal while retaining its simple layout and information. This is a presentation change to the existing observer, implemented directly with Codex.

## Direction

Use a compact stacked layout with a small Mosaic mark, aligned agent identity and status, quieter provenance and timestamps, a chronological handoff feed and a fixed keyboard-help bar. Bordered panels would consume more space; a side-by-side dashboard would complicate narrow windows. The owner selected compact and polished in response to the visual preference question.

Inherit the user's terminal font and background. Use terminal palette cyan for Mosaic and selection, default foreground for content, dim foreground for secondary details, green for active/accepted states, amber for waiting/partial and red for failures. Status words remain visible without color. No decorative animation, fabricated activity or added dependencies.

## Implementation and verification

1. Add a styled rendering path for ordinary interactive terminal sizes. Keep the existing compact layout and redirected plain output. Reuse authoritative actor rows and events; preserve source identity, stale warnings, goal selection and evidence controls.
2. Review rendered previews using real saved demo history at desktop and laptop widths. Check existing narrow-window, terminal-injection, concurrent-agent, keyboard and source-switch regressions. No tests for colors or decorative copy.
3. Run the full suite, review the diff, package a new beta and update the installed copy. Verify installed health and terminal output without dispatching models. Save a local preview and installation handoff.

Review focus: newest handoffs stay visible after wrapping; selected agent status remains readable; footer fits; status is never represented by color alone; source labels and disconnected state remain prominent.

## Goal picker follow-up

The owner identified the full-instruction goal list as confusing. Extend the same compact visual style to goal selection: one clipped title per row, aligned saved status and short ID, a bounded viewport around the selection, and a separate selected-goal preview. Keep the coordinator's ordering and records intact. Add `d` for full scrollable details, Escape back to the picker, and Page Up/Down jumps. Verify long goals at top/middle/end, narrow windows, source/stale warnings, and opening the exact highlighted goal. Package and install as the next beta patch.
