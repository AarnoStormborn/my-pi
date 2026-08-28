# project-recap

Global Agent Skill that builds a full recap of any project: design, plan,
architecture (with mermaid diagrams), and a complete status report — written to
a `.recap/` folder at the project root, with a short digest reported in chat.

## What it produces

| File | Purpose |
|------|---------|
| `.recap/design.md` | What the project is, components, design decisions |
| `.recap/plan.md` | Milestones, done / in-progress / planned, next actions |
| `.recap/arch.md` | Architecture narrative + links to diagrams |
| `.recap/arch/*.mmd` | Mermaid diagrams: architecture, data-flow, deployment, sequence |
| `.recap/status.md` | Full status: project meta, git health, tests/build, code scan, risks |

## Trigger

Say "project recap", "project status", "recap this project", "architecture
overview", "give me the full picture", etc.

## Installation

Installed: the skill lives in `~/.agents/skills/project-recap/`, which Pi scans
automatically. After adding or editing it, use `/reload` in Pi.

## Notes

- Regeneration asks whether to overwrite, archive, or skip when `.recap/`
  already exists.
- Diagrams are plain `.mmd` files; render with
  `npx @mermaid-js/mermaid-cli -i arch/architecture.mmd -o arch/architecture.svg`
  or paste into <https://mermaid.live>.
