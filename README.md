# Transmutación Hero

Starter repository for **Transmutación Hero**. `main` is the default branch. Create a feature branch from `main` before making changes.

## Branching

1. Update `main`:

   ```bash
   git checkout main
   git pull origin main
   ```

2. Create a branch from `main`. Use a short prefix that matches the work:

   ```bash
   git checkout -b feat/short-description
   ```

   Prefixes: `feat/` for features, `fix/` for bug fixes, `chore/` for tooling or docs.

3. Commit on the branch, then push and open a pull request into `main`:

   ```bash
   git push -u origin HEAD
   ```

Keep `main` deployable. Merge through pull requests rather than committing directly to `main`.
