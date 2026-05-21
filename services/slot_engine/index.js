const express    = require('express');
const cors       = require('cors');
const { Pool }   = require('pg');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
const rateLimit  = require('express-rate-limit');

const app  = express();
const PORT = 5001;

const pool = new Pool({
  host:     process.env.DB_HOST     || 'db',
  user:     process.env.DB_USER     || 'betting_user',
  password: process.env.DB_PASSWORD || 'betting_pass',
  database: process.env.DB_NAME     || 'betting_db',
});

const JWT_SECRET = process.env.JWT_SECRET || 'betengine_jwt_secret_changeme_in_prod';

// RTP-verified outcome pool. EV = sum(mult*weight)/total_weight = 8050/8343 ≈ 96.49%
const OUTCOME_POOL = [
  { mult: 0,     weight: 3080, tier: 'no_win'     },
  { mult: 0.5,   weight: 2000, tier: 'tiny_win'   },
  { mult: 1.0,   weight: 2000, tier: 'small_win'  },
  { mult: 2.0,   weight: 1000, tier: 'medium_win' },
  { mult: 5.0,   weight:  200, tier: 'big_win'    },
  { mult: 15.0,  weight:   50, tier: 'mega_win'   },
  { mult: 50.0,  weight:   10, tier: 'super_win'  },
  { mult: 150.0, weight:    2, tier: 'epic_win'   },
  { mult: 500.0, weight:    1, tier: 'jackpot'    },
];
const TOTAL_WEIGHT = OUTCOME_POOL.reduce((s, o) => s + o.weight, 0); // 8343

// Visual symbols and their reel representations per tier
const SYMBOLS = ['COIN', 'SWORD', 'HELM', 'POSEIDON', 'ATHENA', 'ZEUS', 'WILD', 'SCATTER'];

// Grid shape returned to client — 5 reels × 3 rows
// Each tier maps to a dominant winning symbol placed on a payline
const TIER_VISUAL = {
  no_win:     null,
  tiny_win:   { sym: 'COIN',     payline: [1,1,1,1,1], count: 3 },
  small_win:  { sym: 'COIN',     payline: [1,1,1,1,1], count: 4 },
  medium_win: { sym: 'SWORD',    payline: [0,0,0,0,0], count: 3 },
  big_win:    { sym: 'HELM',     payline: [2,2,2,2,2], count: 3 },
  mega_win:   { sym: 'POSEIDON', payline: [1,1,1,1,1], count: 3 },
  super_win:  { sym: 'ATHENA',   payline: [0,0,0,0,0], count: 4 },
  epic_win:   { sym: 'ZEUS',     payline: [1,1,1,1,1], count: 3 },
  jackpot:    { sym: 'ZEUS',     payline: [1,1,1,1,1], count: 5 },
};

// Random symbol from the non-winning pool (filler positions)
const FILLER_SYMS = ['COIN', 'SWORD', 'HELM', 'SCATTER'];

function randFiller() {
  return FILLER_SYMS[crypto.randomInt(0, FILLER_SYMS.length)];
}

function pickOutcome() {
  const roll = crypto.randomInt(0, TOTAL_WEIGHT);
  let acc = 0;
  for (const o of OUTCOME_POOL) {
    acc += o.weight;
    if (roll < acc) return o;
  }
  return OUTCOME_POOL[0];
}

// Build a 5×3 grid (array of 5 reels, each reel is [row0, row1, row2])
function buildGrid(outcome) {
  const grid = Array.from({ length: 5 }, () => [randFiller(), randFiller(), randFiller()]);

  const vis = TIER_VISUAL[outcome.tier];
  if (!vis) return { grid, winLines: [] };

  const { sym, payline, count } = vis;

  // Place winning symbol on the payline for the first `count` reels
  for (let reel = 0; reel < count; reel++) {
    grid[reel][payline[reel]] = sym;
  }

  // Fill remaining reel payline slots with non-matching fillers
  for (let reel = count; reel < 5; reel++) {
    const fillers = FILLER_SYMS.filter(s => s !== sym);
    grid[reel][payline[reel]] = fillers[crypto.randomInt(0, fillers.length)];
  }

  const winLines = count >= 3 ? [payline.slice(0, count)] : [];
  return { grid, winLines };
}

// ── Middleware ──────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json());

const spinLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many spins — slow down.' },
});

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ── Routes ──────────────────────────────────────────────────────────────────

// POST /api/slot/spin  { bet: number }
app.post('/api/slot/spin', authMiddleware, spinLimiter, async (req, res) => {
  const bet = parseFloat(req.body.bet);

  if (!Number.isFinite(bet) || bet < 0.10 || bet > 100) {
    return res.status(400).json({ error: 'Bet must be between €0.10 and €100' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock and read current balance
    const { rows } = await client.query(
      'SELECT balance FROM users WHERE id = $1 FOR UPDATE',
      [req.user.id]
    );
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found' }); }

    const before = parseFloat(rows[0].balance);
    if (before < bet) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Determine outcome
    const outcome = pickOutcome();
    const winAmount = parseFloat((bet * outcome.mult).toFixed(2));
    const netChange = parseFloat((winAmount - bet).toFixed(2));
    const after     = parseFloat((before + netChange).toFixed(2));

    // Debit stake, credit win
    await client.query(
      'UPDATE users SET balance = $1, updated_at = NOW() WHERE id = $2',
      [after, req.user.id]
    );

    // Record transaction (schema allows only deposit/withdrawal/adjustment)
    const note = outcome.mult === 0
      ? `Olympus Strike spin — no win (stake: €${bet.toFixed(2)})`
      : `Olympus Strike spin — ${outcome.tier} ×${outcome.mult} (win: €${winAmount.toFixed(2)}, stake: €${bet.toFixed(2)})`;

    await client.query(
      `INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, note)
       VALUES ($1, 'adjustment', $2, $3, $4, $5)`,
      [req.user.id, Math.abs(netChange) || bet, before, after, note]
    );

    await client.query('COMMIT');

    const { grid, winLines } = buildGrid(outcome);

    res.json({
      tier:      outcome.tier,
      mult:      outcome.mult,
      win:       winAmount,
      net:       netChange,
      balance:   after,
      grid,       // 5×3 symbol matrix
      winLines,   // highlighted paylines
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`[slot] spin error for user ${req.user?.id}:`, err.message);
    res.status(500).json({ error: 'Spin failed — please try again' });
  } finally {
    client.release();
  }
});

// GET /api/slot/info — returns balance + game config, no spin
app.get('/api/slot/info', authMiddleware, async (req, res) => {
  const { rows } = await pool.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  res.json({
    balance: parseFloat(rows[0].balance),
    rtp: 96.5,
    minBet: 0.10,
    maxBet: 100,
    symbols: SYMBOLS,
  });
});

app.listen(PORT, () => console.log(`[slot_engine] listening on :${PORT}`));
