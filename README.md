# BetEngine

A full-stack sports betting platform built with Node.js, PostgreSQL, nginx, and vanilla JavaScript. Runs entirely in Docker.

## Stack

| Layer    | Technology |
|----------|------------|
| Frontend | Vanilla JS / HTML / CSS (served by nginx) |
| API      | Node.js + Express |
| Database | PostgreSQL 15 |
| Proxy    | nginx (alpine) |

## Features

- **User accounts** — register/login with bcrypt-hashed passwords and JWT sessions; new accounts start with €1,000 balance
- **Match listings** — upcoming matches with Home / Draw / Away odds
- **Bet slip** — multi-selection slip with quick-stake buttons (€5/10/25/50), live potential winnings, and balance pre-check
- **Transactional bet placement** — atomic Postgres transaction locks the user row, checks balance, deducts stake, and inserts the bet record
- **My Bets** — full bet history with match details, pick, odds, stake, potential winnings, and status badge (pending / won / lost)

## Project Structure

```
betting_platform/
├── docker-compose.yml
├── db/
│   └── SQL_SCHEMA_COMPLETE.sql   # Schema + sample data (auto-runs on first boot)
├── frontend/
│   └── index.html                # Single-page app
├── nginx/
│   └── default.conf              # Reverse-proxy /api/ to betting_engine
└── services/
    ├── betting_engine/           # Express API
    │   ├── Dockerfile
    │   ├── index.js
    │   └── package.json
    └── risk_engine/              # Reserved for future use
```

## Getting Started

**Prerequisites:** Docker + Docker Compose v2

```bash
git clone https://github.com/thearchitect0110-cell/betting_platform.git
cd betting_platform
docker compose up -d --build
```

The app will be available at **http://localhost:8080**.

> If port 80 is already in use on your machine the nginx service is mapped to **8080** by default.

## API Reference

All endpoints are proxied through nginx at `/api/`.

### Auth

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/register` | — | Create account → returns JWT + user |
| `POST` | `/api/login` | — | Login → returns JWT + user |
| `GET`  | `/api/me` | ✓ | Current user (id, username, email, balance) |

**Register / Login body:**
```json
{ "username": "alice", "email": "alice@example.com", "password": "secret" }
```

### Matches

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/matches` | — | List all matches ordered by date |

### Bets

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/place-bet` | ✓ | Place a bet (deducts balance atomically) |
| `GET`  | `/api/my-bets`   | ✓ | Bet history for the logged-in user |

**Place bet body:**
```json
{ "match_id": 1, "bet_type": "home", "amount": 25 }
```
`bet_type` must be `home`, `draw`, or `away`.

## Database Schema

```sql
users   (id, username, email, password_hash, balance, created_at, updated_at)
matches (id, home_team, away_team, match_date, status, home_odds, away_odds, draw_odds, created_at)
bets    (id, user_id → users, match_id → matches, bet_type, amount, odds, status, created_at)
```

`status` on bets is `pending` | `won` | `lost`.

## Development

Rebuild after backend changes:
```bash
docker compose up -d --build betting_engine
```

Wipe and reseed the database (re-runs `SQL_SCHEMA_COMPLETE.sql`):
```bash
docker compose down && docker volume rm betting_platform_db_data && docker compose up -d
```

Tail API logs:
```bash
docker logs -f betting_platform-betting_engine-1
```
