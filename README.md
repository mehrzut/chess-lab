# Chess Lab

Opening stats, endgame stats and Stockfish game review for your chess.com games. It is a static site (HTML, CSS and JavaScript), so it can be hosted free on GitHub Pages or Cloudflare Pages. There is no server and no login: games come from chess.com's public API and are analysed in your browser.

## Run it on your computer

    python3 -m http.server 8000

Open http://localhost:8000, enter your chess.com username and press Import games. The username is remembered in your browser, so next time the app opens with your games already loaded. A link like `http://localhost:8000/?u=SOMEONE` imports that username straight away.

## Put it on the internet

### Option A: GitHub Pages

1. Create a new public repository on GitHub, for example `chess-lab`.
2. Upload every file in this folder (including `.nojekyll`) to the repository root, or push them:

        git init
        git add .
        git commit -m "Chess Lab"
        git branch -M main
        git remote add origin https://github.com/YOUR-NAME/chess-lab.git
        git push -u origin main

3. In the repository, open Settings, then Pages. Under Build and deployment choose "Deploy from a branch", pick `main` and `/ (root)`, and save.
4. After a minute the site is live at `https://YOUR-NAME.github.io/chess-lab/`.

### Option B: Cloudflare Pages

1. Push the files to a GitHub repository as above.
2. In the Cloudflare dashboard open Workers and Pages, then Create, then Pages, then Connect to Git, and pick the repository.
3. Leave the build command empty and set the build output directory to `/` (or leave it blank). Deploy.
4. The site is live at `https://chess-lab.pages.dev` (the name follows your project name).

To skip Git entirely, run this inside the chess-lab folder (the `.` is the folder to upload, and wrangler fails without it):

    npx wrangler login
    npx wrangler pages deploy . --project-name chess-lab

The first deploy asks whether to create the project. Choose production branch `main` if it asks.

## What it does

- **Stats:** filter by color, time control and period (30 days, 90 days, 1 year). See openings with win and score rates, best and worst openings, how games end, results against stronger and weaker players, weekday and time-of-day results, endgame types, and streak and tilt numbers.
- **Game list:** search by opponent or opening, filter by result, show analyzed games only, sort by date, opponent strength, rating change, game length or accuracy, and export the list as CSV. Each game shows its rating change.
- **Game review:** board with move-quality badges and engine arrows, evaluation graph, accuracy by side and phase, key moments, time per move and a notes tab for each game.
- **Play insights:** analyze your last 10, 20 or 40 games to get blunders and mistakes per game, accuracy by phase and opening, and a list of games to review first.

## How it works

- Games load from `api.chess.com/pub/player/<name>/games/archives`. The API is public, read-only and allows browser requests from any site.
- Imported games and finished analyses are saved in your browser's local storage, so a refresh does not start over.
- Openings come from the `ECOUrl` tag in each game's PGN. Endgames are positions after move 10 where both sides have 13 points of pieces or fewer.
- Review runs Stockfish (stockfish.js, depth 10, 12 or 15) in a Web Worker. Each move is rated from the drop in win probability. Accuracy uses the same win-probability formula Lichess publishes.
- A brilliant move is a near-best move that gives up a piece for less than it is worth in a position that was not already winning. A missed tactic is a big mistake where the best move was a capture or check. These are close to chess.com's categories but not identical, and chess.com's own premium Insights are not available through any public API.

## Files

- `index.html`, `style.css`: layout and styling
- `app.js`: import, stats, board, engine analysis
- `.nojekyll`: tells GitHub Pages to serve the files as they are

## Credits

Stockfish via stockfish.js. Chess rules via chess.js. Piece images: cburnett set from lichess.org (GPLv2+). Not affiliated with chess.com.
