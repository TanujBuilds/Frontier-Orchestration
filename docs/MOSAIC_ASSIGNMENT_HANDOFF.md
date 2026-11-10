# Mosaic assignment handoff

The repository-local [assignment skill](../.agents/skills/mosaic-assignment/SKILL.md) turns a substantial coding request into a draft the owner can review. The chat supplies structured facts from the conversation. `assignment_prepare` checks readiness deterministically and saves the draft through the existing coordinator.

## Existing and added behavior

| Area | Existing Mosaic | Added by assignment preparation |
| --- | --- | --- |
| Conversation | Onboarding chooses the current explicit mode, the active goal's pinned mode, or an explicitly owner-saved project preference, in that order. | A repository-local skill carries those choices into intake and turns readiness issues into one grouped clarification. |
| Checkout and permissions | `goal_prepare` and `normalizeGoal` accept the canonical manifest, including the exact base commit, approved paths and protected checks. | The facade resolves the committed base of the approved checkout read-only and reports missing or unsafe inputs. Dirty or unborn checkouts are left intact. |
| Draft and approval | The coordinator saves the normalized manifest and its exact hash, with existing submission identity and idempotency checks. `goal_activate` uses that hash. | The facade returns the same goal ID and hash with a bounded review summary. Matching retries replay the prepared result. |
| Execution and acceptance | Pinned modes, protected checks, exact authorization, and existing review and integration controls govern work. | Preparation saves a draft with zero model or reviewer calls. A saved draft has no active deadline or task. |
| Follow-ups | `goal_get`, `queue_get`, `questions_list`, `task_get`, `task_evidence`, and `artifacts_list` read saved state. | The skill uses those stable IDs to answer ordinary status and result questions. |

The facade takes `{manifest, idempotencyKey}`. The manifest uses the existing coding goal fields and may be partial. Supply a stable `submissionId` and omit `project.baseCommit` to resolve it from the approved checkout's `HEAD`. A supplied base must match. Use repository-relative read and write paths, with a trailing slash for directory scope. Write scope must fit inside read scope. Check commands use literal `argv` without environment overrides.

Checkout readiness uses bounded, read-only Git checks of the intended root, committed `HEAD`, index and worktree. An absolute alias for the checkout root resolves to the canonical path saved in the draft. The facade reports an issue for a dirty or unborn checkout, a moving `HEAD` during inspection, or an index that prevents reliable verification. Submodules and index entries marked `skip-worktree` or `assume-unchanged` are unsupported. A timeout or other verification failure also leaves the request unprepared. The checkout stays intact for the owner to resolve the issue.

The intake reports outstanding requirements together as `{status: "needs_input", issues: [{code, field, message}]}`. Once complete it returns `status: "prepared"`, `goalId`, the exact `hash`, and `summary`. Use `goal_get` with `goalId` to inspect the complete normalized record, including read scope and check arguments. Retry an identical request with its original key to recover the original result. After successful preparation, that key rejects changes to scope, checks, limits, or mode. A changed draft needs a new submission ID and key, then approval of the resulting hash. An existing active goal uses the existing revision flow.

The facade pins Collaborative, DeepSeek-only and Codex-only to v1. Overnight review defaults to v2 and accepts historical v1 with an explicit `modeVersion: 1`. Other registered versions are outside the facade's supported modes.

The summary identifies the roles selected by the pinned mode. Collaborative uses main Codex planning, scoped Codex and DeepSeek implementation, and main Codex review. DeepSeek-only uses DeepSeek planning and implementation with protected checks governing acceptance. Codex-only uses native Codex planning, implementation and review. Overnight v2 uses DeepSeek planning and implementation, with bounded Codex review after protected checks pass. Provider and model readiness remain unverified during preparation.

The exact prepared record controls what may run. Scope includes the checkout and base, readable and editable paths, literal check arguments, and numerical limits. Keep any host file inspection within approved nonsecret paths. A package script can be proposed as a check and requires the same approval as any other check. For overnight v2, the existing separately authorized `overnight_preflight` must pass before activation. For every mode, send the exact prepared `goalId` and `hash` to `goal_activate` only when matching explicit authorization already exists. If authority is missing, present the summary and ask for the specific remaining approval. Review and integration still depend on the pinned mode and its evidence gates.

## Complete example

> Prepare CSV export in this clean checkout using DeepSeek-only. The export should include every row. Allow reads from `src/`, `checks/`, `README.md` and `package.json` and writes only under `src/`. Use `node checks/verify.mjs` as the protected check. Allow one hour, two assignments, and zero Codex reviewer runs.

The host supplies the resolved root of the disposable checkout in place of the example path. The Git base comes from `HEAD`.

```json
{
  "idempotencyKey": "prepare-csv",
  "manifest": {
    "submissionId": "add-csv",
    "objective": "Add CSV export",
    "acceptance": ["Export includes every row"],
    "mode": "deepseek_only",
    "project": {
      "repo": "/example/committed-csv-fixture",
      "readPaths": ["src/", "checks/", "README.md", "package.json"],
      "writePaths": ["src/"],
      "checks": [{"id": "verify", "argv": ["node", "checks/verify.mjs"]}]
    },
    "limits": {"hours": 1, "maxTasks": 2, "reviewAgentRuns": 0}
  }
}
```

The chat can report that CSV export is prepared for the resolved checkout and base, with `node checks/verify.mjs` as the protected check and edits confined to `src/`. DeepSeek will plan and implement within one hour and two assignments, with checks governing acceptance and zero Codex reviewer runs. The record remains a draft pending start authorization. The chat retains the ID and hash for that action.

## Missing-input example

> Prepare CSV export in the other checkout. The export should include every row.

The checkout reference is unresolved. This fixture uses an absolute path that does not exist so the transport exercise also checks repository resolution.

```json
{
  "idempotencyKey": "missing-details",
  "manifest": {
    "submissionId": "add-csv",
    "objective": "Add CSV export",
    "acceptance": ["Export includes every row"],
    "project": {"repo": "/example/unresolved-csv-checkout"}
  }
}
```

`needs_input` identifies the mode, repo, read scope, write scope, check and all three goal caps. The chat can ask in one turn.

> Which workflow should CSV export use (Collaborative, DeepSeek-only, Codex-only, or Overnight review), and which committed checkout should Mosaic use? Please confirm what Mosaic may read, what it may edit, the command that should verify the export, and the caps for hours and assignments. If you choose Collaborative or Codex-only, also confirm the cap for Codex reviewer runs.

The coordinator saves no draft, activation or provider request for this response. After the owner resolves the issues, the chat carries those answers into preparation and shows the exact draft for approval if needed.

## Required user decisions

These counts compare decisions remaining after each quoted request. Each scope and each discretionary cap counts separately, even if the owner confirms several values together. Exact start approval counts once because neither request grants it. Submission IDs, mutation keys and resolved Git hashes are host details in both workflows.

| Example | Before | With the assignment facade |
| --- | --- | --- |
| Complete | **1** start approval after exact preparation | **1** start approval, with the concise review summary and base resolved by intake |
| Missing input | **8–9** decisions. Mode, checkout, read scope, write scope, check, two or three caps, and later start approval. | **8–9** decisions. Intake reports the unresolved fields together, then the exact draft is available for the later approval. |

DeepSeek-only and Overnight review fix the optional Codex reviewer-run cap at zero. For Overnight review, the automatic check-gated reviews use their own existing policy. The table counts the common intake and start decisions. Any mode-specific prerequisites, including overnight v2 preflight authorization, follow the existing workflow. These are scenario counts. Live usability remains unmeasured.

## Reproduce with a disposable coordinator

Run the transport test from the repository with Node 24 or newer.

```bash
node --test --test-concurrency=1 test/mosaic-assignment.test.mjs
```

The [test](../test/mosaic-assignment.test.mjs) uses an authenticated loopback coordinator, temporary Git checkouts and dummy provider settings. The same transport is available through the existing `node src/harness/cli.mjs call --root STATE_DIR --tool assignment_prepare --input REQUEST_JSON` command against that disposable service. `goal_get` verifies the saved draft and exact hash. The fixture checks preparation and retrieval without activating a goal or contacting a real provider. Release installation, fresh-host skill discovery and live-provider readiness require separate evidence. A saved event is visible on the next host turn or through bounded observation, and an inactive native chat stays inactive.

## Source references

- cc-delegate illustrates supervisor input, preparation diagnostics, and question and result retrieval by task ID. Mosaic applies those ideas with read-only intake. Executable preflight remains a separately authorized Mosaic operation. [Server interface](https://github.com/EtienneLescot/cc-delegate/blob/367edf37b8c1eb8d0241153de0e75344293c44e6/server/main.py), [preflight diagnostics](https://github.com/EtienneLescot/cc-delegate/blob/367edf37b8c1eb8d0241153de0e75344293c44e6/server/preflight.py)
- Augani illustrates compact worker briefs and questions tied to durable job IDs. Mosaic adapts the interaction through its own mode, approval and acceptance controls. [Orchestration skill](https://github.com/Augani/agent-orchestrator/blob/8d9b897c49500e8e1b54ec8028352544db95618d/plugins/agent-orchestrator/skills/orchestrate-cli-agents/SKILL.md)

The facade and skill were written against Mosaic's own contracts. The upstream sources supplied interaction ideas.
