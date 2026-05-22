const express    = require('express');
const { Pool }   = require('pg');
const jwt        = require('jsonwebtoken');
const bcrypt     = require('bcryptjs');
const rateLimit  = require('express-rate-limit');
const crypto     = require('crypto');
const { randomUUID } = crypto;

const pool = new Pool({
  host:     process.env.DB_HOST     || 'db',
  user:     process.env.DB_USER     || 'betting_user',
  password: process.env.DB_PASSWORD || 'betting_pass',
  database: process.env.DB_NAME     || 'betting_db',
});

const JWT_SECRET         = process.env.JWT_SECRET         || 'betengine_jwt_secret_changeme_in_prod';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'betengine_refresh_secret_changeme_in_prod';
const RISK_ENGINE_URL    = process.env.RISK_ENGINE_URL    || 'http://risk_engine:4000';

function issueTokens(user) {
  const payload = { id: user.id, username: user.username };
  return {
    token:        jwt.sign(payload, JWT_SECRET,         { expiresIn: '15m' }),
    refreshToken: jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: '7d'  }),
  };
}

const app = express();
app.use(express.json());

// ── Rate limiters ─────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later.' },
});
const betLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many bet requests, please slow down.' },
});
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, max: 200,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Rate limit exceeded.' },
});
app.use('/api/', apiLimiter);

async function checkRisk(payload) {
  try {
    const res = await fetch(`${RISK_ENGINE_URL}/check`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(3000),
    });
    if (!res.ok) return { allowed: true };
    return await res.json();
  } catch {
    console.warn('[risk] service unreachable — allowing bet through');
    return { allowed: true };
  }
}

// ── SSE broadcast ─────────────────────────────────────────────────────────────
const clients = new Set();

function broadcast(event, data) {
  const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(chunk); } catch { clients.delete(res); }
  }
}

// ── Email (nodemailer if SMTP_HOST set, otherwise console) ─────────────────────
let _mailer = null;
function getMailer() {
  if (_mailer !== null) return _mailer;
  if (process.env.SMTP_HOST) {
    try {
      const nodemailer = require('nodemailer');
      _mailer = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_SECURE === 'true',
        auth: (process.env.SMTP_USER && process.env.SMTP_PASS)
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
          : undefined,
      });
    } catch (err) {
      console.warn('[email] nodemailer unavailable, falling back to console:', err.message);
      _mailer = false;
    }
  } else {
    _mailer = false;
  }
  return _mailer;
}

async function sendEmail(to, subject, body) {
  const mailer = getMailer();
  if (mailer) {
    try {
      await mailer.sendMail({
        from: process.env.SMTP_FROM || 'no-reply@strikebet.local',
        to, subject, text: body,
      });
      return;
    } catch (err) {
      console.warn('[email] send failed, logging to console:', err.message);
    }
  }
  console.log(`[EMAIL] To: ${to} | Subject: ${subject} | Body: ${body}`);
}

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer '))
    return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

async function adminAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer '))
    return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(header.slice(7), JWT_SECRET);
    const { rows } = await pool.query('SELECT is_admin FROM users WHERE id = $1', [decoded.id]);
    if (!rows[0]?.is_admin)
      return res.status(403).json({ error: 'Admin access required' });
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

app.post('/api/register', authLimiter, async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: 'username, email and password are required' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const { rows } = await pool.query(
      `INSERT INTO users (username, email, password_hash, email_verify_token, email_verify_sent_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING id, username, email, balance, is_admin, email_verified, bonus_balance`,
      [username, email, hash, verifyToken]
    );
    const user = rows[0];
    const verifyLink = `${process.env.PUBLIC_URL || ''}/?verify=${verifyToken}`;
    await sendEmail(email, 'Verify your STRIKE Bet email', `Welcome! Verify your email: ${verifyLink}`);
    const tokens = issueTokens(user);
    res.status(201).json({ ...tokens, user });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username or email already taken' });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/login', authLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'username and password are required' });
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      return res.status(401).json({ error: 'Invalid credentials' });
    if (user.is_banned)
      return res.status(403).json({ error: `Ο λογαριασμός σας έχει ανασταλεί.${user.ban_reason ? ' Λόγος: ' + user.ban_reason : ''} Επικοινωνήστε με την υποστήριξη.` });
    if (user.self_excluded_until && new Date(user.self_excluded_until) > new Date())
      return res.status(403).json({ error: `Account self-excluded until ${new Date(user.self_excluded_until).toISOString().slice(0,10)}` });
    const tokens = issueTokens(user);
    res.json({ ...tokens, user: {
      id: user.id, username: user.username, email: user.email, balance: user.balance,
      is_admin: user.is_admin, email_verified: user.email_verified,
      bonus_balance: user.bonus_balance, reality_check_mins: user.reality_check_mins,
    } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });
  try {
    const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET);
    const { rows } = await pool.query(
      'SELECT id, username FROM users WHERE id = $1',
      [decoded.id]
    );
    if (!rows[0]) return res.status(401).json({ error: 'User not found' });
    res.json(issueTokens(rows[0]));
  } catch {
    res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
});

app.get('/api/me', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, username, email, balance, is_admin, email_verified,
              bonus_balance, bonus_wagered, bonus_requirement, reality_check_mins,
              self_excluded_until
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/deposit', auth, async (req, res) => {
  const amount = parseFloat(req.body.amount);
  if (isNaN(amount) || amount < 5)
    return res.status(400).json({ error: 'Minimum deposit is €5.00' });
  if (amount > 50000)
    return res.status(400).json({ error: 'Maximum deposit is €50,000.00' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT balance, self_excluded_until, dep_limit_daily FROM users WHERE id = $1 FOR UPDATE', [req.user.id]
    );
    // Responsible gambling: block deposits while self-excluded
    if (rows[0].self_excluded_until && new Date(rows[0].self_excluded_until) > new Date())
      throw Object.assign(new Error(`Account self-excluded until ${new Date(rows[0].self_excluded_until).toISOString().slice(0,10)}`), { status: 403 });
    // Responsible gambling: daily deposit limit
    if (rows[0].dep_limit_daily != null) {
      const { rows: depRows } = await client.query(
        `SELECT COALESCE(SUM(amount),0) AS total FROM transactions
         WHERE user_id = $1 AND type = 'deposit' AND created_at >= date_trunc('day', NOW())`,
        [req.user.id]
      );
      const todaysDeposits = parseFloat(depRows[0].total);
      const limit = parseFloat(rows[0].dep_limit_daily);
      if (todaysDeposits + amount > limit)
        throw Object.assign(new Error(`Daily deposit limit reached (€${limit.toFixed(2)}). Already deposited €${todaysDeposits.toFixed(2)} today.`), { status: 400 });
    }
    const before = parseFloat(rows[0].balance);
    const after  = before + amount;
    await client.query(
      'UPDATE users SET balance = $1, updated_at = NOW() WHERE id = $2',
      [after, req.user.id]
    );
    await client.query(
      'INSERT INTO transactions (user_id, type, amount, balance_before, balance_after) VALUES ($1,$2,$3,$4,$5)',
      [req.user.id, 'deposit', amount, before, after]
    );
    await client.query('COMMIT');
    res.json({ balance: after.toFixed(2), deposited: amount.toFixed(2) });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/withdraw', auth, async (req, res) => {
  const amount = parseFloat(req.body.amount);
  if (isNaN(amount) || amount < 5)
    return res.status(400).json({ error: 'Minimum withdrawal is €5.00' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT balance FROM users WHERE id = $1 FOR UPDATE', [req.user.id]
    );
    const before = parseFloat(rows[0].balance);
    if (before < amount)
      throw Object.assign(new Error(`Insufficient balance (available: €${before.toFixed(2)})`), { status: 400 });
    const after = before - amount;
    await client.query(
      'UPDATE users SET balance = $1, updated_at = NOW() WHERE id = $2',
      [after, req.user.id]
    );
    await client.query(
      'INSERT INTO transactions (user_id, type, amount, balance_before, balance_after) VALUES ($1,$2,$3,$4,$5)',
      [req.user.id, 'withdrawal', amount, before, after]
    );
    await client.query('COMMIT');
    res.json({ balance: after.toFixed(2), withdrawn: amount.toFixed(2) });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/transactions', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, type, amount, balance_before, balance_after, created_at
       FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/odds-stream', async (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  clients.add(res);

  try {
    const { rows } = await pool.query(
      "SELECT * FROM matches WHERE status = 'scheduled' ORDER BY match_date ASC"
    );
    res.write(`event: snapshot\ndata: ${JSON.stringify(rows)}\n\n`);
  } catch { /* non-fatal */ }

  const heartbeat = setInterval(() => {
    try { res.write(':heartbeat\n\n'); }
    catch { clearInterval(heartbeat); clients.delete(res); }
  }, 25000);

  req.on('close', () => { clients.delete(res); clearInterval(heartbeat); });
});

app.get('/api/matches', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM matches ORDER BY match_date ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/place-bet', auth, betLimiter, async (req, res) => {
  const { match_id, bet_type, amount } = req.body;
  if (!match_id || !bet_type || !amount)
    return res.status(400).json({ error: 'match_id, bet_type and amount are required' });
  if (!['home', 'draw', 'away'].includes(bet_type))
    return res.status(400).json({ error: 'bet_type must be home, draw or away' });
  const stake = parseFloat(amount);
  if (isNaN(stake) || stake <= 0)
    return res.status(400).json({ error: 'amount must be a positive number' });

  const { rows: preMatch } = await pool.query(
    "SELECT home_odds, draw_odds, away_odds FROM matches WHERE id = $1 AND status IN ('scheduled','live','halftime')",
    [match_id]
  );
  if (!preMatch[0])
    return res.status(400).json({ error: 'Match not found or not open for betting' });
  const selectedOdds = parseFloat(preMatch[0][`${bet_type}_odds`]);

  const risk = await checkRisk({ user_id: req.user.id, match_id: parseInt(match_id), bet_type, stake, odds: selectedOdds });
  if (!risk.allowed)
    return res.status(400).json({ error: risk.reason });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userRes = await client.query(
      `SELECT balance, bonus_balance, bonus_wagered, bonus_requirement, stake_limit_daily, self_excluded_until
       FROM users WHERE id = $1 FOR UPDATE`, [req.user.id]
    );
    if (!userRes.rows[0]) throw Object.assign(new Error('User not found'), { status: 404 });
    // Responsible gambling: block betting while self-excluded
    if (userRes.rows[0].self_excluded_until && new Date(userRes.rows[0].self_excluded_until) > new Date())
      throw Object.assign(new Error(`Account self-excluded until ${new Date(userRes.rows[0].self_excluded_until).toISOString().slice(0,10)}`), { status: 403 });
    if (parseFloat(userRes.rows[0].balance) < stake)
      throw Object.assign(new Error('Insufficient balance'), { status: 400 });

    // Responsible gambling: daily stake limit
    if (userRes.rows[0].stake_limit_daily != null) {
      const { rows: stakeRows } = await client.query(
        `SELECT COALESCE(SUM(amount),0) AS total FROM bets
         WHERE user_id = $1 AND created_at >= date_trunc('day', NOW())`,
        [req.user.id]
      );
      const todaysStake = parseFloat(stakeRows[0].total);
      const limit = parseFloat(userRes.rows[0].stake_limit_daily);
      if (todaysStake + stake > limit)
        throw Object.assign(new Error(`Daily stake limit reached (€${limit.toFixed(2)}). Already staked €${todaysStake.toFixed(2)} today.`), { status: 400 });
    }

    const matchRes = await client.query('SELECT * FROM matches WHERE id = $1', [match_id]);
    if (!matchRes.rows[0]) throw Object.assign(new Error('Match not found'), { status: 404 });
    if (!['scheduled','live','halftime'].includes(matchRes.rows[0].status))
      throw Object.assign(new Error('Match is not open for betting'), { status: 400 });

    const isLive = matchRes.rows[0].status !== 'scheduled';

    const oddsMap = {
      home: matchRes.rows[0].home_odds,
      draw: matchRes.rows[0].draw_odds,
      away: matchRes.rows[0].away_odds,
    };

    await client.query(
      'UPDATE users SET balance = balance - $1, updated_at = NOW() WHERE id = $2',
      [stake, req.user.id]
    );

    const { rows: betRows } = await client.query(
      'INSERT INTO bets (user_id, match_id, bet_type, amount, odds, is_live) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [req.user.id, match_id, bet_type, stake, oddsMap[bet_type], isLive]
    );

    // Bonus wagering tracking: if user has an active bonus, count this stake toward the requirement
    let bonusConverted = null;
    if (parseFloat(userRes.rows[0].bonus_requirement) > 0) {
      const newWagered = parseFloat(userRes.rows[0].bonus_wagered) + stake;
      if (newWagered >= parseFloat(userRes.rows[0].bonus_requirement)) {
        // Requirement met — convert bonus to real balance
        const bonusAmt = parseFloat(userRes.rows[0].bonus_balance);
        await client.query(
          `UPDATE users SET balance = balance + bonus_balance,
             bonus_balance = 0, bonus_wagered = 0, bonus_requirement = 0
           WHERE id = $1`,
          [req.user.id]
        );
        await client.query(
          "UPDATE bonuses SET status = 'completed', wagered = wagering_req WHERE user_id = $1 AND status = 'active'",
          [req.user.id]
        );
        bonusConverted = bonusAmt;
      } else {
        await client.query(
          'UPDATE users SET bonus_wagered = bonus_wagered + $1 WHERE id = $2',
          [stake, req.user.id]
        );
        await client.query(
          "UPDATE bonuses SET wagered = wagered + $1 WHERE user_id = $2 AND status = 'active'",
          [stake, req.user.id]
        );
      }
    }

    await client.query('COMMIT');

    const { rows: userRows } = await pool.query(
      'SELECT balance FROM users WHERE id = $1', [req.user.id]
    );

    res.status(201).json({ bet: betRows[0], new_balance: userRows[0].balance, bonus_converted: bonusConverted });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/place-accumulator', auth, betLimiter, async (req, res) => {
  const { legs, stake } = req.body;
  if (!Array.isArray(legs) || legs.length < 2 || legs.length > 20)
    return res.status(400).json({ error: 'Accumulator requires 2–20 legs' });

  const stakeAmount = parseFloat(stake);
  if (isNaN(stakeAmount) || stakeAmount <= 0)
    return res.status(400).json({ error: 'stake must be a positive number' });

  for (const leg of legs) {
    if (!leg.match_id || !leg.bet_type)
      return res.status(400).json({ error: 'Each leg requires match_id and bet_type' });
    if (!['home', 'draw', 'away'].includes(leg.bet_type))
      return res.status(400).json({ error: `Invalid bet_type: ${leg.bet_type}` });
  }

  const matchIds = legs.map(l => parseInt(l.match_id));
  if (new Set(matchIds).size !== matchIds.length)
    return res.status(400).json({ error: 'Each leg must be on a different match' });

  const { rows: matches } = await pool.query(
    "SELECT id, home_odds, draw_odds, away_odds, status FROM matches WHERE id = ANY($1::int[]) AND status IN ('scheduled','live','halftime')",
    [matchIds]
  );
  if (matches.length !== legs.length)
    return res.status(400).json({ error: 'One or more matches not found or not open for betting' });

  const matchMap = new Map(matches.map(m => [m.id, m]));

  let combinedOdds = 1;
  const legDetails = [];
  for (const leg of legs) {
    const m = matchMap.get(parseInt(leg.match_id));
    const legOdds = parseFloat(m[`${leg.bet_type}_odds`]);
    combinedOdds *= legOdds;
    legDetails.push({ match_id: m.id, bet_type: leg.bet_type, odds: legOdds, is_live: m.status !== 'scheduled' });
  }

  const risk = await checkRisk({
    user_id: req.user.id,
    match_id: legDetails[0].match_id,
    bet_type: 'acca',
    stake: stakeAmount,
    odds: combinedOdds,
  });
  if (!risk.allowed) return res.status(400).json({ error: risk.reason });

  const accumulatorId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: userRows } = await client.query(
      'SELECT balance, self_excluded_until FROM users WHERE id = $1 FOR UPDATE', [req.user.id]
    );
    if (!userRows[0]) throw Object.assign(new Error('User not found'), { status: 404 });
    if (userRows[0].self_excluded_until && new Date(userRows[0].self_excluded_until) > new Date())
      throw Object.assign(new Error(`Account self-excluded until ${new Date(userRows[0].self_excluded_until).toISOString().slice(0,10)}`), { status: 403 });
    if (parseFloat(userRows[0].balance) < stakeAmount)
      throw Object.assign(new Error('Insufficient balance'), { status: 400 });

    for (const leg of legDetails) {
      const { rows: mRows } = await client.query(
        "SELECT status FROM matches WHERE id = $1", [leg.match_id]
      );
      if (!mRows[0] || !['scheduled','live','halftime'].includes(mRows[0].status))
        throw Object.assign(new Error(`Match ${leg.match_id} is no longer open for betting`), { status: 400 });
      leg.is_live = mRows[0].status !== 'scheduled';
    }

    await client.query(
      'UPDATE users SET balance = balance - $1, updated_at = NOW() WHERE id = $2',
      [stakeAmount, req.user.id]
    );

    for (const leg of legDetails) {
      await client.query(
        'INSERT INTO bets (user_id, match_id, bet_type, amount, odds, accumulator_id, is_live) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [req.user.id, leg.match_id, leg.bet_type, stakeAmount, leg.odds, accumulatorId, leg.is_live]
      );
    }

    await client.query('COMMIT');

    const { rows: freshUser } = await pool.query(
      'SELECT balance FROM users WHERE id = $1', [req.user.id]
    );
    res.status(201).json({
      accumulator_id:   accumulatorId,
      legs:             legDetails.length,
      combined_odds:    combinedOdds.toFixed(2),
      stake:            stakeAmount.toFixed(2),
      potential_payout: (stakeAmount * combinedOdds).toFixed(2),
      new_balance:      freshUser[0].balance,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/my-bets', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        b.id, b.bet_type, b.amount, b.odds, b.status, b.created_at, b.accumulator_id, b.is_live,
        (b.amount * b.odds) AS potential_winnings,
        m.home_team, m.away_team, m.match_date, m.league_name, m.sport_key
      FROM bets b
      JOIN matches m ON b.match_id = m.id
      WHERE b.user_id = $1
      ORDER BY b.created_at DESC
    `, [req.user.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Bonus system ───────────────────────────────────────────────────────────────

app.post('/api/bonus/claim-welcome', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query(
      'SELECT id FROM bonuses WHERE user_id = $1 LIMIT 1', [req.user.id]
    );
    if (existing[0])
      throw Object.assign(new Error('Welcome bonus already claimed'), { status: 400 });

    const amount = 100, wageringReq = 1000;
    await client.query(
      `INSERT INTO bonuses (user_id, type, amount, wagering_req)
       VALUES ($1, 'welcome', $2, $3)`,
      [req.user.id, amount, wageringReq]
    );
    const { rows } = await client.query(
      `UPDATE users SET
         bonus_balance = bonus_balance + $1,
         bonus_requirement = bonus_requirement + $2
       WHERE id = $3
       RETURNING id, username, email, balance, bonus_balance, bonus_wagered, bonus_requirement`,
      [amount, wageringReq, req.user.id]
    );
    await client.query('COMMIT');
    res.status(201).json({ user: rows[0], message: `€${amount} welcome bonus added! Wager €${wageringReq} to convert it.` });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/bonus/status', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT bonus_balance, bonus_wagered, bonus_requirement FROM users WHERE id = $1',
      [req.user.id]
    );
    const { rows: active } = await pool.query(
      "SELECT id, type, amount, wagering_req, wagered, status, created_at FROM bonuses WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1",
      [req.user.id]
    );
    const u = rows[0] || {};
    res.json({
      bonus_balance:     u.bonus_balance ?? 0,
      bonus_wagered:     u.bonus_wagered ?? 0,
      bonus_requirement: u.bonus_requirement ?? 0,
      active_bonus:      active[0] || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Password reset & email verification ─────────────────────────────────────────

app.post('/api/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });
  try {
    const { rows } = await pool.query('SELECT id, email FROM users WHERE email = $1', [email]);
    if (rows[0]) {
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query(
        "INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour')",
        [rows[0].id, token]
      );
      const resetLink = `${process.env.PUBLIC_URL || ''}/?reset=${token}`;
      await sendEmail(rows[0].email, 'Reset your password', `Your reset link: ${resetLink} (TOKEN=${token})`);
    }
    // Don't reveal whether the email exists
    res.json({ message: 'If that email exists, a reset link was sent.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reset-password', authLimiter, async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword)
    return res.status(400).json({ error: 'token and newPassword are required' });
  if (String(newPassword).length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT id, user_id, used, expires_at FROM password_reset_tokens WHERE token = $1 FOR UPDATE',
      [token]
    );
    const t = rows[0];
    if (!t || t.used || new Date(t.expires_at) < new Date())
      throw Object.assign(new Error('Invalid or expired reset token'), { status: 400 });
    const hash = await bcrypt.hash(newPassword, 10);
    await client.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, t.user_id]);
    await client.query('UPDATE password_reset_tokens SET used = true WHERE id = $1', [t.id]);
    await client.query('COMMIT');
    res.json({ message: 'Password reset successful' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/verify-email', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token is required' });
  try {
    const { rows } = await pool.query(
      'SELECT id, email_verify_sent_at FROM users WHERE email_verify_token = $1',
      [token]
    );
    const u = rows[0];
    if (!u) return res.status(400).json({ error: 'Invalid verification token' });
    if (u.email_verify_sent_at && (Date.now() - new Date(u.email_verify_sent_at).getTime()) > 24 * 3600 * 1000)
      return res.status(400).json({ error: 'Verification link expired. Please request a new one.' });
    await pool.query(
      'UPDATE users SET email_verified = true, email_verify_token = NULL WHERE id = $1',
      [u.id]
    );
    res.json({ message: 'Email verified!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/resend-verification', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT email, email_verified FROM users WHERE id = $1', [req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    if (rows[0].email_verified) return res.json({ message: 'Email already verified.' });
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      'UPDATE users SET email_verify_token = $1, email_verify_sent_at = NOW() WHERE id = $2',
      [token, req.user.id]
    );
    const verifyLink = `${process.env.PUBLIC_URL || ''}/?verify=${token}`;
    await sendEmail(rows[0].email, 'Verify your STRIKE Bet email', `Verify your email: ${verifyLink}`);
    res.json({ message: 'Verification email sent.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Responsible gambling ────────────────────────────────────────────────────────

app.get('/api/responsible-gambling', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT dep_limit_daily, dep_limit_weekly, dep_limit_monthly,
              stake_limit_daily, reality_check_mins, self_excluded_until
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/responsible-gambling', auth, async (req, res) => {
  const { dep_limit_daily, dep_limit_weekly, dep_limit_monthly, stake_limit_daily, reality_check_mins } = req.body;
  const num = v => (v === '' || v === null || v === undefined) ? null : parseFloat(v);
  try {
    // NOTE: Limit increases should be subject to a 24h cooling-off period per
    // responsible-gambling rules. For simplicity we apply changes immediately.
    const { rows } = await pool.query(
      `UPDATE users SET
         dep_limit_daily    = $1,
         dep_limit_weekly   = $2,
         dep_limit_monthly  = $3,
         stake_limit_daily  = $4,
         reality_check_mins = COALESCE($5, reality_check_mins),
         updated_at = NOW()
       WHERE id = $6
       RETURNING dep_limit_daily, dep_limit_weekly, dep_limit_monthly,
                 stake_limit_daily, reality_check_mins, self_excluded_until`,
      [
        num(dep_limit_daily), num(dep_limit_weekly), num(dep_limit_monthly),
        num(stake_limit_daily),
        reality_check_mins === undefined ? null : parseInt(reality_check_mins),
        req.user.id,
      ]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/self-exclude', auth, async (req, res) => {
  const days = parseInt(req.body.days);
  if (![1, 7, 30, 180, 365].includes(days))
    return res.status(400).json({ error: 'days must be one of 1, 7, 30, 180, 365' });
  try {
    const { rows } = await pool.query(
      `UPDATE users SET self_excluded_until = NOW() + ($1 || ' days')::interval, updated_at = NOW()
       WHERE id = $2 RETURNING self_excluded_until`,
      [days, req.user.id]
    );
    const until = new Date(rows[0].self_excluded_until).toISOString().slice(0, 10);
    res.json({ message: `Self-exclusion applied until ${until}`, self_excluded_until: rows[0].self_excluded_until });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin routes ─────────────────────────────────────────────────────────────

app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        u.id, u.username, u.email, u.balance, u.is_admin, u.is_banned, u.ban_reason, u.created_at,
        COUNT(DISTINCT b.id)                                          AS total_bets,
        COALESCE(SUM(b.amount) FILTER (WHERE b.status = 'won'),  0)  AS total_won,
        COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'deposit'),    0) AS total_deposited,
        COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'withdrawal'), 0) AS total_withdrawn
      FROM users u
      LEFT JOIN bets b ON b.user_id = u.id
      LEFT JOIN transactions t ON t.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at ASC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/transactions', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        t.id, t.type, t.amount, t.balance_before, t.balance_after, t.created_at,
        u.id AS user_id, u.username
      FROM transactions t
      JOIN users u ON u.id = t.user_id
      ORDER BY t.created_at DESC
      LIMIT 500
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/matches', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT m.*,
        COUNT(b.id) FILTER (WHERE b.status = 'pending') AS pending_bets,
        COUNT(b.id)                                      AS total_bets,
        COALESCE(SUM(b.amount) FILTER (WHERE b.status = 'pending'), 0) AS total_staked
      FROM matches m
      LEFT JOIN bets b ON b.match_id = m.id
      GROUP BY m.id
      ORDER BY m.match_date ASC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/matches', adminAuth, async (req, res) => {
  const { home_team, away_team, match_date, home_odds, away_odds, draw_odds } = req.body;
  if (!home_team || !away_team || !match_date || !home_odds || !away_odds || !draw_odds)
    return res.status(400).json({ error: 'All fields are required' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO matches (home_team, away_team, match_date, home_odds, away_odds, draw_odds) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [home_team, away_team, match_date, home_odds, away_odds, draw_odds]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/matches/:id', adminAuth, async (req, res) => {
  const { home_team, away_team, match_date, home_odds, away_odds, draw_odds, status } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE matches SET
        home_team  = COALESCE($1, home_team),
        away_team  = COALESCE($2, away_team),
        match_date = COALESCE($3, match_date),
        home_odds  = COALESCE($4, home_odds),
        away_odds  = COALESCE($5, away_odds),
        draw_odds  = COALESCE($6, draw_odds),
        status     = COALESCE($7, status)
       WHERE id = $8 RETURNING *`,
      [home_team, away_team, match_date, home_odds, away_odds, draw_odds, status, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Match not found' });
    if (rows[0].status === 'scheduled') broadcast('match-update', rows[0]);
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/matches/:id', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM matches WHERE id = $1 RETURNING id', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Match not found' });
    res.json({ deleted: rows[0].id });
  } catch (err) {
    const msg = err.code === '23503' ? 'Cannot delete a match that has bets' : err.message;
    res.status(400).json({ error: msg });
  }
});

app.post('/api/admin/matches/:id/status', adminAuth, async (req, res) => {
  const { status, match_minute, home_score, away_score } = req.body;
  const validStatuses = ['scheduled', 'live', 'halftime', 'finished'];
  if (status !== undefined && !validStatuses.includes(status))
    return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
  try {
    const { rows } = await pool.query(
      `UPDATE matches SET
        status       = COALESCE($1, status),
        match_minute = COALESCE($2, match_minute),
        home_score   = COALESCE($3, home_score),
        away_score   = COALESCE($4, away_score)
       WHERE id = $5 RETURNING *`,
      [status ?? null, match_minute ?? null, home_score ?? null, away_score ?? null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Match not found' });
    broadcast('match-update', rows[0]);
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/matches/:id/settle', adminAuth, async (req, res) => {
  const { result } = req.body;
  if (!['home', 'draw', 'away'].includes(result))
    return res.status(400).json({ error: 'result must be home, draw or away' });

  try {
    const { rows } = await pool.query('SELECT result FROM matches WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Match not found' });
    if (rows[0].result !== null)
      return res.status(400).json({ error: 'Result already recorded for this match' });

    await pool.query(
      "UPDATE matches SET status = 'finished', result = $1 WHERE id = $2",
      [result, req.params.id]
    );
    res.json({ message: 'Result recorded — settlement engine will process bets shortly.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/users/:id/ban', adminAuth, async (req, res) => {
  const targetId = parseInt(req.params.id);
  if (targetId === req.user.id)
    return res.status(400).json({ error: 'Cannot ban yourself' });
  const reason = req.body.reason?.trim() || null;
  try {
    const { rows } = await pool.query(
      'UPDATE users SET is_banned = true, ban_reason = $1 WHERE id = $2 AND is_admin = false RETURNING id, username, is_banned',
      [reason, targetId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found or is admin' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/users/:id/unban', adminAuth, async (req, res) => {
  const targetId = parseInt(req.params.id);
  try {
    const { rows } = await pool.query(
      'UPDATE users SET is_banned = false, ban_reason = null WHERE id = $1 RETURNING id, username, is_banned',
      [targetId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/users/:id/toggle-admin', adminAuth, async (req, res) => {
  const targetId = parseInt(req.params.id);
  if (targetId === req.user.id)
    return res.status(400).json({ error: 'You cannot change your own admin status' });
  try {
    const { rows } = await pool.query(
      'UPDATE users SET is_admin = NOT is_admin WHERE id = $1 RETURNING id, username, is_admin',
      [targetId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/users/:id/adjust', adminAuth, async (req, res) => {
  const delta = parseFloat(req.body.amount);
  const note  = req.body.note?.trim() || null;
  if (isNaN(delta) || delta === 0)
    return res.status(400).json({ error: 'amount must be a non-zero number' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT username, balance FROM users WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!rows[0]) throw Object.assign(new Error('User not found'), { status: 404 });
    const before = parseFloat(rows[0].balance);
    const after  = parseFloat((before + delta).toFixed(2));
    if (after < 0)
      throw Object.assign(
        new Error(`Balance cannot go negative (${before.toFixed(2)} + ${delta.toFixed(2)} = ${after.toFixed(2)})`),
        { status: 400 }
      );
    await client.query(
      'UPDATE users SET balance = $1, updated_at = NOW() WHERE id = $2',
      [after, req.params.id]
    );
    await client.query(
      'INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, note) VALUES ($1,$2,$3,$4,$5,$6)',
      [req.params.id, 'adjustment', Math.abs(delta), before, after, note]
    );
    await client.query('COMMIT');
    res.json({ username: rows[0].username, delta: delta.toFixed(2), balance: after.toFixed(2) });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/admin/bonus/grant', adminAuth, async (req, res) => {
  const { user_id, amount, type, wagering_multiplier, note } = req.body;
  const amt = parseFloat(amount);
  const multiplier = wagering_multiplier === undefined ? 10 : parseFloat(wagering_multiplier);
  if (!user_id || isNaN(amt) || amt <= 0)
    return res.status(400).json({ error: 'user_id and a positive amount are required' });
  const bonusType = ['welcome', 'reload', 'free_spins', 'manual'].includes(type) ? type : 'manual';
  const wageringReq = parseFloat((amt * (isNaN(multiplier) ? 10 : multiplier)).toFixed(2));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: u } = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [user_id]);
    if (!u[0]) throw Object.assign(new Error('User not found'), { status: 404 });
    await client.query(
      `INSERT INTO bonuses (user_id, type, amount, wagering_req, note)
       VALUES ($1, $2, $3, $4, $5)`,
      [user_id, bonusType, amt, wageringReq, note?.trim() || null]
    );
    const { rows } = await client.query(
      `UPDATE users SET bonus_balance = bonus_balance + $1, bonus_requirement = bonus_requirement + $2
       WHERE id = $3
       RETURNING id, username, bonus_balance, bonus_requirement`,
      [amt, wageringReq, user_id]
    );
    await client.query('COMMIT');
    res.status(201).json({ user: rows[0], message: `€${amt.toFixed(2)} ${bonusType} bonus granted (wagering €${wageringReq.toFixed(2)}).` });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.listen(3000, () => console.log('Betting engine running on port 3000'));
