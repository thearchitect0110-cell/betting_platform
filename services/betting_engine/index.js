const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  user: process.env.DB_USER || 'betting_user',
  password: process.env.DB_PASSWORD || 'betting_pass',
  database: process.env.DB_NAME || 'betting_db',
});

const JWT_SECRET = process.env.JWT_SECRET || 'betengine_jwt_secret_changeme_in_prod';

const app = express();
app.use(express.json());

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

app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: 'username, email and password are required' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email, balance, is_admin',
      [username, email, hash]
    );
    const user = rows[0];
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
    res.status(201).json({ token, user });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username or email already taken' });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'username and password are required' });
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { id: user.id, username: user.username, email: user.email, balance: user.balance, is_admin: user.is_admin } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/me', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, username, email, balance, is_admin FROM users WHERE id = $1',
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
      'SELECT balance FROM users WHERE id = $1 FOR UPDATE', [req.user.id]
    );
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
    res.status(500).json({ error: err.message });
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

app.get('/api/matches', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM matches ORDER BY match_date ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/place-bet', auth, async (req, res) => {
  const { match_id, bet_type, amount } = req.body;
  if (!match_id || !bet_type || !amount)
    return res.status(400).json({ error: 'match_id, bet_type and amount are required' });
  if (!['home', 'draw', 'away'].includes(bet_type))
    return res.status(400).json({ error: 'bet_type must be home, draw or away' });
  const stake = parseFloat(amount);
  if (isNaN(stake) || stake <= 0)
    return res.status(400).json({ error: 'amount must be a positive number' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userRes = await client.query(
      'SELECT balance FROM users WHERE id = $1 FOR UPDATE',
      [req.user.id]
    );
    if (!userRes.rows[0]) throw Object.assign(new Error('User not found'), { status: 404 });
    if (parseFloat(userRes.rows[0].balance) < stake)
      throw Object.assign(new Error('Insufficient balance'), { status: 400 });

    const matchRes = await client.query('SELECT * FROM matches WHERE id = $1', [match_id]);
    if (!matchRes.rows[0]) throw Object.assign(new Error('Match not found'), { status: 404 });
    if (matchRes.rows[0].status !== 'scheduled')
      throw Object.assign(new Error('Match is not open for betting'), { status: 400 });

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
      'INSERT INTO bets (user_id, match_id, bet_type, amount, odds) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [req.user.id, match_id, bet_type, stake, oddsMap[bet_type]]
    );

    await client.query('COMMIT');

    const { rows: userRows } = await pool.query(
      'SELECT balance FROM users WHERE id = $1', [req.user.id]
    );

    res.status(201).json({ bet: betRows[0], new_balance: userRows[0].balance });
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
        b.id, b.bet_type, b.amount, b.odds, b.status, b.created_at,
        (b.amount * b.odds) AS potential_winnings,
        m.home_team, m.away_team, m.match_date
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

// ── Admin routes ─────────────────────────────────────────────────────────────

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

app.post('/api/admin/matches/:id/settle', adminAuth, async (req, res) => {
  const { result } = req.body;
  if (!['home', 'draw', 'away'].includes(result))
    return res.status(400).json({ error: 'result must be home, draw or away' });

  try {
    const { rows } = await pool.query('SELECT status FROM matches WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Match not found' });
    if (rows[0].status === 'finished')
      return res.status(400).json({ error: 'Match already finished' });

    await pool.query(
      "UPDATE matches SET status = 'finished', result = $1 WHERE id = $2",
      [result, req.params.id]
    );
    res.json({ message: 'Result recorded — settlement engine will process bets shortly.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => console.log('Betting engine running on port 3000'));
