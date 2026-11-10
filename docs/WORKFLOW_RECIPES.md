# Workflow recipes

A recipe expands a versioned JSON template into Mosaic's existing workflow tasks. It uses the scope, mode, checks, limits, and deadline of a saved goal. Preview shows the expanded graph before submission. A launchable preview can be submitted inside the exact active approval. The workflow then follows the goal mode's existing check, review, and integration rules.

| Recipe | Modes | Parameters |
| --- | --- | --- |
| bugfix v1 | collaborative, deepseek_only, codex_only | issue, optional context, readPaths, writePaths, checks |
| feature v1 | collaborative, deepseek_only, codex_only | brief, acceptance, readPaths, writePaths, checks |
| research-comparison v1 | collaborative preview | question, alternatives, constraints, asOf |

The coding recipes each create one cohesive assignment. Collaborative and DeepSeek-only coding use the approved API worker. Codex-only coding waits for a native host. The selected goal mode determines review and acceptance.

Research comparison previews a research assignment with evidence, qualifications, contradictions, and full-report review requirements. The research release gate keeps submission closed. Beta can also report missing research capability in the saved goal. Overnight review uses its dedicated workflow. In overnight v2 the approved planner owns the stage graph, so recipe submission is unavailable in that mode.

## List and inspect

From a source checkout with the harness dependencies available, pass the state directory of the running coordinator. The CLI uses its existing authenticated loopback transport.

```sh
STATE_DIR=/absolute/path/to/coordinator-state
node scripts/mosaic-workflow-recipes.mjs list --root "$STATE_DIR"
node scripts/mosaic-workflow-recipes.mjs inspect --root "$STATE_DIR" --id bugfix --version 1
```

The catalog shows each version's digest and provenance. Inspect returns the complete definition. The same operations are available as the coordinator tools `workflow_recipe_list`, `workflow_recipe_inspect`, `workflow_recipe_preview`, and `workflow_recipe_submit`.

## Preview and submit

Save the following input as `preview-input.json`, replacing the goal ID and example parameters. The goal must approve the listed paths and register the listed check IDs. Include any checks required by approved behavioral mappings.

```json
{
  "goalId": "goal-id-from-your-approval",
  "recipeId": "bugfix",
  "version": 1,
  "parameters": {
    "issue": "Return 42 from the answer module",
    "context": "The fixture currently exports zero.",
    "readPaths": ["src/answer.mjs", "checks/verify.mjs"],
    "writePaths": ["src/answer.mjs"],
    "checks": ["verify"]
  }
}
```

```sh
node scripts/mosaic-workflow-recipes.mjs preview --root "$STATE_DIR" \
  --input preview-input.json > preview.json
```

Inspect the exact `resolvedDefinition`, the task dependencies, the requested paths and check IDs, and any `diagnostics`. A preview can be structurally valid and compatible while a goal awaits approval or a release gate is closed. Check `launchable` before submitting. For an active collaborative goal with the example scope and check registered, the preview includes these fields.

```json
{
  "validTemplate": true,
  "compatible": true,
  "launchable": true,
  "mode": {"id": "collaborative", "version": 1},
  "diagnostics": [],
  "requirements": {
    "mode": "collaborative",
    "tasks": [
      {
        "key": "fix",
        "kind": "coding",
        "actor": "deepseek",
        "permissions": {
          "readPaths": ["src/answer.mjs", "checks/verify.mjs"],
          "writePaths": ["src/answer.mjs"],
          "checks": ["verify"]
        }
      }
    ]
  }
}
```

After reviewing the preview, copy its exact digests and saved approval hash into the submission. Keep the recipe version and parameters identical. This command generates the submission JSON from the two files.

```sh
node --input-type=module <<'NODE' > submit-input.json
import {readFileSync} from 'node:fs';
const input = JSON.parse(readFileSync('preview-input.json', 'utf8'));
const preview = JSON.parse(readFileSync('preview.json', 'utf8'));
if (!preview.launchable) throw Error('Review preview diagnostics before submitting');
const {goalHash, definitionDigest, parameterDigest, previewDigest} = preview;
console.log(JSON.stringify({
  ...input, expectedGoalHash: goalHash, definitionDigest, parameterDigest, previewDigest,
  submissionId: 'fix-answer'
}, null, 2));
NODE
node scripts/mosaic-workflow-recipes.mjs submit --root "$STATE_DIR" \
  --input submit-input.json --idempotency-key fix-answer-request
```

The receipt includes the workflow run ID, task IDs, and pinned definition, parameter, preview, and resolved digests. A submission is atomic. An exact retry returns the same receipt and task IDs. Changing the parameters or approval requires a fresh preview. Use a new submission ID and idempotency key for independent work. Use `task_get` to read a created task and its saved checks.

## Add a data-only recipe

Place a definition in `src/harness/workflow-recipes/definitions/` as `<id>.v<version>.json`, then regenerate the runtime catalog. Use an explicit ID, version, and supported mode ID or array. The graph uses the existing workflow engine. Stable task keys are at most 76 characters and can be referenced in `dependsOn`. Existing workflows have a ten-task ceiling and each goal can approve a smaller cap.

For example, this complete definition creates one task in Codex-only mode. The project must already approve both paths and register the `verify` check.

```json
{
  "schemaVersion": 1,
  "id": "answer-maintenance",
  "version": 1,
  "title": "Maintain the answer module",
  "mode": "codex_only",
  "parameters": {
    "issue": {"type": "text", "required": true}
  },
  "tasks": [
    {
      "key": "fix",
      "kind": "coding",
      "objective": {"parameter": "issue"},
      "acceptance": ["The approved verification check passes."],
      "dependsOn": [],
      "permissions": {
        "readPaths": ["src/answer.mjs", "checks/verify.mjs"],
        "writePaths": ["src/answer.mjs"],
        "checks": ["verify"]
      }
    }
  ],
  "provenance": {
    "source": "Project maintainers",
    "description": "A small maintenance assignment scoped to the answer module."
  }
}
```

The compiler accepts bounded text, path lists, check ID lists, and enumerations. A definition can declare up to 20 parameters. Each definition, parameter object, and resolved graph has a 256 KiB limit in canonical JSON. A parameter reference occupies the entire supported value position. Literal strings remain literal. Checks are registered IDs whose commands come from the approved goal. Provenance describes where the definition came from. Change a released definition by adding a new version and keeping its prior version in the catalog. The first successful submission pins the version digest in coordinator state. Earlier workflow instances retain their exact resolved tasks and digests.

The JSON files are the source for the catalog. The standalone package includes the generated JavaScript module through its static import. From the repository root, run the following command and commit the resulting `catalog.mjs` alongside the JSON changes.

```sh
node --input-type=module <<'NODE'
import {readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {validateRecipeDefinition} from './src/harness/workflow-recipes/schema.mjs';
const root = 'src/harness/workflow-recipes';
const files = readdirSync(root + '/definitions').filter(file => file.endsWith('.json')).sort();
const definitions = files.map(file => {
  const source = readFileSync(root + '/definitions/' + file, 'utf8');
  validateRecipeDefinition(JSON.parse(source));
  // Keep prose outside the Beta packager's static import matcher.
  return source.replace(/'/g, '\\u0027').trim().split(/\r?\n/).map(line => '  ' + line).join('\n');
});
writeFileSync(root + '/catalog.mjs',
  '// Generated from definitions/*.json. Regenerate using docs/WORKFLOW_RECIPES.md.\n' +
  'export const builtins = [\n' + definitions.join(',\n') + '\n];\n');
NODE
```

## Run the disposable demo

The complete demo uses Node 24+, Git, and the existing macOS Codex CLI sandbox. Choose a new output directory under a parent you own.

```sh
DEMO_PARENT="$(mktemp -d)"
node scripts/mosaic-workflow-recipes.mjs demo --output "$DEMO_PARENT/evidence"
cat "$DEMO_PARENT/evidence/demo.json"
```

The demo starts an isolated authenticated loopback coordinator with disposable state and a Git fixture. It previews the bug fix, rejects a changed-parameter submission before any task exists, submits and replays the exact request, and reads the saved task to verify its scope. A deterministic worker response supplies the patch. The protected check runs in the actual local sandbox on the candidate and combined integration workspace. The fixture driver records the review decision. The demo also saves a research preview with the gate diagnostic. It removes the coordinator state and Git fixture and leaves the evidence JSON in the chosen directory.
