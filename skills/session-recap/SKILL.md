---
name: session-recap
description: >
  Summarize the current session and produce next action points. Use when the
  user says "session recap", "recap", "summarize this session", "what did we
  do", "wrap up", "next steps", "where are we", or ends a work block. Writes
  the full recap to a markdown file so the chat transcript stays small.
---

# Session Recap

Produce a concise summary of the current session plus actionable next steps.
The **full** recap goes to a file; the chat reply is a short digest only, so
the transcript is not polluted with a long recap.

## Why this design

Anything spoken as a regular assistant message (or passed through tool calls)
stays in the transcript and re-enters context on every compaction. The recap
text is large, so it is the exact thing you do NOT want in the transcript.
Writing it with the `write`/`edit` tools keeps the big text off the chat
surface — only the tool call + a tiny reply remain. This is the closest a
skill can get to "recap without context pollution" because the model side
cannot read its own transcript from outside.

## When to trigger

- User invokes it explicitly: "recap", "session recap", "summarize this
  session", "what did we do today", "wrap up", "next steps".
- User pauses a long task and asks for status.
- The skill may also self-suggest at a natural milestone if the session was
  long and the user said something like "ok, let's pause".

## Workflow

1. **Gather** (from context already in the session — do NOT re-read files or
   transcripts unless something is genuinely unclear):
   - Session goal / what the user asked for.
   - What was done (commits, files changed, features, fixes).
   - Key decisions, tradeoffs, and gotchas.
   - Anything left unfinished or blocked.
   - Next actions, with `path:line` pointers where useful.
   - Pull items from the active `todowrite` list if one exists (it is the most
     reliable source of "next actions"); mark it *done* only if the todos are
     truly complete, otherwise carry unfinished items forward.

2. **Write the recap to a file** so the chat stays clean:
   - Preferred: `<project>/.opencode/recaps/<YYYY-MM-DD>.md` (project-scoped,
     inside the working tree, survives and is easy to find).
   - Fallback if the project dir is not writable: `~/.config/opencode/recaps/<YYYY-MM-DD>.md`.
   - If the dated file already exists, append a new `<h2>` section titled with
     the session title instead of overwriting.
   - Use this template:

     ```markdown
     ## <YYYY-MM-DD> — <short session title>

     ### Goal
     ...

     ### Done
     - ...

     ### Decisions / learnings
     - ...

     ### Blocked / issues
     - ...

     ### Next actions
     - [ ] ...
     ```

3. **Reply in chat** with ONLY:
   - A heading line like `Recap → .opencode/recaps/2026-08-09.md`.
   - 3–6 tight bullets (what's done / what's next).
   - Optionally offer: "Want me to append next actions to the repo TODO?"

   Do NOT paste the full recap into the chat. If the user explicitly asks for
   the full text in chat, paste it then — their choice overrides.

## Low-context / strict mode

If the session was extremely long and the model is near a compaction, or the
user says "don't pollute context", draft and write the file through a
`task` (subagent) call instead:

1. Compose the recap content as a compact digest.
2. Call the `task` tool with `subagent_type: "general"` instructing it to write
   the provided content to the target file path (and give it the exact content
   or a scratch file it can read).
3. It confirms only the path. Your reply stays 2–3 lines.

This keeps the drafting work out of the main context. Do not use the subagent
to "re-derive" the recap from scratch — it has no session history; you must
supply the digest.

## Notes

- Keep recap filenames date-based (`YYYY-MM-DD`); multiple recaps in one day
  append as sections.
- File-scoped, so different projects accumulate their own history.
- If the user asks for a plain chat recap only (no file), honor it, but keep
  the chat version tight regardless.