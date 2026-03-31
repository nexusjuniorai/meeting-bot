# Napkin

## Corrections
| Date | Source | What Went Wrong | What To Do Instead |
|------|--------|----------------|-------------------|
| 2026-03-31 | self | Assumed the repo already had `.claude/napkin.md`; it only had `.claude/CONTEXT_SHIFT.md` | Create `.claude/napkin.md` at session start when missing and keep it updated during the task |
| 2026-03-31 | self | Tried importing `GoogleMeetBot` directly in a `node:test` regression test; the runtime failed first on a legacy transitive dependency (`buffer-equal-constant-time`) | For narrow regression coverage in this repo, prefer source-level tests when full module import pulls in brittle runtime dependencies unrelated to the bug |

## User Preferences
- Keep debugging pragmatic and focused on the actual code path instead of broad refactors.

## Patterns That Work
- For Google Meet guest joins, trace request fields from Express route to `GoogleMeetBot.join()` to `createBrowserContext()` before changing browser automation.
- When a join-time option is accepted by the Express route and `JoinParams`, verify the bot class destructuring keeps that field; silent drops can happen before Playwright is involved.

## Patterns That Don't Work
- Treating `avatarUrl` as a guaranteed profile avatar. In this codebase it is wired as a virtual camera image unless the bot joins with a signed-in Google account.

## Domain Notes
- Google Meet guest flow can accept an `avatarUrl`, but the visual effect depends on the bot passing it through to the Chromium virtual camera injection.
