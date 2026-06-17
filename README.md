# NoBossly

AI-powered entrepreneurial platform: founder questionnaire → AI-matched business ideas → launch blueprint → weekly sprints with XP, levels, and streaks.

## Stack
Node.js (Express + EJS) · Supabase (auth + Postgres with RLS) · Anthropic Claude API

## Run locally
1. `npm install`
2. Copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY`
3. `npm start` → http://localhost:3000

## Deploy (Hostinger Node.js hosting)
- Upload the project (without `node_modules`)
- Entry point: `server.js`
- Set env vars: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `ANTHROPIC_API_KEY`, `NODE_ENV=production`
- Run `npm install`, then start
