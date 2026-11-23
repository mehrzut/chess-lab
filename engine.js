/* Stockfish in Web Workers.
   Stockfish 19 (lite NNUE, single-threaded WASM) ships with the site in vendor/stockfish,
   so it loads from the same origin and needs no special server headers. Browsers without
   WebAssembly fall back to the old stockfish.js 10 from a CDN.
   Two engines run separately: 'main' analyses whole games, 'live' serves explore mode,
   the trainer and guess-the-move, so they never wait for each other. */

const SF_WASM = 'vendor/stockfish/stockfish-19-lite-single.js';
const SF_OLD = [
  'https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js',
  'https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js',
];

function parseInfo(l) {
  const t = l.split(' '); const o = {};
  for (let i = 1; i < t.length; i++) {
    const k = t[i];
    if (k === 'depth') o.depth = +t[++i];
    else if (k === 'multipv') o.mpv = +t[++i];
    else if (k === 'score') {
      o.st = t[++i]; o.sv = +t[++i];
      if (t[i + 1] === 'lowerbound' || t[i + 1] === 'upperbound') { o.bound = true; i++; }
    } else if (k === 'pv') { o.pv = t.slice(i + 1).filter(Boolean); break; }
    else if (k === 'string') break;
  }
  return o;
}
/* centipawns for the side to move; mate in n becomes 10000 - n (negative when being mated) */
const scoreCp = (o) => (o.st === 'cp' ? o.sv : (o.sv > 0 ? 10000 - o.sv : -10000 - o.sv));

class Engine {
  constructor(worker) {
    this.w = worker; this.subs = new Set(); this.chain = Promise.resolve(); this.running = false; this.mpv = 1; this.options = {};
    worker.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      if (e.data.startsWith('option name ')) { // remember the options this build offers (UCI_Elo, Skill Level, ...)
        const m = e.data.match(/^option name (.+?) type (\S+)(.*)$/);
        if (m) this.options[m[1]] = { type: m[2], min: +((m[3].match(/ min (-?\d+)/) || [])[1]), max: +((m[3].match(/ max (-?\d+)/) || [])[1]) };
      }
      for (const f of [...this.subs]) f(e.data);
    };
  }
  send(c) { this.w.postMessage(c); }
  wait(pred, ms) {
    return new Promise((res, rej) => {
      let timer = null;
      const f = (l) => { if (pred(l)) { clearTimeout(timer); this.subs.delete(f); res(l); } };
      this.subs.add(f);
      if (ms) timer = setTimeout(() => { this.subs.delete(f); rej(new Error('Stockfish did not respond')); }, ms);
    });
  }
  async init(ms) {
    const failed = new Promise((_, rej) => { this.w.onerror = (e) => { e.preventDefault(); rej(new Error(e.message || 'Stockfish failed to load')); }; });
    const ok = (async () => { const p = this.wait((l) => l.startsWith('uciok'), ms); this.send('uci'); await p; await this.ready(ms); })();
    await Promise.race([ok, failed]);
  }
  async ready(ms) { const p = this.wait((l) => l === 'readyok', ms); this.send('isready'); await p; }
  stop() { if (this.running) this.send('stop'); }
  queue(fn) { const run = this.chain.then(fn, fn); this.chain = run.catch(() => {}); return run; }
  newGame() { return this.queue(async () => { this.send('ucinewgame'); await this.ready(); }); }
  /* o: { depth, movetime (ms, instead of depth), multipv, moves (searchmoves), onInfo(lines, depth), stale() } -> { best, lines: [{depth, cp, pv}] }
     cp in lines is from White's point of view. Returns null if stale() was true before it started. */
  search(fen, o = {}) { return this.queue(() => (o.stale && o.stale() ? null : this.run(fen, o))); }
  run(fen, { depth = 12, movetime = 0, multipv = 1, moves = null, onInfo = null }) {
    const sgn = fen.split(' ')[1] === 'w' ? 1 : -1;
    return new Promise((res) => {
      if (multipv !== this.mpv) { this.send('setoption name MultiPV value ' + multipv); this.mpv = multipv; }
      const lines = [];
      const f = (l) => {
        if (l.startsWith('info ')) {
          const o = parseInfo(l); if (!o.pv || !o.pv.length || o.bound || o.st == null) return;
          lines[(o.mpv || 1) - 1] = { depth: o.depth, cp: scoreCp(o) * sgn, pv: o.pv };
          if (onInfo) onInfo(lines.filter(Boolean), o.depth);
        } else if (l.startsWith('bestmove')) {
          this.subs.delete(f); this.running = false;
          res({ best: l.split(' ')[1], lines: lines.filter(Boolean) });
        }
      };
      this.subs.add(f); this.running = true;
      this.send('position fen ' + fen);
      this.send((movetime ? 'go movetime ' + movetime : 'go depth ' + depth) + (moves && moves.length ? ' searchmoves ' + moves.join(' ') : ''));
    });
  }
}

async function spawnEngine(hash) {
  if (typeof WebAssembly === 'object') {
    let w = null;
    try {
      w = new Worker(SF_WASM); const e = new Engine(w); await e.init(30000);
      e.kind = 'Stockfish 19'; e.send('setoption name Hash value ' + hash); return e;
    } catch (_) { if (w) w.terminate(); }
  }
  for (const u of SF_OLD) {
    let w = null;
    try {
      const r = await fetch(u); if (!r.ok) continue;
      w = new Worker(URL.createObjectURL(new Blob([await r.text()], { type: 'text/javascript' })));
      const e = new Engine(w); await e.init(30000);
      // Stockfish 10 defaults to Contempt 24, which skews scores toward the side to move
      e.send('setoption name Contempt value 0'); e.kind = 'Stockfish 10'; return e;
    } catch (_) { if (w) w.terminate(); }
  }
  throw new Error('Could not start Stockfish. Check your connection and try again.');
}
const engines = {};
function getEngine(name = 'main') {
  if (!engines[name]) {
    engines[name] = spawnEngine(name === 'main' ? 32 : 16);
    engines[name].catch(() => { delete engines[name]; });
  }
  return engines[name];
}

/* One position of a game: { cp (White's view), best (uci), pv (uci list) } */
async function evalPosition(eng, fen, depth) {
  const ch = new Chess(fen); const sgn = fen.split(' ')[1] === 'w' ? 1 : -1;
  if (ch.game_over()) return { cp: ch.in_checkmate() ? -sgn * 10000 : 0, best: null, pv: [] };
  const r = await eng.search(fen, { depth });
  const l = r.lines[0];
  return { cp: l ? l.cp : 0, best: r.best, pv: l ? l.pv.slice(0, 10) : (r.best ? [r.best] : []) };
}

/* The opponent in Play and learn: its own worker, so a weakened engine never coaches.
   elo 0 means full strength. Uses UCI_Elo when the build offers it, else Skill Level. */
async function playEngine(elo) {
  const eng = await getEngine('play');
  if (eng.elo === elo) return eng;
  await eng.queue(async () => {
    const o = eng.options;
    if (!elo) {
      if (o.UCI_LimitStrength) eng.send('setoption name UCI_LimitStrength value false');
      if (o['Skill Level']) eng.send('setoption name Skill Level value 20');
    } else if (o.UCI_Elo) {
      const v = Math.max(o.UCI_Elo.min || 0, Math.min(o.UCI_Elo.max || 4000, elo));
      eng.send('setoption name UCI_LimitStrength value true'); eng.send('setoption name UCI_Elo value ' + v);
    } else if (o['Skill Level']) {
      eng.send('setoption name Skill Level value ' + Math.round(Math.max(0, Math.min(20, (elo - 1300) / 60))));
    }
    eng.send('ucinewgame'); await eng.ready();
  });
  eng.elo = elo;
  return eng;
}

/* ---------- live analysis (explore mode) ---------- */
const live = { gen: 0 };
function liveStop() {
  live.gen++;
  if (engines.live) engines.live.then((e) => e.stop()).catch(() => {});
}
/* calls onUpdate(lines, depth, done) as the search deepens; a newer call cancels older ones */
async function liveAnalyze(fen, onUpdate, depth = 20) {
  const gen = ++live.gen; const stale = () => gen !== live.gen;
  let eng;
  try { eng = await getEngine('live'); } catch (err) { if (!stale()) onUpdate(null, 0, true, err); return; }
  if (stale()) return;
  eng.stop();
  if (new Chess(fen).game_over()) { onUpdate([], 0, true); return; }
  const r = await eng.search(fen, { depth, multipv: 3, stale, onInfo: (lines, d) => { if (!stale()) onUpdate(lines, d, false); } });
  if (r && !stale()) onUpdate(r.lines, r.lines[0] ? r.lines[0].depth : depth, true);
}

/* Compares a move with the engine's best in the same position, at the same depth.
   opts: { best (known best uci), played (also score this move), depth }
   Returns { best, bestCp, bestPv, guess: {cp, pv}, guessDrop, played?, playedDrop? }.
   Drops are in win-percentage points for the side to move. */
async function judgeMove(fen, guess, opts = {}) {
  const depth = opts.depth || 14; liveStop();
  const eng = await getEngine('live');
  const sgn = fen.split(' ')[1] === 'w' ? 1 : -1;
  const top = await eng.search(fen, { depth, moves: opts.best ? [opts.best] : null });
  const best = opts.best || top.best; const tl = top.lines[0];
  const res = { best, bestCp: tl ? tl.cp : 0, bestPv: tl ? tl.pv : [best] };
  const score = async (u) => {
    if (u === best) return { cp: res.bestCp, pv: res.bestPv };
    const r = await eng.search(fen, { depth, moves: [u] }); const l = r.lines[0];
    return { cp: l ? l.cp : res.bestCp, pv: l ? l.pv : [u] };
  };
  const drop = (cp) => Math.max(0, winPct(res.bestCp * sgn) - winPct(cp * sgn));
  res.guess = await score(guess); res.guessDrop = drop(res.guess.cp);
  if (opts.played) { res.played = await score(opts.played); res.playedDrop = drop(res.played.cp); }
  return res;
}
