/* Train tab: every mistake and blunder from your analyzed games becomes a puzzle. You get
   the position before your move and look for a better one. Puzzles you solve come back
   later and later; ones you miss come back tomorrow (see srsRecord in learn.js). */

const tr = { board: null, all: [], queue: [], cur: null, phase: 'ask', hint: false, recorded: false, filter: 'due', type: 'all', session: { ok: 0, n: 0 }, msg: '', view: null };

/* puzzles for the current user's analyzed games; built once per game and stored */
function allPuzzles() {
  const out = [];
  for (const g of state.games) {
    if (!kv.has('an2:' + g.url)) continue;
    let pz = kv.get('pz:' + g.url);
    if (!pz || pz.v !== PZ_VERSION) {
      const r = reviewFor(g); if (!r) continue;
      pz = { v: PZ_VERSION, list: puzzlesFrom(g, r.s, r.rv) }; kv.set('pz:' + g.url, pz);
    }
    out.push(...pz.list);
  }
  return out;
}
const isDue = (p, now) => { const x = srsOf(p.id); return !x || x.due <= now; };
function buildQueue() {
  const now = Date.now();
  let list = tr.all.filter((p) => tr.type === 'all' || p.type === tr.type);
  if (tr.filter === 'blun') list = list.filter((p) => p.t === 'blun');
  if (tr.filter === 'due') list = list.filter((p) => isDue(p, now));
  const box = (p) => { const x = srsOf(p.id); return x ? x.box : -1; };
  list.sort((a, b) => {
    const x = srsOf(a.id), y = srsOf(b.id);
    if (tr.filter !== 'due' && box(a) !== box(b)) return box(a) - box(b);
    if (!!x !== !!y) return x ? -1 : 1; // reviews before new puzzles
    if (x && y) return x.due - y.due;
    return b.end - a.end || a.i - b.i; // newest mistakes first
  });
  tr.queue = list;
}
function openTrain() {
  if (!tr.board) tr.board = makeBoard($('#tBox'));
  tr.all = allPuzzles(); buildQueue();
  if (!tr.cur || !tr.all.some((p) => p.id === tr.cur.id)) nextPuzzle(); else drawTrain();
}
function nextPuzzle() {
  tr.queue = tr.queue.filter((p) => !tr.cur || p.id !== tr.cur.id);
  tr.cur = tr.queue.shift() || null; tr.phase = 'ask'; tr.hint = false; tr.recorded = false; tr.msg = ''; tr.view = null;
  drawTrain();
}
function record(outcome) {
  if (tr.recorded || !tr.cur) return; tr.recorded = true;
  srsRecord(tr.cur.id, outcome); tr.session.n++; if (outcome !== 'fail') tr.session.ok++;
}

async function onTrainMove(mv) {
  const p = tr.cur; if (!p || tr.phase !== 'ask') return;
  const ch = new Chess(p.fen); const r = ch.move(mv); if (!r) return;
  const uci = r.from + r.to + (r.promotion || '');
  tr.phase = 'checking'; tr.msg = ''; tr.view = { fen: ch.fen(), last: { from: r.from, to: r.to } }; drawTrain();
  if (uci === p.best) return solved(r.san, 0);
  if (uci === p.playedUci) return wrong(r, 'That is the move you played in the game.');
  let j = null;
  try { j = await judgeMove(p.fen, uci, { best: p.best }); } catch (_) { /* engine unavailable: only the exact move counts */ }
  if (tr.cur !== p || tr.phase !== 'checking') return;
  if (j && j.guessDrop <= 5) return solved(r.san, j.guessDrop);
  const reply = j && j.guess.pv && j.guess.pv[1] ? playLine(ch.fen(), [j.guess.pv[1]], 1)[0] : null;
  wrong(r, j ? `It costs about ${Math.round(j.guessDrop)}% of your winning chances${reply ? `, for example after ${reply.mv.san}` : ''}.` : 'That is not the engine\'s move.');
}
function solved(san, drop) {
  record(tr.hint ? 'hint' : 'ok');
  tr.phase = 'solved'; tr.msg = drop > 0 ? `${san} works too: it is about as good as the engine's ${tr.cur.bestSan}.` : `${san} is the engine's move.`;
  tr.view = null; drawTrain(); announce('Solved. ' + tr.msg);
}
function wrong(r, why) {
  record('fail');
  tr.phase = 'wrong'; tr.msg = `${r.san} is not it. ${why} Try again.`; tr.view = { ...tr.view, marks: { [r.to]: 'bad' } };
  drawTrain(); announce(tr.msg);
  const p = tr.cur;
  setTimeout(() => { if (tr.cur === p && tr.phase === 'wrong') { tr.phase = 'ask'; tr.view = null; drawTrain(); } }, 900);
}

function trainStats() {
  const now = Date.now(); const st = tr.all.map((p) => srsOf(p.id)).filter(Boolean);
  const due = tr.all.filter((p) => isDue(p, now)).length;
  const n = st.reduce((a, x) => a + x.n, 0), ok = st.reduce((a, x) => a + x.ok, 0);
  const tiles = [[due, 'due now'], [tr.all.length, 'puzzles in total'], [st.filter((x) => x.box >= 4).length, 'mastered'], [n ? pct(ok, n) + '%' : '-', 'success rate']];
  return `<div class="tiles small">${tiles.map(([b, t]) => `<div class="tile"><b>${b}</b><span>${t}</span></div>`).join('')}</div>
    ${tr.session.n ? `<p class="muted" style="margin:0 0 .6rem">This session: ${tr.session.ok} of ${tr.session.n} solved.</p>` : ''}`;
}
function drawTrain() {
  $('#tStats').innerHTML = trainStats();
  const p = tr.cur; const card = $('#tCard');
  if (!tr.all.length) {
    tr.board.set({ fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' });
    $('#tMeta').innerHTML = '';
    card.innerHTML = `<h2>No puzzles yet</h2><p>Every mistake and blunder you make becomes a puzzle here once the game is analyzed.</p>
      <p class="muted" style="margin:0">Go to Openings and stats and press Analyze recent games, or analyze a single game in Game review.</p>`;
    return;
  }
  if (!p) {
    tr.board.set({ fen: '8/8/8/8/8/8/8/8 w - - 0 1' });
    $('#tMeta').innerHTML = '';
    card.innerHTML = tr.filter === 'due'
      ? `<h2>All done for now</h2><p>No puzzles are due. Come back tomorrow, or practise anyway.</p><div class="acts"><button data-act="all" class="primary">Practise all puzzles</button></div>`
      : '<h2>Nothing matches</h2><p>No puzzles match this filter. Pick another mistake type.</p>';
    return;
  }
  const side = p.color === 'w' ? 'White' : 'Black';
  const ask = tr.phase === 'ask';
  const showBest = tr.phase === 'solved' || tr.phase === 'shown';
  const view = { fen: p.fen, flip: p.color === 'b', last: p.last, movable: ask ? p.color : null, onMove: onTrainMove, arrows: [], marks: null };
  if (tr.hint && ask) view.marks = { [p.best.slice(0, 2)]: 'hint' };
  if (showBest) view.arrows = [uciArrow(p.playedUci, ARROW.ref, 0.55, 0.12), uciArrow(p.best, ARROW.best)];
  if (tr.view) Object.assign(view, tr.view, { movable: null });
  tr.board.set(view);
  const st = srsOf(p.id);
  const seen = !st ? 'new puzzle' : st.box >= 4 ? 'mastered' : `practised ${st.n} time${st.n === 1 ? '' : 's'}`;
  $('#tMeta').innerHTML = `<b>${esc(p.opening)}</b><span class="muted" style="margin:0">Move ${p.moveNo} vs ${esc(p.opp)} · ${new Date(p.end * 1000).toLocaleDateString()} · ${seen}</span>`;
  const badge = `<span class="badge k-${p.t}">${p.label} in the game</span> <span class="badge type">${MTYPES[p.type] ? MTYPES[p.type].label : ''}</span>`;
  let body;
  if (ask || tr.phase === 'checking' || tr.phase === 'wrong') {
    body = `<p class="big">${side} to move. Find a better move than the one you played.</p>
      <p class="muted" style="margin:0 0 .6rem">In the game you played ${esc(p.played)} here.</p>
      ${tr.phase === 'checking' ? '<p><span class="spin" aria-hidden="true"></span>Checking your move...</p>'
        : tr.msg ? `<p class="verdict">${tr.phase === 'wrong' ? '<span class="badge k-blun">Not it</span>' : ''}<span>${esc(tr.msg)}</span></p>` : ''}
      ${moveFormHtml('tMove', !ask)}
      <div class="acts"><button data-act="hint"${tr.hint || !ask ? ' disabled' : ''}>Hint</button><button data-act="show"${ask ? '' : ' disabled'}>Show the answer</button><button data-act="skip">Skip</button></div>`;
  } else {
    const head = tr.phase === 'solved'
      ? `<p class="big verdict"><span class="badge k-best">Solved</span><span>${esc(tr.msg)}</span></p>`
      : `<p class="big verdict"><span class="badge tag">Answer</span><span>The best move was ${esc(p.bestSan)}.</span></p>`;
    body = `${head}<p><b>Best line:</b> ${esc(p.bestLine)}</p>
      <p><b>What went wrong in the game:</b> you played ${esc(p.played)} (red arrow). ${esc(p.text)}</p>
      <p class="muted">${MTYPES[p.type] ? esc(MTYPES[p.type].tip) : ''}</p>
      <div class="acts"><button data-act="next" class="primary">Next puzzle</button><button data-act="open">Open in game review</button></div>`;
  }
  card.innerHTML = `<div class="badges">${badge}</div>${body}`;
}

$('#tCard').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const p = tr.cur; const act = b.dataset.act;
  if (act === 'all') { tr.filter = 'all'; syncFilter(); buildQueue(); return nextPuzzle(); }
  if (!p) return;
  if (act === 'hint') { tr.hint = true; drawTrain(); }
  else if (act === 'show') { record('fail'); tr.phase = 'shown'; tr.view = null; drawTrain(); announce(`The best move was ${p.bestSan}.`); }
  else if (act === 'skip' || act === 'next') nextPuzzle();
  else if (act === 'open') {
    const g = state.games.find((x) => x.url === p.url); if (!g) return;
    tab('review'); openGame(g); go(p.i + 1); renderList();
  }
});
$('#tCard').addEventListener('submit', (e) => {
  e.preventDefault();
  const p = tr.cur; const input = $('#tMove'); if (!p || tr.phase !== 'ask' || !input) return;
  const mv = parseTypedMove(p.fen, input.value);
  if (!mv) { tr.msg = badMoveText(input.value); drawTrain(); const again = $('#tMove'); if (again) again.focus(); return; }
  onTrainMove(mv);
});
function syncFilter() { $('#tFilter').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === tr.filter)); }
$('#tFilter').addEventListener('click', (e) => {
  if (!e.target.dataset.v) return; tr.filter = e.target.dataset.v; syncFilter();
  buildQueue(); tr.cur = null; nextPuzzle();
});
$('#tType').innerHTML = '<option value="all">All mistake types</option>' + Object.entries(MTYPES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
$('#tType').addEventListener('change', () => { tr.type = $('#tType').value; buildQueue(); tr.cur = null; nextPuzzle(); });

boot();
