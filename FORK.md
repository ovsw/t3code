# This fork

This is Ovi Savescu's fork of T3 Code. Read this before you plan or change anything here.

## Branches and remotes

- `origin` is the fork, `ovsw/t3code`. `upstream` is `pingdotgg/t3code`.
- `origin/main` is the trunk. Start every branch and worktree from it, and open PRs against it, never against upstream.
- Local `main` tracks `origin/main`. Upstream is not merged in automatically, so code on `upstream/main` may be missing here, and fork features are missing upstream.

## Tickets

Work is tracked as GitHub issues on `ovsw/t3code`: a parent issue per feature, one sub-issue per change.

## Fork-only features

### Walk mode (iOS)

A hands-free session on one thread, driven by headphone presses: the phone speaks each agent reply and the user answers by voice. Terms are in the Walk mode section of [the glossary](docs/internals/glossary.md#walk-mode).

- Session logic: `packages/client-runtime/src/walk-mode/`
- Mobile UI and settings: `apps/mobile/src/features/walk-mode/`, `apps/mobile/src/features/settings/SettingsWalkModeRouteScreen.tsx`
- Native audio (speech, cues, recording, headphone presses): `apps/mobile/modules/t3-walk-mode-audio/`
- Behavior checks on a device: `scripts/mobile-behavior/`

When a fork feature lands or changes, update this file.
