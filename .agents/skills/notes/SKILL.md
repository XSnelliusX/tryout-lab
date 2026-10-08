---
name: notes
description: Clean up the personal markdown notes in this repository and weave wiki-style links between them, so related topics reference each other where it makes sense. Use whenever the user says "clean up my notes", "update the notes", "make my notes a wiki", "link the notes", "notes cleanup", "there's a new note", or asks to organize or format the markdown notes in this lab/course repo. The skill discovers what's new or changed in the worktree, cleans up those notes (fixing typos, consolidating duplication, keeping them short and simple), integrates links to the other notes inline at the points where they are relevant, and commits the result. Always reach for this when markdown notes were added or edited, even if the user doesn't explicitly ask for cleanup.
---

# Notes cleanup + wiki linking

A repeatable workflow for keeping this repo's course/lab notes tidy and interlinked. It runs **clean up → link → commit** over whatever is new in the worktree.

The workflow was designed on the `kubernetes/` notes (see `kubernetes/kubectl.md` as the gold-standard example) and should generalize to any topic directory in the repo.

## Step 1 — Discover what's new in the worktree

Run these to find notes that need attention:

```bash
git status --porcelain              # untracked + modified files
git diff --stat                     # unstaged changes
git diff --cached --stat            # staged changes
find . -name "*.md" -not -path "./.git/*" -newermt "7 days ago"   # recently touched markdown
```

- **New/untracked notes**: process them.
- **Modified notes**: process them (but see "Work in progress" below).
- **Recently committed notes**: check whether they already link to the other notes; if not, process them.
- Collect the full set of markdown files in the repo so you know the link targets available (Step 3).

### Work in progress
If a file is **newly created / actively being edited** (e.g. the user just mentioned they are writing it, or it was modified minutes ago and is near-empty), do **not** rewrite it — the user is mid-thought and a heavy cleanup would clobber their work. Instead, link *to* it from other files where relevant, but leave the file itself alone and tell the user you skipped it. When in doubt, skim the file first; empty or skeleton files are telltale signs of work in progress.

## Step 2 — Clean up the notes

For every topic directory (e.g. `kubernetes/`), open each note and apply the house style:

1. **Fix typos and grammar** — quiet, mechanical fixes (`se` → `see`, `unnecesary` → `unnecessary`, `alerady` → `already`, missing articles). Never change the meaning.
2. **Consolidate duplication** — if the same command or fact appears multiple times, keep one clear instance and remove the repeat.
3. **Short and simple** — prefer terse bullet points and one-liners over prose. Keep flair like the occasional emoji but don't overdo it.
4. **Don't invent facts** — these are course notes. Fill only obvious gaps (a command that was used but never explained, a referenced concept), never new course material. If unsure, leave it.
5. **Structure** — use `##` sections for topics; group related commands under one header instead of one header per command.
6. **Code blocks** — fenced with the correct language tag (`````bash````), with a short comment inside rather than a sentence above when it keeps things readable. Use `> Tip:` / `> Note:` blockquotes for asides.
7. **Preserve fidelity** — keep the source links, keep any `.yaml` examples referenced, keep the notes recognizable as what the user wrote.

The gold standard: `kubernetes/kubectl.md` — terse section headers, grouped command blocks, tip callouts, no bloat.

## Step 3 — Add wiki links (inline, where relevant)

**Do NOT add a navigation bar or "wiki" banner to the top of the notes.** The links belong inside the content, at the exact point where another note is relevant.

### a) Inline "see also" links

Weave a link into the existing sentence where a related concept is covered in another note. Example from `rancher.md`: "Kubernetes is provided by **k3s**, a lightweight certified Kubernetes distribution — for the big picture, see [Kubernetes Essentials](kubernetes.md)."

Apply loosely and only where natural:

- A note about the CLI mentions pods → link to the note that explains pods.
- A note explains how Pods are grouped into Deployments → link to `deployments.md`.
- A note about local setup ships `kubectl` → link to the kubectl note.
- A note about a resource type links to the CLI notes when it shows the commands for it.

A note links forward to topics that *continue* from it (e.g. Kubernetes Essentials → Pods are managed via kubectl → Deployments), and links to setup/tooling notes when they are referenced by name.

### b) Relative paths

Use relative links (no leading `/`) so they work on GitHub, local editors, Obsidian, etc.

### c) README as the hub

`README.md` is the repository home and should index every topic directory with one short row per note, so it stays the single place to discover all notes. Keep directory listings up to date (e.g. `kubernetes/` rather than stale names). Don't grow the README into per-note navigation — one line per note is enough.

### d) Consistency checklist

- Every link targets an existing file (no dead links).
- Each note is linked to at least once from somewhere else (README counts).
- Links are woven into existing prose — never a new "Related files:" dump block sitting on its own.

## Step 4 — Commit

Commit the cleaned and linked notes so the wiki stays in sync with the course progress.

```bash
git add <files-you-changed>
git commit -m "notes: clean up and link <topic> notes"
```

- **Only stage files you actually changed.** Never sweep in unrelated files (`.DS_Store`, the user's in-progress note, binaries) with `git add -A`.
- Follow the repo's existing commit style (e.g. `add: ...`, `update: ...`, `notes: ...`).
- If the user asked you NOT to commit, or was mid-edit, stop after Step 3 and report instead.
- Mention in your final reply what you changed and what you deliberately left alone.
