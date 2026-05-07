# Agent instructions for Edge Friendly Rspamd

This repository is an open-source Hono + Cloudflare Workers mail-firewall project.

## Documentation rules

- Maintain both `README.md` and `README.ko.md` for README-level documentation.
- When changing public setup, API, roadmap, or development instructions in `README.md`, update `README.ko.md` in the same commit.
- Keep the English README as the GitHub default entrypoint and link to `README.ko.md` near the top.
- Keep the Korean README as a full standalone document, not a short summary.

## Current implementation boundary

- `POST /check` is implemented.
- `/check-raw`, `/quarantine`, and `/triage` are roadmap items unless explicitly requested.
- Run `npm run check` before committing code or documentation changes that may affect formatting.
