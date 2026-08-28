# my-pi

My personal [pi coding agent](https://github.com/badlogic/pi-mono) configuration, packaged as a portable git repo. This repo is the **source of truth**; the live config under `~/.pi` and `~/.agents` is symlinked into it, so edits here take effect immediately (extensions on `/reload` or restart).

## Layout

```
my-pi/
├── pi/
│   ├── settings.json           # pi agent settings (theme, models, packages, skill allowlist)
│   └── agent/
│       ├── pi-coding-agent.svg # banner icon asset
│       └── extensions/
│           ├── startup-banner.ts  # custom ASCII startup banner (git branch, dirty state)
│           ├── atuin.ts           # atuin shell history hook for bash tool (no-ops without atuin)
│           └── ask/               # ask + questionnaire tools (interactive clarifying questions)
├── skills/                     # agent skills installed to ~/.agents/skills
│   ├── caveman*                # token-efficient communication mode family (6 skills)
│   ├── cavecrew/               # caveman-style subagent delegation decision guide
│   ├── pr-readiness/           # PR prep: lint, rebase, validate changeset
│   ├── project-recap/          # full project recap w/ design/plan/arch docs
│   └── session-recap/          # session summary + next steps (file-based, transcript-safe)
└── install.sh                  # wires symlinks; --status / --restore
```

## Install on a new machine

```bash
git clone <this-repo> ~/my-pi
cd ~/my-pi
./install.sh              # creates symlinks, backs up existing real files
```

Then restart pi or run `/reload`.

Notes:
- **atuin** (optional): run `atuin hook install pi` to record bash tool commands in atuin history. The extension no-ops safely without atuin installed.
- **MCP servers** are deliberately *not* managed by this repo (`~/.pi/mcp.json` stays local).
- **auth.json**, caches, and sessions are machine-local and never packaged.
- **npm packages** (`pi/` packages list in settings.json) are installed by pi's own package manager, not this repo.

## Daily use

- Edit files here; live config follows via symlink.
- `./install.sh --status` — verify all links are healthy.
- `./install.sh --restore` — undo symlinks, restore the pre-install backups.
- Commit and push from this repo to back everything up.

## Excluded / not yet packaged

- `~/.pi/mcp.json` — MCP servers (excluded per design).
- `obsidian-ingest`, `graphify-vault-query` skills — excluded in v1; pending rework into generic skills before inclusion.
- `terminal-browser` — external app-managed symlink in `~/.agents/skills`, not self-authored.
