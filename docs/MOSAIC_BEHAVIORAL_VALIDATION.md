# Behavioral validation in Mosaic

A coding goal can map a user-visible acceptance criterion to the protected
checks that exercise it. A build can confirm that the export code parses, and
a unit test can confirm CSV quoting. A separate check can click **Export** and
verify the bytes the browser downloads.

Add `behavioralChecks` to the approved `project` alongside its existing
literal `checks`. This example maps two declared checks, `csv-unit` and
`csv-download`, to one criterion.

```json
{
  "behavioralChecks": [
    {
      "criterionId": "selected-rows-download",
      "description": "Export downloads the selected rows with valid CSV quoting.",
      "checkIds": ["csv-unit", "csv-download"]
    }
  ]
}
```

The exact approval hash covers the mapping. Omit the field to keep the original
approval and check behavior. The mapping accepts 1–32 criteria, each with a
unique stable identifier of at most 120 characters, a nonblank description of
at most 512 characters, and 1–16 distinct IDs of declared checks. Only the
declared checks supply commands and artifact paths. Use plain descriptions
of the expected behavior and keep credentials out of the manifest. Keep the check scripts in
protected paths such as `checks/` and include their inputs in the approved
read scope.

In Overnight v2, each intermediate stage uses its applicable approved checks,
including preflight and checks carried forward from accepted stages. Put gates
that require the completed application in `overnightPolicy.finalOnlyCheckIds`.
The final stage runs all project checks. Outside Overnight v2, a coding
assignment's check scope must include every mapped check.

The background reviewer receives `evidence.behavioralEvidence` alongside
literal check receipts, output and declared artifacts. Each criterion shows
its description, mapped check IDs and their outcomes against the recorded
candidate snapshot and Git executable bits. All mapped checks must pass for a criterion to pass.
A missing result is `not_run`. An intermediate stage can report `not_run`
with reason `not_due` for checks outside that stage's gate. Due failures or
missing receipts prevent a new review reservation. The prepared review
evidence is bounded to 1 MiB.

Integration verifies the checked candidate again and runs the applicable
checks against the combined result. Its saved record carries behavioral
evidence for the integration snapshot and links to the integration commit.
A successful candidate run alone cannot certify the combined result. Mosaic
checks that the approved readable files and their Git executable bits
match the recorded tree. Mapped integrations require Git executable-bit
tracking before they commit and decline clean conversions that change
checked bytes. They also decline CRLF checkout settings and applicable
Git filter, ident, or working-tree encoding attributes. Receipts describe
the checked workspace and Git tree under those settings.

The mapping's coverage is limited to the behavior the approved checks exercise.
The existing mode-specific review and acceptance rules still apply.

## Run the CSV download fixture

From the repository root on macOS with the Codex CLI on PATH for
`codex sandbox`, prepare the pinned dependencies and Chromium locally.

```sh
npm ci --ignore-scripts
PLAYWRIGHT_BROWSERS_PATH="$PWD/node_modules/.cache/ms-playwright" \
  node node_modules/playwright/cli.js install --only-shell chromium
MOSAIC_REQUIRE_BROWSER=1 node --test test/mosaic-validation-browser.test.mjs
```

The fixture runs the same protected build, unit and browser checks before and
after a scoped edit. The build and unit tests pass in both runs. The first
browser run detects an unselected row in the download. After the edit,
Chromium clicks the same button and downloads the expected filename and CSV
bytes. Playwright serves the tiny fixture through intercepted routes in the
browser, which keeps the production check sandbox's network denial in force.
The ordinary test suite reports a skip if the required browser environment is
unavailable. The explicit command above requires it.

The implementation borrows the practice of exercising a running application at
defined milestones and keeps the reviewer's decision separate from executed
checks. The code was written for Mosaic. [Factory Planning & Validation](https://docs.factory.com/missions/planning),
[bob's acceptance policy](https://github.com/yonk-labs/bob/blob/71ee07ffe9c1441513c2a3c095b98d0a804ef5c9/src/engine.rs#L212).
