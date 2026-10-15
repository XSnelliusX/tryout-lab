# Undoing Things

Undo commands differ in one question: does the change stay in the history, or is it removed from it? The table answers this for each command.

| Command | Changes history? | Use case |
|---|---|---|
| `git restore <file>` | no | discard uncommitted edits in a file |
| `git restore --staged <file>` | no | unstage a file, keep its edits |
| `git reset --soft HEAD~1` | yes, removes the last commit | redo a commit, keep its changes staged |
| `git reset --mixed HEAD~1` | yes, removes the last commit | undo a commit, keep its changes unstaged |
| `git reset --hard HEAD~1` | yes, removes the last commit | undo a commit and discard its changes |
| `git revert <commit>` | no, adds a new commit | undo a commit that is already pushed |

## Reset

`git reset <target>` moves the current branch to `<target>`. The flag decides what happens to the files.

Before the reset, `main` points to `C`:

```mermaid
gitGraph
   commit id: "A"
   commit id: "B"
   commit id: "C" tag: "main, HEAD"
```

After `git reset --soft HEAD~1`, `main` points to `B`:

```mermaid
gitGraph
   commit id: "A"
   commit id: "B" tag: "main, HEAD"
```

Commit `C` is not deleted. It is no longer reachable from `main`, but it still exists in the reflog. gitGraph can't draw it because no branch points to it, so it is missing from the second diagram.

| Flag | Branch | Staging area | Working files |
|---|---|---|---|
| `--soft` | moved | unchanged, changes of C are staged | unchanged |
| `--mixed` (default) | moved | reset, changes of C are unstaged | unchanged |
| `--hard` | moved | reset | reset, uncommitted work is lost |

Reset rewrites history. It is used only for commits that are not pushed.

## Revert

`git revert <commit>` adds a commit that does the reverse of an old commit. The old commit stays in the history.

```mermaid
gitGraph
   commit id: "A"
   commit id: "B" tag: "bad change"
   commit id: "C"
   commit id: "Revert B" type: HIGHLIGHT
```

Revert is the safe choice for a pushed branch, because other people may already have `B`.

```bash
git revert <commit>
git revert --no-commit <commit>     # stage the reverse changes without committing
```

## Restore

`git restore` works on files, not on commits.

```bash
git restore <file>                  # throw away unstaged changes in the file
git restore --staged <file>         # remove the file from the staging area
git restore --source=HEAD~2 <file>  # take the file as it was two commits ago
```

## Where to find lost commits

Undone commits are found in the reflog. See [reflog](reflog.md) for `HEAD@{n}` and how to return to an earlier state.

## Try it

In the practice repo:

```bash
git reset --soft HEAD~1          # the last commit is gone from the log
git status                       # its changes are staged
git commit -m "commit 4 again"   # the changes are committed again
```
