---
name: git-safety
description: Git safety rules for InvoiceExtract. Use before any task that creates branches, commits, pushes, or touches repository state, and whenever a task asks to verify branch/HEAD/status or report ahead/behind.
---

# Git safety — InvoiceExtract

Repository: `sachamorenosm-star/invoice-extractor` · default branch: `main`.

## Before any significant task

Run and report:

```bash
git branch --show-current
git rev-parse HEAD
git status --short
git rev-parse origin/main        # only if origin/main is already known locally
```

- When the task is about "current state", treat `origin/main` as the source of
  truth, not the local `main`.
- If the working tree is dirty and the task did not create those changes, stop
  and report them; do not stash, discard, or commit them.

## Forbidden without explicit authorization in the current task

- `git push`, `git pull`, `git fetch`
- `git reset`, `git clean`, `git rebase`, `git commit --amend`, `git merge`
- `git stash drop`, `git checkout -- <file>`, `git restore` on files you did not change
- deleting untracked files or directories (they may be historical local data,
  e.g. `data/`, backups, fixtures)

Never, even if asked indirectly:

- `git push --force` / `--force-with-lease` on shared branches
- committing or pushing directly to `main` from a Cloud session

## Branching

- Cloud sessions: every change goes on a dedicated feature branch
  (e.g. `feat/...`, `fix/...`, `chore/...`) created from `origin/main`.
- Use exactly the branch name the task specifies; do not invent another.
- Local/feature-branch commits only when the task authorizes committing.
- Pushing: only the authorized feature branch, with `git push -u origin <branch>`.

## After commit / push

```bash
git log --oneline -3
git status --short                               # must be clean
git rev-list --left-right --count origin/main...HEAD   # behind / ahead
git rev-parse HEAD origin/<branch>                # after push: must match
```

Report: commit hash, branch, ahead/behind vs `origin/main`, pushed YES/NO.
If any of these checks fails, report it as FAIL — do not retry destructively.
