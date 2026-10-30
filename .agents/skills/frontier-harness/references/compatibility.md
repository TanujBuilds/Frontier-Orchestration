# Legacy and overnight routing

Inspect the existing record before choosing an execution backend. Saved legacy
JSONL overnight jobs, task-queue entries and research SQLite submissions retain
their original IDs, approval hashes, deadlines and consumed counters. Never
resubmit them as new harness goals or run a competing scheduler for the same work.

| Existing entry | Historical records | New unified goal |
| --- | --- | --- |
| overnight-build | Existing project CLI/coordinator and saved stage approvals | Explicit `overnight_review` via installed MCP |
| task-queue | Existing queue CLI and job approvals; no research | Harness `task_submit`/priorities/dependencies |
| deep-research | Its configured research CLI/remote submission and collection | Harness research task through same MCP |
| deepseek-delegate | Existing personal configuration and documented record backend | `frontier-collaborate` |

Personal deepseek-delegate sources/configs are not portable vendored inputs. Do
not overwrite/install them from this package. Legacy entry docs remain in the
reviewed checkout; the package carries this compatibility route and the Python
research bridge, without private settings or silently copying personal skills.
If a historical entry is absent, inspect its actual installation before use.

`overnight_review` retains DeepSeek planning/implementation and automatic
check-gated Codex CLI review, max2reviews/stage. It grants no native implementation,
Codex repair, takeover or supervisor-answer fallback. Optional one-call pre-stage
guidance belongs to explicitly authorized legacy workflow controls. Never select
this mode just to keep a collaborative chat reviewing after closure.

One harness-managed DeepSeek task executes globally. Independent historical
clients/startup-scout can still compete; coordination with them is best effort.
Inspect/stop or defer those clients through their own authorized controls before
claiming exclusive execution. The two Sparks serve one distributed model.
No changes to Spark runtime configuration belong to routing or package setup.
