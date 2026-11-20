# Handoff log

Shared context between collaborators and their Claude agents. Agents only see what is in the repo, so anything that lives on one person's machine (decisions, env setup, test results, blockers) must be written here and pushed.

Read this file first. Add a new entry at the top before every push. Never put secrets (API keys, tokens) in it.

## Entry template

### YYYY-MM-DD, <author>
- **Pushed:** branch / commit, one line on what changed
- **State:** what works, what is broken or unverified
- **Decisions:** choices made and why
- **Needs from you:** questions or tasks for the other person
- **Local-only info:** anything the other side cannot see (env vars needed by name only, sample files, test results)

---

### 2026-11-20, initial
- **Pushed:** nothing yet
- **State:** repo contains README.md and PRODUCT_BRIEF.md. Build plan agreed: Hokkien-only demo (Cantonese and Teochew listed as coming soon), web/PWA, Claude vision for reading and summarizing the letter.
- **Decisions:** see the plan summary in PRODUCT_BRIEF.md and README once added
- **Needs from you:** confirm Hokkien audio approach (recorded prompts, TTS choice)
- **Local-only info:** none
