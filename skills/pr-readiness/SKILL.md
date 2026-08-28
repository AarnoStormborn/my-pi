---
name: pr-readiness
description: "Use when preparing a branch for pull request: linting, formatting, rebasing onto the base branch, validating changed files, or collecting merge-readiness evidence."
---

# PR Readiness

Prepare a worktree for review without changing unrelated work or publishing anything unless explicitly requested.

This skill is repository-agnostic. Every concrete value it needs — base branch, toolchain paths, test invocation, required gates, commit conventions — comes from the repository itself. Establish those first; never assume them and never carry them over from another project.

## Establish Context

1. Read `git status --short`, `git diff --check HEAD`, and the current branch.

2. **Determine the base branch from the repository, not by inference.** Look for it in contributor docs, a PR template, `CONTRIBUTING`, an agent-facing workflow doc, or CI config. Repositories frequently carry several similarly named long-lived branches, and picking the wrong one produces a PR against the wrong target.

   ```bash
   git symbolic-ref refs/remotes/origin/HEAD   # the repo's default, if set
   ```

   If the base cannot be established from the repository, ask. Do not guess from a branch listing.

3. **Determine the real changeset.** `git diff <base>...HEAD` is unreliable: it returns nothing when the branch has no commits of its own, and `git diff` never sees untracked files. Enumerate what the worktree actually authored:

   ```bash
   git fetch origin <base>                   # updates origin/<base>, NOT the local branch
   git diff --name-only HEAD                 # tracked edits
   git ls-files --others --exclude-standard  # new files
   ```

   Compare against `origin/<base>` — the ref the host will merge into. A local branch of the same name can lag behind it.

4. **Subtract anything byte-identical to the base.** A file already committed upstream with identical content contributes nothing and produces a no-op diff or a spurious conflict. Because `git diff` is blind to untracked files, hash-compare:

   ```bash
   git hash-object <file>            # content on disk
   git rev-parse origin/<base>:<file>  # content on base
   ```

   Equal hashes mean the path is already upstream — exclude it. This matters most for whole directories added by a base commit, which appear untracked locally and look new when they are not.

5. Read the repository's own contributor, CI, and testing docs before running anything. They define the gates that actually apply.

6. Keep user or sibling-agent changes intact. Do not reset, checkout, clean, amend, force-push, or commit unless explicitly requested.

## Format And Validate

Use the repository's own toolchain, preferring a project-local environment over a global one when the project provides it. Target changed paths first.

Determine from the repository: which linter and which formatter, their configured line length and rule set, and the correct test invocation. Linter and formatter are usually different tools — running only the linter leaves formatting unverified.

Use `git diff --check HEAD` rather than bare `git diff --check`: the bare form inspects only unstaged changes to tracked files, so new untracked files are never examined. Check those directly for trailing whitespace and a final newline.

### Separate new findings from pre-existing ones

**This is mandatory.** Touched files often carry many pre-existing violations. A raw lint run on a branch responsible for two findings can report dozens, and reporting the raw number is misleading.

Baseline each changed file against the base *without writing to the worktree*, using the linter's stdin-filename option so configuration resolves identically on both sides:

```bash
BASE=origin/<base>
for f in <changed-source-paths>; do
  git show "$BASE:$f" 2>/dev/null | <linter> --stdin-filename "$f" - \
    | sed 's/^[^:]*:[0-9]*:[0-9]*: //' | sort > /tmp/base.txt
  <linter> --stdin-filename "$f" - < "$f" \
    | sed 's/^[^:]*:[0-9]*:[0-9]*: //' | sort > /tmp/curr.txt
  echo "== $f new:"; comm -23 /tmp/curr.txt /tmp/base.txt
done
```

Two traps this avoids:

- **Never extract base blobs to a temp directory to lint them.** Most linters resolve configuration by walking up from the file path, so a temp location silently applies different settings — and misses nested per-directory config that overrides the repository root.
- **Key the comparison on `(code, message)`, not `file:line`.** Any sizeable insertion shifts every downstream line number and would report dozens of phantom new findings.

A file with no base blob is new, so all of its findings are new.

Apply the same baselining to formatting. If a modified file was already non-compliant on the base, **do not reformat it** — that buries the real diff under unrelated churn. Format only files the branch adds, or touched files that were already clean.

Before auto-fixing, read what the fix would do. Autofixes resolve the symptom the rule names, which is not always the intended change — an unused exception binding, for example, may be fixed by deleting the binding when the surrounding code's convention is to chain the exception instead. Check adjacent code.

### A passing gate may have inspected nothing

Verify that each gate actually examined the changed paths before recording it as evidence. Build systems that operate on declared targets will exit zero when a path is not covered by any target; coverage-filtered CI will skip a job when no filter matches; a test selection can match zero tests. All three look identical to success.

Where a gate supports it, enumerate what it matched first, and report "passed (nothing matched — verified nothing)" rather than "passed". A gate that cannot fail is not evidence.

Be aware that some checks mutate the worktree as a side effect: pre-commit hooks typically run formatters and autofixers in write mode, and some build tools create cache or lock directories in the repository root even in check-only modes. If the worktree must stay clean, run them elsewhere or skip them and say so.

Treat known stale collection or import failures as pre-existing only when documented and independently verified — confirm the branch does not touch the implicated code, and that the failure reproduces on the base. Never hide a new failure behind them.

## Rebase

Rebase only when the user requests it or the documented process requires it. Inspect conflicts before resolving them, rerun affected checks afterward, and never rebase a worktree another agent is actively editing.

```bash
git fetch origin <base>
git rebase origin/<base>
```

Rebase onto `origin/<base>`, not a local branch of the same name — `git fetch origin <branch>` does not fast-forward the local branch, so the two can differ.

Uncommitted work must be committed or stashed first. Confirm which the user wants rather than choosing for them.

### Untracked files that the base already contains

A rebase aborts with *"untracked working tree files would be overwritten"* when the base adds a path that also exists untracked on disk. This is common after a base commit lands a directory the worktree already has.

Those files are not part of the change. Confirm each is byte-identical to the base before moving it, move the set aside, rebase, then verify the checkout restored identical content.

If a hash does **not** match, stop: that file carries local work and needs a real decision, not relocation. Never delete such files outright, and never `git clean` to clear the way — that silently destroys uncommitted work.

### A clean rebase does not mean a working feature

Git merges text; it does not know what the code was for. When the base **rewrites or deletes the thing the change plugs into**, every file can merge cleanly, every pre-existing test can pass, and the feature can still be inert — a hook registered on a function nobody calls any more, a capture that fills a structure nothing reads.

No conflict marker will point at this, and neither will the existing tests, because they were written against the old structure.

After any rebase where the base touched the same subsystem, verify the change is still *reachable*, not merely present:

- Identify the entry point the change depends on — the registered handler, route, tool, or callback — and confirm the base still calls it. A grep for that symbol on the base returning zero is the signal to stop and re-plan.
- Trace one full path from caller into the changed code. If the base moved the integration point, port the change to the new one rather than leaving it attached to the old.
- Run or add a test that exercises the feature end to end through the *new* structure. A suite that passes without touching the changed code proves nothing about it.

Report this check explicitly. "Rebased with no conflicts" is not evidence the feature survived.

## Create The PR

Only when explicitly asked. Target the base branch established earlier.

```bash
git push -u origin <branch>
gh pr create --base <base> --title "<summary>" --body "<body>"
```

**Match the repository's existing commit and title conventions.** Do not import a convention from elsewhere — a repository that has never used Conventional Commits should not receive `feat(scope):` subjects. Check before writing the message:

```bash
git log --format="%s" origin/<base> -20
```

Detail belongs in the commit body and PR description, not the subject line.

If the repository's process requires in-progress PRs to be drafts, add `--draft`.

## PR Evidence

Report:

- branch and verified base, and where the base was established from;
- the changeset actually staged, and any changed path deliberately excluded with the reason;
- exact format/lint/test commands with results, with **new findings counted separately from pre-existing ones** and the baseline method stated;
- for any gate that passed, whether it actually inspected anything — a vacuous pass is reported as such, not as green;
- after a rebase, how the change was confirmed still reachable through the base's current structure;
- every conflict, what each side held, how it was resolved, and why;
- known pre-existing failures separately from new risks;
- unresolved conflicts, uncommitted unrelated changes, or required follow-up work;
- anything redone, gotten wrong, or still uncertain — an honest account is worth more than a clean-looking one.

Do not create a commit, push, or PR unless explicitly asked.
