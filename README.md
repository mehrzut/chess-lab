# Chess Lab

Opening stats, Stockfish game review that explains each mistake, and puzzles built from your own chess.com games. It is a static site (HTML, CSS and JavaScript), so it can be hosted free on GitHub Pages or Cloudflare Pages. There is no server and no login: games come from chess.com's public API and are analysed in your browser.

## Run it on your computer

    python3 -m http.server 8000

Open http://localhost:8000, enter your chess.com username and press Import games. The username is remembered in your browser, so next time the app opens with your games already loaded. A link like `http://localhost:8000/?u=SOMEONE` imports that username straight away.

## Put it on the internet

### Option A: GitHub Pages

1. Create a new public repository on GitHub, for example `chess-lab`.
2. Upload every file in this folder (including `.nojekyll` and the `vendor` folder) to the repository root, or push them:

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
- **Why it was a mistake:** every inaccuracy, mistake and blunder gets a plain-language explanation and a type: hung material, missed their threat, walked into a tactic, allowed mate, missed mate, missed free material, missed a tactic, or a weaker plan. A green arrow shows the better move and a red arrow shows the opponent's best reply. Moves made in time trouble or much faster than your average are marked.
- **Explore:** move pieces for either side from any position while Stockfish shows its three best lines. "See their best reply" and "See the better move" load the engine line so you can step through it.
- **Guess the move:** replay your own game and guess each of your moves before it is shown. Each guess is compared with the engine and with what you played.
- **Show threats:** marks loose pieces (yours with a solid red ring, theirs with a dashed green ring) and says what the last move attacks.
- **Train your mistakes:** every mistake and blunder from your analyzed games becomes a puzzle. Find a better move than the one you played. Puzzles you solve come back after 1, 3, 7, 21 and 60 days; ones you miss come back the next day. You can drag, click or type moves.
- **Play insights:** analyze your last 10, 20, 40 or 100 games in the current filters to see accuracy, what kind of mistakes you make, how they relate to your clock, positions where you went wrong more than once, the move where each opening first slips, and the games to review first.

## How it works

- Games load from `api.chess.com/pub/player/<name>/games/archives`. The API is public, read-only and allows browser requests from any site.
- Imported games, analyses, notes and puzzle progress are saved in your browser's IndexedDB, so a refresh does not start over. Data saved by older versions in local storage is moved across automatically.
- Openings come from the `ECOUrl` tag in each game's PGN. Endgames are positions after move 10 where both sides have 13 points of pieces or fewer.
- Review runs Stockfish 19 (the lite, single-threaded WebAssembly build of stockfish.js) in Web Workers, at depth 12, 15 or 18 for one game and 12 for batch analysis. It ships in `vendor/stockfish`, so it loads from your own site and needs no special server headers. Browsers without WebAssembly fall back to stockfish.js 10 from a CDN. Each move is rated from the drop in win probability. Accuracy uses the same win-probability formula Lichess publishes.
- Explanations come from the stored engine lines: the best reply after your move shows what it allowed, and the material count along that line (after equal trades cancel out) tells a hung piece from a tactic. Games analyzed by an older version have shorter lines, so analyzing them again gives fuller explanations.
- A brilliant move is a near-best move that gives up a piece for less than it is worth in a position that was not already winning. A missed tactic is a big mistake where the best move was a capture or check. These are close to chess.com's categories but not identical, and chess.com's own premium Insights are not available through any public API.

## Files

- `index.html`, `style.css`: layout and styling
- `store.js`: shared helpers, IndexedDB storage
- `board.js`: board drawing, click, drag and typed moves
- `engine.js`: Stockfish workers, live analysis, move judging
- `learn.js`: mistake explanations, loose pieces, mistake patterns, puzzles and review schedule
- `app.js`: import, stats, game list, game review, insights
- `explore.js`: explore mode and guess the move
- `train.js`: the Train your mistakes tab
- `vendor/stockfish/`: Stockfish 19 lite (stockfish.js 19.0.1, GPLv3; see `Copying.txt`, source at github.com/nmrugg/stockfish.js)
- `.nojekyll`: tells GitHub Pages to serve the files as they are

## Credits

Stockfish 19 via stockfish.js by Nathan Rugg (GPLv3). Chess rules via chess.js. Piece images: cburnett set from lichess.org (GPLv2+). Not affiliated with chess.com.
