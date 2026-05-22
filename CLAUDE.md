# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**amtracked** is an Amtrak train tracker and booking assistant. Core goals:
- Search trains along a route with filtering by timing and price
- Sort/filter results easily
- Scan for and alert on price drops or discount tickets for saved routes

## Project State

Always read `PROJECT_STATE.md` at the start of a session to understand current status, what was last worked on, and what comes next. Update it whenever meaningful progress is made.

## Commit Guidelines

- Commits should be modular — each commit represents a coherent, self-contained change
- Do not squash unrelated changes into one commit; do not commit every trivial line change
- Write useful commit messages that describe what changed and why
- Never add `Co-Authored-By` lines or any attribution beyond the default git config
- Git config: `Priyam Kabra <priyamkabra7@gmail.com>`
- Use standard `git commit -m "..."` — no `--no-verify`, no amended published commits without asking

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **Scraping**: Playwright (Chromium) + playwright-extra stealth
- **DB**: SQLite via `better-sqlite3`
- **Server**: Express 5
- **Search API**: `POST https://www.amtrak.com/dotcom/journey-solution-option` (confirmed, currently blocked by Akamai 403 — see PROJECT_STATE.md)

## Commands

```bash
npm run dev            # start API server (PORT=3000)
npm run test:api       # test direct Amtrak API call from browser context
npm run test:scraper   # test full Playwright form automation
DEBUG_XHR=true npm run test:scraper  # verbose XHR + browser console logging
```

## Key Conventions

- Keep `.gitignore` up to date as new tooling/frameworks are added
- Sensitive config (API keys, credentials) goes in `.env` and is never committed
