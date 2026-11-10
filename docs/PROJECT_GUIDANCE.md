# Project check guidance

Mosaic can recall registered checks that passed on accepted coding integrations. A project check guidance lesson connects exact check definitions to repository-relative paths and terms, with the saved outcome IDs as evidence. For example, a later assignment that mentions the parser and `src/parser.mjs` can receive guidance that `parser-unit` and `parser-regression` passed on an earlier parser integration.

The approved goal and assignment still own the check plan and permissions. A recall packet is context data. A prior pass establishes that the checks ran and passed in the recorded integration. The protected evaluator measures deterministic recall on held-out fixture contexts and boundary cases. Check sufficiency and model task success remain unmeasured. Here, learning means storing and recalling a scoped procedure. Model training and general conversation history sit outside this workflow.

## Propose and inspect a lesson

Use the existing learning tools inside a goal that permits a native learning assignment.

1. Use `learning_get` for the goal to find the outcome of a checked, accepted coding integration. The evidence resolver verifies the original event, its digest, the accepted integration receipt, the approved definition at execution time, and the passing check results. A candidate finish that still awaits integration cannot establish this evidence. Where the approval maps checks to behavioral criteria, the resolver also requires the workflow's bound behavioral receipts. Separate candidate integration uses candidate and combined receipts. Native in-place integration uses its combined receipt.
2. Submit a learning task, start it through `native_text_start`, and use `learning_propose` under that task. Set `family` to `project_check_guidance`, `scope` to `project`, and supply the outcome IDs in `evidence`. The proposed `parameters` are:

   | Field | Value |
   | --- | --- |
   | `checkIds` | Up to 20 approved check IDs with evidence of a passing run, each at most 120 characters. |
   | `checkDefinitionHashes` | Exact canonical SHA-256 digest of each registered definition, keyed by ID. The full saved definition participates, including argv, timeout, environment fields, and screenshot settings when supplied. |
   | `relatedPaths` | Up to 20 approved repository-relative paths, each at most 240 characters. Tokens use ASCII letters and digits plus `_`, `@`, `.`, `+`, `-`, and `/`. A trailing slash indicates a directory. |
   | `whenTerms` | Up to 12 applicability terms, each at most 80 characters. Use ASCII letters and digits, with single spaces, underscores, or hyphens between words. |

   Use paths and plain terms grounded in the source assignment. The proposal rejects traversal, out-of-scope paths, additional fields, and executable instructions. The displayed content uses fixed wording derived from validated parameters. A supplied rationale gives proposal context and is excluded from the rendered lesson.

3. Run `learning_evaluate` and inspect the protected result before calling `learning_promote`. Each mutation uses the existing idempotency key and learning budget. Invalid native proposals use an attempt. Evaluation and promotion stay inside the original learning assignment deadline. Promotion revalidates the exact candidate and its evidence.

The API worker's maintenance prompt still proposes the existing `edit_batch` and `backoff_zero` families. The new-family proposal flow above uses native learning. Applicable promoted guidance reaches coding assignments through existing memory pinning and worker delivery.

## Recall, correction, and stale definitions

`memory_retrieve` explains which paths and terms matched and shows each packet's source outcome IDs, recipe hash, and version. Matching requires a scoped path and a term. It respects project identity, the coding capability version, the approved environment, and the current registered definition of every referenced check. Assignment pinning also applies the task's approved read scope. Exact file paths match as tokens. Directory paths can match descendant path tokens. Retrieval retains the four-item and 8 KiB combined limits across lesson families. It skips an individually oversized guidance packet, so smaller packets can still be returned.

A check-definition change can make a lesson inapplicable even when its check ID stays the same. Rollback may restore a previously superseded version, subject to the same checks on future recall. The project identity derives from the approved repository root path. Moving or renaming that root changes the identity, so moving lessons across those identities would require an explicit migration.

Use `learning_correct` to create a new candidate version. Evaluate that version before promotion. Use `learning_quarantine` to disable recall, `learning_rollback` on the active guidance version to withdraw it and restore eligible predecessors, or `learning_archive` to retire a version while retaining history. A task keeps the exact memory bytes pinned when its assignment started, even if later tasks see a different version or no guidance.

## Reproduce the public fixture

Run from the repository root on macOS with the existing Node and Codex sandbox prerequisites.

```sh
node --test --test-name-pattern='project guidance public lifecycle demo' test/harness-project-guidance-lifecycle.test.mjs
```

The fixture creates a temporary Git repository and coordinator. Registered parser checks execute through the real local sandbox. Mosaic checkpoints and integrates the change and records the mapped parser regression for the candidate and combined checkout. The test supplies the native edit and review decision as fixtures. It exercises Dispatcher learning tools, recall, pinning, a same-ID argv change, correction, rollback, quarantine, archive, and invalid-attempt accounting without dispatching provider inference.
