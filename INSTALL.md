# Put Late Kick-off on your phone

Late Kick-off is a web app that installs on your phone's home screen. Once installed it opens full screen with its own icon, like any other app, and it still shows the last data it loaded when you have no signal.

You need to host it online once (free), then install it from your phone's browser.

## Option A: GitHub Pages (recommended, about 10 minutes)

### 1. Create a GitHub account
Go to [github.com](https://github.com) and sign up if you don't have an account. It's free.

### 2. Create a repository
1. Click **+** (top right), then **New repository**.
2. Name it `late-kickoff`.
3. Set it to **Public**. (Free GitHub Pages needs a public repo.)
4. Click **Create repository**.

### 3. Upload the files
1. Unzip `late-kickoff.zip` on your computer.
2. On the new repo's page, click **uploading an existing file**.
3. Open the unzipped `late-kickoff` folder and drag **everything inside it** (not the folder itself) into the browser: `index.html`, `styles.css`, `app.js`, `channels.js`, `sw.js`, `manifest.webmanifest`, the `icons` folder, and the other files.
4. Click **Commit changes**.

Check the repo's main page shows `index.html` at the top level, not inside a `late-kickoff` folder. If it's inside a folder, the site won't load.

### 4. Turn on GitHub Pages
1. In the repo, go to **Settings**, then **Pages** (left menu).
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
3. Choose branch **main** and folder **/ (root)**, then click **Save**.
4. Wait a minute or two, then refresh the page. You'll see your link: `https://YOUR-USERNAME.github.io/late-kickoff/`

Open that link on your computer first to check the fixtures load.

### 5. Install it on your phone
Skip to [Install on your phone](#install-on-your-phone).

## Option B: Firebase Hosting

Use this if you'd rather have a `your-name.web.app` address. It needs a computer with [Node.js](https://nodejs.org) installed.

1. Go to [console.firebase.google.com](https://console.firebase.google.com), click **Create a project**, give it a name (for example `late-kickoff`) and finish the setup. You can turn Google Analytics off.
2. Note the **Project ID** shown under the project name (for example `late-kickoff-1a2b3`).
3. Open a terminal (Terminal on Mac, PowerShell on Windows) and install the Firebase tools:
   ```bash
   npm install -g firebase-tools
   ```
4. Sign in:
   ```bash
   firebase login
   ```
5. Go into the unzipped app folder:
   ```bash
   cd path/to/late-kickoff
   ```
6. Deploy it. `firebase.json` is already set up, so you only need your Project ID:
   ```bash
   firebase deploy --only hosting --project YOUR-PROJECT-ID
   ```
7. The terminal prints a **Hosting URL**, such as `https://late-kickoff-1a2b3.web.app`. That's your app.

## Why not Google Apps Script?

Apps Script (script.google.com) shows web pages inside a locked-down frame on Google's servers. That stops the app installing properly on a phone and stops it working offline, so it would only ever be a bookmark. GitHub Pages or Firebase gives you the real installable app.

## Install on your phone

### iPhone (Safari)
1. Open your app link in **Safari**. (Other iPhone browsers may not offer the option.)
2. Tap the **Share** button (square with an arrow pointing up).
3. Scroll down and tap **Add to Home Screen**.
4. Tap **Add**. The Late Kick-off icon appears on your home screen.

### Android (Chrome)
1. Open your app link in **Chrome**.
2. Tap **Install app** in the banner at the top of the page. If it doesn't appear, tap the **⋮** menu, then **Install app** or **Add to Home screen**.
3. Confirm. The app appears on your home screen and in your app drawer.

## Updating the app later

1. Change the files you need (for example `channels.js` for channel rules).
2. Open `sw.js` and change the version at the top, for example `'v3'` to `'v4'`. This tells phones there's a new version.
3. Upload the changed files again (GitHub: **Add file**, then **Upload files**; Firebase: run the deploy command again).
4. On your phone, close the app fully and reopen it. The update shows after one or two reopens.

## Troubleshooting

**The page is blank or says it couldn't load data.** Check you can open `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard` in your browser. If that fails, ESPN's feed is down or has changed.

**GitHub shows a 404 page.** Wait a few minutes after turning on Pages, and make sure `index.html` is in the top level of the repo.

**No "Install app" option on Android.** The page must be opened over `https://` (GitHub Pages and Firebase both do this). Reload the page once, then check the ⋮ menu again.

**The app shows old games.** You're probably offline and seeing saved data. Reconnect and pull down or reopen the app.
