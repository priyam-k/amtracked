# Project State

## Status: Planning

## Last Session
- Initialized repository
- Created CLAUDE.md, PROJECT_STATE.md, .gitignore
- About to enter plan mode to design project architecture

## What's Next
- Plan out architecture and tech stack
- Decide on: frontend framework, backend language, data source (Amtrak API / scraping), alert mechanism
- Scaffold initial project structure

## Known Decisions / Constraints
- Must support filtering by time and price
- Must support price-drop alerts for saved routes
- Sensitive config (API keys) in `.env`, never committed

## Open Questions
- Amtrak API access: official API vs. third-party vs. scraping?
- Alert delivery: email, push notification, or in-app?
- Deployment target?
