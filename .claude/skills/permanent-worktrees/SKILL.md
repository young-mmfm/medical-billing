---
name: permanent-worktrees
description: Create a persistent sibling-directory worktree for parallel work on this repo (distinct from the built-in `worktree` command). Use when asked to create a permanent worktree.
---

# Permanent Worktrees

## Create a Permanent Worktree

When asked to create a permanent worktree:

- If the user has not identified a branch name or the first feature the worktree will be used for, ask for the branch name.

1. Identify the original repo path and sibling directories to find existing worktrees. Naming conventions: /path/repo, /path/repo-2, ... use the smallest missing number for this worktree.
2. Set up the branch from origin/main unless the user specified another base branch. Use the specified name, or create a branch name based on the feature being worked on.
3. Set up files not managed in git (e.g. environment variable files) by symlinking each path listed in the repo's `.worktreeinclude` file into the new worktree. Create parent directories in the worktree as needed, and use absolute symlink targets.
4. (Optional) Run repo-specific setup by executing `./.worktreesetup` in the new worktree if it exists and is executable.
5. Summarize the worktree name, branch name, base branch, and any other setup.
