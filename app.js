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
  const lineNum = v => (v == null ? null : toNum(String(v).replace(/^[ou]/i, '')));
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
      away: ml('away'),
      homeOpen: toNum(o.moneyline?.home?.open?.odds),
      awayOpen: toNum(o.moneyline?.away?.open?.odds),
      spreadHome: lineNum(o.pointSpread?.home?.close?.line ?? o.pointSpread?.home?.open?.line),
      spreadAway: lineNum(o.pointSpread?.away?.close?.line ?? o.pointSpread?.away?.open?.line),
      spreadHomePrice: toNum(o.homeTeamOdds?.spreadOdds ?? o.pointSpread?.home?.close?.odds),
      spreadAwayPrice: toNum(o.awayTeamOdds?.spreadOdds ?? o.pointSpread?.away?.close?.odds),
      overPrice: toNum(o.overOdds ?? o.total?.over?.close?.odds),
      underPrice: toNum(o.underOdds ?? o.total?.under?.close?.odds)
    };
    if (odds.overUnder == null) odds.overUnder = lineNum(o.total?.over?.close?.line ?? o.total?.over?.open?.line);
    return (odds.home != null || odds.away != null || odds.details) ? odds : null;
  }
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  // Snap to the nearest fraction a UK bookmaker would actually show.
  const UK_FRACTIONS = ['1/10','1/8','1/7','1/6','1/5','2/9','1/4','2/7','3/10','1/3','4/11','2/5','4/9','1/2','8/15',
    '4/7','8/13','4/6','8/11','4/5','5/6','10/11','Evens','11/10','6/5','5/4','11/8','6/4','13/8','7/4','15/8','2/1',
    '9/4','5/2','11/4','3/1','10/3','7/2','4/1','9/2','5/1','11/2','6/1','13/2','7/1','15/2','8/1','9/1','10/1',
    '11/1','12/1','14/1','16/1','20/1','25/1','33/1','40/1','50/1','66/1','100/1'];
  const fracVal = f => (f === 'Evens' ? 1 : f.split('/').reduce((n, d) => n / d));
  function ukFraction(ratio) {
    return UK_FRACTIONS.reduce((best, f) => (Math.abs(fracVal(f) - ratio) < Math.abs(fracVal(best) - ratio) ? f : best));
  }
  function americanTo(ml) {
    if (ml == null || ml === 0) return null;
    const [num, den] = ml > 0 ? [ml, 100] : [100, Math.abs(ml)];
    const g = gcd(Math.round(num), Math.round(den)) || 1;
    return {
      decimal: (1 + num / den).toFixed(2),
      fractional: ukFraction(num / den),
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
      neutral: !!comp.neutralSite,
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
        nt: g.neutral ? 1 : 0,
        h: { id: String(g.home.id), a: g.home.abbr, n: g.home.short },
        a: { id: String(g.away.id), a: g.away.abbr, n: g.away.short }
      };
    }
    if (odds && (g.state === 'pre' || !r.o || oddsOverride)) {
      const next = { h: odds.home, a: odds.away, d: odds.details, ou: odds.overUnder, p: odds.provider };
      if (g.state === 'pre') {
        const now = Date.now();
        if (!r.seen) r.seen = now;                 // when this app first saw odds for the game
        if (!r.o0) {
          r.o0 = { h: odds.homeOpen ?? odds.home, a: odds.awayOpen ?? odds.away, d: odds.details, ou: odds.overUnder };
        }
        if (r.o && (r.o.h !== next.h || r.o.a !== next.a || r.o.d !== next.d || r.o.ou !== next.ou)) r.chg = now;
      }
      r.o = next;
    }
    if (g.state === 'post') {
      const hs = toNum(g.home.score), as = toNum(g.away.score);
      if (hs != null && as != null) { r.hs = hs; r.as = as; }
    }
    persistHistory();
  }

  // Opening vs current odds for an upcoming game, plus "new" / "moved" flags.
  const NEW_ODDS_HOURS = 12;
  const MOVED_HOURS = 24;
  function oddsNews(g) {
    const r = hist[`${g.league}-${g.id}`];
    if (!r || !g.odds || g.state !== 'pre') return null;
    const now = Date.now();
    const o0 = r.o0 || {};
    const moved = side => {
      const from = americanTo(o0[side]), to = americanTo(side === 'h' ? g.odds.home : g.odds.away);
      return from && to && from.decimal !== to.decimal ? { from: from.decimal, to: to.decimal, shorter: +to.decimal < +from.decimal } : null;
    };
    return {
      isNew: r.seen && now - r.seen < NEW_ODDS_HOURS * 36e5 && !r.chg,
      movedRecently: r.chg && now - r.chg < MOVED_HOURS * 36e5,
      home: moved('h'),
      away: moved('a'),
      openDetails: o0.d && o0.d !== g.odds.details ? o0.d : null,
      openTotal: o0.ou != null && o0.ou !== g.odds.overUnder ? o0.ou : null
    };
  }
  function newsBadge(n) {
    if (!n) return '';
    if (n.movedRecently) return '<span class="badge moved">Odds moved</span>';
    if (n.isNew) return '<span class="badge new">New odds</span>';
    return '';
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

  // ---------- our estimate: saving and grading ----------
  function saveEstimate(key, est, live) {
    const r = hist[key];
    if (!r || (r.est?.live && !live)) return;          // never replace a pre-game estimate with a worked-out one
    if (r.hs != null && live && !r.est) return;          // too late to count as a pre-game estimate
    r.est = {
      h: +est.pHome.toFixed(4),
      c: est.pHomeCover != null ? +est.pHomeCover.toFixed(4) : null,
      ov: est.pOver != null ? +est.pOver.toFixed(4) : null,
      live: live ? 1 : 0,
      mv: MODEL_VERSION,
      pl: est.adj ? 1 : 0
    };
    persistHistory();
  }

  // Did our estimate get it right? Compares our picks with the final score.
  function gradeEstimate(r, g) {
    if (!r.est || r.hs == null) return null;
    const winner = r.hs > r.as ? 'h' : r.hs < r.as ? 'a' : null;
    const pick = r.est.h >= 0.5 ? 'h' : 'a';
    const out = {
      pick,
      conf: Math.max(r.est.h, 1 - r.est.h),
      won: winner == null ? null : pick === winner,
      agreed: g ? pick === g.fav : null,
      live: !!r.est.live
    };
    if (r.est.c != null && g?.line != null) {
      const homeLine = g.fav === 'h' ? -g.line : g.line;
      const res = (r.hs - r.as) + homeLine;
      const coverPick = r.est.c >= 0.5 ? 'h' : 'a';
      out.cover = res === 0 ? null : (res > 0 ? 'h' : 'a') === coverPick;
    }
    if (r.est.ov != null && g?.total && g.total !== 'push') {
      out.totalPick = r.est.ov >= 0.5 ? 'over' : 'under';
      out.total = out.totalPick === g.total;
    }
    return out;
  }

  // For finished games with odds but no saved estimate, work one out using
  // only results from before that game, so it's a fair test.
  let backtesting = null;
  function backtestEstimates(onProgress = () => {}) {
    if (backtesting) return backtesting;
    backtesting = (async () => {
      const todo = Object.values(hist).filter(r => r.o && r.hs != null && r.yr &&
        (!r.est || (!r.est.live && r.est.mv !== MODEL_VERSION)));
      if (!todo.length) return;
      onProgress(`Working out our estimate for ${todo.length} past ${todo.length === 1 ? 'game' : 'games'}…`);
      const histFor = new Map();
      const getHist = (league, id, yr) => {
        const k = `${league}-${id}-${yr}`;
        if (!histFor.has(k)) histFor.set(k, teamHistory(league, id, yr, 2));
        return histFor.get(k);
      };
      for (const r of todo) {
        try {
          const [hh, ah] = await Promise.all([getHist(r.league, r.h.id, r.yr), getHist(r.league, r.a.id, r.yr)]);
          const before = h => h.filter(x => x.date.getTime() < r.t && x.id !== r.id);
          const pseudo = {
            league: r.league, neutral: !!r.nt,
            home: { abbr: r.h.a, id: r.h.id }, away: { abbr: r.a.a, id: r.a.id },
            odds: { details: r.o.d, overUnder: r.o.ou, home: r.o.h, away: r.o.a }
          };
          pseudo.seasonYear = r.yr;
          // maxYear: only use league tables from seasons already finished by then
          const ctx = await loadContext(r.league, [r.yr], r.yr);
          const est = estimate(pseudo, before(ah), before(hh), ctx, null);
          if (est) { if (hist[`${r.league}-${r.id}`]?.est && !hist[`${r.league}-${r.id}`].est.live) delete hist[`${r.league}-${r.id}`].est; saveEstimate(`${r.league}-${r.id}`, est, false); }
        } catch { /* skip this game */ }
      }
    })().finally(() => { backtesting = null; });
    return backtesting;
  }

  function ourEstimateHTML(games) {
    const rows = games.map(x => ({ ...x, e: gradeEstimate(x.r, x.g) })).filter(x => x.e);
    if (!rows.length) {
      return `<section class="our">
        <h2 class="day-head">How our estimate did</h2>
        <p class="intro">No finished games with an estimate yet. Estimates are saved when you open a game on the Games today tab, and worked out for past games once their results are in.</p>
      </section>`;
    }
    const decided = rows.filter(x => x.e.won != null);
    const right = decided.filter(x => x.e.won).length;
    const favDecided = decided.filter(x => x.g.favWon != null);
    const favRight = favDecided.filter(x => x.g.favWon).length;
    const disagree = decided.filter(x => x.e.agreed === false);
    const disRight = disagree.filter(x => x.e.won).length;
    const confident = decided.filter(x => x.e.conf >= 0.65);
    const confRight = confident.filter(x => x.e.won).length;
    const cov = rows.filter(x => x.e.cover != null);
    const covRight = cov.filter(x => x.e.cover).length;
    const tot = rows.filter(x => x.e.total != null);
    const totRight = tot.filter(x => x.e.total).length;
    const live = rows.filter(x => x.e.live).length;

    const stat = (label, tip, n, d) => d ? `<div>
        <dt>${tipBtn(esc(label), tip)}</dt>
        <dd>${pct(n, d)}% <small>${n} of ${d}</small></dd></div>` : '';

    return `<section class="our">
      <h2 class="day-head">How our estimate did</h2>
      <div class="hit-rate">
        <div class="hit-main">
          <span class="hit-num">${pct(right, decided.length)}%</span>
          <span class="hit-lbl">${tipBtn(`winners picked by our estimate (${right} of ${decided.length} games)`,
            'Our pick is the team our estimate gave more than a 50% chance. This is how often that team won.')}</span>
        </div>
        <dl class="hit-side">
          ${stat('Bookmakers’ favourite, same games', 'How often the bookmakers’ favourite won in the same games, so you can compare.', favRight, favDecided.length)}
          ${stat('When we disagreed with the bookmakers', 'Games where our estimate picked the team the bookmakers made the underdog. This is how often our pick won.', disRight, disagree.length)}
          ${stat('Confident picks (65%+)', 'Games where our estimate gave one team at least a 65% chance.', confRight, confident.length)}
          ${stat('Handicap picks', 'How often the side our estimate expected to land the handicap actually did. Pushes are left out.', covRight, cov.length)}
          ${stat('Over/under picks', 'How often our over or under pick on the total points was right. Pushes are left out.', totRight, tot.length)}
        </dl>
      </div>
      <p class="hint left">${live} of ${rows.length} estimates were saved before kick-off. The rest were worked out afterwards using only results from before each game, without player news.</p>
    </section>`;
  }

  // ---------- odds record tab ----------
  const oddsEl = document.getElementById('odds-record');
  const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
  const BANDS = [
    { name: 'Heavy favourites', from: 0.75, to: 1.01,
      tip: 'Teams the bookmakers gave a 75% or higher chance of winning, roughly a price of 1.33 or shorter. Big mismatches.' },
    { name: 'Clear favourites', from: 0.6, to: 0.75,
      tip: 'Teams the bookmakers gave a 60% to 75% chance of winning, roughly a price between 1.33 and 1.67.' },
    { name: 'Slight favourites', from: 0, to: 0.6,
      tip: 'Teams the bookmakers gave less than a 60% chance of winning, roughly a price of 1.67 or longer. Close games.' }
  ];
  const ODDS_SAID_TIP = 'The average chance of winning the bookmakers gave these teams. A price turns into a chance as roughly 1 ÷ price (1.25 is about 80%, 1.50 about 67%, 1.80 about 56%), with the bookmakers’ margin taken out so both teams add up to 100%.';
  const ACTUAL_TIP = 'How often these teams really won. If the odds are accurate, this should be close to the “Odds said” figure.';

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
        <span class="hit-lbl">${tipBtn(`of favourites won (${favWins} of ${decided.length} games)`,
          'The favourite is the team with the shorter (lower) price. This is how often that team won. Ties are left out.')}</span>
      </div>
      <dl class="hit-side">
        ${spread.length ? `<div><dt>${tipBtn('Favourite covered the spread', 'How often the favourite won by more than the bookmakers’ handicap, for example by 4 or more when the line was −3.5. Games that landed exactly on the line, or had no handicap listed, are left out.')}</dt><dd>${pct(covers, spread.length)}% <small>${covers} of ${spread.length}</small></dd></div>` : ''}
        ${totals.length ? `<div><dt>${tipBtn('Went over the points total', 'How often both teams’ scores added together beat the bookmakers’ points total. Around 50% means the totals have been well set.')}</dt><dd>${pct(overs, totals.length)}% <small>${overs} of ${totals.length}</small></dd></div>` : ''}
        <div><dt>${tipBtn('Upsets', 'Games the underdog (the team with the longer price) won.')}</dt><dd>${decided.length - favWins} <small>underdog wins</small></dd></div>
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
      const verdictTip = Math.abs(diff) <= 5
        ? `These teams won within 5% of what the odds said, so the bookmakers’ prices have been about right.`
        : `Across ${inBand.length} ${inBand.length === 1 ? 'game' : 'games'}, the odds said these teams would win about ${Math.round(expected / 100 * inBand.length)}, and they actually won ${inBand.filter(x => x.g.favWon).length}. ${inBand.length < 20 ? 'That’s a small sample, so a couple of surprise results can make a big difference.' : ''}`;
      return `<div class="band">
        <div class="band-head"><strong>${tipBtn(b.name, b.tip)}</strong><span>${inBand.length} ${inBand.length === 1 ? 'game' : 'games'}</span></div>
        <div class="band-bars">
          <span class="bl">${tipBtn('Odds said', ODDS_SAID_TIP)}</span><span class="track"><span class="fill exp" style="width:${expected}%"></span></span><span class="bv">${expected}%</span>
          <span class="bl">${tipBtn('Actually won', ACTUAL_TIP)}</span><span class="track"><span class="fill act" style="width:${actual}%"></span></span><span class="bv">${actual}%</span>
        </div>
        <p class="verdict">${tipBtn(verdict, verdictTip)}</p>
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
      const e = gradeEstimate(r, g);
      const ourPick = e ? `<small class="ourpick ${e.won == null ? '' : e.won ? 'ok' : 'no'}">Our pick: ${esc((e.pick === 'h' ? r.h : r.a).n)} ${Math.round(e.conf * 100)}%${e.won == null ? '' : e.won ? ' ✓' : ' ✗'}</small>` : '';
      return `<li class="${outcome[0]}">
        <span class="odate">${esc(date)}<span class="league-tag ${r.league}">${LEAGUES[r.league].label}</span></span>
        <span class="ogame">${esc(r.a.n)} ${r.as} <span class="muted-i">at</span> ${esc(r.h.n)} ${r.hs}</span>
        <span class="ofav">Favourite: ${esc(favT.n)}${price ? ` <span class="frac">${price.decimal}</span>` : ''}${extras ? `<small>${esc(extras)}</small>` : ''}${ourPick}</span>
        <span class="oresult">${outcome[1]}</span>
      </li>`;
    }).join('');

    oddsEl.innerHTML = `${progressHTML}${headline}
      ${ourEstimateHTML(games)}
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
    await backtestEstimates(msg => { if (state.tab === 'odds') renderOddsRecord(msg); });
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

  function scheduleOddsHTML(g) {
    if (g.state !== 'pre') return '';
    if (!g.odds) return '<p class="sodds none">Odds not out yet</p>';
    const n = oddsNews(g);
    const price = (t, ml, mv) => {
      const x = americanTo(ml);
      if (!x) return '';
      const move = mv ? ` <span class="mv ${mv.shorter ? 'in' : 'out'}" title="Was ${mv.from}">${mv.shorter ? '▼' : '▲'} from ${mv.from}</span>` : '';
      return `<span class="sp"><span class="who">${esc(t.abbr || t.short)}</span> <strong>${x.decimal}</strong>${move}</span>`;
    };
    const line = [
      g.odds.details ? `Spread ${esc(g.odds.details)}${n?.openDetails ? ` <span class="was">(opened ${esc(n.openDetails)})</span>` : ''}` : '',
      g.odds.overUnder ? `Total ${esc(g.odds.overUnder)}${n?.openTotal != null ? ` <span class="was">(opened ${esc(n.openTotal)})</span>` : ''}` : ''
    ].filter(Boolean).join(', ');
    return `<div class="sodds">
      ${newsBadge(n)}
      ${price(g.away, g.odds.away, n?.away)}
      ${price(g.home, g.odds.home, n?.home)}
      ${line ? `<span class="sline">${line}</span>` : ''}
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
        ${scheduleOddsHTML(g)}
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
    try { return parseScheduleEvents(await getJSON(url), teamId).map(x => ({ ...x, yr: year })); }
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

  // ---------- descriptions (hover on a computer, tap on a phone) ----------
  const TIPS = {
    main: {
      'Win chance from the odds': 'The bookmakers’ prices turned into a percentage chance for each team, with their built-in margin taken out so the two add up to 100%.',
      'To win': 'The price for each team to win the game. The first number is the decimal price (your total return per £1 staked, including the stake). The second is the UK fractional price.'
    },
    more: {
      'Handicap (spread)': 'The favourite gets a minus number and must win by more than that many points for the handicap to land. The underdog gets a plus number and lands it by losing by less than that, or by winning. The “at” price is what each side pays.',
      'Total points': 'The bookmakers’ line for both teams’ scores added together. “Over” lands if the final combined score is higher than the line, “under” if it’s lower.',
      'Opening win price': 'The first win price this app saw for each team. ▼ means the price has shortened since (bookmakers now rate the team’s chances higher). ▲ means it has drifted (rated lower).',
      'Prices by bookmaker': 'Win prices, handicap and total from each bookmaker ESPN lists. The highlighted price is the highest available for each team.'
    },
    est: {
      'Win chance, our estimate': 'Worked out from each team’s last 10 results, with recent games counting more. Points are adjusted for how strong each opponent was, a small home advantage is added, injured or returning players are allowed for, and the expected margin is turned into a chance of winning.',
      'Before player news': 'Our estimate before any changes for injured or returning players, so you can see how much the team news moves it.',
      'Win chance, bookmakers': 'The bookmakers’ win prices turned into a percentage, with their margin taken out.',
      'Win chance, ESPN': 'ESPN’s own prediction from its team-strength model (FPI for the NFL, BPI for the NBA). It also takes schedule strength into account.',
      'Fair price from our estimate': 'The decimal price that matches our estimate (1 ÷ chance). If the bookmakers’ price is higher, they rate the team’s chances lower than our estimate does. If it’s lower, they rate them higher.',
      'Expected points': 'How many points each team is expected to score, from its recent average scored blended with the opponent’s recent average allowed.',
      'Chance to cover': 'Our estimate of how likely each side is to land the bookmakers’ handicap, based on the expected winning margin.',
      'Total points': 'Our estimate of how likely the combined score is to go over or under the bookmakers’ total, based on both teams’ expected points.',
      'From your Odds record': 'How often favourites with a similar win chance (within 5%) have actually won, from the finished games saved in your Odds record tab.'
    },
    form: {
      'Season record': 'Wins and losses (and ties in the NFL) so far this season.',
      'Away / home record': 'The away team’s record on the road and the home team’s record at home this season.',
      'Last 5 games': 'Most recent result first. W is a win, L a loss, T a tie. Hover over or tap a result to see the score.',
      'Points scored per game': 'Average points scored over the last 5 games.',
      'Points allowed per game': 'Average points conceded over the last 5 games.',
      'Average margin': 'Average points scored minus points allowed over the last 5 games. Positive means they’ve been winning by that much on average.',
      'Record against the spread': 'How often the team has landed the bookmakers’ handicap this season (wins–losses–pushes), from ESPN.',
      'Record as favourite': 'Wins and losses this season in games where the bookmakers made this team the favourite, from your saved odds history.',
      'Record as underdog': 'Wins and losses this season in games where this team was the underdog, from your saved odds history.'
    },
    h2h: {
      'Wins, last': 'Regular-season wins for each team when they’ve played each other.',
      'Average points': 'Average points each team scored in those meetings.'
    }
  };

  function addTips(root) {
    root.querySelectorAll('.lbl').forEach(el => {
      if (el.querySelector('.tip') || el.closest('.meetings')) return;
      const sect = el.closest('[data-sect]')?.dataset.sect || 'main';
      const text = el.textContent.trim();
      const table = { ...TIPS.main, ...(TIPS[sect] || {}) };
      const key = Object.keys(table).find(k => text.startsWith(k));
      if (!key) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tip';
      btn.dataset.tip = table[key];
      while (el.firstChild) btn.appendChild(el.firstChild);
      el.appendChild(btn);
    });
  }
  const tipBtn = (text, tip) => `<button type="button" class="tip" data-tip="${esc(tip)}">${text}</button>`;

  const tipEl = document.createElement('div');
  tipEl.className = 'tooltip';
  tipEl.id = 'tooltip';
  tipEl.setAttribute('role', 'tooltip');
  tipEl.hidden = true;
  document.body.appendChild(tipEl);
  let tipFor = null;

  function showTip(btn) {
    if (tipFor && tipFor !== btn) tipFor.removeAttribute('aria-describedby');
    tipFor = btn;
    tipEl.textContent = btn.dataset.tip;
    tipEl.hidden = false;
    btn.setAttribute('aria-describedby', 'tooltip');
    const r = btn.getBoundingClientRect();
    const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, document.documentElement.clientWidth - w - 8));
    let top = r.bottom + 8;
    if (top + h > window.innerHeight - 8) top = r.top - h - 8;
    tipEl.style.left = `${left + window.scrollX}px`;
    tipEl.style.top = `${top + window.scrollY}px`;
  }
  function hideTip() {
    tipEl.hidden = true;
    tipFor?.removeAttribute('aria-describedby');
    tipFor = null;
  }
  const canHover = () => window.matchMedia?.('(hover: hover)').matches;
  document.addEventListener('mouseover', e => {
    const b = e.target.closest?.('.tip');
    if (b && canHover()) showTip(b);
  });
  document.addEventListener('mouseout', e => {
    const b = e.target.closest?.('.tip');
    if (b && canHover() && !b.contains(e.relatedTarget)) hideTip();
  });
  document.addEventListener('click', e => {
    const b = e.target.closest?.('.tip');
    if (!b) { if (!e.target.closest?.('.tooltip')) hideTip(); return; }
    if (tipFor === b && !tipEl.hidden && !canHover()) hideTip(); else showTip(b);
  });
  document.addEventListener('focusin', e => { const b = e.target.closest?.('.tip'); if (b) showTip(b); });
  document.addEventListener('focusout', e => { if (e.target.closest?.('.tip')) hideTip(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hideTip(); });
  window.addEventListener('scroll', () => { if (!tipEl.hidden) hideTip(); }, { passive: true });

  // ---------- games today: odds markets ----------
  const todayEl = document.getElementById('today');
  let observer = null;

  const price = ml => {
    const x = americanTo(ml);
    return x ? `<strong>${x.decimal}</strong> <span class="frac">${x.fractional}</span>` : '–';
  };
  const signedLine = v => (v == null ? '' : v > 0 ? `+${v}` : v === 0 ? 'PK' : `${v}`);

  // Spread line for each side, from ESPN's spread fields or the "KC -3.5" text.
  function spreadLines(g, o) {
    if (!o) return null;
    let h = o.spreadHome, a = o.spreadAway;
    if (h == null && a == null) {
      const m = /^([A-Za-z]{2,4})\s+([+-]?\d+(?:\.\d+)?)/.exec(o.details || '');
      if (m) {
        const v = parseFloat(m[2]);
        if (m[1].toUpperCase() === (g.home.abbr || '').toUpperCase()) { h = v; a = -v; }
        else if (m[1].toUpperCase() === (g.away.abbr || '').toUpperCase()) { a = v; h = -v; }
      } else if (/^(even|pk|pick)/i.test(o.details || '')) { h = 0; a = 0; }
    }
    if (h == null && a != null) h = -a;
    if (a == null && h != null) a = -h;
    return h == null ? null : { home: h, away: a };
  }

  // The always-visible odds: win chance bar and match prices.
  function oddsMainHTML(g) {
    const o = g.odds;
    if (!o) return '<p class="muted">Odds not out yet for this game.</p>';
    const a = americanTo(o.away), h = americanTo(o.home);
    const n = oddsNews(g);
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
    return `
      ${newsBadge(n) ? `<div class="badge-row">${newsBadge(n)}</div>` : ''}
      ${bar ? `<div class="row full"><span class="lbl">Win chance from the odds</span>${bar}</div>` : ''}
      <div class="row"><span class="v">${price(o.away)}</span><span class="lbl">To win</span><span class="v">${price(o.home)}</span></div>`;
  }

  // Every other market: spread with prices, totals, opening prices, other bookmakers.
  function oddsMoreHTML(g, books) {
    const o = g.odds;
    if (!o) return '<p class="muted">No odds yet.</p>';
    const n = oddsNews(g);
    const sl = spreadLines(g, o);
    const opened = mv => mv ? `<span class="mv ${mv.shorter ? 'in' : 'out'}">${mv.shorter ? '▼' : '▲'} ${mv.from}</span>` : '<span class="muted-i">no change</span>';
    const spreadCell = (line, p) => line == null ? '–'
      : `<strong>${signedLine(line)}</strong>${p != null ? ` <span class="frac">at ${americanTo(p)?.decimal ?? '–'}</span>` : ''}`;

    let rows = '';
    if (sl) {
      rows += `<div class="row"><span class="v">${spreadCell(sl.away, o.spreadAwayPrice)}</span><span class="lbl">Handicap (spread)${n?.openDetails ? `<br><small>opened ${esc(n.openDetails)}</small>` : ''}</span><span class="v">${spreadCell(sl.home, o.spreadHomePrice)}</span></div>`;
    }
    if (o.overUnder != null) {
      rows += `<div class="row"><span class="v">Over <strong>${esc(o.overUnder)}</strong>${o.overPrice != null ? ` <span class="frac">at ${americanTo(o.overPrice)?.decimal}</span>` : ''}</span>
        <span class="lbl">Total points${n?.openTotal != null ? `<br><small>opened ${esc(n.openTotal)}</small>` : ''}</span>
        <span class="v">Under <strong>${esc(o.overUnder)}</strong>${o.underPrice != null ? ` <span class="frac">at ${americanTo(o.underPrice)?.decimal}</span>` : ''}</span></div>`;
    }
    if (n && (n.home || n.away)) {
      rows += `<div class="row"><span class="v">${opened(n.away)}</span><span class="lbl">Opening win price</span><span class="v">${opened(n.home)}</span></div>`;
    }

    const list = (books || []).filter(b => b.home != null || b.away != null || b.details);
    if (list.length > 1) {
      const best = side => Math.max(...list.map(b => b[side]).filter(v => v != null).map(v => +americanTo(v).decimal));
      const bA = best('away'), bH = best('home');
      const cell = (v, b) => { const x = americanTo(v); return x ? `<span class="${+x.decimal === b ? 'best' : ''}">${x.decimal}</span>` : '–'; };
      rows += `<div class="books"><p class="lbl">Prices by bookmaker</p>
        <div class="table-wrap slim"><table>
          <thead><tr><th scope="col" class="tcell">Bookmaker</th><th scope="col">${esc(g.away.abbr)}</th><th scope="col">${esc(g.home.abbr)}</th><th scope="col">Spread</th><th scope="col">Total</th></tr></thead>
          <tbody>${list.map(b => `<tr><th scope="row" class="tcell">${esc(b.provider || 'Unknown')}</th>
            <td>${cell(b.away, bA)}</td><td>${cell(b.home, bH)}</td><td>${esc(b.details || '–')}</td><td>${esc(b.overUnder ?? '–')}</td></tr>`).join('')}</tbody>
        </table></div><p class="hint">Highlighted is the best price for each team.</p></div>`;
    }
    return (rows || '<p class="muted">Only match odds are available for this game.</p>') +
      (o.provider ? `<p class="provider">Main odds from ${esc(o.provider)}</p>` : '');
  }

  // ---------- games today: estimate from past data ----------
  const MODEL = {
    // decay: how much less each older game counts (0.85 = each game back counts 15% less)
    nfl: { homeEdge: 1.5, marginSD: 13.5, totalSD: 13.5, games: 10, decay: 0.85, adjCap: 10 },
    nba: { homeEdge: 2.5, marginSD: 12.5, totalSD: 18, games: 10, decay: 0.85, adjCap: 12 }
  };
  const MODEL_VERSION = 2;
  function normCdf(z) {
    // Abramowitz & Stegun approximation
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp(-z * z / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  }
  const fairPrice = p => {
    if (!p || p <= 0 || p >= 1) return null;
    const dec = 1 / p;
    return { decimal: dec.toFixed(2), fractional: ukFraction(dec - 1) };
  };
  const avgOf = arr => (arr.length ? arr.reduce((t, v) => t + v, 0) / arr.length : 0);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ----- opponent strength: each team's season scoring from the standings -----
  const ratingsCache = new Map();
  function seasonRatings(league, year) {
    const key = `${league}-${year}`;
    if (!ratingsCache.has(key)) {
      ratingsCache.set(key, (async () => {
        const data = await getJSON(`${STANDINGS}/${LEAGUES[league].path}/standings?season=${year}`);
        const teams = new Map();
        let sumF = 0, sumA = 0, sumG = 0;
        for (const grp of collectGroups(data)) {
          for (const e of grp.entries) {
            const id = String(e.team?.id ?? '');
            if (!id || teams.has(id)) continue;
            const v = n => findStat(e, [n])?.value;
            const games = ((v('wins') || 0) + (v('losses') || 0) + (v('ties') || 0)) || v('gamesPlayed') || 0;
            if (!games) continue;
            let pf = v('avgPointsFor'), pa = v('avgPointsAgainst');
            if (pf == null && v('pointsFor') != null) { pf = v('pointsFor') / games; pa = (v('pointsAgainst') || 0) / games; }
            if (pf == null || pa == null) continue;
            teams.set(id, { off: pf, def: pa, games });
            sumF += pf * games; sumA += pa * games; sumG += games;
          }
        }
        return { teams, lg: sumG ? (sumF + sumA) / (2 * sumG) : null };
      })().catch(() => ({ teams: new Map(), lg: null })));
    }
    return ratingsCache.get(key);
  }

  // ctx.maxYear: for a fair back-test, the current season's table isn't used
  // (it includes later games), so the previous season stands in for it.
  async function loadContext(league, years, maxYear) {
    const ys = [...new Set(years.filter(Boolean).flatMap(y => [y, y - 1]))];
    const list = await Promise.all(ys.map(y => seasonRatings(league, y)));
    const byYear = new Map(ys.map((y, i) => [y, list[i]]));
    return { byYear, maxYear };
  }
  function ratingFor(ctx, yr, teamId) {
    if (!ctx || !yr) return null;
    let y = yr;
    if (ctx.maxYear && y >= ctx.maxYear) y = ctx.maxYear - 1;
    for (const tryYear of [y, y - 1]) {
      const r = ctx.byYear.get(tryYear);
      const t = r?.teams.get(String(teamId));
      if (t && r.lg && t.games >= 3) {
        const k = t.games / (t.games + 4);          // trust early-season numbers less
        return { off: r.lg + (t.off - r.lg) * k, def: r.lg + (t.def - r.lg) * k, lg: r.lg };
      }
    }
    return null;
  }
  function leagueAvg(ctx, yr, fallback) {
    let y = yr;
    if (ctx?.maxYear && y >= ctx.maxYear) y = ctx.maxYear - 1;
    return ctx?.byYear.get(y)?.lg ?? ctx?.byYear.get(y - 1)?.lg ?? fallback;
  }

  // A past game's points, adjusted for how good the opponent was and shown
  // relative to that season's league average.
  function adjustedGame(x, ctx, rawLg) {
    const lg = leagueAvg(ctx, x.yr, rawLg);
    const opp = ratingFor(ctx, x.yr, x.oppId);
    const scored = opp ? x.us - (opp.def - opp.lg) : x.us;
    const allowed = opp ? x.them - (opp.off - opp.lg) : x.them;
    return { off: scored - lg, def: allowed - lg, margin: scored - allowed };
  }

  // Recency-weighted, opponent-adjusted scoring for one team.
  function teamStrength(hist, league, ctx, rawLg) {
    const m = MODEL[league];
    const games = hist.slice(0, m.games);
    let w = 0, off = 0, def = 0;
    games.forEach((x, i) => {
      const wt = Math.pow(m.decay, i);
      const a = adjustedGame(x, ctx, rawLg);
      off += wt * a.off; def += wt * a.def; w += wt;
    });
    const n = games.length;
    const shrink = n / (n + 2);
    return { off: (off / w) * shrink, def: (def / w) * shrink, n };
  }

  // adj: { home, away } margin changes from player news (points)
  function estimate(g, awayHist, homeHist, ctx, adj) {
    const m = MODEL[g.league];
    if (Math.min(awayHist.length, homeHist.length, m.games) < 3) return null;
    const recent = [...awayHist.slice(0, m.games), ...homeHist.slice(0, m.games)];
    const rawLg = avgOf(recent.flatMap(x => [x.us, x.them]));
    const lg = leagueAvg(ctx, g.seasonYear || recent[0]?.yr, rawLg) ?? rawLg;
    const A = teamStrength(awayHist, g.league, ctx, rawLg);
    const H = teamStrength(homeHist, g.league, ctx, rawLg);
    const edge = g.neutral ? 0 : m.homeEdge;

    const build = (dH, dA) => {
      const expHome = lg + H.off + A.def + edge / 2 + dH / 2 - dA / 2;
      const expAway = lg + A.off + H.def - edge / 2 + dA / 2 - dH / 2;
      const margin = expHome - expAway;
      const pHome = normCdf(margin / m.marginSD);
      const out = { expHome, expAway, pHome, pAway: 1 - pHome };
      const sl = spreadLines(g, g.odds);
      if (sl) { out.pHomeCover = normCdf((margin + sl.home) / m.marginSD); out.lines = sl; }
      if (g.odds?.overUnder != null) out.pOver = 1 - normCdf((toNum(g.odds.overUnder) - (expHome + expAway)) / m.totalSD);
      return out;
    };
    const base = build(0, 0);
    const final = adj ? build(adj.home || 0, adj.away || 0) : base;
    return { ...final, base, games: Math.min(A.n, H.n), adj };
  }

  // ----- player availability: who played in each past game -----
  const PLAYED_KEY = 'lko-played';
  const PLAYER_SAMPLE = 12;
  const playedStore = readStore(PLAYED_KEY, {});
  let playedTimer = null;
  function persistPlayed() {
    clearTimeout(playedTimer);
    playedTimer = setTimeout(() => {
      const cutoff = Date.now() - HIST_MAX_DAYS * 864e5;
      for (const k of Object.keys(playedStore)) if (playedStore[k].t < cutoff) delete playedStore[k];
      for (let attempt = 0; attempt < 3; attempt++) {
        try { localStorage.setItem(PLAYED_KEY, JSON.stringify(playedStore)); return; }
        catch {
          // Storage full: drop the oldest half and try again
          const keys = Object.keys(playedStore).sort((a, b) => playedStore[a].t - playedStore[b].t);
          keys.slice(0, Math.ceil(keys.length / 2)).forEach(k => delete playedStore[k]);
        }
      }
    }, 500);
  }

  // Box scores are large, so they're read once, boiled down to "who played"
  // and kept on the device, rather than cached whole.
  const playedPending = new Map();
  function playedIn(league, eventId, gameTime) {
    if (playedStore[eventId]) return Promise.resolve(playedStore[eventId]);
    if (playedPending.has(eventId)) return playedPending.get(eventId);
    const p = limited(async () => {
      const res = await fetch(`${SITE}/${LEAGUES[league].path}/summary?event=${eventId}&lkobox=1`);
      if (!res.ok) throw new Error('summary');
      return res.json();
    }).then(sum => {
      const out = { t: gameTime || Date.now(), teams: {} };
      for (const tp of sum.boxscore?.players || []) {
        const tid = String(tp.team?.id ?? '');
        if (!tid) continue;
        const rec = out.teams[tid] = { ids: [], pts: {}, nm: {} };
        for (const grp of tp.statistics || []) {
          const labels = grp.labels || grp.keys || [];
          const ptsIdx = league === 'nba' ? labels.findIndex(l => /^(pts|points)$/i.test(l)) : -1;
          for (const a of grp.athletes || []) {
            const id = String(a.athlete?.id ?? '');
            if (!id || a.didNotPlay || !(a.stats || []).length) continue;
            if (!rec.ids.includes(id)) rec.ids.push(id);
            rec.nm[id] = [a.athlete.shortName || a.athlete.displayName || '', a.athlete.position?.abbreviation || ''];
            if (ptsIdx >= 0) { const v = toNum(a.stats[ptsIdx]); if (v != null) rec.pts[id] = v; }
          }
        }
      }
      if (!Object.keys(out.teams).length) return null;
      playedStore[eventId] = out;
      persistPlayed();
      return out;
    }).catch(() => null).finally(() => playedPending.delete(eventId));
    playedPending.set(eventId, p);
    return p;
  }

  function parseInjuries(sum) {
    const out = {};
    for (const t of sum?.injuries || []) {
      const tid = String(t.team?.id ?? '');
      if (!tid) continue;
      out[tid] = (t.injuries || []).map(i => ({
        id: String(i.athlete?.id ?? ''),
        name: i.athlete?.shortName || i.athlete?.displayName || 'Unknown player',
        pos: i.athlete?.position?.abbreviation || '',
        status: i.status || i.type?.description || i.details?.fantasyStatus?.description || 'Unknown'
      })).filter(i => i.id);
    }
    return out;
  }

  // How likely an injured player is to play, by report status.
  function availability(league, status) {
    const s = String(status).toLowerCase();
    if (/out|reserve|suspend|ir\b/.test(s)) return 0;
    if (/doubt/.test(s)) return 0.2;
    if (/question/.test(s)) return league === 'nfl' ? 0.7 : 0.5;
    if (/day-to-day|day to day|gtd/.test(s)) return 0.6;
    if (/probable/.test(s)) return 0.9;
    return 0.5;
  }

  // Typical value of a player when there isn't enough with/without data.
  function typicalImpact(league, pos, ppg) {
    if (league === 'nba') return clamp(0.35 * (ppg || 0), 0.3, 6);
    const p = String(pos).toUpperCase();
    if (p === 'QB') return 4;
    if (['WR', 'TE', 'RB'].includes(p)) return 0.7;
    if (['OT', 'T', 'G', 'OG', 'C', 'OL'].includes(p)) return 0.5;
    if (p === 'K' || p === 'PK') return 0.4;
    return 0.5;
  }
  const impactCap = (league, pos) => (league === 'nba' ? 7 : String(pos).toUpperCase() === 'QB' ? 7 : 3);
  const SHRINK_GAMES = 3;

  // Compare the team's (opponent-adjusted) results with and without each player.
  async function playerNews(g, teamId, teamHist, injuries, ctx) {
    const m = MODEL[g.league];
    const sample = teamHist.slice(0, PLAYER_SAMPLE);
    const boxes = await Promise.all(sample.map(x => playedIn(g.league, x.id, x.date.getTime())));
    const rawLg = avgOf(sample.flatMap(x => [x.us, x.them]));
    const games = sample
      .map((x, i) => ({ x, i, box: boxes[i]?.teams?.[String(teamId)] }))
      .filter(z => z.box);
    if (games.length < 4) return { adj: 0, items: [], checked: games.length, enough: false };
    games.forEach(z => { z.m = adjustedGame(z.x, ctx, rawLg).margin; });

    const names = {};
    games.forEach(z => Object.assign(names, z.box.nm));
    const injById = new Map((injuries || []).map(i => [i.id, i]));

    const evaluate = id => {
      const W = games.filter(z => z.box.ids.includes(id));
      const O = games.filter(z => !z.box.ids.includes(id));
      if (W.length < 2) return null;
      const pos = names[id]?.[1] || injById.get(id)?.pos || '';
      const ppg = g.league === 'nba' ? avgOf(W.map(z => z.box.pts?.[id] ?? 0)) : null;
      const typical = typicalImpact(g.league, pos, ppg);
      let measured = null, impact = typical;
      if (O.length >= 1) {
        measured = avgOf(W.map(z => z.m)) - avgOf(O.map(z => z.m));
        impact = (O.length * measured + SHRINK_GAMES * typical) / (O.length + SHRINK_GAMES);
      }
      impact = clamp(impact, 0, impactCap(g.league, pos));
      // How much of the recent form (which the estimate is built on) had him playing
      let ws = 0, wp = 0;
      games.forEach(z => {
        if (z.i >= m.games) return;
        const wt = Math.pow(m.decay, z.i);
        ws += wt; if (z.box.ids.includes(id)) wp += wt;
      });
      return {
        id, pos, impact, measured, typical, ppg,
        name: names[id]?.[0] || injById.get(id)?.name || 'Player',
        nW: W.length, nO: O.length, share: ws ? wp / ws : 1
      };
    };

    const items = [];
    for (const inj of injuries || []) {
      const ev = evaluate(inj.id);
      const avail = availability(g.league, inj.status);
      if (!ev) {
        items.push({ name: inj.name, pos: inj.pos, status: inj.status, adj: 0, note: 'Not enough recent games to measure' });
        continue;
      }
      const adj = ev.impact * (avail - ev.share);
      items.push({ ...ev, name: inj.name || ev.name, status: inj.status, avail, adj });
    }

    // Regulars who missed some recent games and aren't on the injury report: add them back.
    const regulars = [...new Set(games.flatMap(z => z.box.ids))].filter(id => !injById.has(id));
    const back = regulars.map(evaluate).filter(ev =>
      ev && ev.nW >= games.length * 0.5 && ev.share < 0.85 && ev.impact >= 0.5)
      .map(ev => ({ ...ev, status: 'Available', avail: 1, adj: ev.impact * (1 - ev.share), back: true }))
      .filter(ev => ev.adj >= 0.4)
      .sort((a, b) => b.adj - a.adj)
      .slice(0, 3);
    items.push(...back);

    const total = clamp(items.reduce((t, i) => t + (i.adj || 0), 0), -m.adjCap, m.adjCap);
    items.sort((a, b) => Math.abs(b.adj || 0) - Math.abs(a.adj || 0));
    return { adj: total, items, checked: games.length, enough: true };
  }

  // How often favourites priced like this one have won, from the Odds record history.
  function similarFavourites(g) {
    const a = americanTo(g.odds?.away), h = americanTo(g.odds?.home);
    if (!a || !h || g.odds.home === g.odds.away) return null;
    const p = Math.max(a.implied, h.implied) / (a.implied + h.implied);
    const near = gradedGames(g.league).filter(x => x.g.prob != null && x.g.favWon != null && Math.abs(x.g.prob - p) <= 0.05);
    if (near.length < 5) return null;
    return { p, n: near.length, won: near.filter(x => x.g.favWon).length, fav: a.implied > h.implied ? g.away : g.home };
  }

  function playerItemHTML(it) {
    const signed = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`;
    const cls = it.adj > 0.05 ? 'pos' : it.adj < -0.05 ? 'neg' : 'zero';
    let tip;
    if (it.note) tip = `${it.note}, so no change is made for this player.`;
    else {
      const how = it.measured != null
        ? `The team's margin was ${Math.abs(it.measured).toFixed(1)} pts ${it.measured >= 0 ? 'better' : 'worse'} with him (${it.nW} games with, ${it.nO} without), allowing for opponent strength. That's blended with a typical value for a ${it.pos || 'player'} because the sample is small, giving ${it.impact.toFixed(1)} pts.`
        : `He hasn't missed a game in the sample, so a typical value for a ${it.pos || 'player'}${it.ppg ? ` scoring ${it.ppg.toFixed(1)} a game` : ''} is used: ${it.impact.toFixed(1)} pts.`;
      const share = `He played in ${Math.round(it.share * 100)}% of the recent games the estimate is built on`;
      const avail = it.back ? 'and is available now, so he’s added back.' :
        `and is ${it.avail === 0 ? 'not expected to play' : `about ${Math.round(it.avail * 100)}% likely to play`} (${it.status}).`;
      tip = `${how} ${share} ${avail}`;
    }
    const label = it.back ? 'back' : it.status;
    return `<li>${tipBtn(`${esc(it.name)}${it.pos ? ` <span class="pp">${esc(it.pos)}</span>` : ''} <span class="ps">${esc(label)}</span>`, tip)}
      <span class="padj ${cls}">${it.note ? '–' : signed(it.adj)}</span></li>`;
  }

  function playersHTML(g, news) {
    if (news === 'pending') {
      return `<div class="row full"><span class="lbl">Player news</span>
        <span class="line"><span class="notice slim inline"><span class="spinner" aria-hidden="true"></span>Checking injuries and who played in recent games…</span></span></div>`;
    }
    if (!news) return '';
    const side = (t, n) => {
      if (!n.enough) return `<p class="muted small">Not enough box scores yet for ${esc(t.short)}.</p>`;
      const shown = n.items.filter(i => i.note || Math.abs(i.adj) >= 0.1).slice(0, 6);
      if (!shown.length) return `<p class="muted small">${esc(t.short)}: no changes.</p>`;
      return `<ul class="players">${shown.map(playerItemHTML).join('')}</ul>
        <p class="ptotal">${esc(t.short)} ${n.adj >= 0 ? '+' : '−'}${Math.abs(n.adj).toFixed(1)} pts</p>`;
    };
    return `<div class="row full"><span class="lbl">${tipBtn('Player news',
      'Injured players are taken off, and regulars returning from a spell out are added back. Each player’s value comes from how the team did with and without him over its last 12 games.')}</span></div>
      <div class="pgrid"><div>${side(g.away, news.away)}</div><div>${side(g.home, news.home)}</div></div>`;
  }

  function estimateHTML(g, est, predictor, news) {
    if (!est) {
      return `<p class="muted">Not enough recent games to work out an estimate yet. It needs at least 3 finished games for each team.</p>`;
    }
    const pc = p => `${Math.round(p * 100)}%`;
    const fa = fairPrice(est.pAway), fh = fairPrice(est.pHome);
    const fp = x => x ? `${x.decimal} <span class="frac">${x.fractional}</span>` : '–';
    const oddsPct = side => {
      const a = americanTo(g.odds?.away), h = americanTo(g.odds?.home);
      if (!a || !h) return '–';
      const t = a.implied + h.implied;
      return pc((side === 'a' ? a.implied : h.implied) / t);
    };
    const changed = est.adj && Math.round(est.base.pHome * 100) !== Math.round(est.pHome * 100);
    let rows = `
      <div class="row"><span class="v big">${pc(est.pAway)}</span><span class="lbl">Win chance, our estimate</span><span class="v big">${pc(est.pHome)}</span></div>
      ${changed ? `<div class="row"><span class="v">${pc(est.base.pAway)}</span><span class="lbl">Before player news</span><span class="v">${pc(est.base.pHome)}</span></div>` : ''}
      ${playersHTML(g, news)}
      ${g.odds ? `<div class="row"><span class="v">${oddsPct('a')}</span><span class="lbl">Win chance, bookmakers</span><span class="v">${oddsPct('h')}</span></div>` : ''}
      ${predictor ? `<div class="row"><span class="v">${pc(predictor.away)}</span><span class="lbl">Win chance, ESPN</span><span class="v">${pc(predictor.home)}</span></div>` : ''}
      <div class="row"><span class="v">${fp(fa)}</span><span class="lbl">Fair price from our estimate</span><span class="v">${fp(fh)}</span></div>
      <div class="row"><span class="v">${Math.round(est.expAway)}</span><span class="lbl">Expected points</span><span class="v">${Math.round(est.expHome)}</span></div>`;
    if (est.pHomeCover != null) {
      rows += `<div class="row"><span class="v">${pc(1 - est.pHomeCover)}</span><span class="lbl">Chance to cover ${esc(signedLine(est.lines.away))} / ${esc(signedLine(est.lines.home))}</span><span class="v">${pc(est.pHomeCover)}</span></div>`;
    }
    if (est.pOver != null) {
      rows += `<div class="row full"><span class="lbl">Total points ${esc(g.odds.overUnder)}</span>
        <span class="line">Over ${pc(est.pOver)}, under ${pc(1 - est.pOver)} <span class="muted-i">(expected ${Math.round(est.expHome + est.expAway)})</span></span></div>`;
    }
    const sim = similarFavourites(g);
    if (sim) {
      rows += `<div class="row full"><span class="lbl">From your Odds record</span>
        <span class="line">Favourites priced like ${esc(sim.fav.short)} (${pc(sim.p)}) have won ${sim.won} of ${sim.n} (${pc(sim.won / sim.n)})</span></div>`;
    }
    return rows + `<p class="hint">Built from each team's last ${MODEL[g.league].games} games, with recent games counting more,
      points adjusted for how strong each opponent was, a small home advantage, and changes for injured or returning players.
      It's a guide, not a prediction. It can't see late team news, weather or rested players.</p>`;
  }

  // ---------- games today: form and head-to-head ----------
  function formChips(f) {
    if (!f) return '<span class="muted">No recent games</span>';
    return `<span class="form">${f.games.map(x =>
      `<span class="res r${x.result}" title="${esc(`${pastDate(x.date)}: ${x.home ? 'vs' : 'at'} ${x.oppName} ${x.us}–${x.them}`)}">${x.result}</span>`
    ).join('')}</span>`;
  }

  function formHTML(g, awayHist, homeHist, ats) {
    const af = formStats(awayHist), hf = formStats(homeHist);
    const n = v => (v == null ? '–' : v.toFixed(1));
    const signed = v => (v == null ? '–' : `${v > 0 ? '+' : ''}${v.toFixed(1)}`);
    const ar = teamOddsRecord(g.league, g.away.id, g.seasonYear);
    const hr = teamOddsRecord(g.league, g.home.id, g.seasonYear);
    const rec = x => (x[0] + x[1] ? `${x[0]}–${x[1]}` : '–');
    const anyOdds = [...ar.fav, ...ar.dog, ...hr.fav, ...hr.dog].some(Boolean);
    return `
      <div class="row"><span class="v">${esc(g.away.record || '–')}</span><span class="lbl">Season record</span><span class="v">${esc(g.home.record || '–')}</span></div>
      ${g.away.awayRecord || g.home.homeRecord ? `<div class="row"><span class="v">${esc(g.away.awayRecord || '–')}</span><span class="lbl">Away / home record</span><span class="v">${esc(g.home.homeRecord || '–')}</span></div>` : ''}
      <div class="row"><span class="v">${formChips(af)}</span><span class="lbl">Last ${FORM_GAMES} games</span><span class="v">${formChips(hf)}</span></div>
      <div class="row"><span class="v">${n(af?.scored)}</span><span class="lbl">Points scored per game</span><span class="v">${n(hf?.scored)}</span></div>
      <div class="row"><span class="v">${n(af?.conceded)}</span><span class="lbl">Points allowed per game</span><span class="v">${n(hf?.conceded)}</span></div>
      <div class="row"><span class="v">${signed(af?.margin)}</span><span class="lbl">Average margin</span><span class="v">${signed(hf?.margin)}</span></div>
      ${ats && (ats.away || ats.home) ? `<div class="row"><span class="v">${esc(ats.away || '–')}</span><span class="lbl">Record against the spread</span><span class="v">${esc(ats.home || '–')}</span></div>` : ''}
      ${anyOdds ? `<div class="row"><span class="v">${rec(ar.fav)}</span><span class="lbl">Record as favourite</span><span class="v">${rec(hr.fav)}</span></div>
        <div class="row"><span class="v">${rec(ar.dog)}</span><span class="lbl">Record as underdog</span><span class="v">${rec(hr.dog)}</span></div>` : ''}`;
  }

  function h2hHTML(g, awayHist) {
    const meetings = awayHist.filter(x => x.oppId === String(g.home.id) && x.id !== g.id);
    const seasons = LEAGUES[g.league].h2hSeasons;
    if (!meetings.length) return `<p class="muted">No regular-season meetings in the last ${seasons} seasons.</p>`;
    const aw = meetings.filter(x => x.result === 'W').length;
    const hw = meetings.filter(x => x.result === 'L').length;
    const avgA = meetings.reduce((t, x) => t + x.us, 0) / meetings.length;
    const avgH = meetings.reduce((t, x) => t + x.them, 0) / meetings.length;
    return `
      <div class="row"><span class="v big">${aw}</span><span class="lbl">Wins, last ${seasons} seasons</span><span class="v big">${hw}</span></div>
      <div class="row"><span class="v">${avgA.toFixed(1)}</span><span class="lbl">Average points</span><span class="v">${avgH.toFixed(1)}</span></div>
      <ol class="meetings">${meetings.slice(0, H2H_SHOWN).map(x => `<li>
        <span class="v ${x.result === 'W' ? 'won' : ''}">${x.us}</span>
        <span class="lbl">${esc(pastDate(x.date))}, at ${esc(x.home ? g.away.abbr : g.home.abbr)}</span>
        <span class="v ${x.result === 'L' ? 'won' : ''}">${x.them}</span>
      </li>`).join('')}</ol>`;
  }

  // ---------- games today: card ----------
  const openByDefault = () => window.matchMedia?.('(min-width: 761px)').matches ?? true;

  function section(key, title, summary, open) {
    return `<details class="sect" data-sect="${key}" ${open ? 'open' : ''}>
      <summary><span class="st">${title}</span><span class="ss">${summary || ''}</span></summary>
      <div class="sect-body"><div class="notice slim"><span class="spinner" aria-hidden="true"></span>Loading…</div></div>
    </details>`;
  }

  function matchCardHTML(g) {
    const open = openByDefault();
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
          ${logoHTML(g.away, 40)}
          <span class="sname">${esc(g.away.name)}</span>
          ${g.state !== 'pre' && g.away.score != null ? `<span class="big-score">${esc(g.away.score)}</span>` : ''}
        </div>
        <span class="at">at</span>
        <div class="side">
          ${logoHTML(g.home, 40)}
          <span class="sname">${esc(g.home.name)}</span>
          ${g.state !== 'pre' && g.home.score != null ? `<span class="big-score">${esc(g.home.score)}</span>` : ''}
        </div>
      </div>

      <div class="compare">
        <div class="odds-slot">${oddsMainHTML(g)}</div>
      </div>
      <div class="sections">
        ${section('est', 'Our estimate', 'from past results', open)}
        ${section('more', 'More odds', 'handicap, totals, bookmakers', open)}
        ${section('form', 'Form and stats', 'last 5 games', open)}
        ${section('h2h', 'Head-to-head', 'recent meetings', false)}
      </div>
    </article>`;
  }

  function fill(card, key, html) {
    const body = card.querySelector(`[data-sect="${key}"] .sect-body`);
    if (body) { body.innerHTML = `<div class="compare">${html}</div>`; addTips(body); }
  }

  async function loadMatchDetail(card, g) {
    const seasons = LEAGUES[g.league].h2hSeasons;
    const year = g.seasonYear || new Date().getFullYear();

    // The match summary has every bookmaker's prices, ESPN's own prediction
    // and records against the spread.
    const summaryP = getJSON(`${SITE}/${LEAGUES[g.league].path}/summary?event=${g.id}`).catch(() => null);
    const histP = Promise.all([
      teamHistory(g.league, g.away.id, year, seasons),
      teamHistory(g.league, g.home.id, year, 2)
    ]).catch(() => null);

    const sum = await summaryP;
    const books = (sum?.pickcenter || []).map(parseOdds).filter(Boolean);
    if (!g.odds && books.length) {
      g.odds = books[0];
      noteGame(g, g.odds);
      card.querySelector('.odds-slot').innerHTML = oddsMainHTML(g);
      addTips(card.querySelector('.odds-slot'));
    }
    // Fill in prices the scoreboard didn't include from the matching bookmaker.
    if (g.odds && books.length) {
      const same = books.find(b => b.provider === g.odds.provider) || books[0];
      for (const k of ['spreadHome', 'spreadAway', 'spreadHomePrice', 'spreadAwayPrice', 'overPrice', 'underPrice', 'overUnder']) {
        if (g.odds[k] == null && same[k] != null) g.odds[k] = same[k];
      }
    }
    fill(card, 'more', oddsMoreHTML(g, books));

    const proj = side => toNum(sum?.predictor?.[`${side}Team`]?.gameProjection);
    const predictor = proj('home') != null && proj('away') != null ? { home: proj('home') / 100, away: proj('away') / 100 } : null;
    const atsFor = id => {
      const t = (sum?.againstTheSpread || []).find(x => String(x.team?.id) === String(id));
      return t?.records?.[0]?.summary || '';
    };
    const ats = { away: atsFor(g.away.id), home: atsFor(g.home.id) };

    const hist = await histP;
    if (!hist) {
      const msg = '<p class="muted">Past results couldn’t load. Refresh to try again.</p>';
      fill(card, 'est', msg); fill(card, 'form', msg); fill(card, 'h2h', msg);
      return;
    }
    const before = h => h.filter(x => x.id !== g.id && x.date < g.date);
    const [awayHist, homeHist] = hist.map(before);
    fill(card, 'form', formHTML(g, awayHist, homeHist, ats));
    fill(card, 'h2h', h2hHTML(g, awayHist));

    const years = [g.seasonYear, ...awayHist.slice(0, PLAYER_SAMPLE).map(x => x.yr), ...homeHist.slice(0, PLAYER_SAMPLE).map(x => x.yr)];
    const ctx = await loadContext(g.league, years);
    const key = `${g.league}-${g.id}`;
    const showSummary = est => {
      const el = card.querySelector('[data-sect="est"] .ss');
      if (el && est) el.textContent = `${g.away.abbr} ${Math.round(est.pAway * 100)}%, ${g.home.abbr} ${Math.round(est.pHome * 100)}%`;
    };

    const base = estimate(g, awayHist, homeHist, ctx, null);
    if (!base) { fill(card, 'est', estimateHTML(g, null, predictor)); return; }
    if (g.state === 'pre') saveEstimate(key, base, true);
    fill(card, 'est', estimateHTML(g, base, predictor, 'pending'));
    showSummary(base);

    // Player news needs a box score for each recent game, so it only runs once
    // the "Our estimate" section is open.
    const injuries = parseInjuries(sum);
    const runPlayers = async () => {
      const [away, home] = await Promise.all([
        playerNews(g, g.away.id, awayHist, injuries[String(g.away.id)] || [], ctx),
        playerNews(g, g.home.id, homeHist, injuries[String(g.home.id)] || [], ctx)
      ]);
      const est = estimate(g, awayHist, homeHist, ctx, { home: home.adj, away: away.adj });
      if (g.state === 'pre') saveEstimate(key, est, true);
      fill(card, 'est', estimateHTML(g, est, predictor, { away, home }));
      showSummary(est);
    };
    const sect = card.querySelector('[data-sect="est"]');
    if (sect.open) runPlayers().catch(() => fill(card, 'est', estimateHTML(g, base, predictor)));
    else sect.addEventListener('toggle', () => {
      if (sect.open) runPlayers().catch(() => fill(card, 'est', estimateHTML(g, base, predictor)));
    }, { once: true });
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

    addTips(todayEl);
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

  // ---------- share the app with a QR code ----------
  (function shareApp() {
    const dialog = document.getElementById('share-dialog');
    const openBtn = document.getElementById('share-open');
    if (!dialog || !openBtn) return;
    // The app's public address, without "index.html" on the end.
    const appUrl = new URL('./', location.href).href;

    function drawQR() {
      const box = document.getElementById('share-qr');
      if (box.firstChild || typeof window.qrcode !== 'function') return;
      const qr = window.qrcode(0, 'M');
      qr.addData(appUrl);
      qr.make();
      const n = qr.getModuleCount();
      const quiet = 4;
      const size = n + quiet * 2;
      let path = '';
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (qr.isDark(r, c)) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
        }
      }
      box.innerHTML = `<svg viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">
        <rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
    }

    document.getElementById('share-url').textContent = appUrl.replace(/^https?:\/\//, '');
    openBtn.addEventListener('click', () => {
      drawQR();
      if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    });
    const close = () => (typeof dialog.close === 'function' ? dialog.close() : dialog.removeAttribute('open'));
    document.getElementById('share-close').addEventListener('click', close);
    dialog.addEventListener('click', e => { if (e.target === dialog) close(); });

    const copyBtn = document.getElementById('share-copy');
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(appUrl);
        copyBtn.textContent = 'Link copied';
      } catch {
        copyBtn.textContent = 'Press and hold the link to copy';
      }
      setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 2500);
    });

    const nativeBtn = document.getElementById('share-native');
    if (navigator.share) {
      nativeBtn.hidden = false;
      nativeBtn.addEventListener('click', () => {
        navigator.share({
          title: 'Late Kick-off',
          text: 'NFL and NBA in UK time, with UK channels, odds and standings.',
          url: appUrl
        }).catch(() => {});
      });
    }
  })();

  // ---------- keep odds fresh ----------
  // Bookmakers release and move lines all week, so re-check every 10 minutes
  // while the app is open, and straight away when it's reopened.
  const ODDS_REFRESH_MS = 10 * 60_000;
  let lastRefresh = Date.now();
  function refreshOdds() {
    if (document.hidden || state.tab === 'standings') return;
    lastRefresh = Date.now();
    clearScoreboardCache();
    renderCurrent();
  }
  setInterval(() => { if (Date.now() - lastRefresh >= ODDS_REFRESH_MS) refreshOdds(); }, 60_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - lastRefresh > 5 * 60_000) refreshOdds();
  });

  // ---------- start ----------
  renderMine();
  selectTab(state.tab);
})();
