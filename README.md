# Late Kick-off

NFL and NBA fixtures in UK time, with the UK channel for each game, plus a standings tab for both leagues.

It's a plain HTML/CSS/JavaScript site with no build step, no API keys and no server, so it runs straight from GitHub Pages.

## What it does

The **Schedule** tab shows the next 7 days of NFL and NBA games, grouped by UK date, with kick-off/tip-off times converted to UK time (including BST/GMT changes). Each game shows:

- the UK channel (solid chip = normally on UK TV, dashed chip with **?** = only some games in that slot are picked, so check listings)
- the streaming service that carries every game
- the US broadcaster, for reference
- live scores and final results once games start (refreshes every minute while games are live)

You can filter by league, show only games on UK TV, and step forward or back a week. Late US games are labelled "overnight".

The **Games today** tab shows today's games (or the next day with games, if there are none today) as side-by-side match cards. Each card shows the win chance from the odds and each team's price to win, with four sections you can open and close (open on a computer, closed on a phone):

- **Our estimate**: a win chance worked out from each team's last 10 results (points scored and allowed, plus a small home advantage), shown next to the bookmakers' and ESPN's win chances. It also gives a fair price, expected points, the chance each side covers the handicap, the chance the game goes over or under the points total, and how often similarly priced favourites have won in your Odds record. It's a simple statistical guide and doesn't know about injuries.
- **More odds**: the handicap (spread) and points total with their prices, opening prices, and prices from each bookmaker ESPN lists, with the best price for each team highlighted.
- **Form and stats**: season and home/away records, last 5 results, points scored and allowed, record against the spread, and record as favourite and underdog.
- **Head-to-head**: wins for each side over recent regular seasons (5 for NFL, 3 for NBA), average points, and the last few meetings.

Details load as each card scrolls into view, so the page stays quick on busy NBA nights. On phones, text and spacing are tighter so more fits on screen.

**Upcoming odds** appear on every game in the Schedule tab as soon as bookmakers release them ("Odds not out yet" until then). Each team's decimal price is shown with the spread and points total. Once the price changes, you'll see where it opened, with ▼ when a price has shortened and ▲ when it has drifted. A "New odds" badge marks lines released in the last 12 hours, and "Odds moved" marks lines that changed in the last 24 hours. The Games today cards also show each team's opening price. The app re-checks odds every 10 minutes while it's open, and again whenever you reopen it.

The **Odds record** tab tracks how often the odds got it right:

- how often the favourite won, how often it covered the spread, and how often games went over the points total
- an accuracy check by favourite strength (heavy, clear and slight favourites), comparing the win chance the odds gave with how often those teams actually won
- the last 40 finished games, marked as "Favourite won" or "Upset"

It saves the odds for every game the app sees, keeping the last odds before kick-off, then adds the result. It also fills in past games from ESPN (finished NFL weeks this season and the last 3 weeks of NBA). History is stored on your device, so each phone or browser builds its own. Match cards on the Games today tab also show each team's record as favourite and as underdog this season.

The **Standings** tab shows NFL standings by division and NBA standings by conference.

**My channels** (above the tabs) lets you tick the channels and services you have. They get a green tick on every game, and the Schedule tab's "Only games I can watch" filter hides everything else. DAZN and Channel 5 are ticked to start with.

Your choices are remembered in your browser.

## Install it on your phone

Late Kick-off installs on iPhone and Android home screens and works offline with the last data it loaded. See **[INSTALL.md](INSTALL.md)** for step-by-step setup with GitHub Pages or Firebase, and how to install it on your phone.

## Put it on GitHub Pages

1. Create a new repository on GitHub (for example `late-kickoff`).
2. Upload everything to the root of the repo: `index.html`, `styles.css`, `app.js`, `channels.js`, `sw.js`, `manifest.webmanifest`, the `icons` folder and the docs.
3. In the repo, go to **Settings → Pages**.
4. Under **Build and deployment**, set **Source** to *Deploy from a branch*, pick `main` and `/ (root)`, then **Save**.
5. After a minute your site is live at `https://<your-username>.github.io/late-kickoff/`.

To run it locally, serve the folder with any static server, for example:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Keeping the UK channels accurate

ESPN's feed only includes US broadcasters, so UK channels are worked out by rules in `channels.js`. UK rights deals change between seasons, so check these at the start of each season:

| Setting | What it's for |
| --- | --- |
| `SERVICES` | Every channel or service, as listed in My channels |
| `DEFAULT_MINE` | What's ticked in My channels the first time the app opens |
| `RULES.nfl.primetimeNetworks` | US networks whose games count as primetime (shown on Sky) |
| `RULES.nfl.channel5` | Which UK days and hours Channel 5 might show a game. **Check this against the current Channel 5 deal** |
| `RULES.nba.tvService` / `tvLabel` | UK TV partner for selected NBA games. **Verify this one**, NBA UK rights have moved around |

A game can show several channels. The current rules are:

- **NFL**: primetime games, International Series games and playoffs are marked as on Sky Sports NFL. Sunday games from 5pm to 11pm UK are marked "possible" on Sky and on Channel 5, because each only picks some games. International Series games are also marked "possible" on Channel 5. Netflix and YouTube games are tagged with those services. Every game is marked as on DAZN (Game Pass).
- **NBA**: games on a US national network are marked "possible" on the UK TV partner; playoffs are marked as on it. Every game is marked as on NBA League Pass.

To set the exact channel for a specific game, hover over the game to see its ID, then add it to `OVERRIDES` in `channels.js`:

```js
const OVERRIDES = {
  '401772810': [{ id: 'ch5' }, { id: 'sky', name: 'Sky Sports Main Event' }, { id: 'dazn' }]
};
```

## Data source

Fixtures, scores, odds and standings come from ESPN's public site API (`site.api.espn.com`). It's unofficial and undocumented, so it could change without notice. If the page stops loading data, that's the first thing to check. Odds are US bookmaker lines (as listed by ESPN), not UK bookmaker prices, and are for information only. This project isn't affiliated with ESPN, the NFL, the NBA or any broadcaster.
