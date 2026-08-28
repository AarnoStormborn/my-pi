---
name: project-recap
description: >
  Build a complete recap of a project: writes .recap/design.md, .recap/plan.md,
  .recap/arch.md, .recap/arch/*.mmd (mermaid diagrams), and .recap/status.md at
  the repo root, then reports the full project status in chat. Use when the
  user says "project recap", "recap this project", "project status", "what's
  the state of this project", "architecture overview", "explain the
  architecture", "generate design/plan/architecture docs", or asks for a full
  picture of a codebase.
---

# Project Recap

Build a full, file-based recap of a project in a `.recap/` folder at the repo
root, and report the project's status in chat.

## What it produces

```
.recap/
├── design.md          # what the project is + design decisions
├── plan.md            # milestones, done/in-progress/planned, next actions
├── arch.md            # architecture narrative + diagram references
├── arch/              # mermaid diagram files (.mmd)
│   ├── architecture.mmd
│   ├── data-flow.mmd
│   ├── deployment.mmd (only if deployment topology exists)
│   └── sequence.mmd   (only if a request lifecycle is worth showing)
└── status.md          # full status report (meta, git, tests, scan)
```

## When to trigger

- "project recap", "recap this project", "project status", "what's the state
  of this project"
- "architecture overview", "explain the architecture", "generate design/plan
  docs", "give me the full picture"
- User hands you an unfamiliar codebase and wants an overview

## Workflow

### 1. Locate root & check .recap

- Determine project root: `git rev-parse --show-toplevel` if in a repo,
  otherwise the working directory.
- If `.recap/` already exists, ASK the user (use the `ask` tool):
  - **Overwrite** in place,
  - **Archive** current to `.recap/archive/YYYY-MM-DD/` then regenerate, or
  - **Skip** (just report status in chat).
- Create `.recap/` and `.recap/arch/` if needed.

### 2. Gather project meta

- Root listing + 2-level structure; note key entrypoints.
- README (first ~100 lines; note if missing or thin).
- Manifests: package.json, pyproject.toml, Cargo.toml, go.mod,
  requirements.txt, Gemfile, pom.xml, etc. Read the relevant one(s) — name,
  version, scripts, dependencies, toolchain.
- Infra: Dockerfile / docker-compose.yml, CI workflows
  (.github/workflows, etc.).

### 3. Gather git health

Run these (skip gracefully if not a git repo):
- `git branch --show-current` and `git status -sb` (ahead/behind, counts)
- `git log --oneline -15` and last-commit detail
- `git log --since="14 days ago" --pretty=format:'%h %ad %s' --date=short`
- `git remote -v`

### 4. Tests & build (best effort)

- Detect commands: package.json `scripts.test` / `scripts.build`, Makefile
  targets, pytest (pyproject.toml / tox.ini), `cargo test`, `go test ./...`,
  `mvn test`.
- Run with a generous timeout (~3 min). Report pass/fail + failure summary.
- If none detected, or running would be slow or state-changing, note "not run"
  and why. Never run commands that modify state (no migrations, no installs).

### 5. Code scan

- TODO/FIXME/HACK/XXX inventory (exclude node_modules, .git, lockfiles):
  counts + top offenders with paths.
- Dependency summary: count + notable packages from manifests.
- Docs coverage: README, docs/ dir, missing docs for key modules.
- File-type distribution: `find . -type f | sed 's/.*\.//' | sort | uniq -c |
  sort -rn | head -15` (adjust for dotfiles).

### 6. Write the docs (do NOT paste content into chat)

Use the `write` tool for each file, filling in the templates in
`assets/templates/` (relative to this skill directory). Adapt sections to the
real project; drop sections that don't apply.

- `.recap/design.md`  ← `assets/templates/design.md`
- `.recap/plan.md`    ← `assets/templates/plan.md`
- `.recap/arch.md`    ← `assets/templates/arch.md`
- `.recap/status.md`  ← `assets/templates/status.md`

### 7. Mermaid diagrams

Write separate `.mmd` files under `.recap/arch/` and link them from `arch.md`:

- `architecture.mmd` — component diagram: clients, services, stores, annotated
  with the real tech from the manifests.
- `data-flow.mmd` — end-to-end request/data flow through components.
- `deployment.mmd` — only if deployment topology exists (docker compose,
  cloud, etc.).
- `sequence.mmd` — only for projects with a notable request lifecycle.

Keep each diagram to ~10–20 nodes; use `flowchart` or `sequenceDiagram`
syntax with concrete labels from the actual code. Diagrams must be valid
mermaid.

### 8. Chat reply (digest only)

Reply with:
- A heading line like `Project recap → .recap/`
- 4–8 tight bullets: status highlights (branch/commit, tests pass/fail, TODO
  count, biggest risks) and immediate next actions.
- Do NOT paste the doc contents; point at the files.

## Notes

- Files are written with `write`, keeping the transcript small.
- Content comes from the live project (git, files, tests) — re-scan rather
  than guess. If a fact is uncertain, mark it `[unverified]`.
- Regeneration asks the user each time (overwrite / archive / skip).
- Never modify project files other than creating/updating `.recap/`.
