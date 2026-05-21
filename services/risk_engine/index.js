const express = require('express');
const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'db',
  user:     process.env.DB_USER     || 'betting_user',
  password: process.env.DB_PASSWORD || 'betting_pass',
  database: process.env.DB_NAME     || 'betting_db',
});

// ── Configurable limits ───────────────────────────────────────────────────────
const MAX_STAKE       = parseFloat(process.env.MAX_STAKE_PER_BET  || '500');
const MAX_PAYOUT      = parseFloat(process.env.MAX_PAYOUT_PER_BET || '10000');
const MAX_DAILY_STAKE = parseFloat(process.env.MAX_DAILY_STAKE    || '1000');
const LIABILITY_CAP   = parseFloat(process.env.LIABILITY_CAP      || '50000');

const app = express();
app.use(express.json());

function euro(n) { return `€${parseFloat(n).toFixed(2)}`; }

// ── POST /check ───────────────────────────────────────────────────────────────
// Called by the betting engine before every bet placement.
// Body: { user_id, match_id, bet_type, stake, odds }
// Response: { allowed: bool, reason?: string }
app.post('/check', async (req, res) => {
  const { user_id, match_id, bet_type, stake, odds } = req.body;

  if (!user_id || !match_id || !bet_type || !stake || !odds)
    return res.status(400).json({ allowed: false, reason: 'Missing required fields' });

  const payout = stake * odds;

  // ── Rule 1: Maximum stake per bet ─────────────────────────────────────────
  if (stake > MAX_STAKE)
    return res.json({ allowed: false, reason: `Maximum stake is ${euro(MAX_STAKE)} per bet` });

  // ── Rule 2: Maximum potential payout ─────────────────────────────────────
  if (payout > MAX_PAYOUT)
    return res.json({
      allowed: false,
      reason: `Potential payout ${euro(payout)} exceeds the ${euro(MAX_PAYOUT)} limit. ` +
               `Reduce your stake to ${euro(MAX_PAYOUT / odds)} or less.`,
    });

  try {
    // ── Rule 3: User daily stake limit ──────────────────────────────────────
    const { rows: daily } = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM bets
       WHERE user_id = $1 AND created_at >= CURRENT_DATE`,
      [user_id]
    );
    const dailyUsed = parseFloat(daily[0].total);
    if (dailyUsed + stake > MAX_DAILY_STAKE) {
      const remaining = Math.max(0, MAX_DAILY_STAKE - dailyUsed);
      return res.json({
        allowed: false,
        reason: `Daily stake limit of ${euro(MAX_DAILY_STAKE)} reached. ` +
                 `You have ${euro(remaining)} remaining today.`,
      });
    }

    // ── Rule 4: Match liability cap per outcome ──────────────────────────────
    const { rows: liab } = await pool.query(
      `SELECT COALESCE(SUM(amount * odds), 0) AS exposure
       FROM bets
       WHERE match_id = $1 AND bet_type = $2 AND status = 'pending'`,
      [match_id, bet_type]
    );
    const exposure = parseFloat(liab[0].exposure);
    if (exposure + payout > LIABILITY_CAP)
      return res.json({
        allowed: false,
        reason: `This selection is temporarily suspended (liability limit reached).`,
      });

  } catch (err) {
    console.error('[risk] DB error during check:', err.message);
    // Fail-open on DB error: the betting engine's own checks will still protect fundamentals
    return res.json({ allowed: true });
  }

  return res.json({ allowed: true });
});

// ── GET /config ───────────────────────────────────────────────────────────────
// Returns current limits for admin inspection.
app.get('/config', (_req, res) => {
  res.json({
    max_stake_per_bet:  MAX_STAKE,
    max_payout_per_bet: MAX_PAYOUT,
    max_daily_stake:    MAX_DAILY_STAKE,
    liability_cap:      LIABILITY_CAP,
  });
});

// ── GET /health ───────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(4000, () =>
  console.log(
    `Risk engine on :4000  ` +
    `[max_stake=${euro(MAX_STAKE)} max_payout=${euro(MAX_PAYOUT)} ` +
    `daily_limit=${euro(MAX_DAILY_STAKE)} liability_cap=${euro(LIABILITY_CAP)}]`
  )
);
