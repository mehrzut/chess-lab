/* Play and learn: a game against Stockfish where a second, full-strength engine checks
   each of your moves. When a move falls below the level you chose, the game pauses: the
   coach says what your move allows (without giving the answer away), and you can take it
   back and try again, see the better move, or keep your move and play on. */

const PLAY_LEVELS = [[1350, 'Beginner (about 1350)'], [1600, 'Casual (about 1600)'], [1900, 'Club player (about 1900)'], [2200, 'Strong (about 2200)'], [2500, 'Expert (about 2500)'], [0, 'Full strength']];
const COACH_LEVELS = [[30, 'Stop me on blunders'], [20, 'Stop me on mistakes and blunders'], [10, 'Stop me on every inaccuracy'], [101, "Don't stop me, just label my moves"]];
const CLOCKS = [['0+0', 'No clock'], ['180+2', '3 min + 2 s'], ['300+0', '5 min'], ['600+0', '10 min'], ['900+10', '15 min + 10 s'], ['1800+0', '30 min']];
const COACH_DEPTH = 14;
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const pl = {
  board: null, ch: null, startFen: START_FEN, color: 'w', elo: 1600, coach: 20, side: 'w',
  phase: 'idle', log: [], pre: null, preFen: null, preVal: null, tok: 0, flag: null, hint: 0, retry: false,
  counts: { flagged: 0, corrected: 0, kept: 0, helped: 0, hints: 0 }, msg: '', result: null, armed: false,
  tcPick: '0+0', tc: null, clock: { w: 0, b: 0 }, run: null, since: 0, ticker: null,
};
const levelName = (elo) => (elo ? `Stockfish ${elo}` : 'Stockfish (full strength)');
const sideName = (c) => (c === 'w' ? 'White' : 'Black');

/* ---------- setup ---------- */
(function setupPlay() {
  const saved = prefs.get('play') || {};
  if (saved.elo != null) pl.elo = saved.elo; if (saved.coach) pl.coach = saved.coach; if (saved.side) pl.side = saved.side; if (saved.tc) pl.tcPick = saved.tc;
  $('#pClock').innerHTML = CLOCKS.map(([v, l]) => `<option value="${v}"${v === pl.tcPick ? ' selected' : ''}>${l}</option>`).join('');
  $('#pLevel').innerHTML = PLAY_LEVELS.map(([v, l]) => `<option value="${v}"${v === pl.elo ? ' selected' : ''}>${l}</option>`).join('');
  $('#pCoach').innerHTML = COACH_LEVELS.map(([v, l]) => `<option value="${v}"${v === pl.coach ? ' selected' : ''}>${l}</option>`).join('');
  $('#pSide').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === pl.side));
  const keep = () => prefs.set('play', { elo: pl.elo, coach: pl.coach, side: pl.side, tc: pl.tcPick });
  $('#pClock').addEventListener('change', () => { pl.tcPick = $('#pClock').value; keep(); });
  $('#pSide').addEventListener('click', (e) => {
    if (!e.target.dataset.v) return; pl.side = e.target.dataset.v; keep();
    $('#pSide').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.target));
  });
  $('#pLevel').addEventListener('change', () => { pl.elo = +$('#pLevel').value; keep(); drawPlay(); });
  // the coach level can change mid-game; it applies from your next move
  $('#pCoach').addEventListener('change', () => { pl.coach = +$('#pCoach').value; keep(); saveGame(); });
  $('#pThreats').checked = state.threats;
  $('#pThreats').addEventListener('change', () => {
    state.threats = $('#pThreats').checked; prefs.set('threats', state.threats); $('#threatsChk').checked = state.threats; drawPlay();
  });
  $('#pStart').addEventListener('click', () => {
    // a game in progress needs a second click, so one stray tap does not throw it away
    if (pl.ch && pl.phase !== 'over' && pl.log.length && !pl.armed) {
      pl.armed = true; $('#pStart').textContent = 'Click again to abandon this game';
      setTimeout(() => { pl.armed = false; $('#pStart').textContent = 'Start a new game'; }, 3000);
      return;
    }
    pl.armed = false; $('#pStart').textContent = 'Start a new game';
    startPlay({});
  });
})();

function openPlay() {
  if (!pl.board) pl.board = makeBoard($('#pBox'));
  $('#pThreats').checked = state.threats;
  if (!pl.ch) restoreGame();
  resumeClock(); drawPlay();
}
/* Game review: play on against Stockfish from the position on the board */
$('#bPlayHere').addEventListener('click', () => {
  const s = state.sel; if (!s) return;
  const fen = state.mode === 'explore' && state.ex ? exFen() : s.fens[state.ply];
  if (new Chess(fen).game_over()) return;
  if (state.mode !== 'game') leaveMode();
  tab('play'); startPlay({ fen, color: fen.split(' ')[1] });
});
/* opts: { fen, color } (Play from here passes both; the setup buttons pass neither) */
function startPlay(opts) {
  if (!pl.board) pl.board = makeBoard($('#pBox'));
  pl.tok++;
  pl.startFen = opts.fen || START_FEN;
  pl.color = opts.color || (pl.side === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : pl.side);
  pl.elo = +$('#pLevel').value; pl.coach = +$('#pCoach').value;
  const [base, inc] = $('#pClock').value.split('+').map(Number);
  stopClock(); pl.tc = base ? { base, inc } : null; pl.clock = { w: base * 1000, b: base * 1000 };
  pl.ch = new Chess(pl.startFen); pl.log = []; pl.flag = null; pl.hint = 0; pl.retry = false; pl.result = null;
  pl.pre = null; pl.preFen = null; pl.preVal = null;
  pl.counts = { flagged: 0, corrected: 0, kept: 0, helped: 0, hints: 0 };
  pl.msg = opts.fen ? 'Playing on from the position in game review.' : '';
  saveGame(); next();
}
function next() {
  if (pl.ch.game_over()) return finish();
  if (pl.ch.turn() === pl.color) yourTurn(); else engineTurn();
}

/* ---------- your move ---------- */
const coachEval = (fen) => getEngine('live').then((eng) => evalPosition(eng, fen, COACH_DEPTH));
function analyzePre() {
  const fen = pl.ch.fen(); if (pl.preFen === fen && pl.pre) return;
  pl.preFen = fen; pl.preVal = null;
  pl.pre = coachEval(fen).then((v) => { if (pl.preFen === fen) { pl.preVal = v; if (pl.hint && pl.phase === 'you') drawPlay(); } return v; });
  pl.pre.catch(() => {});
}
function yourTurn() { pl.phase = 'you'; pl.hint = 0; analyzePre(); startClock(pl.color); drawPlay(); }

async function onPlayMove(mv) {
  if (pl.phase !== 'you') return;
  const before = pl.ch.fen(); const r = pl.ch.move(mv); if (!r) return;
  stopClock(); // your clock does not run while the coach checks the move or while you read its warning
  const tok = pl.tok; pl.phase = 'checking'; drawPlay();
  const uci = r.from + r.to + (r.promotion || ''); const sg = pl.color === 'w' ? 1 : -1;
  let pre = null, post = null;
  try { pre = await pl.pre; post = await coachEval(pl.ch.fen()); } catch (_) { /* no coach available: play on */ }
  if (tok !== pl.tok) return;
  if (!pre || !post) { pl.msg = 'The coach could not check this move, so the game goes on without it.'; return commitMine({ uci, san: r.san, from: r.from, to: r.to, t: null, drop: 0 }); }
  const drop = uci === pre.best ? 0 : Math.max(0, winPct(pre.cp * sg) - winPct(post.cp * sg));
  const c = clsOf(drop); const label = c[1] === 'best' && uci !== pre.best ? 'Excellent' : c[3];
  const entry = { uci, san: r.san, from: r.from, to: r.to, t: c[1], sym: c[2], label, drop };
  if (drop >= pl.coach && ['inacc', 'mist', 'blun'].includes(c[1])) {
    let ex = null;
    try { ex = explainMove({ moves: [r], fens: [before, pl.ch.fen()], clocks: [], spent: [], base: null }, [pre, post], 0, drop, null); } catch (_) { ex = null; }
    pl.flag = { entry, ex, before, pre, post, better: false }; pl.counts.flagged++; pl.phase = 'flagged';
    teachNote('flag', { type: ex ? ex.type : 'other', cls: c[1] });
    drawPlay(); announce(`${label}: ${r.san}. ${hintText(pl.flag)}`);
    return;
  }
  pl.msg = `${label}: ${r.san}.`;
  commitMine(entry);
}
function commitMine(entry) {
  if (pl.retry && entry.t && !['inacc', 'mist', 'blun'].includes(entry.t)) pl.counts.corrected++;
  pl.retry = false; pl.flag = null; addInc(pl.color);
  pl.log.push({ ...entry, mine: true }); saveGame(); next();
}
/* what your move allows, without naming the better move (that is what you are looking for) */
function hintText(f) {
  const ex = f.ex; if (!ex) return 'The engine thinks there was something better here.';
  const sg = pl.color === 'w' ? 1 : -1; const lead = situation(f.pre.cp * sg, f.post.cp * sg);
  if (ex.type === 'mateMissed') return lead + 'You had a forced mate here. Look at every check.';
  if (ex.type === 'missedWin') return lead + 'You could have won material here. Look for captures and pieces that are not defended.';
  if (ex.type === 'missedTactic') return lead + 'There was a strong forcing move here. Look at checks and captures first.';
  if (ex.type === 'positional') return lead + `Nothing is lost straight away, but your position gets worse${ex.refSan ? `, and ${ex.refSan} is a strong reply (red arrow)` : ''}.`;
  return ex.text + ' The red arrow shows their strongest reply.';
}

/* ---------- Stockfish's move ---------- */
async function engineTurn() {
  pl.phase = 'thinking'; drawPlay();
  const tok = pl.tok; const t0 = Date.now(); const side = pl.color === 'w' ? 'b' : 'w';
  try {
    const eng = await playEngine(pl.elo);
    if (tok !== pl.tok) return;
    startClock(side);
    const movetime = pl.tc ? Math.max(150, Math.min(800, Math.round(pl.clock[side] / 30))) : 600;
    const r = await eng.search(pl.ch.fen(), { movetime });
    const wait = 450 - (Date.now() - t0); if (wait > 0) await new Promise((res) => setTimeout(res, wait)); // a reply that lands instantly is hard to follow
    if (tok !== pl.tok) return;
    stopClock(); addInc(side);
    const u = r.best; const mv = u && u !== '(none)' ? pl.ch.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || undefined }) : null;
    if (!mv) return finish();
    pl.log.push({ uci: u, san: mv.san, from: mv.from, to: mv.to, mine: false });
    if (pl.msg && !pl.msg.includes('Stockfish played')) pl.msg += ` Stockfish played ${mv.san}.`; else pl.msg = `Stockfish played ${mv.san}.`;
    announce(`Stockfish played ${mv.san}.`);
    saveGame(); next();
  } catch (err) {
    if (tok !== pl.tok) return;
    pl.phase = 'error'; pl.msg = err.message; drawPlay();
  }
}

/* ---------- actions ---------- */
function takeBackFlagged() { // undo the flagged move and try again from the same position
  pl.ch.undo(); pl.flag = null; pl.retry = true; pl.hint = 0; pl.phase = 'you';
  pl.msg = 'Try another move.'; startClock(pl.color); drawPlay();
}
function playBetter() {
  const f = pl.flag; pl.ch.undo();
  const u = f.pre.best; const mv = pl.ch.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || undefined });
  pl.counts.helped++; pl.retry = false;
  pl.msg = `You played the engine's move, ${mv.san}.`;
  commitMine({ uci: u, san: mv.san, from: mv.from, to: mv.to, t: 'best', sym: CLS[0][2], label: 'Best', drop: 0, helped: true });
}
function keepMove() {
  const f = pl.flag; pl.counts.kept++; pl.retry = false;
  pl.msg = `You kept ${f.entry.san} (${f.entry.label.toLowerCase()}).`;
  commitMine({ ...f.entry, kept: true });
}
function takeBackTurn() { // during your turn: undo Stockfish's last move and your move before it
  if (pl.phase !== 'you' || !pl.log.length) return;
  pl.tok++; stopClock();
  let undone = 0;
  while (pl.log.length && undone < 2) { const e = pl.log.pop(); pl.ch.undo(); undone++; if (e.mine) break; }
  pl.flag = null; pl.retry = false; pl.msg = 'Took back your last move.'; saveGame(); next();
}
/* kind: 'resign', or 'time' with the side whose clock ran out; otherwise read the board */
function finish(kind, side) {
  pl.tok++; stopClock(); pl.phase = 'over';
  const ch = pl.ch; let res, how;
  if (kind === 'resign') { res = 'L'; how = 'Resignation'; }
  else if (kind === 'time') {
    // running out of time only loses if the other side could still checkmate
    const other = side === 'w' ? 'b' : 'w'; const m = boardMap(ch.fen());
    const canMate = Object.values(m).some((p) => pieceColor(p) === other && /[pqr]/i.test(p)) || Object.values(m).filter((p) => pieceColor(p) === other && /[nb]/i.test(p)).length >= 2;
    res = !canMate ? 'D' : side === pl.color ? 'L' : 'W'; how = canMate ? 'Timeout' : 'Timeout vs insufficient material';
  }
  else if (ch.in_checkmate()) { res = ch.turn() === pl.color ? 'L' : 'W'; how = 'Checkmate'; }
  else { res = 'D'; how = ch.in_stalemate() ? 'Stalemate' : ch.in_threefold_repetition() ? 'Repetition' : ch.insufficient_material() ? 'Insufficient material' : '50-move rule'; }
  pl.result = { res, how };
  const mine = pl.log.filter((e) => e.mine && e.t);
  if (mine.length) teachNote('game', { res, flagged: pl.counts.flagged, corrected: pl.counts.corrected, kept: pl.counts.kept, acc: Math.round(mine.reduce((a, e) => a + moveAcc(e.drop), 0) / mine.length) });
  kv.del('play:current'); drawPlay();
  announce(res === 'W' ? `You won by ${how.toLowerCase()}.` : res === 'L' ? `You lost by ${how.toLowerCase()}.` : `Draw by ${how.toLowerCase()}.`);
}
/* opens the finished (or current) game in Game review, where it can be analyzed like any other */
function reviewPlayed() {
  const ch = new Chess(pl.startFen);
  pl.log.forEach((e) => ch.move({ from: e.uci.slice(0, 2), to: e.uci.slice(2, 4), promotion: e.uci[4] || undefined }));
  const r = pl.result || { res: 'D', how: 'Unfinished' };
  ch.header('White', pl.color === 'w' ? 'You' : levelName(pl.elo), 'Black', pl.color === 'b' ? 'You' : levelName(pl.elo),
    'Result', r.res === 'D' ? '1/2-1/2' : (r.res === 'W') === (pl.color === 'w') ? '1-0' : '0-1');
  const g = {
    url: 'practice:' + Date.now(), pgn: ch.pgn(), end: Math.floor(Date.now() / 1000), tc: 'practice', color: pl.color === 'w' ? 'white' : 'black',
    res: r.res, how: r.how, eco: '', tcontrol: '', rating: '', oppName: levelName(pl.elo), oppRating: pl.elo || '',
    variation: 'Practice game against Stockfish', family: 'Practice game',
  };
  openGame(g); tab('review');
}

/* the game in progress survives a page reload */
function saveGame() {
  if (!pl.ch || pl.phase === 'over') return;
  kv.set('play:current', { startFen: pl.startFen, color: pl.color, elo: pl.elo, coach: pl.coach, log: pl.log, counts: pl.counts, tc: pl.tc, clock: { ...pl.clock } });
}
function restoreGame() {
  const g = kv.get('play:current'); if (!g) return;
  const ch = new Chess(g.startFen);
  for (const e of g.log) { if (!ch.move({ from: e.uci.slice(0, 2), to: e.uci.slice(2, 4), promotion: e.uci[4] || undefined })) return; }
  Object.assign(pl, { ch, startFen: g.startFen, color: g.color, elo: g.elo, coach: g.coach, log: g.log, counts: g.counts, tc: g.tc || null, clock: g.clock || { w: 0, b: 0 }, msg: 'Picked up your game where you left it.' });
  $('#pLevel').value = String(g.elo); $('#pCoach').value = String(g.coach);
  next();
}

/* ---------- drawing ---------- */
function playMarks(fen) {
  if (!state.threats) return null;
  const marks = {}; loosePieces(fen).forEach((x) => { marks[x.sq] = x.color === pl.color ? 'risk' : 'loose'; }); return marks;
}
function drawPlay() {
  $('#pStart').textContent = pl.armed ? 'Click again to abandon this game' : 'Start a new game';
  if (!pl.board) return;
  const ch = pl.ch; const card = $('#pCard');
  if (!ch) {
    pl.board.set({ fen: START_FEN, flip: pl.side === 'b' });
    $('#pTop').innerHTML = $('#pBot').innerHTML = ''; $('#pMoves').innerHTML = '';
    card.innerHTML = `<h2>How it works</h2><p>You play Stockfish at the strength you pick. After each of your moves, a full-strength engine checks it.</p>
      <p>If the move is a mistake, the game pauses. You see what it allows and can <b>take it back and try again</b>, <b>see the better move</b>, or <b>keep it</b> and play on.</p>
      <p class="muted" style="margin:0">Choose a side, the opponent's strength and how strict the coach should be, then start. You can also press Play from here in Game review to play on from any position.</p>`;
    return;
  }
  const flip = pl.color === 'b'; const lastE = pl.log[pl.log.length - 1];
  const view = { fen: ch.fen(), flip, last: lastE ? { from: lastE.from, to: lastE.to } : null, movable: null, onMove: onPlayMove, arrows: [], marks: null };
  if (pl.phase === 'you') {
    view.movable = pl.color;
    if (pl.hint && pl.preVal && pl.preVal.best) {
      if (pl.hint === 1) view.marks = { [pl.preVal.best.slice(0, 2)]: 'hint' };
      else view.arrows = [uciArrow(pl.preVal.best, ARROW.best)];
    }
  } else if (pl.phase === 'flagged') {
    const f = pl.flag;
    if (f.better) Object.assign(view, { fen: f.before, last: view.last, arrows: [uciArrow(f.entry.uci, ARROW.ref, 0.55, 0.12), uciArrow(f.pre.best, ARROW.best)] });
    else { view.last = { from: f.entry.from, to: f.entry.to }; view.arrows = [uciArrow(f.post.best, ARROW.ref)]; }
  }
  if (!view.marks) view.marks = playMarks(view.fen);
  pl.board.set(view);

  // player bars with captured material
  const cb = capturedBy(view.fen); const opp = levelName(pl.elo);
  const bar = (c) => {
    const name = c === pl.color ? (state.user || 'You') : opp; const cap = c === 'w' ? cb.byWhite : cb.byBlack; const adv = c === 'w' ? cb.diff : -cb.diff;
    const thinking = pl.phase === 'thinking' && c !== pl.color ? '<span class="muted" style="margin:0"><span class="spin" aria-hidden="true"></span>thinking</span>' : '';
    const clk = pl.tc ? `<span class="clock" data-side="${c}">${fmtMs(clockLeft(c))}</span>` : '';
    return `<span class="nm">${esc(name)}</span><span class="cap">${cap.map((k) => G[k]).join('')}<b>${adv > 0 ? ' +' + adv : ''}</b></span>${thinking}${clk}`;
  };
  $('#pTop').innerHTML = bar(flip ? 'w' : 'b'); $('#pBot').innerHTML = bar(flip ? 'b' : 'w');

  // moves, with a badge on each of yours
  const p = pl.startFen.split(' '); let n = +p[5] || 1; let w = p[1] === 'w'; let h = '';
  pl.log.forEach((e, i) => {
    if (w) h += `<span class="n">${n}.</span>`; else if (i === 0) h += `<span class="n">${n}.</span><span></span>`;
    const badge = e.mine && e.t ? `<span class="bg k-${e.t}" title="${esc(e.label)}${e.kept ? ', kept after a warning' : ''}${e.helped ? ', shown by the coach' : ''}">${e.sym || ''}</span>` : '';
    h += `<span class="mv${i === pl.log.length - 1 ? ' on' : ''}"><span>${esc(e.san)}${badge}</span></span>`;
    if (!w) n++; w = !w;
  });
  $('#pMoves').innerHTML = h || '<span class="muted" style="grid-column:1/-1;margin:0">No moves yet.</span>';
  const mv = $('#pMoves'); mv.scrollTop = mv.scrollHeight;

  card.innerHTML = cardHtml(); teachSync();
  if (pl.phase === 'you') { const inp = $('#pMove'); if (inp && document.activeElement && document.activeElement.id === 'pMove') inp.focus(); }
}
function cardHtml() {
  const c = pl.counts; const mine = pl.log.filter((e) => e.mine && e.t);
  const acc = mine.length ? Math.round(mine.reduce((a, e) => a + moveAcc(e.drop), 0) / mine.length) : null;
  const head = `<div class="exHead"><span class="modeTag">Play</span><b>You are ${sideName(pl.color)} against ${esc(levelName(pl.elo))}</b></div>`;
  if (pl.phase === 'error') return `${head}<p>${esc(pl.msg)}</p><div class="acts"><button data-act="retryEngine" class="primary">Try again</button></div>`;
  if (pl.phase === 'over') {
    const r = pl.result; const verdict = r.res === 'W' ? 'You won' : r.res === 'L' ? 'You lost' : 'Draw';
    const tiles = [[acc != null ? acc + '%' : '-', 'your accuracy'], [c.flagged, 'times the coach stopped you'], [c.corrected, 'fixed on your own'], [c.kept, 'mistakes you kept']];
    return `${head}<p class="big verdict"><span class="badge fin-${r.res}">${verdict}</span><span>by ${esc(r.how.toLowerCase())}.</span></p>
      <div class="tiles small">${tiles.map(([b, t]) => `<div class="tile"><b>${b}</b><span>${t}</span></div>`).join('')}</div>
      ${c.helped || c.hints ? `<p class="muted">You asked for ${c.hints} hint${c.hints === 1 ? '' : 's'} and played the coach's move ${c.helped} time${c.helped === 1 ? '' : 's'}.</p>` : ''}
      <div class="acts"><button data-act="review" class="primary">Review this game</button><button data-act="again">Play again</button></div>`;
  }
  if (pl.phase === 'checking') return `${head}<p><span class="spin" aria-hidden="true"></span>Checking your move...</p>`;
  if (pl.phase === 'thinking') return `${head}<p class="muted">${esc(pl.msg)}</p><p><span class="spin" aria-hidden="true"></span>Stockfish is thinking...</p>`;
  if (pl.phase === 'flagged') {
    const f = pl.flag; const e = f.entry;
    const type = f.ex && MTYPES[f.ex.type] ? `<span class="badge type">${MTYPES[f.ex.type].label}</span>` : '';
    if (!f.better) {
      return `${head}<div class="badges"><span class="badge k-${e.t}">${e.label}</span>${type}</div>
        <p class="big">Wait: ${esc(e.san)} is a ${e.label.toLowerCase()}.</p><p class="why">${esc(hintText(f))}</p>
        <div class="acts"><button data-act="retry" class="primary">Take it back and try again</button><button data-act="better">Show the better move</button><button data-act="keep">Keep my move</button>${teachBtnHtml('play')}</div>`;
    }
    const tip = f.ex && MTYPES[f.ex.type] ? `<p class="muted">${esc(MTYPES[f.ex.type].tip)}</p>` : '';
    return `${head}<div class="badges"><span class="badge k-${e.t}">${e.label}</span>${type}</div>
      <p class="big">Better was ${esc(f.ex && f.ex.bestSan ? f.ex.bestSan : f.pre.best)} (green arrow).</p>
      ${f.ex ? `<p class="why">${esc(f.ex.text)}</p>${f.ex.bestLine ? `<p><b>Best line:</b> ${esc(f.ex.bestLine)}</p>` : ''}` : ''}${tip}
      <div class="acts"><button data-act="playBetter" class="primary">Play the better move</button><button data-act="retry">Try again myself</button><button data-act="keep">Keep my move</button>${teachBtnHtml('play')}</div>`;
  }
  // your turn
  const hintBtn = pl.hint >= 2 ? '' : `<button data-act="hint">${pl.hint ? 'Show the move' : 'Hint'}</button>`;
  const hintMsg = pl.hint && !pl.preVal ? '<p class="muted"><span class="spin" aria-hidden="true"></span>Working out a hint...</p>' : pl.hint === 1 ? '<p class="muted">The highlighted piece is the one to move.</p>' : '';
  return `${head}${pl.msg ? `<p class="muted">${esc(pl.msg)}</p>` : ''}
    <p class="big">${pl.retry ? 'Find a better move.' : 'Your move.'}</p>${hintMsg}
    ${moveFormHtml('pMove')}${pl.typedErr ? `<p class="muted small">${esc(pl.typedErr)}</p>` : ''}
    <div class="acts">${hintBtn}<button data-act="undo"${pl.log.some((e) => e.mine) ? '' : ' disabled'}>Take back</button><button data-act="resign">Resign</button></div>`;
}

$('#pCard').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act;
  if (act === 'retry' && pl.phase === 'flagged') takeBackFlagged();
  else if (act === 'better' && pl.phase === 'flagged') { pl.flag.better = true; drawPlay(); announce(`Better was ${pl.flag.ex && pl.flag.ex.bestSan ? pl.flag.ex.bestSan : pl.flag.pre.best}.`); }
  else if (act === 'playBetter' && pl.phase === 'flagged') playBetter();
  else if (act === 'keep' && pl.phase === 'flagged') keepMove();
  else if (act === 'hint' && pl.phase === 'you') { pl.hint++; if (pl.hint === 1) pl.counts.hints++; drawPlay(); }
  else if (act === 'undo') takeBackTurn();
  else if (act === 'resign' && pl.phase === 'you') finish('resign');
  else if (act === 'review') reviewPlayed();
  else if (act === 'again') startPlay({});
  else if (act === 'retryEngine') next();
});
$('#pCard').addEventListener('submit', (e) => {
  e.preventDefault(); if (pl.phase !== 'you') return;
  const input = $('#pMove'); const mv = parseTypedMove(pl.ch.fen(), input && input.value);
  if (!mv) { pl.typedErr = badMoveText(input ? input.value : ''); drawPlay(); const a = $('#pMove'); if (a) a.focus(); return; }
  pl.typedErr = null; onPlayMove(mv);
});

/* ---------- optional clock ---------- */
/* Clocks are in milliseconds. Only one side runs at a time; it is paused while the coach
   checks or explains your move, and when the Play tab or the browser tab is not visible. */
const clockLeft = (side) => Math.max(0, pl.clock[side] - (pl.run === side ? performance.now() - pl.since : 0));
function fmtMs(ms) {
  const s = ms / 1000;
  if (s < 10) return `0:0${s.toFixed(1)}`;
  const m = Math.floor(s / 60), r = Math.floor(s % 60); return `${m}:${String(r).padStart(2, '0')}`;
}
const playVisible = () => !$('#play').hidden && document.visibilityState === 'visible';
function startClock(side) {
  if (!pl.tc || pl.phase === 'over') return;
  stopClock();
  if (!playVisible()) return; // resumes when you come back (see resumeClock)
  pl.run = side; pl.since = performance.now();
  if (!pl.ticker) pl.ticker = setInterval(tickClock, 100);
}
function stopClock() {
  if (pl.run) { pl.clock[pl.run] = clockLeft(pl.run); pl.run = null; }
  if (pl.ticker) { clearInterval(pl.ticker); pl.ticker = null; }
}
function addInc(side) { if (pl.tc && pl.tc.inc) pl.clock[side] += pl.tc.inc * 1000; }
function resumeClock() {
  if (!pl.tc || pl.run || !pl.ch) return;
  if (pl.phase === 'you') startClock(pl.color);
  else if (pl.phase === 'thinking') startClock(pl.color === 'w' ? 'b' : 'w');
}
function tickClock() {
  if (!pl.run) return;
  const side = pl.run; const left = clockLeft(side);
  document.querySelectorAll('#play .clock[data-side]').forEach((el) => {
    const v = clockLeft(el.dataset.side); el.textContent = fmtMs(v); el.classList.toggle('low', v < 20000);
  });
  if (left <= 0) { pl.clock[side] = 0; finish('time', side); }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resumeClock(); else stopClock(); });
