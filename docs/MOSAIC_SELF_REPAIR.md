# Focused local coding repair

A failed protected check can use another original DeepSeek attempt. The coding
adapter sends the failed check IDs and exit codes, short diagnostic excerpts,
the approved files already in context, and the remaining allowance. It also
identifies approved files whose content changed since the preceding failed gate
or the initial workspace snapshot. The worker continues from the current
candidate and uses the existing action for its mode. Ordinary coding uses
`submit_changes`. Overnight v2 can apply several batches before
`finish_stage` runs the gate.

The repair summary includes a lookup key for the full check result already
saved in the task's coding journal. Look up the `operation.completed` event
with the matching key, such as `harness-attempt-2/checks`, in
`coding/jobs/<task-id>.jsonl` under the coordinator state root. Large summaries
mark omitted output and entries. The existing protected check runner keeps its
approved file and environment boundaries. Repair excerpts also redact common
credential formats before they enter the worker input. Automatic repair
feedback is bound to its approved check and file scope. An approved scope
change keeps the original spending and deadline. An action already proposed
under the earlier scope requires a fresh attempt within those limits.

Two consecutive failed gates with the same candidate content and normalized
failures stop local execution with a saved no-progress reason. This comparison
uses Git-visible content hashes and failing check IDs, exit codes and output.
It normalizes common timestamp, elapsed-time and temporary-directory patterns.
A changed candidate can still use its remaining original allowance when the
same test fails. The failed candidate and its original check results stay
available for inspection.

Malformed actions use the original correction and exchange limits. When a
protocol correction interrupts a functional repair, the previous failed gate
remains available in the same approved scope. A stale hash prompts an exact
approved file read before retrying edits. A fulfilled Overnight v2 action
receipt describes what already happened so a worker can continue from the
current hashes. The existing provider transport handles
reconnect and ambiguous outcomes. Protected check infrastructure failures
stop at the existing infrastructure boundary, and required checks still have
to pass before any applicable frontier review.

## Demonstrate with fixtures

Run `node --test --test-concurrency=1 test/mosaic-self-repair*.test.mjs` from
the repository root. The fixtures use disposable repositories and coordinator
state, deterministic local responses, and a review spy. The tests exercise a
failed protected assertion followed by a passing repair in ordinary coding and
Overnight v2, as well as the repeated-failure stop after reopening the state.
Real DeepSeek repair quality and latency remain to be measured after combined
review.
