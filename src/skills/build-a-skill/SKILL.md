---
name: build-a-skill
description: >
  Step-by-step guide for creating a Claude SKILL.md file. Use this skill whenever
  the user wants to build, write, draft, scaffold, or create a new skill — including
  requests like "make a skill for X", "help me write a SKILL.md", "turn this workflow
  into a skill", "how do I package this as a skill", or any time the user describes
  a repeatable workflow they want Claude to reliably follow in the future.
  Also trigger when the user wants to improve or update an existing skill.
---

# Build a Skill

A Claude skill is a Markdown file (`SKILL.md`) that teaches Claude a specialized
workflow. Skills are stored in a known directory and selectively loaded into context
when relevant — so they must be self-contained, precise, and easy to trigger.

---

## Step 1 — Capture intent

Before writing anything, understand what the skill should do. Extract answers from
the conversation first (the user may have already described the workflow). Fill any
gaps by asking:

1. What should this skill enable Claude to do?
2. What user phrases or contexts should trigger it?
3. What does a good output look like?
4. Are there edge cases, constraints, or dependencies to handle?

If the user says "turn this into a skill", extract the workflow from the conversation
history — tools used, sequence of steps, corrections made, input/output formats seen.

---

## Step 2 — Design the file structure

Three formats are supported, resolved in this order by a compliant loader:

### Format A — Folder (full, authoring format)

```
my-skill/
├── SKILL.md              ← required
├── scripts/              ← optional: reusable scripts for deterministic steps
├── references/           ← optional: large docs, loaded on demand
└── assets/               ← optional: templates, fonts, icons
```

Use this when building or editing a skill. It is the canonical authoring format and
is fully compatible with Anthropic's ecosystem (claude.ai, Claude Code, Cowork) and
with lollms.

### Format B — `.skill` archive (distribution format)

A zip of the folder above, renamed to `.skill`. This is what you share, publish to
a registry, or install. Loaders unzip to a temp directory and read `SKILL.md` there.

```bash
# Package
zip -r my-skill.skill my-skill/

# Or with the helper script
python -m scripts.package_skill path/to/my-skill/
```

### Format C — Bare `SKILL.md` (simple skills, no bundled resources)

A single `.md` file when there are no scripts, references, or assets. Treated
identically to Format A — just without the folder overhead.

```
skills/
  my-skill.md            ← bare single-file skill
```

### Loader resolution (for lollms and compatible runtimes)

```python
def load_skill(path: Path) -> SkillMeta:
    if path.is_dir():
        return parse_skill_md(path / "SKILL.md")      # Format A
    elif path.suffix == ".skill":
        with zipfile.ZipFile(path) as zf:              # Format B
            zf.extractall(tmp := Path(tempfile.mkdtemp()))
            skill_md = next(tmp.rglob("SKILL.md"))
            return parse_skill_md(skill_md)
    elif path.suffix == ".md":
        return parse_skill_md(path)                    # Format C
```

Supporting all three keeps skills portable across the ecosystem and lets simple
skills stay simple.

---

**Progressive disclosure — three loading levels (applies to Format A and B):**

| Level | What | When loaded | Size guidance |
|---|---|---|---|
| 1 | `name` + `description` | Always | ~100 words |
| 2 | `SKILL.md` body | On trigger | < 500 lines |
| 3 | `scripts/`, `references/`, `assets/` | On demand | Unlimited |

Keep the body lean. If a section would exceed ~300 lines, move it to `references/`
and add a pointer in the body ("For detailed options, read `references/advanced.md`").

---

## Step 3 — Write the SKILL.md

### Frontmatter fields

The frontmatter is freeform YAML. Only `name` and `description` are required.
Everything else is optional metadata — Claude ignores unknown fields, so you can
add whatever makes sense for your project.

```yaml
---
# ── Required ────────────────────────────────────────────────────────────────

name: skill-identifier          # kebab-case, matches the folder name

description: >
  What the skill does AND when to trigger it. Be specific about trigger
  phrases, file types, and user contexts. This is the ONLY thing Claude
  reads when deciding whether to use the skill, so make it count.
  Lean slightly "pushy" — Claude tends to under-trigger skills, so err
  toward listing more trigger contexts rather than fewer.

# ── Authorship & versioning ──────────────────────────────────────────────────

author: ParisNeo                # or "Team Acme", a GitHub handle, email, etc.
version: 1.0.0                  # semver recommended
created: 2026-04-09             # ISO date
updated: 2026-04-09

# ── Discovery & organisation ─────────────────────────────────────────────────

category: productivity/automation  # slash-separated hierarchy, general → specific
                                   # e.g. coding/python, data/visualisation
tags: [documents, pdf, export]  # free-form, used for search and filtering

# ── Runtime requirements ─────────────────────────────────────────────────────

compatibility:                  # surfaces where the skill works
  platforms: [claude.ai, claude-code, cowork]
  tools: [bash_tool, create_file]
  python: ">=3.9"
  node: ">=18"

# ── Licensing ────────────────────────────────────────────────────────────────

license: MIT                    # SPDX identifier, or "Proprietary"

# ── Icon (base64 SVG or PNG, shown in skill browsers / marketplaces) ─────────

icon: |
  data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcm...

# ── Changelog (optional, useful for shared / versioned skills) ───────────────

changelog:
  - version: 1.0.0
    date: 2026-04-09
    notes: Initial release
  - version: 1.1.0
    date: 2026-04-10
    notes: Added edge-case handling for empty inputs
---
```

**Practical notes on each field:**

- **`name`** — must match the folder name exactly; used as the unique identifier.
- **`description`** — the primary triggering mechanism. All "when to use" info goes
  here, never in the body. Keep under ~150 words; longer descriptions still work but
  reduce the signal-to-noise ratio.
- **`author`** — freeform; useful when skills are shared or published to a registry.
- **`version`** — use semver (`MAJOR.MINOR.PATCH`). Bump MINOR for new capabilities,
  PATCH for fixes, MAJOR for breaking changes to inputs/outputs.
- **`category`** — slash-separated path from general to specific, e.g.
  `coding/python`, `data/visualisation`, `productivity/automation`.
  Use as many levels as needed; the UI collapses to the top level when browsing
  and expands for filtering. Top-level buckets: `coding`, `writing`, `data`,
  `productivity`, `research`, `creative`, `devops`, `media`.
- **`tags`** — array of lowercase strings; used by skill browsers and search tools.
- **`compatibility`** — documents requirements so users know what's needed before
  installing. `platforms` lists surfaces (`claude.ai`, `claude-code`, `cowork`).
- **`license`** — use an [SPDX identifier](https://spdx.org/licenses/) for open
  skills, or `"Proprietary"` with a `LICENSE.txt` in the folder.
- **`icon`** — a base64-encoded SVG or PNG embedded directly in the frontmatter.
  SVG is preferred (smaller, scales cleanly). To encode:
  ```bash
  # SVG
  echo "data:image/svg+xml;base64,$(base64 -w0 icon.svg)"
  # PNG
  echo "data:image/png;base64,$(base64 -w0 icon.png)"
  ```
  Keep icons small: 64×64 px PNG or a compact SVG. A 64px PNG gzips to ~1–3 KB,
  which is fine in a YAML block.
- **`changelog`** — structured history; useful when you distribute skills to a team
  and want users to know what changed between versions.

**All "when to use" information goes in `description`.** Never put trigger conditions
in the body — Claude won't see them at decision time.

### Body structure

Start with a one-sentence summary of what the skill does. Then lay out the workflow
in numbered steps. Use imperative form ("Read the file", "Write the output to…").

**Useful patterns:**

*Defining output format:*
```markdown
## Output format
ALWAYS use this exact structure:
# [Title]
## Summary
## Steps
## Notes
```

*Including examples:*
```markdown
## Example
Input: "added retry logic to the API client"
Output: `fix(api): add retry logic with exponential backoff`
```

*Domain variants (multiple frameworks/languages):*
Instead of one giant body, put a short router in `SKILL.md` and details in
`references/`:
```
cloud-deploy/
├── SKILL.md         ← reads user intent, picks a variant, loads the right ref
└── references/
    ├── aws.md
    ├── gcp.md
    └── azure.md
```

*Scripts over prose:* If a step is deterministic and repetitive (file transforms,
installs, data processing), write it once as a script in `scripts/` and tell Claude
to execute it rather than re-deriving the logic from prose each time.

### Writing style

- Explain the **why** behind instructions, not just the **what**. Claude is smart —
  understanding the reasoning produces better results than rigid rules.
- Prefer "explain why X matters" over bolded MUST/NEVER in all-caps.
- Write a draft, then read it with fresh eyes and trim anything not pulling its weight.
- Use theory of mind: imagine a capable model reading this cold — will it know what
  to do in edge cases?

---

## Step 4 — Test the skill

Come up with 2–3 realistic test prompts — the kind of thing a real user would type.
Run Claude on those prompts with the skill available, and evaluate:

- Does the output match the expected format?
- Did Claude follow the workflow, or skip steps?
- Are edge cases handled correctly?

For skills with objectively verifiable outputs (file transforms, code generation,
data extraction), write explicit assertions:

```json
{
  "skill_name": "my-skill",
  "evals": [
    {
      "id": 1,
      "prompt": "...",
      "expected_output": "...",
      "assertions": [
        { "text": "Output file exists at expected path", "type": "file_exists" },
        { "text": "Title section is present", "type": "contains_string" }
      ]
    }
  ]
}
```

For subjective skills (writing style, design), qualitative human review is more
useful than assertions.

---

## Step 5 — Iterate

After reviewing test results:

1. Generalize from feedback — don't over-fit to the specific test cases
2. Remove instructions that aren't pulling their weight
3. If multiple test runs independently wrote the same helper script, bundle it
   in `scripts/` and reference it from the skill
4. Re-run tests, compare outputs, repeat until satisfied

---

## Step 6 — Optimize the description (optional)

The `description` field is the triggering mechanism. Once the skill content is solid,
consider generating 15–20 trigger-eval queries (a mix of should-trigger and
should-not-trigger) and testing whether the description reliably discriminates.

Focus negative test cases on **near-misses** — queries that share keywords with the
skill but actually need something different. Obvious negatives ("write a fibonacci
function" for a PDF skill) don't test anything useful.

Refine the description based on what fails.

---

## Step 7 — Package and install

```bash
# Package into a .skill archive (zip)
python -m scripts.package_skill path/to/my-skill/
# — or —
zip -r my-skill.skill my-skill/
```

**Install locations by runtime:**

| Runtime | Path |
|---|---|
| claude.ai / Cowork | `/mnt/skills/user/my-skill/` (folder) |
| Claude Code | `~/.claude/skills/my-skill/` (folder) |
| lollms | `<lollms_data>/skills/my-skill/` (folder, `.skill`, or bare `.md`) |

lollms resolves all three formats automatically — drop whichever form makes sense:
folder for development, `.skill` for distribution, bare `.md` for simple one-file skills.

---

---

## Category taxonomy

Categories use slash-separated paths: `top/sub/leaf`. The registry indexes on the
full path; UIs collapse to the top level for browsing and expand for filtering.
2–3 levels is usually sufficient.

```
coding/
  python / javascript / typescript / rust / go / cpp / java
  web / backend / cli / embedded
  testing / debugging / refactoring / docs
data/
  analysis / visualisation / etl / ml / sql
writing/
  technical / creative / academic / marketing / email
productivity/
  automation / scheduling / summarisation / search
research/
  web-search / literature / fact-checking
devops/
  ci-cd / docker / kubernetes / cloud / monitoring
media/
  image / audio / video / pdf / office
```

Unknown top-level buckets are valid — the registry files them under `other/`.

## Quick reference — SKILL.md template

```markdown
---
name: my-skill
description: >
  [One sentence of what it does.] Use this skill whenever [trigger contexts,
  be specific]. Also trigger for [additional contexts, edge cases].

author: your-name
version: 1.0.0
created: 2026-04-09
category: productivity/automation  # slash-separated, e.g. coding/python/testing
tags: [tag1, tag2]
license: MIT
compatibility:
  platforms: [claude.ai, claude-code, cowork, lollms]
  tools: [bash_tool, create_file]
icon: |
  data:image/svg+xml;base64,...  # optional, base64-encoded SVG or PNG
---

# My Skill

[One-sentence summary.]

## When to use
[Only if there's nuance not captured in description — otherwise omit.]

## Steps

1. [First step — imperative, explains why if non-obvious]
2. [Second step]
3. [Third step — reference a script if deterministic: "Run `scripts/transform.py`"]

## Output format

[Exact structure Claude should produce.]

## Examples

Input: ...
Output: ...

## Edge cases

- [Edge case 1]: [how to handle]
- [Edge case 2]: [how to handle]
```