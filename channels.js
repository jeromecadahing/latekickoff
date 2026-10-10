/*
 * UK channel rules
 * ----------------
 * ESPN's data feed only lists the US broadcaster for each game, so this file
 * turns that (plus the UK kick-off time and the type of game) into the UK
 * channels a game is likely to be on. A game can be on several channels.
 *
 * UK rights deals change, so CHECK AND EDIT THE SETTINGS BELOW at the start of
 * each season. Everything you might want to change is in SERVICES, RULES and
 * OVERRIDES.
 *
 * Each channel returned for a game has:
 *   id        – a key from SERVICES (used for the "My channels" setting)
 *   name      – what's shown on the chip
 *   kind      – "tv" (a TV channel) or "stream" (an app / subscription)
 *   certainty – "likely"   (this type of game is normally shown there)
 *               "possible" (only some games in this slot are picked, check listings)
 */
(function () {
  // Every channel or service the app knows about. These appear in "My channels".
  const SERVICES = {
    sky:     { name: 'Sky Sports',        kind: 'tv' },
    ch5:     { name: 'Channel 5',         kind: 'tv', note: 'Free-to-air, also streams on the 5 app' },
    dazn:    { name: 'DAZN',              kind: 'stream', note: 'NFL Game Pass, every NFL game live' },
    nbalp:   { name: 'NBA League Pass',   kind: 'stream', note: 'Every NBA game live' },
    netflix: { name: 'Netflix',           kind: 'stream' },
    youtube: { name: 'YouTube',           kind: 'stream' }
  };

  // Ticked in "My channels" the first time someone opens the app.
  const DEFAULT_MINE = ['dazn', 'ch5'];

  const RULES = {
    nfl: {
      // Label used on chips for Sky's NFL coverage.
      skyLabel: 'Sky Sports NFL',
      // Label used on chips for DAZN's NFL coverage.
      daznLabel: 'DAZN (Game Pass)',
      // US networks whose games are national primetime / standalone games.
      // Sky normally shows these (Thursday, Sunday and Monday night).
      primetimeNetworks: ['NBC', 'ESPN', 'ABC', 'Prime Video', 'Amazon', 'Peacock', 'Netflix', 'YouTube'],
      // Channel 5's free-to-air NFL coverage. It doesn't show every game, so
      // games in these UK windows are marked "possible". Edit to match the
      // current season's deal (days are UK days, hours are UK 24h clock).
      channel5: {
        enabled: true,
        days: ['Sunday'],
        fromHour: 17,          // 5pm UK
        toHour: 23,            // up to 11pm UK
        includeInternational: true,
        includePostseason: false
      }
    },
    nba: {
      // UK TV partner for selected NBA games (a key from SERVICES).
      // NBA UK rights have moved around, so verify this each season.
      tvService: 'sky',
      tvLabel: 'Sky Sports',
      // US national networks. Games on these are the ones most likely to be
      // picked up by the UK TV partner.
      nationalNetworks: ['ESPN', 'ABC', 'NBC', 'Peacock', 'Prime Video', 'Amazon', 'TNT']
    }
  };

  /*
   * Force the channels for a specific game. Find a game's ID by hovering over
   * it in the schedule. Example:
   *   '401772810': [{ id: 'sky', name: 'Sky Sports Main Event' }, { id: 'ch5' }, { id: 'dazn' }]
   */
  const OVERRIDES = {
  };

  const has = (list, names) =>
    list.some(n => names.some(x => n.toLowerCase().includes(x.toLowerCase())));

  const ch = (id, certainty = 'likely', name) => ({
    id, name: name || SERVICES[id].name, kind: SERVICES[id].kind, certainty
  });

  function nflChannels(g) {
    const r = RULES.nfl;
    const out = [];
    const post = g.seasonType === 3;
    const intl = g.international;
    const primetime = has(g.usTv, r.primetimeNetworks);
    const sundayWindow = g.uk.weekday === 'Sunday' && g.uk.hour >= 17 && g.uk.hour <= 23;

    // Sky Sports NFL
    if (post || intl || primetime) out.push(ch('sky', 'likely', r.skyLabel));
    else if (sundayWindow) out.push(ch('sky', 'possible', r.skyLabel));

    // Channel 5
    const c5 = r.channel5;
    if (c5.enabled) {
      const inWindow = c5.days.includes(g.uk.weekday) && g.uk.hour >= c5.fromHour && g.uk.hour <= c5.toHour;
      if ((inWindow && !primetime) || (intl && c5.includeInternational) || (post && c5.includePostseason)) {
        out.push(ch('ch5', 'possible'));
      }
    }

    // Global streamers that hold their own games
    if (has(g.usTv, ['Netflix'])) out.push(ch('netflix'));
    if (has(g.usTv, ['YouTube'])) out.push(ch('youtube'));

    // DAZN carries every game
    out.push(ch('dazn', 'likely', r.daznLabel));
    return out;
  }

  function nbaChannels(g) {
    const r = RULES.nba;
    const out = [];
    if (g.seasonType === 3) out.push(ch(r.tvService, 'likely', r.tvLabel));
    else if (has(g.usTv, r.nationalNetworks)) out.push(ch(r.tvService, 'possible', r.tvLabel));
    out.push(ch('nbalp'));
    return out;
  }

  window.UKTV = {
    SERVICES,
    DEFAULT_MINE,
    RULES,
    channelsFor(game) {
      if (OVERRIDES[game.id]) {
        return OVERRIDES[game.id].map(o => ({
          ...ch(o.id, 'likely', o.name), ...(o.certainty ? { certainty: o.certainty } : {})
        }));
      }
      return game.league === 'nfl' ? nflChannels(game) : nbaChannels(game);
    }
  };
})();
