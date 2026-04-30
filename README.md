# ProductionAggregator_App

Production data intake and export application for Stewardship.IS, Inc.

## Overview

Monitors a Gmail inbox for operator production reports (Excel/PDF), parses them into a standardized format, stores in Supabase, and provides a web UI for consolidated exports.

## Tech Stack

- **Backend**: Node.js + TypeScript (hosted on Railway)
- **Database**: Supabase (PostgreSQL)
- **Frontend**: React + TypeScript
- **Email**: Gmail API (Google Workspace)
- **Source Control**: GitHub (monorepo)

## Folder Structure

```
├── api/          # Backend API + email poller + parsers (Railway)
├── web/          # React frontend
├── mappings/     # Operator format JSON configs
├── templates/    # Export template definitions
├── supabase/     # Database migrations
└── sample-data/  # Reference operator files (not committed)
```

## Getting Started

1. Clone the repo
2. Copy `.env.example` to `.env` in both `api/` and `web/`
3. Fill in your Supabase and Gmail API credentials
4. Run `npm install` from root
5. Run `npm run dev:api` and `npm run dev:web`

<!-- Cowork verified push access on 2026-04-29. -->
