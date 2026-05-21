const { Pool } = require('pg');

const API_KEY       = process.env.ODDS_API_KEY;
const BASE_URL      = 'https://api.the-odds-api.com/v4';
const INTERVAL_MS   = parseFloat(process.env.INGEST_INTERVAL_HOURS       || '6')   * 60 * 60 * 1000;
const SCORE_POLL_MS = parseInt(process.env.SCORE_POLL_INTERVAL_SECONDS    || '120') * 1000;

// ── League list ────────────────────────────────────────────────────────────
// European top leagues (end May, restart August — kept so they auto-appear on season start)
const EU_LEAGUES = [
  'soccer_epl',                          // Premier League
  'soccer_spain_la_liga',                // La Liga
  'soccer_italy_serie_a',                // Serie A
  'soccer_germany_bundesliga',           // Bundesliga
  'soccer_france_ligue_one',             // Ligue 1
  'soccer_greece_super_league',          // Super League Greece (restarts Aug)
  'soccer_netherlands_eredivisie',       // Eredivisie
  'soccer_portugal_primeira_liga',       // Primeira Liga
  'soccer_turkey_super_league',          // Süper Lig
  'soccer_austria_bundesliga',           // Austrian Bundesliga
  'soccer_belgium_first_div',            // Belgium First Div
  'soccer_poland_ekstraklasa',           // Ekstraklasa (Poland)
];

// European 2nd divisions & cups
const EU2_LEAGUES = [
  'soccer_spain_segunda_division',       // La Liga 2
  'soccer_italy_serie_b',               // Serie B
  'soccer_efl_champ',                   // EFL Championship
  'soccer_england_league1',             // League 1
  'soccer_england_league2',             // League 2
  'soccer_germany_bundesliga2',         // Bundesliga 2
  'soccer_germany_dfb_pokal',           // DFB-Pokal
  'soccer_france_coupe_de_france',      // Coupe de France
  'soccer_uefa_champs_league',          // Champions League
  'soccer_uefa_europa_league',          // Europa League
  'soccer_uefa_europa_conference_league',// Conference League
];

// Summer / year-round leagues (active May–September)
const SUMMER_LEAGUES = [
  'soccer_usa_mls',                      // MLS (USA)
  'soccer_brazil_campeonato',            // Brasileirão Serie A
  'soccer_brazil_serie_b',              // Brasileirão Serie B
  'soccer_argentina_primera_division',   // Argentine Primera División
  'soccer_mexico_ligamx',               // Liga MX (Mexico)
  'soccer_chile_campeonato',            // Primera División Chile
  'soccer_australia_aleague',            // A-League (Australia)
  'soccer_sweden_allsvenskan',           // Allsvenskan (Sweden)
  'soccer_sweden_superettan',           // Superettan (Sweden)
  'soccer_norway_eliteserien',           // Eliteserien (Norway)
  'soccer_finland_veikkausliiga',       // Veikkausliiga (Finland)
  'soccer_japan_j_league',             // J1 League (Japan)
  'soccer_china_superleague',          // Super League (China)
  'soccer_conmebol_copa_libertadores',  // Copa Libertadores
  'soccer_conmebol_copa_sudamericana',  // Copa Sudamericana
  'soccer_league_of_ireland',          // League of Ireland
];

// International tournaments
const INTL_LEAGUES = [
  'soccer_fifa_world_cup',               // FIFA World Cup 2026 (Jun 11 – Jul 19)
  'soccer_conmebol_copa_america',        // Copa América
  'soccer_uefa_european_championship',   // Euros
];

const SPORT_KEYS = [...new Set([
  ...EU_LEAGUES,
  ...EU2_LEAGUES,
  ...SUMMER_LEAGUES,
  ...INTL_LEAGUES,
])];

// Fetch window: 21 days ahead to capture full fixture cycles
const DAYS_AHEAD = 21;

const pool = new Pool({
  host:     process.env.DB_HOST     || 'db',
  user:     process.env.DB_USER     || 'betting_user',
  password: process.env.DB_PASSWORD || 'betting_pass',
  database: process.env.DB_NAME     || 'betting_db',
});

const toApiDate = d => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const sleep     = ms => new Promise(r => setTimeout(r, ms));

function currentSeason() {
  const now = new Date();
  const yr  = now.getFullYear();
  return now.getMonth() + 1 >= 8
    ? `${yr}/${String(yr + 1).slice(2)}`
    : `${yr - 1}/${String(yr).slice(2)}`;
}

async function waitForDb() {
  for (let attempt = 1; attempt <= 15; attempt++) {
    try {
      const c = await pool.connect(); c.release(); return;
    } catch {
      console.log(`[db] not ready, waiting 3s... (attempt ${attempt}/15)`);
      await sleep(3000);
    }
  }
  throw new Error('Database never became ready');
}

async function fetchJson(url) {
  const res  = await fetch(url);
  const rem  = res.headers.get('x-requests-remaining');
  const used = res.headers.get('x-requests-used');
  if (rem != null) process.stdout.write(`  [quota] used=${used} remaining=${rem}\n`);
  if (!res.ok) {
    const b = await res.text();
    // 404 = sport key not available yet (tournament not started) — not a hard error
    if (res.status === 404) throw Object.assign(new Error('not available'), { status: 404 });
    throw new Error(`HTTP ${res.status}: ${b}`);
  }
  return res.json();
}

async function fetchSportsMeta() {
  const all = await fetchJson(`${BASE_URL}/sports/?apiKey=${API_KEY}`);
  return Object.fromEntries(all.map(s => [s.key, s.title]));
}

function extractOdds(event) {
  const acc = { home: [], draw: [], away: [] };
  for (const bk of event.bookmakers ?? []) {
    const market = bk.markets?.find(m => m.key === 'h2h');
    if (!market) continue;
    for (const o of market.outcomes) {
      if      (o.name === event.home_team) acc.home.push(o.price);
      else if (o.name === event.away_team) acc.away.push(o.price);
      else if (o.name === 'Draw')          acc.draw.push(o.price);
    }
  }
  const avg = arr =>
    arr.length ? parseFloat((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)) : null;
  return { home_odds: avg(acc.home), draw_odds: avg(acc.draw), away_odds: avg(acc.away) };
}

async function run() {
  const started  = Date.now();
  const now      = new Date();
  const cutoff   = new Date(now.getTime() + DAYS_AHEAD * 24 * 60 * 60 * 1000);
  const season   = currentSeason();

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[ingest] ${now.toISOString()}  season ${season}  window +${DAYS_AHEAD}d`);

  // ── Phase 1: discover which sport keys the API actually knows about ────────
  let sportsMeta;
  try {
    sportsMeta = await fetchSportsMeta();
  } catch (err) {
    console.error(`[ingest] failed to fetch sports metadata: ${err.message}`);
    return;
  }

  // Filter to keys the API recognises (avoids unnecessary 404 requests)
  const activeKeys = SPORT_KEYS.filter(k => k in sportsMeta);
  const unknownKeys = SPORT_KEYS.filter(k => !(k in sportsMeta));
  if (unknownKeys.length) {
    console.log(`  [skip] ${unknownKeys.length} keys not in API: ${unknownKeys.join(', ')}`);
  }

  // ── Phase 2: fetch odds for each active league ────────────────────────────
  const batches  = [];
  let apiErrors  = 0;
  let skipped    = 0;

  for (const sportKey of activeKeys) {
    const leagueName = sportsMeta[sportKey] ?? sportKey;
    process.stdout.write(`  ${leagueName}... `);

    let events;
    try {
      events = await fetchJson(
        `${BASE_URL}/sports/${sportKey}/odds/` +
        `?apiKey=${API_KEY}` +
        `&regions=eu&markets=h2h&dateFormat=iso&oddsFormat=decimal` +
        `&commenceTimeFrom=${toApiDate(now)}` +
        `&commenceTimeTo=${toApiDate(cutoff)}`
      );
    } catch (err) {
      if (err.status === 404) { console.log('no events (tournament pending)'); skipped++; }
      else { console.log(`ERROR — ${err.message}`); apiErrors++; }
      continue;
    }

    const valid = events.filter(ev => {
      if (new Date(ev.commence_time) <= now) return false;
      const { home_odds, draw_odds, away_odds } = extractOdds(ev);
      return home_odds && draw_odds && away_odds;
    });

    if (valid.length > 0) {
      console.log(`${events.length} events, ${valid.length} with odds`);
      batches.push({ sportKey, leagueName, events: valid });
    } else {
      console.log(`${events.length} events, none with odds (season gap)`);
    }
  }

  const total = batches.reduce((n, b) => n + b.events.length, 0);
  console.log(`  ${total} matches ready across ${batches.length} active leagues`);

  if (total === 0) {
    console.log(`[ingest] no new data — keeping existing matches`);
    return;
  }

  // ── Phase 3: safe upsert — never touch admin matches or live/finished rows ─
  const client = await pool.connect();
  let upserted = 0;
  let pruned   = 0;
  try {
    await client.query('BEGIN');

    // Collect external_ids we're about to upsert
    const freshIds = batches.flatMap(b => b.events.map(ev => ev.id));

    // Remove stale scheduled API matches that are no longer in the fresh batch
    // (expired / cancelled events). NEVER touch:
    //   • admin-created rows (external_id IS NULL)
    //   • live / finished rows (in case settlement is pending)
    if (freshIds.length > 0) {
      const { rowCount } = await client.query(
        `DELETE FROM matches
         WHERE external_id IS NOT NULL
           AND status     = 'scheduled'
           AND match_date > NOW()
           AND external_id != ALL($1::text[])`,
        [freshIds]
      );
      pruned = rowCount;
    }

    // Upsert fresh events
    for (const { sportKey, leagueName, events } of batches) {
      for (const ev of events) {
        const { home_odds, draw_odds, away_odds } = extractOdds(ev);
        await client.query(
          `INSERT INTO matches
             (external_id, home_team, away_team, match_date, status,
              home_odds, draw_odds, away_odds, sport_key, league_name, season)
           VALUES ($1,$2,$3,$4,'scheduled',$5,$6,$7,$8,$9,$10)
           ON CONFLICT (external_id) DO UPDATE SET
             home_odds   = EXCLUDED.home_odds,
             draw_odds   = EXCLUDED.draw_odds,
             away_odds   = EXCLUDED.away_odds,
             league_name = EXCLUDED.league_name,
             season      = EXCLUDED.season
           WHERE matches.status = 'scheduled'`,
          [ev.id, ev.home_team, ev.away_team, ev.commence_time,
           home_odds, draw_odds, away_odds, sportKey, leagueName, season]
        );
        upserted++;
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`[ingest] DB error: ${err.message}`);
    return;
  } finally {
    client.release();
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `[ingest] done — ${upserted} upserted, ${pruned} pruned` +
    `  (${elapsed}s, ${apiErrors} API errors, ${skipped} pending tournaments)`
  );
}

async function pollScores() {
  const { rows } = await pool.query(`
    SELECT DISTINCT sport_key
    FROM matches
    WHERE external_id IS NOT NULL
      AND status     != 'finished'
      AND match_date BETWEEN NOW() - INTERVAL '3 hours' AND NOW() + INTERVAL '30 minutes'
  `);

  if (rows.length === 0) return;

  const sportKeys = rows.map(r => r.sport_key).filter(Boolean);
  let settled = 0;

  for (const sportKey of sportKeys) {
    let scores;
    try {
      scores = await fetchJson(
        `${BASE_URL}/sports/${sportKey}/scores/` +
        `?apiKey=${API_KEY}&daysFrom=1&dateFormat=iso`
      );
    } catch (err) {
      console.log(`[scores] ${sportKey}: ${err.message}`);
      continue;
    }

    for (const ev of scores) {
      if (!ev.completed || !ev.scores?.length) continue;

      const homeScore = parseInt(ev.scores.find(s => s.name === ev.home_team)?.score ?? -1);
      const awayScore = parseInt(ev.scores.find(s => s.name === ev.away_team)?.score ?? -1);
      if (homeScore < 0 || awayScore < 0) continue;

      const result = homeScore > awayScore ? 'home' : awayScore > homeScore ? 'away' : 'draw';

      const { rowCount } = await pool.query(
        `UPDATE matches
         SET status = 'finished', result = $1, home_score = $2, away_score = $3
         WHERE external_id = $4 AND status != 'finished'`,
        [result, homeScore, awayScore, ev.id]
      );

      if (rowCount > 0) {
        console.log(
          `[scores] ${ev.home_team} ${homeScore}–${awayScore} ${ev.away_team}  →  ${result}`
        );
        settled++;
      }
    }
  }

  if (settled > 0) {
    console.log(`[scores] ${settled} match(es) marked finished`);
  }
}

async function main() {
  if (!API_KEY) { console.error('ERROR: ODDS_API_KEY is not set'); process.exit(1); }

  console.log(`Data ingestor starting`);
  console.log(`  Match refresh : every ${process.env.INGEST_INTERVAL_HOURS || '6'}h`);
  console.log(`  Score poll    : every ${process.env.SCORE_POLL_INTERVAL_SECONDS || '120'}s`);
  console.log(`  Leagues cfg   : ${SPORT_KEYS.length} keys (API filters to active ones)`);
  console.log(`  Fetch window  : +${DAYS_AHEAD} days\n`);

  await waitForDb();
  await run();
  setInterval(run, INTERVAL_MS);

  setInterval(async () => {
    try { await pollScores(); }
    catch (err) { console.error(`[scores] poll error: ${err.message}`); }
  }, SCORE_POLL_MS);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
