// Generated from definitions/*.json. Regenerate using docs/WORKFLOW_RECIPES.md.
export const builtins = [
  {
    "schemaVersion": 1,
    "id": "bugfix",
    "version": 1,
    "title": "Scoped bug fix",
    "mode": ["collaborative", "deepseek_only", "codex_only"],
    "parameters": {
      "issue": {"type": "text", "required": true},
      "context": {"type": "text", "required": false},
      "readPaths": {"type": "paths", "required": true},
      "writePaths": {"type": "paths", "required": true},
      "checks": {"type": "checks", "required": true}
    },
    "tasks": [
      {
        "key": "fix",
        "kind": "coding",
        "objective": {"parameter": "issue"},
        "context": {"parameter": "context"},
        "acceptance": [
          "Reproduce the reported behavior or record the evidence that narrows the cause.",
          "Correct the behavior within the approved paths and report the results of the selected protected checks."
        ],
        "dependsOn": [],
        "permissions": {
          "readPaths": {"parameter": "readPaths"},
          "writePaths": {"parameter": "writePaths"},
          "checks": {"parameter": "checks"}
        }
      }
    ],
    "provenance": {
      "source": "Mosaic",
      "description": "Keeps reproduction, correction, and protected verification in one scoped coding assignment."
    }
  },
  {
    "schemaVersion": 1,
    "id": "feature",
    "version": 1,
    "title": "Scoped feature",
    "mode": ["collaborative", "deepseek_only", "codex_only"],
    "parameters": {
      "brief": {"type": "text", "required": true},
      "acceptance": {"type": "text", "required": true},
      "readPaths": {"type": "paths", "required": true},
      "writePaths": {"type": "paths", "required": true},
      "checks": {"type": "checks", "required": true}
    },
    "tasks": [
      {
        "key": "implement",
        "kind": "coding",
        "objective": {"parameter": "brief"},
        "acceptance": [
          {"parameter": "acceptance"},
          "Report how the changed behavior meets the acceptance criterion and give the results of the selected protected checks."
        ],
        "dependsOn": [],
        "permissions": {
          "readPaths": {"parameter": "readPaths"},
          "writePaths": {"parameter": "writePaths"},
          "checks": {"parameter": "checks"}
        }
      }
    ],
    "provenance": {
      "source": "Mosaic",
      "description": "Carries a bounded feature brief, acceptance criterion, and check selection into one implementation assignment."
    }
  },
  {
    "schemaVersion": 1,
    "id": "research-comparison",
    "version": 1,
    "title": "Evidence-backed research comparison",
    "mode": "collaborative",
    "parameters": {
      "question": {"type": "text", "required": true},
      "alternatives": {"type": "text", "required": true},
      "constraints": {"type": "text", "required": true},
      "asOf": {"type": "text", "required": true}
    },
    "tasks": [
      {
        "key": "compare",
        "kind": "research",
        "objective": {"parameter": "question"},
        "context": {"parameter": "alternatives"},
        "acceptance": [
          "Apply the supplied constraints and as-of date to the alternatives described in context.",
          {"parameter": "constraints"},
          {"parameter": "asOf"},
          "Tie material comparison claims to evidence and preserve contradictions, qualifications, and unanswered questions.",
          "Submit the complete report through Mosaic\u0027s existing research review route."
        ],
        "dependsOn": []
      }
    ],
    "provenance": {
      "source": "Mosaic",
      "description": "Previews the evidence and review requirements for a research comparison while the research release gate is closed."
    }
  }
];
