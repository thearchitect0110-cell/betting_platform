const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'db',
  user:     process.env.DB_USER     || 'betting_user',
  password: process.env.DB_PASSWORD || 'betting_pass',
  database: process.env.DB_NAME     || 'betting_db',
});

const POLL_MS = parseInt(process.env.POLL_INTERVAL_MS || '10000');

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function settleAccumulator(client, accaId) {
  const { rows: legs } = await client.query(
    "SELECT id, user_id, amount, odds, status FROM bets WHERE accumulator_id = $1",
    [accaId]
  );
  if (!legs.length || legs.some(l => l.status === 'pending')) return;

  if (legs.every(l => l.status === 'won')) {
    const stake        = parseFloat(legs[0].amount);
    const combinedOdds = legs.reduce((p, l) => p * parseFloat(l.odds), 1);
    const payout       = stake * combinedOdds;
    await client.query(
      'UPDATE users SET balance = balance + $1, updated_at = NOW() WHERE id = $2',
      [payout, legs[0].user_id]
    );
    log(`Accumulator ${accaId} WON — ${legs.length} legs, payout €${payout.toFixed(2)}`);
  } else {
    log(`Accumulator ${accaId} LOST — ${legs.filter(l => l.status === 'lost').length} losing leg(s)`);
  }
}

async function settleMatch(match) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock match row; SKIP LOCKED so a parallel engine instance won't double-process
    const { rows: locked } = await client.query(
      `SELECT id FROM matches
       WHERE id = $1 AND status = 'finished' AND result IS NOT NULL AND settled_at IS NULL
       FOR UPDATE SKIP LOCKED`,
      [match.id]
    );
    if (!locked.length) {
      await client.query('ROLLBACK');
      return;
    }

    // ── Settle single bets ────────────────────────────────────────────────────
    const { rows: singles } = await client.query(
      "SELECT * FROM bets WHERE match_id = $1 AND status = 'pending' AND accumulator_id IS NULL FOR UPDATE",
      [match.id]
    );
    let won = 0, lost = 0;
    for (const bet of singles) {
      if (bet.bet_type === match.result) {
        const payout = parseFloat(bet.amount) * parseFloat(bet.odds);
        await client.query(
          'UPDATE users SET balance = balance + $1, updated_at = NOW() WHERE id = $2',
          [payout, bet.user_id]
        );
        await client.query("UPDATE bets SET status = 'won' WHERE id = $1", [bet.id]);
        won++;
      } else {
        await client.query("UPDATE bets SET status = 'lost' WHERE id = $1", [bet.id]);
        lost++;
      }
    }

    // ── Settle accumulator legs on this match ─────────────────────────────────
    const { rows: accaLegs } = await client.query(
      "SELECT * FROM bets WHERE match_id = $1 AND status = 'pending' AND accumulator_id IS NOT NULL FOR UPDATE",
      [match.id]
    );
    for (const leg of accaLegs) {
      const newStatus = leg.bet_type === match.result ? 'won' : 'lost';
      await client.query("UPDATE bets SET status = $1 WHERE id = $2", [newStatus, leg.id]);
    }

    await client.query('UPDATE matches SET settled_at = NOW() WHERE id = $1', [match.id]);
    await client.query('COMMIT');

    log(
      `Settled match ${match.id} (${match.home_team} vs ${match.away_team}) ` +
      `result=${match.result} — ${won} WON, ${lost} LOST singles; ${accaLegs.length} acca leg(s) marked`
    );

    // ── Check if any accumulators are now fully settled ───────────────────────
    const accaIds = [...new Set(accaLegs.map(l => l.accumulator_id))];
    if (accaIds.length) {
      const accaClient = await pool.connect();
      try {
        await accaClient.query('BEGIN');
        for (const accaId of accaIds) await settleAccumulator(accaClient, accaId);
        await accaClient.query('COMMIT');
      } catch (err) {
        await accaClient.query('ROLLBACK');
        log(`ERROR settling accumulators for match ${match.id}: ${err.message}`);
      } finally {
        accaClient.release();
      }
    }
  } catch (err) {
    await client.query('ROLLBACK');
    log(`ERROR settling match ${match.id}: ${err.message}`);
  } finally {
    client.release();
  }
}

async function poll() {
  const { rows: matches } = await pool.query(`
    SELECT id, home_team, away_team, result
    FROM matches
    WHERE status = 'finished'
      AND result     IS NOT NULL
      AND settled_at IS NULL
  `);

  if (matches.length) {
    log(`Found ${matches.length} unsettled match(es) — processing...`);
    for (const match of matches) await settleMatch(match);
  }
}

async function main() {
  log(`Settlement engine started (poll interval: ${POLL_MS}ms)`);

  // Wait for the DB service to be fully ready on first boot
  await new Promise(r => setTimeout(r, 5000));

  while (true) {
    try {
      await poll();
    } catch (err) {
      log(`Poll error: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

main();
