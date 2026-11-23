/* Explore mode: move pieces for either side from any position while Stockfish shows its
   three best lines. Guess the move: step through your own game and guess each of your
   moves before it is shown, then compare your guess with the engine and with the game. */

/* ---------- modes ---------- */
function updateModeButtons() {
  $('#bExplore').textContent = state.mode === 'explore' ? 'Back to game' : 'Explore this position';
  $('#bGuess').textContent = state.mode === 'guess' ? 'Stop guessing' : 'Guess the move';
  $('#bExplore').disabled = state.mode === 'guess';
}
/* back to plain game review without redrawing (used by openGame and go) */
function resetMode() {
  if (state.mode === 'explore') liveStop();
  clearTimeout(gs.timer); gs.waiting = false; gs.show = null; gs.done = false;
  state.mode = 'game'; state.ex = null;
  $('#modePanel').hidden = true; $('#modePanel').innerHTML = ''; $('#coach').hidden = false;
  $('.graphPanel').classList.remove('dim');
}
function leaveMode() { resetMode(); if (state.sel) renderGame(); }
$('#bExplore').addEventListener('click', () => {
  const s = state.sel; if (!s) return;
  if (state.mode === 'explore') return leaveMode();
  stopPlay();
  startExplore(s.fens[state.ply], [], 0, s.moves[state.ply - 1], 'From the game position');
});
$('#bGuess').addEventListener('click', () => { if (state.mode === 'guess') leaveMode(); else startGuess(); });

/* ---------- explore ---------- */
function startExplore(root, line, cur, rootLast, title) {
  if (!state.sel) return;
  resetMode(); stopPlay();
  const steps = playLine(root, line || [], 12);
  state.ex = {
    root, rootLast: rootLast ? { from: rootLast.from, to: rootLast.to } : null, title,
    moves: steps.map((x) => ({ uci: x.uci, san: x.mv.san, fen: x.fen, from: x.mv.from, to: x.mv.to })),
    cur: Math.min(cur || 0, steps.length), lines: null, linesFen: null, depth: 0, err: null,
  };
  state.mode = 'explore'; renderGame();
}
const exFen = () => { const ex = state.ex; return ex.cur ? ex.moves[ex.cur - 1].fen : ex.root; };
function exGo(n) { const ex = state.ex; ex.cur = Math.max(0, Math.min(ex.moves.length, n)); renderGame(); }
function exMove(mv) {
  const ex = state.ex; if (!ex) return;
  const ch = new Chess(exFen()); const r = ch.move(mv); if (!r) return;
  const uci = r.from + r.to + (r.promotion || '');
  if (ex.moves[ex.cur] && ex.moves[ex.cur].uci === uci) ex.cur++;
  else { ex.moves = ex.moves.slice(0, ex.cur); ex.moves.push({ uci, san: r.san, fen: ch.fen(), from: r.from, to: r.to }); ex.cur++; }
  renderGame();
}
function exView() {
  const ex = state.ex; const fen = exFen();
  const last = ex.cur ? ex.moves[ex.cur - 1] : ex.rootLast;
  const lines = ex.linesFen === fen ? ex.lines : null;
  const arrows = (lines || []).slice(0, 2).map((l, k) => uciArrow(l.pv[0], k ? ARROW.eng2 : ARROW.eng1, k ? 0.55 : 0.85, k ? 0.12 : 0.16));
  return { fen, flip: state.flip, last, arrows, marks: threatMarks(fen), movable: 'turn', onMove: exMove };
}
function renderExplore() {
  const ex = state.ex; const v = exView();
  board.set(v);
  renderBars(v.fen); renderMoves(); renderThreatNote(v.fen, v.last);
  $('#coach').hidden = true; $('#modePanel').hidden = false; $('.graphPanel').classList.add('dim');
  const lines = ex.linesFen === v.fen ? ex.lines : null;
  setEvalBar(lines && lines[0] ? lines[0].cp : null);
  drawExplorePanel();
  if (ex.linesFen !== v.fen) {
    ex.linesFen = v.fen; ex.lines = null; ex.depth = 0; ex.err = null;
    const fen = v.fen; let pending = false;
    liveAnalyze(fen, (ls, d, done, err) => {
      if (!state.ex || state.ex.linesFen !== fen) return;
      state.ex.lines = ls || []; state.ex.depth = d; state.ex.err = err ? err.message : null; state.ex.done = done;
      if (pending) return; pending = true;
      setTimeout(() => { // redraw at most every 150 ms while the search deepens
        pending = false;
        if (state.mode !== 'explore' || !state.ex || state.ex.linesFen !== fen) return;
        const nv = exView(); board.set(nv);
        setEvalBar(state.ex.lines[0] ? state.ex.lines[0].cp : null); drawExplorePanel(false);
      }, 150);
    });
  }
}
/* full: redraw everything; otherwise only the engine lines, so typing in the move box is not interrupted */
function drawExplorePanel(full = true) {
  const ex = state.ex; const fen = exFen();
  const lines = ex.linesFen === fen ? ex.lines : null;
  const p = ex.root.split(' '); let n = +p[5] || 1; let w = p[1] === 'w';
  const moves = ex.moves.map((m, i) => {
    const pre = w ? `${n}.` : (i === 0 ? `${n}...` : ''); if (!w) n++; w = !w;
    return `<button class="xm${ex.cur === i + 1 ? ' on' : ''}" data-x="${i + 1}">${pre}${esc(m.san)}</button>`;
  }).join('');
  const turn = fen.split(' ')[1] === 'w' ? 'White' : 'Black';
  let eng;
  if (ex.err) eng = `<p class="muted">${esc(ex.err)}</p>`;
  else if (!lines) eng = '<p class="muted"><span class="spin" aria-hidden="true"></span>Starting Stockfish...</p>';
  else if (!lines.length) eng = `<p class="muted">${new Chess(fen).in_checkmate() ? 'Checkmate.' : 'Game over.'}</p>`;
  else {
    eng = lines.map((l) => {
      const st = playLine(fen, l.pv, 10);
      return `<button class="engLine" data-uci="${esc(l.pv[0])}"><b>${evText(l.cp)}</b><span>${esc(lineText(fen, st))}</span></button>`;
    }).join('') + `<p class="muted small">Depth ${ex.depth}${ex.done ? '' : '...'} · Click a line to play its first move. Blue arrows show the top two moves.</p>`;
  }
  const engEl = $('#modePanel .engLines');
  if (!full && engEl) { engEl.innerHTML = eng; return; }
  $('#modePanel').innerHTML = `
    <div class="exHead"><span class="modeTag">Explore</span><b>${esc(ex.title || 'Explore')}</b><span class="muted">Move pieces for either side. This does not change the game.</span><button data-act="exit">Back to game</button></div>
    <div class="exLine"><button class="xm${ex.cur === 0 ? ' on' : ''}" data-x="0">Start</button>${moves || '<span class="muted">Make a move on the board.</span>'}</div>
    <p class="muted small" style="margin:.2rem 0 .3rem">${turn} to move. Use the arrow keys or the buttons above to step through the line.</p>
    ${moveFormHtml('xMove')}${ex.typedErr ? `<p class="muted small">${esc(ex.typedErr)}</p>` : ''}
    <div class="engLines">${eng}</div>`;
}
$('#modePanel').addEventListener('click', (e) => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.dataset.act === 'exit' || t.dataset.act === 'gstop' || t.dataset.act === 'gdone') return leaveMode();
  if (state.mode === 'explore') {
    if (t.dataset.x != null) return exGo(+t.dataset.x);
    if (t.dataset.uci) { const u = t.dataset.uci; return exMove({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); }
  }
  if (state.mode === 'guess') {
    if (t.dataset.act === 'gnext') { gs.show = null; state.ply++; return advanceGuess(); }
    if (t.dataset.act === 'gskip') { gs.waiting = false; gs.res.push({ skipped: true }); state.ply++; return advanceGuess(); }
    if (t.dataset.act === 'gagain') { state.ply = 0; return startGuess(); }
  }
});

$('#modePanel').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = e.target.querySelector('input'); if (!input) return;
  if (state.mode === 'explore' && state.ex) {
    const mv = parseTypedMove(exFen(), input.value);
    if (!mv) { state.ex.typedErr = badMoveText(input.value); drawExplorePanel(); return; }
    state.ex.typedErr = null; exMove(mv);
    const next = document.getElementById('xMove'); if (next) next.focus();
  } else if (state.mode === 'guess' && gs.waiting) {
    const mv = parseTypedMove(state.sel.fens[state.ply], input.value);
    if (!mv) { gs.msg = badMoveText(input.value); drawGuessPanel(); return; }
    onGuessMove(mv);
  }
});

/* ---------- guess the move ---------- */
const gs = { waiting: false, timer: null, res: [], show: null, done: false, checking: false, msg: '' };
function startGuess() {
  const s = state.sel; if (!s) return;
  resetMode(); stopPlay();
  state.mode = 'guess'; gs.res = []; gs.show = null; gs.done = false;
  if (state.ply >= s.moves.length) state.ply = 0;
  $('#coach').hidden = true; $('#modePanel').hidden = false;
  advanceGuess();
}
/* plays your opponent's moves until it is your turn */
function advanceGuess() {
  clearTimeout(gs.timer);
  const s = state.sel; if (state.mode !== 'guess' || !s) return;
  gs.show = null; gs.waiting = false; gs.checking = false;
  if (state.ply >= s.moves.length) { gs.done = true; renderGame(); return drawGuessPanel(); }
  if (s.moves[state.ply].color !== s.g.color[0]) {
    gs.msg = 'Your opponent is moving...'; renderGame(); drawGuessPanel();
    gs.timer = setTimeout(() => { if (state.mode !== 'guess') return; state.ply++; advanceGuess(); }, 450);
    return;
  }
  gs.waiting = true; gs.msg = ''; renderGame(); drawGuessPanel();
}
function guessView() {
  const o = { movable: gs.waiting ? state.sel.g.color[0] : null, onMove: onGuessMove };
  if (gs.show) Object.assign(o, gs.show, { movable: null });
  return o;
}
async function onGuessMove(mv) {
  if (!gs.waiting) return;
  const s = state.sel; const i = state.ply; const fen = s.fens[i];
  const ch = new Chess(fen); const r = ch.move(mv); if (!r) return;
  gs.waiting = false; gs.checking = true;
  const uci = r.from + r.to + (r.promotion || ''); const played = s.moves[i]; const pUci = uciOf(played);
  gs.show = { fen: ch.fen(), last: { from: r.from, to: r.to }, arrows: [] }; gs.msg = 'Checking your move...';
  renderGame(); drawGuessPanel();
  const rv = state.review;
  let j;
  try { j = await judgeMove(fen, uci, { best: rv && rv.evals[i].best ? rv.evals[i].best : undefined, played: rv || uci === pUci ? null : pUci }); } catch (err) {
    if (state.mode !== 'guess' || state.ply !== i) return;
    gs.show = null; gs.waiting = true; gs.checking = false; gs.msg = err.message; renderGame(); return drawGuessPanel();
  }
  if (state.mode !== 'guess' || state.ply !== i) return;
  const guessDrop = uci === j.best ? 0 : j.guessDrop; const gq = clsOf(guessDrop);
  /* "Best" only for the engine's own move; a move almost as good is "Excellent" */
  const named = (t, label, u) => (t === 'best' && u !== j.best ? 'Excellent' : label);
  let pDrop, pT, pLabel;
  if (uci === pUci) { pDrop = guessDrop; [, pT, , pLabel] = gq; }
  else if (rv) { pDrop = rv.cls[i].drop; pT = rv.cls[i].t; pLabel = rv.cls[i].label; }
  else { pDrop = pUci === j.best ? 0 : j.playedDrop; const pq = clsOf(pDrop); pT = pq[1]; pLabel = pq[3]; }
  pLabel = named(pT, pLabel, pUci);
  const bestStep = playLine(fen, [j.best], 1)[0];
  const label = named(gq[1], gq[3], uci); const bestSan = bestStep ? bestStep.mv.san : j.best;
  gs.res.push({ i, san: r.san, uci, drop: guessDrop, t: gq[1], label, pSan: played.san, pUci, pDrop, pT, pLabel, best: j.best, bestSan });
  announce(`${label}. You chose ${r.san}. ${uci === j.best ? "That is the engine's top move." : `The engine's choice was ${bestSan}.`} In the game you played ${played.san}.`);
  gs.checking = false;
  gs.show = { fen, last: s.moves[i - 1], arrows: [uciArrow(pUci, ARROW.game, 0.7, 0.12), uci !== j.best ? uciArrow(uci, ARROW.guess, 0.8, 0.14) : null, uciArrow(j.best, ARROW.best)] };
  renderGame(); drawGuessPanel();
}
function drawGuessPanel() {
  const s = state.sel; const me = s.g.color === 'white' ? 'White' : 'Black';
  const done = gs.res.filter((x) => !x.skipped);
  const head = `<div class="exHead"><span class="modeTag guess">Guess</span><b>Guess the move</b><span class="muted">${done.length} guess${done.length === 1 ? '' : 'es'} so far</span><button data-act="gstop">Stop</button></div>`;
  let body;
  if (gs.done) {
    const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);
    const yours = avg(done.map((x) => moveAcc(x.drop))), game = avg(done.map((x) => moveAcc(x.pDrop)));
    const count = (k) => done.filter((x) => x.t === k).length;
    const same = done.filter((x) => x.uci === x.pUci).length; const top = done.filter((x) => x.uci === x.best).length;
    body = done.length ? `<p>Your guesses: <b>${yours}% accuracy</b>. Your moves in the game: <b>${game}%</b>.</p>
      <p class="muted" style="margin:0">${top} of ${done.length} guesses were the engine's top move, and ${same} matched what you played. Best ${count('best')}, good ${count('good')}, inaccuracies ${count('inacc')}, mistakes ${count('mist')}, blunders ${count('blun')}.</p>
      <div class="acts"><button data-act="gagain">Start again</button><button data-act="gdone" class="primary">Done</button></div>`
      : '<p>No guesses this time.</p><div class="acts"><button data-act="gdone" class="primary">Done</button></div>';
  } else if (gs.waiting) {
    body = `<p><b>Your move as ${me}.</b> What would you play? Drag or click a piece.</p>${gs.msg ? `<p class="muted">${esc(gs.msg)}</p>` : ''}${moveFormHtml('gMove')}<div class="acts"><button data-act="gskip">Skip and show the game move</button></div>`;
  } else if (gs.checking || !gs.res.length || gs.res[gs.res.length - 1].i !== state.ply) {
    body = `<p class="muted">${gs.checking ? '<span class="spin" aria-hidden="true"></span>' : ''}${esc(gs.msg || '')}</p>`;
  } else {
    const x = gs.res[gs.res.length - 1];
    const verdict = x.uci === x.best ? "That is the engine's top move." : `The engine's choice was <b>${esc(x.bestSan)}</b> (green arrow).`;
    const game = x.uci === x.pUci ? 'That is also what you played in the game.' : `In the game you played <b>${esc(x.pSan)}</b> <span class="badge k-${x.pT}">${x.pLabel}</span> (grey arrow).`;
    body = `<p class="verdict"><span class="badge k-${x.t}">${x.label}</span><span>You chose <b>${esc(x.san)}</b>${x.uci !== x.best ? ' (purple arrow)' : ''}. ${verdict}</span></p><p>${game}</p>
      <div class="acts"><button data-act="gnext" class="primary">Continue</button></div>`;
  }
  $('#modePanel').innerHTML = head + body;
}
