# Contributing to CircleUp

Thank you for helping build trustless savings circles for the world. Every contribution matters — bug fixes, docs, contract improvements, or UI polish.

---

## Table of Contents

- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [How to Contribute](#how-to-contribute)
- [Commit Style](#commit-style)
- [Pull Request Process](#pull-request-process)
- [Code Style](#code-style)
- [Reporting Bugs](#reporting-bugs)

---

## Getting Started

1. Fork the repo on GitHub
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/CIRCLEUP`
3. Create a feature branch: `git checkout -b feat/your-feature`
4. Make your changes
5. Open a pull request against `main`

---

## Development Setup

```bash
# Install Node dependencies
npm install

# Build the SDK
npm run build:sdk

# Start the app (requires indexer + Postgres running)
npm run dev:app

# Start the indexer
npm run dev:indexer

# Run Rust contract tests (requires Rust + stellar-cli)
cd contracts && cargo test
```

See the [README](./README.md) for full environment variable setup.

---

## How to Contribute

**Bug fixes** — Open an issue first describing the bug, then submit a PR with a fix and a test if possible.

**New features** — Open an issue to discuss the feature before building it. For contract changes especially, discuss the design first.

**Documentation** — PRs that improve docs, examples, or comments are always welcome without prior discussion.

**Tests** — Additional unit tests for the Rust contracts or TypeScript SDK are always appreciated.

---

## Commit Style

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): short description

feat(circle): add grace period before mark_default
fix(indexer): handle null contractId in event response
docs(readme): update quick start steps
chore(ci): upgrade to Node 24
test(contracts): add edge case for zero collateral
```

Types: `feat`, `fix`, `docs`, `test`, `chore`, `refactor`, `ci`, `build`

---

## Pull Request Process

1. Make sure CI passes (TypeScript build + Rust compile + ESLint)
2. Keep PRs focused — one feature or fix per PR
3. Update the `CHANGELOG.md` under `[Unreleased]` with what you changed
4. Fill in the PR template
5. Request a review from a maintainer
6. PRs are squash-merged into `main`

---

## Code Style

**Rust** — `cargo fmt` before committing. Follow existing patterns in the contracts.

**TypeScript** — ESLint + Prettier. Run `npm run lint` before committing.

**React** — Server components for data fetching, client components only where interactivity is needed. Keep `"use client"` boundaries minimal.

---

## Reporting Bugs

Use the [Bug Report issue template](.github/ISSUE_TEMPLATE/bug_report.md). For security vulnerabilities, see [SECURITY.md](./SECURITY.md) — do not open a public issue.
