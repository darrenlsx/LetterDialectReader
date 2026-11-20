# Agent instructions

Two people work on this repo, each with their own Claude instance. You cannot see the other person's machine, so the repo is the only shared channel.

- At the start of a session, read `HANDOFF.md` and `PRODUCT_BRIEF.md`, and run `git pull`.
- Before every push, add a new entry at the top of `HANDOFF.md` using its template. Include anything the other side cannot see locally.
- Never commit secrets. Refer to env vars by name only (see `.env.example`).
- Do not push, force-push or change remotes without the user's go-ahead.
