CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(50)  NOT NULL UNIQUE,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  balance       NUMERIC(12, 2) NOT NULL DEFAULT 1000.00,
  is_admin      BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS matches (
  id          SERIAL PRIMARY KEY,
  home_team   VARCHAR(100) NOT NULL,
  away_team   VARCHAR(100) NOT NULL,
  match_date  TIMESTAMPTZ  NOT NULL,
  status      VARCHAR(20)  NOT NULL DEFAULT 'scheduled',
  home_odds   NUMERIC(6, 2),
  away_odds   NUMERIC(6, 2),
  draw_odds   NUMERIC(6, 2),
  result      VARCHAR(10)  CHECK (result IN ('home', 'draw', 'away')),
  settled_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type           VARCHAR(10)    NOT NULL CHECK (type IN ('deposit', 'withdrawal', 'adjustment')),
  amount         NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
  balance_before NUMERIC(12, 2) NOT NULL,
  balance_after  NUMERIC(12, 2) NOT NULL,
  note           VARCHAR(255),
  created_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bets (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  match_id   INTEGER        NOT NULL REFERENCES matches(id),
  bet_type   VARCHAR(10)    NOT NULL CHECK (bet_type IN ('home', 'draw', 'away')),
  amount     NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
  odds       NUMERIC(6, 2)  NOT NULL,
  status     VARCHAR(10)    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'won', 'lost')),
  created_at TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

INSERT INTO matches (home_team, away_team, match_date, status, home_odds, away_odds, draw_odds) VALUES
  ('Panathinaikos', 'Olympiacos',  '2026-05-25 19:00:00+00', 'scheduled', 2.40, 2.90, 3.10),
  ('AEK',          'PAOK',        '2026-05-25 21:00:00+00', 'scheduled', 2.10, 3.20, 3.40),
  ('Aris',         'Atromitos',   '2026-05-26 18:00:00+00', 'scheduled', 1.95, 3.75, 3.50),
  ('Asteras',      'OFI',         '2026-05-26 20:00:00+00', 'scheduled', 2.20, 3.10, 3.25);
