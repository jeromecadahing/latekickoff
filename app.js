/* Late Kick-off – NFL & NBA schedule with UK channels, today's odds and form,
 * plus standings. Data: ESPN public site API (no key needed). */
(function () {
  'use strict';

  const TZ = 'Europe/London';
  const SITE = 'https://site.api.espn.com/apis/site/v2/sports';
  const STANDINGS = 'https://site.api.espn.com/apis/v2/sports';
  const LEAGUES = {
    nfl: { label: 'NFL', path: 'football/nfl', h2hSeasons: 5 },
    nba: { label: 'NBA', path: 'basketball/nba', h2hSeasons: 3 }
  };
  const DAYS_SHOWN = 7;
  const FORM_GAMES = 5;
  const H2H_SHOWN = 6;
  const LIVE_REFRESH_MS = 60_000;
  const MAX_PARALLEL = 6;

  // ---------- state ----------
  const prefs = loadPrefs();
  const state = {
    tab: prefs.tab || 'schedule',
    league: prefs.league || 'all',
    todayLeague: prefs.todayLeague || 'all',
    tvOnly: !!prefs.tvOnly,
    canWatch: !!prefs.canWatch,
    mine: Array.isArray(prefs.mine) ? prefs.mine : [...window.UKTV.DEFAULT_MINE],
    standingsLeague: prefs.standingsLeague || 'nfl',
    oddsLeague: prefs.oddsLeague || 'all',
    start: todayLondon(),
    refreshTimer: null
  };
  const cache = new Map();

  // ---------- helpers ----------
  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem('lko-prefs')) || {}; } catch { return {}; }
  }
  function savePrefs() {
    const { tab, league, todayLeague, tvOnly, canWatch, mine, standingsLeague, oddsLeague } = state;
    try {
      localStorage.setItem('lko-prefs', JSON.stringify({ tab, league, todayLeague, tvOnly, canWatch, mine, standingsLeague, oddsLeague }));
    } catch { /* storage unavailable – fine */ }
  }

  function todayLondon() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()); // YYYY-MM-DD
  }
  function addDays(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10);
  }
  const compact = iso => iso.replace(/-/g, '');

  function londonParts(date) {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: TZ, weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
      }).formatToParts(date).map(x => [x.type, x.value])
    );
    return { ymd: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, hour: Number(p.hour), time: `${p.hour}:${p.minute}` };
  }
  const fmtUTC = (iso, opts) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d, 12)));
  };
  const dayHeading = iso => fmtUTC(iso, { weekday: 'long', day: 'numeric', month: 'long' });
  const shortDate = iso => fmtUTC(iso, { day: 'numeric', month: 'short' });
  const pastDate = d => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: '2-digit', timeZone: TZ }).format(d);

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Fetch with caching and a small parallel limit so we don't hammer ESPN.
  let active = 0;
  const queue = [];
  function limited(fn) {
    return new Promise((resolve, reject) => {
      const run = () => {
        active++;
        fn().then(resolve, reject).finally(() => { active--; if (queue.length) queue.shift()(); });
      };
      active < MAX_PARALLEL ? run() : queue.push(run);
    });
  }
  function getJSON(url) {
    if (cache.has(url)) return cache.get(url);
    const p = limited(async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
      return res.json();
    });
    cache.set(url, p);
    p.catch(() => cache.delete(url));
    return p;
  }

  // ---------- odds ----------
  function toNum(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v;
    if (/even/i.test(v)) return 100;
    const n = parseFloat(String(v).replace('+', ''));
    return Number.isFinite(n) ? n : null;
  }
  function parseOdds(o) {
    if (!o) return null;
    const ml = side => toNum(
      o[`${side}TeamOdds`]?.moneyLine ??
      o.moneyline?.[side]?.close?.odds ?? o.moneyline?.[side]?.open?.odds
    );
    const odds = {
      provider: o.provider?.name || '',
      details: o.details || '',
      overUnder: o.overUnder ?? null,
      home: ml('home'),
      away: ml('away')
    };
    return (odds.home != null || odds.away != null || odds.details) ? odds : null;
  }
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  function americanTo(ml) {
    if (ml == null || ml === 0) return null;
    const [num, den] = ml > 0 ? [ml, 100] : [100, Math.abs(ml)];
    const g = gcd(Math.round(num), Math.round(den)) || 1;
    return {
      decimal: (1 + num / den).toFixed(2),
      fractional: num === den ? 'Evens' : `${Math.round(num) / g}/${Math.round(den) / g}`,
      implied: ml > 0 ? 100 / (ml + 100) : -ml / (-ml + 100)
    };
  }

  // ---------- schedule data ----------
  function parseTeam(c) {
    const t = c?.team || {};
    const rec = type => (c?.records || []).find(r => r.type === type || r.name === type)?.summary || '';
    return {
      id: t.id,
      name: t.displayName || t.name || 'TBC',
      short: t.shortDisplayName || t.name || t.abbreviation || 'TBC',
      abbr: t.abbreviation || '',
      logo: t.logo || t.logos?.[0]?.href || '',
      score: c?.score,
      record: rec('total') || c?.records?.[0]?.summary || '',
      homeRecord: rec('home'),
      awayRecord: rec('road') || rec('away'),
      winner: !!c?.winner
    };
  }

  function parseEvent(ev, league, skipHistory) {
    const comp = ev.competitions?.[0] || {};
    const cs = comp.competitors || [];
    const status = comp.status?.type || ev.status?.type || {};
    const date = new Date(ev.date);
    const country = comp.venue?.address?.country || '';
    const usTv = [...new Set([
      ...(comp.broadcasts || []).flatMap(b => b.names || []),
      ...(comp.geoBroadcasts || []).map(g => g.media?.shortName).filter(Boolean)
    ])];

    const game = {
      id: ev.id,
      league,
      date,
      uk: londonParts(date),
      home: parseTeam(cs.find(c => c.homeAway === 'home')),
      away: parseTeam(cs.find(c => c.homeAway === 'away')),
      state: status.state || 'pre',
      detail: status.shortDetail || status.detail || '',
      seasonType: ev.season?.type ?? ev.seasonType?.type,
      seasonYear: ev.season?.year,
      venue: comp.venue?.fullName || '',
      international: !!country && !/^(usa|united states)$/i.test(country),
      notes: (comp.notes || []).map(n => n.headline).filter(Boolean),
      odds: parseOdds(comp.odds?.[0]),
      usTv
    };
    game.channels = window.UKTV.channelsFor(game);
    game.onUkTv = game.channels.some(c => c.kind === 'tv');
    if (!skipHistory) noteGame(game);
    return game;
  }

  async function loadDays(start, days) {
    // ESPN groups games by US date. A late US game falls on the next UK date,
    // so fetch the day before the range too and regroup by UK date.
    const usDates = Array.from({ length: days + 1 }, (_, i) => compact(addDays(start, i - 1)));
    const end = addDays(start, days - 1);
    const jobs = [];
    for (const key of Object.keys(LEAGUES)) {
      for (const d of usDates) {
        jobs.push(getJSON(`${SITE}/${LEAGUES[key].path}/scoreboard?dates=${d}&limit=200`)
          .then(data => (data.events || []).map(ev => parseEvent(ev, key))));
      }
    }
    const results = await Promise.allSettled(jobs);
    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed === results.length) throw new Error('Could not reach ESPN');

    const byId = new Map();
    results.forEach(r => r.status === 'fulfilled' && r.value.forEach(g => byId.set(`${g.league}-${g.id}`, g)));
    const games = [...byId.values()].filter(g => g.uk.ymd >= start && g.uk.ymd <= end).sort((a, b) => a.date - b.date);
    return { games, partial: failed > 0 };
  }

  // ---------- odds history ----------
  // Every game seen with odds is saved on this device. Pre-game odds are kept
  // up to kick-off (so we end up with the closing line), then the final score
  // is added. Past games are also back-filled from ESPN.
  const HIST_KEY = 'lko-odds-history';
  const CHECKED_KEY = 'lko-odds-checked';
  const DONE_KEY = 'lko-odds-done';
  const HIST_MAX_DAYS = 400;
  const SUMMARY_BUDGET = 120;           // max extra odds look-ups per session
  const NBA_BACKFILL_DAYS = 21;

  const readStore = (k, fallback) => {
    try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; }
  };
  const hist = readStore(HIST_KEY, {});
  const checked = new Set(readStore(CHECKED_KEY, []));
  const doneChunks = new Set(readStore(DONE_KEY, []));
  let summaryBudget = SUMMARY_BUDGET;
  let saveTimer = null;

  function persistHistory() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const cutoff = Date.now() - HIST_MAX_DAYS * 864e5;
      for (const k of Object.keys(hist)) if (hist[k].t < cutoff) delete hist[k];
      try {
        localStorage.setItem(HIST_KEY, JSON.stringify(hist));
        localStorage.setItem(CHECKED_KEY, JSON.stringify([...checked].slice(-3000)));
        localStorage.setItem(DONE_KEY, JSON.stringify([...doneChunks]));
      } catch { /* storage full or unavailable */ }
    }, 400);
  }

  function noteGame(g, oddsOverride) {
    const key = `${g.league}-${g.id}`;
    const odds = oddsOverride || g.odds;
    let r = hist[key];
    if (!r && !odds) return;
    if (!r) {
      r = hist[key] = {
        id: g.id, league: g.league, t: g.date.getTime(), yr: g.seasonYear, st: g.seasonType,
        h: { id: String(g.home.id), a: g.home.abbr, n: g.home.short },
        a: { id: String(g.away.id), a: g.away.abbr, n: g.away.short }
      };
    }
    if (odds && (g.state === 'pre' || !r.o || oddsOverride)) {
      r.o = { h: odds.home, a: odds.away, d: odds.details, ou: odds.overUnder, p: odds.provider };
    }
    if (g.state === 'post') {
      const hs = toNum(g.home.score), as = toNum(g.away.score);
      if (hs != null && as != null) { r.hs = hs; r.as = as; }
    }
    persistHistory();
  }

  // Work out what the odds said and whether it happened.
  function grade(r) {
    if (!r.o || r.hs == null) return null;
    const o = r.o;
    let fav = null, prob = null, line = null;
    const hp = americanTo(o.h), ap = americanTo(o.a);
    if (hp && ap && o.h !== o.a) {
      fav = o.h < o.a ? 'h' : 'a';
      const total = hp.implied + ap.implied;
      prob = (fav === 'h' ? hp.implied : ap.implied) / total;
    }
    const m = /^([A-Za-z]{2,4})\s+([+-]?\d+(?:\.\d+)?)/.exec(o.d || '');
    if (m) {
      const side = m[1].toUpperCase() === (r.h.a || '').toUpperCase() ? 'h'
        : m[1].toUpperCase() === (r.a.a || '').toUpperCase() ? 'a' : null;
      if (side) { fav = fav || side; if (side === fav) line = Math.abs(parseFloat(m[2])); }
    }
    if (!fav) return null;
    const favScore = fav === 'h' ? r.hs : r.as;
    const dogScore = fav === 'h' ? r.as : r.hs;
    const margin = favScore - dogScore;
    const ou = toNum(o.ou);
    const pts = r.hs + r.as;
    return {
      fav, prob, line,
      favWon: margin === 0 ? null : margin > 0,
      cover: line == null ? null : margin - line > 0 ? 'yes' : margin - line < 0 ? 'no' : 'push',
      total: ou == null ? null : pts > ou ? 'over' : pts < ou ? 'under' : 'push'
    };
  }

  function gradedGames(league) {
    return Object.values(hist)
      .filter(r => league === 'all' || r.league === league)
      .map(r => ({ r, g: grade(r) }))
      .filter(x => x.g)
      .sort((a, b) => b.r.t - a.r.t);
  }

  // A team's record as favourite and as underdog this season.
  function teamOddsRecord(league, teamId, year) {
    const out = { fav: [0, 0], dog: [0, 0] };
    for (const { r, g } of gradedGames(league)) {
      if (year && r.yr !== year) continue;
      const side = r.h.id === String(teamId) ? 'h' : r.a.id === String(teamId) ? 'a' : null;
      if (!side || g.favWon == null) continue;
      const won = (side === g.fav) === g.favWon;
      const bucket = side === g.fav ? out.fav : out.dog;
      bucket[won ? 0 : 1]++;
    }
    return out;
  }

  async function fillMissingOdds(events, league) {
    for (const ev of events || []) {
      const key = `${league}-${ev.id}`;
      const status = ev.competitions?.[0]?.status?.type || ev.status?.type || {};
      if (!status.completed || hist[key]?.o || checked.has(key) || summaryBudget <= 0) continue;
      summaryBudget--;
      try {
        const sum = await getJSON(`${SITE}/${LEAGUES[league].path}/summary?event=${ev.id}`);
        const o = parseOdds(sum.pickcenter?.[0] || sum.odds?.[0]);
        if (o) noteGame(parseEvent(ev, league, true), o);
        checked.add(key);
      } catch { /* try again another time */ }
    }
  }

  const allFinal = events => (events || []).length > 0 &&
    events.every(ev => (ev.competitions?.[0]?.status?.type || ev.status?.type || {}).completed);

  let backfilling = null;
  function backfillOdds(onProgress = () => {}) {
    if (backfilling) return backfilling;
    backfilling = (async () => {
      // NFL: every finished week of the current season.
      try {
        onProgress('Checking past NFL weeks…');
        const cur = await getJSON(`${SITE}/football/nfl/scoreboard`);
        (cur.events || []).forEach(ev => parseEvent(ev, 'nfl'));
        const year = cur.season?.year, type = cur.season?.type, week = cur.week?.number || 1;
        const lastWeek = type === 2 ? week : type === 3 ? 18 : 0;
        for (let w = 1; w <= lastWeek; w++) {
          const chunk = `nfl-${year}-${w}`;
          if (doneChunks.has(chunk)) continue;
          onProgress(`Checking NFL week ${w}…`);
          const d = await getJSON(`${SITE}/football/nfl/scoreboard?seasontype=2&week=${w}&dates=${year}`);
          (d.events || []).forEach(ev => parseEvent(ev, 'nfl'));
          await fillMissingOdds(d.events, 'nfl');
          if (w < week || type !== 2) if (allFinal(d.events)) doneChunks.add(chunk);
        }
      } catch { /* NFL back-fill unavailable right now */ }

      // NBA: the last few weeks, day by day.
      try {
        const today = todayLondon();
        for (let i = NBA_BACKFILL_DAYS; i >= 1; i--) {
          const day = compact(addDays(today, -i));
          const chunk = `nba-${day}`;
          if (doneChunks.has(chunk)) continue;
          onProgress('Checking recent NBA games…');
          const d = await getJSON(`${SITE}/basketball/nba/scoreboard?dates=${day}&limit=200`);
          (d.events || []).forEach(ev => parseEvent(ev, 'nba'));
          await fillMissingOdds(d.events, 'nba');
          if (i > 1 && (allFinal(d.events) || !(d.events || []).length)) doneChunks.add(chunk);
        }
      } catch { /* NBA back-fill unavailable right now */ }
      persistHistory();
    })().finally(() => { backfilling = null; });
    return backfilling;
  }

  // ---------- odds record tab ----------
  const oddsEl = document.getElementById('odds-record');
  const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
  const BANDS = [
    { name: 'Heavy favourites', from: 0.75, to: 1.01 },
    { name: 'Clear favourites', from: 0.6, to: 0.75 },
    { name: 'Slight favourites', from: 0, to: 0.6 }
  ];

  function renderOddsRecord(progress) {
    const league = state.oddsLeague;
    const games = gradedGames(league);
    const progressHTML = progress ? `<div class="notice slim left"><span class="spinner" aria-hidden="true"></span>${esc(progress)}</div>` : '';

    if (!games.length) {
      oddsEl.innerHTML = progressHTML || `<div class="notice empty">
        <p>No finished games with odds yet${league === 'all' ? '' : ` for the ${LEAGUES[league].label}`}.</p>
        <p>The app saves the odds for every game it shows, so this fills up as games are played. Check back after the next game day.</p></div>`;
      return;
    }

    const decided = games.filter(x => x.g.favWon != null);
    const favWins = decided.filter(x => x.g.favWon).length;
    const spread = games.filter(x => x.g.cover && x.g.cover !== 'push');
    const covers = spread.filter(x => x.g.cover === 'yes').length;
    const totals = games.filter(x => x.g.total && x.g.total !== 'push');
    const overs = totals.filter(x => x.g.total === 'over').length;

    const headline = `<div class="hit-rate">
      <div class="hit-main">
        <span class="hit-num">${pct(favWins, decided.length)}%</span>
        <span class="hit-lbl">of favourites won (${favWins} of ${decided.length} games)</span>
      </div>
      <dl class="hit-side">
        ${spread.length ? `<div><dt>Favourite covered the spread</dt><dd>${pct(covers, spread.length)}% <small>${covers} of ${spread.length}</small></dd></div>` : ''}
        ${totals.length ? `<div><dt>Went over the points total</dt><dd>${pct(overs, totals.length)}% <small>${overs} of ${totals.length}</small></dd></div>` : ''}
        <div><dt>Upsets</dt><dd>${decided.length - favWins} <small>underdog wins</small></dd></div>
      </dl>
    </div>`;

    const withProb = decided.filter(x => x.g.prob != null);
    const bandRows = BANDS.map(b => {
      const inBand = withProb.filter(x => x.g.prob >= b.from && x.g.prob < b.to);
      if (!inBand.length) return '';
      const expected = Math.round(inBand.reduce((t, x) => t + x.g.prob, 0) / inBand.length * 100);
      const actual = pct(inBand.filter(x => x.g.favWon).length, inBand.length);
      const diff = actual - expected;
      const verdict = Math.abs(diff) <= 5 ? 'About right' : diff > 0 ? `Won more often than the odds said (+${diff}%)` : `Won less often than the odds said (−${-diff}%)`;
      return `<div class="band">
        <div class="band-head"><strong>${b.name}</strong><span>${inBand.length} ${inBand.length === 1 ? 'game' : 'games'}</span></div>
        <div class="band-bars">
          <span class="bl">Odds said</span><span class="track"><span class="fill exp" style="width:${expected}%"></span></span><span class="bv">${expected}%</span>
          <span class="bl">Actually won</span><span class="track"><span class="fill act" style="width:${actual}%"></span></span><span class="bv">${actual}%</span>
        </div>
        <p class="verdict">${verdict}</p>
      </div>`;
    }).join('');

    const recent = games.slice(0, 40).map(({ r, g }) => {
      const favT = g.fav === 'h' ? r.h : r.a;
      const price = americanTo(g.fav === 'h' ? r.o.h : r.o.a);
      const date = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: TZ }).format(new Date(r.t));
      const outcome = g.favWon == null ? ['tie', 'Tie'] : g.favWon ? ['hit', 'Favourite won'] : ['miss', 'Upset'];
      const extras = [
        g.cover ? `Spread ${g.cover === 'yes' ? 'covered' : g.cover === 'no' ? 'not covered' : 'push'}` : '',
        g.total ? `${g.total === 'push' ? 'Total push' : g.total === 'over' ? 'Over' : 'Under'} ${r.o.ou}` : ''
      ].filter(Boolean).join(', ');
      return `<li class="${outcome[0]}">
        <span class="odate">${esc(date)}<span class="league-tag ${r.league}">${LEAGUES[r.league].label}</span></span>
        <span class="ogame">${esc(r.a.n)} ${r.as} <span class="muted-i">at</span> ${esc(r.h.n)} ${r.hs}</span>
        <span class="ofav">Favourite: ${esc(favT.n)}${price ? ` <span class="frac">${price.decimal}</span>` : ''}${extras ? `<small>${esc(extras)}</small>` : ''}</span>
        <span class="oresult">${outcome[1]}</span>
      </li>`;
    }).join('');

    oddsEl.innerHTML = `${progressHTML}${headline}
      ${bandRows ? `<h2 class="day-head">How accurate were the odds?</h2>
        <p class="intro">If the odds are well judged, teams given a 70% chance should win about 70% of the time.</p>
        <div class="bands">${bandRows}</div>` : ''}
      <h2 class="day-head">Recent results <span class="count">${games.length} games tracked</span></h2>
      <ol class="odds-list">${recent}</ol>
      <p class="gamble">Uses the last odds ESPN listed before each game, mostly from US bookmakers. History is saved on this device only.
        Past results don't predict future ones. If you bet, you must be 18+. For free support, visit <a href="https://www.begambleaware.org" rel="noopener">BeGambleAware.org</a>.</p>`;
  }

  async function showOddsRecord() {
    renderOddsRecord('Checking past games for odds…');
    let last = 0;
    await backfillOdds(msg => {
      if (state.tab !== 'odds' || Date.now() - last < 600) return;
      last = Date.now();
      renderOddsRecord(msg);
    });
    if (state.tab === 'odds') renderOddsRecord();
  }

  function clearScoreboardCache() {
    for (const k of [...cache.keys()]) if (k.includes('/scoreboard') || k.includes('/summary')) cache.delete(k);
  }

  // ---------- shared render bits ----------
  function renderLoading(el, msg) {
    el.innerHTML = `<div class="notice"><span class="spinner" aria-hidden="true"></span>${esc(msg)}</div>`;
  }
  function renderError(el, err, retry) {
    el.innerHTML = `<div class="notice error">
      <p><strong>Couldn't load the data.</strong> ${esc(err.message)}. Check your connection, then try again.</p>
      <button class="btn" type="button">Try again</button></div>`;
    el.querySelector('button').addEventListener('click', retry);
  }

  const canWatch = g => g.channels.some(c => state.mine.includes(c.id));

  function chipHTML(ch) {
    const mine = state.mine.includes(ch.id);
    const cls = ['chip', ch.kind === 'tv' ? 'chip-tv' : 'chip-stream',
      ch.certainty === 'possible' ? 'chip-maybe' : '', mine ? 'chip-mine' : ''].filter(Boolean).join(' ');
    const title = [
      ch.certainty === 'possible' ? 'Only some games in this slot are shown, so check the TV listings' :
        (ch.kind === 'tv' ? 'UK TV channel' : 'Streaming service'),
      mine ? 'You have this' : ''
    ].filter(Boolean).join('. ');
    return `<span class="${cls}" title="${esc(title)}">${mine ? '<span class="tick" aria-hidden="true">✓</span>' : ''}${esc(ch.name)}${ch.certainty === 'possible' ? '<span class="q" aria-label="possibly">?</span>' : ''}</span>`;
  }
  const channelsHTML = g => g.channels.map(chipHTML).join('');

  function statusHTML(g) {
    if (g.state === 'in') return `<span class="status live"><span class="dot" aria-hidden="true"></span>${esc(g.detail || 'Live')}</span>`;
    if (g.state === 'post') return `<span class="status final">${esc(g.detail || 'Final')}</span>`;
    if (/postponed|canceled|cancelled|delayed/i.test(g.detail)) return `<span class="status">${esc(g.detail)}</span>`;
    return '';
  }
  const logoHTML = (t, size) => t.logo
    ? `<img src="${esc(t.logo)}" alt="" width="${size}" height="${size}" loading="lazy">`
    : `<span class="logo-fallback" style="width:${size}px;height:${size}px" aria-hidden="true">${esc(t.abbr.slice(0, 3))}</span>`;

  // ---------- schedule ----------
  const scheduleEl = document.getElementById('schedule');

  function teamHTML(t, showScore, isHome) {
    const score = showScore && t.score != null ? `<span class="score${t.winner ? ' win' : ''}">${esc(t.score)}</span>` : '';
    return `<div class="team${isHome ? ' home' : ''}">
      ${logoHTML(t, 28)}
      <span class="tname"><span class="full">${esc(t.name)}</span><span class="abbr">${esc(t.short)}</span></span>
      ${t.record && !showScore ? `<span class="rec">${esc(t.record)}</span>` : ''}
      ${score}
    </div>`;
  }

  function gameHTML(g) {
    const extra = [...g.notes, g.international && g.venue ? g.venue : ''].filter(Boolean);
    return `<article class="game ${g.league}" title="Game ID ${esc(g.id)}">
      <div class="when">
        <span class="time">${esc(g.uk.time)}</span>
        ${g.uk.hour < 7 ? '<span class="night">overnight</span>' : ''}
      </div>
      <div class="matchup">
        <div class="meta">
          <span class="league-tag ${g.league}">${LEAGUES[g.league].label}</span>
          ${statusHTML(g)}
          ${extra.length ? `<span class="note">${esc(extra.join(', '))}</span>` : ''}
        </div>
        ${teamHTML(g.away, g.state !== 'pre', false)}
        ${teamHTML(g.home, g.state !== 'pre', true)}
      </div>
      <div class="channels">
        ${channelsHTML(g)}
        ${g.usTv.length ? `<span class="ustv">US: ${esc(g.usTv.join(', '))}</span>` : ''}
      </div>
    </article>`;
  }

  function scheduleLive(games, rerender) {
    clearTimeout(state.refreshTimer);
    if (games.some(g => g.state === 'in')) {
      state.refreshTimer = setTimeout(() => { clearScoreboardCache(); rerender(); }, LIVE_REFRESH_MS);
    }
  }

  async function renderSchedule() {
    const end = addDays(state.start, DAYS_SHOWN - 1);
    document.getElementById('range-label').textContent =
      state.start === todayLondon() ? `Today to ${shortDate(end)}` : `${shortDate(state.start)} to ${shortDate(end)}`;

    renderLoading(scheduleEl, 'Loading fixtures…');
    let data;
    try { data = await loadDays(state.start, DAYS_SHOWN); }
    catch (err) { renderError(scheduleEl, err, renderSchedule); return; }
    if (state.tab !== 'schedule') return;

    let games = data.games;
    if (state.league !== 'all') games = games.filter(g => g.league === state.league);
    if (state.tvOnly) games = games.filter(g => g.onUkTv);
    if (state.canWatch) games = games.filter(canWatch);

    if (!games.length) {
      const which = state.league === 'all' ? 'NFL or NBA' : LEAGUES[state.league].label;
      const filtered = state.tvOnly || state.canWatch;
      scheduleEl.innerHTML = `<div class="notice empty">
        <p>No ${which} games ${filtered ? 'match your filters ' : ''}in these 7 days.</p>
        <p>${filtered ? 'Turn off a filter, or try' : 'Try'} the next week with the arrow above.</p></div>`;
      return;
    }

    const groups = new Map();
    games.forEach(g => { if (!groups.has(g.uk.ymd)) groups.set(g.uk.ymd, []); groups.get(g.uk.ymd).push(g); });
    const today = todayLondon();
    let html = data.partial ? '<div class="notice warn">Some days didn’t load, so a few games may be missing. Refresh to try again.</div>' : '';
    for (const [day, list] of groups) {
      html += `<section class="day">
        <h2 class="day-head">${day === today ? 'Today, ' : ''}${esc(dayHeading(day))}
          <span class="count">${list.length} ${list.length === 1 ? 'game' : 'games'}</span></h2>
        <div class="day-list">${list.map(gameHTML).join('')}</div>
      </section>`;
    }
    scheduleEl.innerHTML = html;
    scheduleLive(data.games, () => state.tab === 'schedule' && renderSchedule());
  }

  // ---------- games today: team history ----------
  function parseScheduleEvents(data, teamId) {
    return (data.events || []).map(ev => {
      const comp = ev.competitions?.[0] || {};
      if (!comp.status?.type?.completed && !ev.competitions?.[0]?.status?.type?.completed) return null;
      const cs = comp.competitors || [];
      const us = cs.find(c => String(c.team?.id ?? c.id) === String(teamId));
      const them = cs.find(c => c !== us);
      if (!us || !them) return null;
      const score = c => toNum(c.score?.value ?? c.score?.displayValue ?? c.score);
      const s1 = score(us), s2 = score(them);
      if (s1 == null || s2 == null) return null;
      return {
        id: ev.id,
        date: new Date(ev.date),
        home: us.homeAway === 'home',
        oppId: String(them.team?.id ?? them.id),
        oppAbbr: them.team?.abbreviation || '',
        oppName: them.team?.displayName || them.team?.shortDisplayName || '',
        us: s1, them: s2,
        result: s1 > s2 ? 'W' : s1 < s2 ? 'L' : 'T'
      };
    }).filter(Boolean);
  }

  async function teamSeason(league, teamId, year) {
    const url = `${SITE}/${LEAGUES[league].path}/teams/${teamId}/schedule?season=${year}&seasontype=2`;
    try { return parseScheduleEvents(await getJSON(url), teamId); }
    catch { return []; }
  }

  async function teamHistory(league, teamId, year, seasons) {
    const years = Array.from({ length: seasons }, (_, i) => year - i);
    const all = (await Promise.all(years.map(y => teamSeason(league, teamId, y)))).flat();
    const seen = new Set();
    return all.filter(g => !seen.has(g.id) && seen.add(g.id)).sort((a, b) => b.date - a.date);
  }

  function formStats(games) {
    const last = games.slice(0, FORM_GAMES);
    if (!last.length) return null;
    const sum = k => last.reduce((t, g) => t + g[k], 0);
    const w = last.filter(g => g.result === 'W').length;
    const l = last.filter(g => g.result === 'L').length;
    const t = last.length - w - l;
    return {
      games: last,
      record: `${w}–${l}${t ? `–${t}` : ''}`,
      scored: sum('us') / last.length,
      conceded: sum('them') / last.length,
      margin: (sum('us') - sum('them')) / last.length
    };
  }

  // ---------- games today: render ----------
  const todayEl = document.getElementById('today');
  let observer = null;

  function oddsRows(g) {
    const o = g.odds;
    if (!o) return '';
    const a = americanTo(o.away), h = americanTo(o.home);
    let bar = '';
    if (a && h) {
      const total = a.implied + h.implied;
      const ap = Math.round((a.implied / total) * 100), hp = 100 - ap;
      bar = `<div class="chance" role="img" aria-label="Win chance implied by the odds: ${esc(g.away.short)} ${ap}%, ${esc(g.home.short)} ${hp}%">
        <span class="pct">${ap}%</span>
        <span class="bar"><span class="a" style="width:${ap}%"></span><span class="h" style="width:${hp}%"></span></span>
        <span class="pct">${hp}%</span>
      </div>`;
    }
    const price = x => x ? `<strong>${x.decimal}</strong> <span class="frac">${x.fractional}</span>` : '–';
    return `
      ${bar ? `<div class="row full"><span class="lbl">Win chance from the odds</span>${bar}</div>` : ''}
      <div class="row"><span class="v">${price(a)}</span><span class="lbl">To win</span><span class="v">${price(h)}</span></div>
      ${o.details || o.overUnder ? `<div class="row full"><span class="lbl">Line</span><span class="line">${esc([
        o.details ? `Spread ${o.details}` : '', o.overUnder ? `Total points ${o.overUnder}` : ''
      ].filter(Boolean).join(', '))}</span></div>` : ''}
      ${o.provider ? `<p class="provider">Odds from ${esc(o.provider)}</p>` : ''}`;
  }

  function matchCardHTML(g) {
    return `<article class="match ${g.league}" data-key="${g.league}-${g.id}" title="Game ID ${esc(g.id)}">
      <header class="match-top">
        <div class="when"><span class="time">${esc(g.uk.time)}</span>${g.uk.hour < 7 ? '<span class="night">overnight</span>' : ''}</div>
        <div class="match-meta">
          <span class="league-tag ${g.league}">${LEAGUES[g.league].label}</span>
          ${statusHTML(g)}
          ${g.notes.length ? `<span class="note">${esc(g.notes.join(', '))}</span>` : ''}
        </div>
        <div class="channels">${channelsHTML(g)}</div>
      </header>

      <div class="versus">
        <div class="side">
          ${logoHTML(g.away, 44)}
          <span class="sname">${esc(g.away.name)}</span>
          ${g.state !== 'pre' && g.away.score != null ? `<span class="big-score">${esc(g.away.score)}</span>` : ''}
        </div>
        <span class="at">at</span>
        <div class="side">
          ${logoHTML(g.home, 44)}
          <span class="sname">${esc(g.home.name)}</span>
          ${g.state !== 'pre' && g.home.score != null ? `<span class="big-score">${esc(g.home.score)}</span>` : ''}
        </div>
      </div>

      <div class="compare">
        <div class="odds-slot">${oddsRows(g)}</div>
        <div class="row"><span class="v">${esc(g.away.record || '–')}</span><span class="lbl">Season record</span><span class="v">${esc(g.home.record || '–')}</span></div>
        ${g.away.awayRecord || g.home.homeRecord ? `<div class="row"><span class="v">${esc(g.away.awayRecord || '–')}</span><span class="lbl">Away / home record</span><span class="v">${esc(g.home.homeRecord || '–')}</span></div>` : ''}
        <div class="history-slot"><div class="notice slim"><span class="spinner" aria-hidden="true"></span>Loading form and head-to-head…</div></div>
      </div>
    </article>`;
  }

  function formChips(f) {
    if (!f) return '<span class="muted">No recent games</span>';
    return `<span class="form">${f.games.map(x =>
      `<span class="res r${x.result}" title="${esc(`${pastDate(x.date)}: ${x.home ? 'vs' : 'at'} ${x.oppName} ${x.us}–${x.them}`)}">${x.result}</span>`
    ).join('')}</span>`;
  }

  function historyHTML(g, awayHist, homeHist) {
    const af = formStats(awayHist), hf = formStats(homeHist);
    const n = v => (v == null ? '–' : v.toFixed(1));
    const signed = v => (v == null ? '–' : `${v > 0 ? '+' : ''}${v.toFixed(1)}`);

    const formRows = `
      <div class="row"><span class="v">${formChips(af)}</span><span class="lbl">Last ${FORM_GAMES} games</span><span class="v">${formChips(hf)}</span></div>
      <div class="row"><span class="v">${af ? af.record : '–'}</span><span class="lbl">Record, last ${FORM_GAMES}</span><span class="v">${hf ? hf.record : '–'}</span></div>
      <div class="row"><span class="v">${n(af?.scored)}</span><span class="lbl">Points scored per game</span><span class="v">${n(hf?.scored)}</span></div>
      <div class="row"><span class="v">${n(af?.conceded)}</span><span class="lbl">Points allowed per game</span><span class="v">${n(hf?.conceded)}</span></div>
      <div class="row"><span class="v">${signed(af?.margin)}</span><span class="lbl">Average margin</span><span class="v">${signed(hf?.margin)}</span></div>`;

    // Head-to-head from the away team's point of view
    const meetings = awayHist.filter(x => x.oppId === String(g.home.id) && x.id !== g.id);
    const seasons = LEAGUES[g.league].h2hSeasons;
    let h2h;
    if (!meetings.length) {
      h2h = `<p class="muted">These teams haven't met in the regular season in the last ${seasons} seasons.</p>`;
    } else {
      const aw = meetings.filter(x => x.result === 'W').length;
      const hw = meetings.filter(x => x.result === 'L').length;
      const avgA = meetings.reduce((t, x) => t + x.us, 0) / meetings.length;
      const avgH = meetings.reduce((t, x) => t + x.them, 0) / meetings.length;
      h2h = `
        <div class="row"><span class="v big">${aw}</span><span class="lbl">Wins, last ${seasons} seasons</span><span class="v big">${hw}</span></div>
        <div class="row"><span class="v">${avgA.toFixed(1)}</span><span class="lbl">Average points</span><span class="v">${avgH.toFixed(1)}</span></div>
        <ol class="meetings">${meetings.slice(0, H2H_SHOWN).map(x => {
          const venue = x.home ? `at ${g.away.abbr}` : `at ${g.home.abbr}`;
          return `<li>
            <span class="v ${x.result === 'W' ? 'won' : ''}">${x.us}</span>
            <span class="lbl">${esc(pastDate(x.date))}, ${esc(venue)}</span>
            <span class="v ${x.result === 'L' ? 'won' : ''}">${x.them}</span>
          </li>`;
        }).join('')}</ol>`;
    }

    const ar = teamOddsRecord(g.league, g.away.id, g.seasonYear);
    const hr = teamOddsRecord(g.league, g.home.id, g.seasonYear);
    const rec = x => (x[0] + x[1] ? `${x[0]}–${x[1]}` : '–');
    const oddsRec = ar.fav[0] + ar.fav[1] + ar.dog[0] + ar.dog[1] + hr.fav[0] + hr.fav[1] + hr.dog[0] + hr.dog[1]
      ? `<h3 class="sub">Against the odds this season</h3>
        <div class="row"><span class="v">${rec(ar.fav)}</span><span class="lbl">Record as favourite</span><span class="v">${rec(hr.fav)}</span></div>
        <div class="row"><span class="v">${rec(ar.dog)}</span><span class="lbl">Record as underdog</span><span class="v">${rec(hr.dog)}</span></div>`
      : '';

    return `<h3 class="sub">Recent form</h3>${formRows}${oddsRec}
      <h3 class="sub">Head-to-head</h3>${h2h}`;
  }

  async function loadMatchDetail(card, g) {
    const seasons = LEAGUES[g.league].h2hSeasons;
    const year = g.seasonYear || new Date().getFullYear();

    // Odds fallback: the match summary carries a fuller odds list (pickcenter).
    if (!g.odds) {
      getJSON(`${SITE}/${LEAGUES[g.league].path}/summary?event=${g.id}`).then(sum => {
        const o = parseOdds(sum.pickcenter?.[0] || sum.odds?.[0]);
        if (o) { g.odds = o; card.querySelector('.odds-slot').innerHTML = oddsRows(g); }
      }).catch(() => {});
    }

    try {
      const [awayHist, homeHist] = await Promise.all([
        teamHistory(g.league, g.away.id, year, seasons),
        // Form only needs the last couple of seasons for the home team
        teamHistory(g.league, g.home.id, year, 2)
      ]);
      const notThis = h => h.filter(x => x.id !== g.id);
      card.querySelector('.history-slot').innerHTML = historyHTML(g, notThis(awayHist), notThis(homeHist));
    } catch {
      card.querySelector('.history-slot').innerHTML = '<p class="muted">Form and head-to-head couldn’t load. Refresh to try again.</p>';
    }
  }

  async function renderToday() {
    renderLoading(todayEl, 'Loading today’s games…');
    let data;
    const today = todayLondon();
    try { data = await loadDays(today, DAYS_SHOWN); }
    catch (err) { renderError(todayEl, err, renderToday); return; }
    if (state.tab !== 'today') return;
    backfillOdds(); // fills "Against the odds" rows in the background

    let games = data.games;
    if (state.todayLeague !== 'all') games = games.filter(g => g.league === state.todayLeague);

    let day = today;
    let intro = '';
    if (!games.some(g => g.uk.ymd === today)) {
      const next = games[0];
      if (!next) {
        const which = state.todayLeague === 'all' ? 'NFL or NBA' : LEAGUES[state.todayLeague].label;
        todayEl.innerHTML = `<div class="notice empty"><p>No ${which} games today or in the next 7 days.</p>
          <p>Check the Schedule tab for later weeks.</p></div>`;
        return;
      }
      day = next.uk.ymd;
      intro = `<p class="intro">No games today. Here’s ${esc(dayHeading(day))}, the next day with games.</p>`;
    }
    const list = games.filter(g => g.uk.ymd === day);

    todayEl.innerHTML = `${intro}
      <h2 class="day-head">${day === today ? 'Today, ' : ''}${esc(dayHeading(day))}
        <span class="count">${list.length} ${list.length === 1 ? 'game' : 'games'}</span></h2>
      <div class="matches">${list.map(matchCardHTML).join('')}</div>`;

    // Load form and head-to-head as each card scrolls into view.
    observer?.disconnect();
    const byKey = new Map(list.map(g => [`${g.league}-${g.id}`, g]));
    const load = card => loadMatchDetail(card, byKey.get(card.dataset.key));
    const cards = [...todayEl.querySelectorAll('.match')];
    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver(entries => entries.forEach(e => {
        if (e.isIntersecting) { observer.unobserve(e.target); load(e.target); }
      }), { rootMargin: '300px' });
      cards.forEach(c => observer.observe(c));
    } else {
      cards.forEach(load);
    }
    scheduleLive(list, () => state.tab === 'today' && renderToday());
  }

  // ---------- standings ----------
  const standingsEl = document.getElementById('standings');
  const COLUMNS = {
    nfl: [['W', ['wins']], ['L', ['losses']], ['T', ['ties']], ['PCT', ['winPercent']],
      ['PF', ['pointsFor']], ['PA', ['pointsAgainst']], ['DIFF', ['differential', 'pointDifferential']], ['STRK', ['streak']]],
    nba: [['W', ['wins']], ['L', ['losses']], ['PCT', ['winPercent']], ['GB', ['gamesBehind']],
      ['PPG', ['avgPointsFor']], ['OPP', ['avgPointsAgainst']], ['DIFF', ['differential', 'pointDifferential']], ['STRK', ['streak']]]
  };
  const COLUMN_TITLES = {
    W: 'Wins', L: 'Losses', T: 'Ties', PCT: 'Win percentage', PF: 'Points for', PA: 'Points against',
    DIFF: 'Points difference', STRK: 'Current streak', GB: 'Games behind', PPG: 'Points per game', OPP: 'Opponent points per game'
  };
  function findStat(entry, names) {
    const stats = entry.stats || [];
    for (const n of names) {
      const s = stats.find(x => x.name === n || x.type === n || x.abbreviation === n);
      if (s) return s;
    }
    return null;
  }
  function collectGroups(node, out = []) {
    if (node?.standings?.entries?.length) out.push({ name: node.name || node.abbreviation || '', entries: node.standings.entries });
    (node?.children || []).forEach(c => collectGroups(c, out));
    return out;
  }
  function sortEntries(entries) {
    const seed = e => findStat(e, ['playoffSeed'])?.value;
    const pct = e => findStat(e, ['winPercent'])?.value ?? 0;
    const diff = e => findStat(e, ['differential', 'pointDifferential'])?.value ?? 0;
    return [...entries].sort((a, b) => {
      const sa = seed(a), sb = seed(b);
      if (sa > 0 && sb > 0 && sa !== sb) return sa - sb;
      return (pct(b) - pct(a)) || (diff(b) - diff(a));
    });
  }
  function tableHTML(group, league) {
    const cols = COLUMNS[league];
    const rows = sortEntries(group.entries).map((e, i) => {
      const t = e.team || {};
      const logo = t.logos?.[0]?.href;
      const cells = cols.map(([label, names]) => {
        const s = findStat(e, names);
        let v = s ? (s.displayValue ?? s.value) : '–';
        if (label === 'DIFF' && s && typeof s.value === 'number' && s.value > 0 && !String(v).startsWith('+')) v = `+${v}`;
        return `<td>${esc(v)}</td>`;
      }).join('');
      return `<tr><td class="pos">${i + 1}</td>
        <th scope="row" class="tcell">${logo ? `<img src="${esc(logo)}" alt="" width="22" height="22" loading="lazy">` : ''}
          <span class="full">${esc(t.displayName || t.name)}</span><span class="abbr">${esc(t.abbreviation || t.shortDisplayName)}</span></th>${cells}</tr>`;
    }).join('');
    return `<section class="table-block"><h2 class="group-head">${esc(group.name)}</h2>
      <div class="table-wrap"><table>
        <thead><tr><th class="pos" scope="col"><span class="sr">Position</span></th><th scope="col" class="tcell">Team</th>
          ${cols.map(([l]) => `<th scope="col"><abbr title="${esc(COLUMN_TITLES[l])}">${l}</abbr></th>`).join('')}</tr></thead>
        <tbody>${rows}</tbody></table></div></section>`;
  }
  async function renderStandings() {
    const league = state.standingsLeague;
    renderLoading(standingsEl, `Loading ${LEAGUES[league].label} standings…`);
    try {
      let data = await getJSON(`${STANDINGS}/${LEAGUES[league].path}/standings${league === 'nfl' ? '?level=3' : ''}`);
      let groups = collectGroups(data);
      if (!groups.length && league === 'nfl') {
        data = await getJSON(`${STANDINGS}/${LEAGUES[league].path}/standings`);
        groups = collectGroups(data);
      }
      if (state.tab !== 'standings' || state.standingsLeague !== league) return;
      if (!groups.length) {
        standingsEl.innerHTML = '<div class="notice empty"><p>No standings published yet for this season. Check back once games have been played.</p></div>';
        return;
      }
      const season = data.seasons?.[0]?.displayName || data.season?.displayName || '';
      standingsEl.innerHTML = (season ? `<p class="season">${esc(season)} season</p>` : '') +
        `<div class="tables ${league}">${groups.map(g => tableHTML(g, league)).join('')}</div>`;
    } catch (err) {
      renderError(standingsEl, err, renderStandings);
    }
  }

  // ---------- my channels ----------
  function renderMine() {
    const list = document.getElementById('mine-list');
    list.innerHTML = Object.entries(window.UKTV.SERVICES).map(([id, s]) => `
      <label class="svc">
        <input type="checkbox" value="${esc(id)}" ${state.mine.includes(id) ? 'checked' : ''}>
        <span><strong>${esc(s.name)}</strong>${s.note ? `<small>${esc(s.note)}</small>` : ''}</span>
      </label>`).join('');
    updateMineSummary();
    list.querySelectorAll('input').forEach(i => i.addEventListener('change', () => {
      state.mine = [...list.querySelectorAll('input:checked')].map(x => x.value);
      updateMineSummary(); savePrefs(); renderCurrent();
    }));
  }
  function updateMineSummary() {
    const names = state.mine.map(id => window.UKTV.SERVICES[id]?.name).filter(Boolean);
    document.getElementById('mine-summary').textContent = names.length ? names.join(', ') : 'none chosen';
  }

  // ---------- controls ----------
  const renderCurrent = () => {
    clearTimeout(state.refreshTimer);
    ({ schedule: renderSchedule, today: renderToday, odds: showOddsRecord, standings: renderStandings })[state.tab]();
  };

  const tabs = [...document.querySelectorAll('[role="tab"]')];
  function selectTab(name, focus) {
    state.tab = name;
    tabs.forEach(t => {
      const on = t.id === `tab-${name}`;
      t.setAttribute('aria-selected', on);
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
      if (on && focus) t.focus();
    });
    document.getElementById('mine').hidden = name === 'standings' || name === 'odds';
    savePrefs();
    renderCurrent();
  }
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => selectTab(t.id.replace('tab-', '')));
    t.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      selectTab(next.id.replace('tab-', ''), true);
    });
  });

  function setPressed(attr, value) {
    document.querySelectorAll(`[data-${attr}]`).forEach(b => b.setAttribute('aria-pressed', b.dataset[attr] === value));
  }
  function bindSeg(attr, key) {
    document.querySelectorAll(`[data-${attr}]`).forEach(b => b.addEventListener('click', () => {
      state[key] = b.dataset[attr];
      setPressed(attr, state[key]);
      savePrefs(); renderCurrent();
    }));
    setPressed(attr, state[key]);
  }
  bindSeg('league', 'league');
  bindSeg('today', 'todayLeague');
  bindSeg('standings', 'standingsLeague');
  bindSeg('odds', 'oddsLeague');

  function bindToggle(id, key) {
    const el = document.getElementById(id);
    el.checked = state[key];
    el.addEventListener('change', () => { state[key] = el.checked; savePrefs(); renderSchedule(); });
  }
  bindToggle('tv-only', 'tvOnly');
  bindToggle('can-watch', 'canWatch');

  document.getElementById('prev-week').addEventListener('click', () => { state.start = addDays(state.start, -DAYS_SHOWN); renderSchedule(); });
  document.getElementById('next-week').addEventListener('click', () => { state.start = addDays(state.start, DAYS_SHOWN); renderSchedule(); });
  document.getElementById('this-week').addEventListener('click', () => { state.start = todayLondon(); renderSchedule(); });

  // ---------- phone app: offline support and install prompt ----------
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker?.register('sw.js').catch(() => {});
  }

  (function installBanner() {
    const banner = document.getElementById('install');
    const text = document.getElementById('install-text');
    const btn = document.getElementById('install-btn');
    const standalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone;
    let dismissed = false;
    try { dismissed = localStorage.getItem('lko-install-dismissed') === '1'; } catch { /* ignore */ }
    if (standalone || dismissed) return;

    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    let deferred = null;

    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      deferred = e;
      text.textContent = 'Install Late Kick-off to open it from your home screen like an app.';
      btn.hidden = false;
      banner.hidden = false;
    });
    btn.addEventListener('click', async () => {
      if (!deferred) return;
      deferred.prompt();
      await deferred.userChoice.catch(() => {});
      deferred = null;
      banner.hidden = true;
    });
    window.addEventListener('appinstalled', () => { banner.hidden = true; });
    document.getElementById('install-close').addEventListener('click', () => {
      banner.hidden = true;
      try { localStorage.setItem('lko-install-dismissed', '1'); } catch { /* ignore */ }
    });

    if (isIOS) {
      text.textContent = 'To install on your iPhone, tap the Share button, then “Add to Home Screen”.';
      banner.hidden = false;
    }
  })();

  // ---------- start ----------
  renderMine();
  selectTab(state.tab);
})();
