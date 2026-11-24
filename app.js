/* Chess Lab: imports games from chess.com's public API, shows opening and endgame stats,
   reviews games with Stockfish running in the browser and explains each mistake.
   No server is needed. Scripts load in this order:
   store.js, board.js, engine.js, learn.js, app.js, explore.js, train.js */

const API = 'https://api.chess.com/pub/player/';
const BATCH_DEPTH = 12;
const ARROW = { best: '#3d9f68', ref: '#d4483e', eng1: '#3454d1', eng2: '#7f93dd', guess: '#8a63d2', game: '#98a2b0' };
const state = {
  user: '', games: [], filter: { color: 'all', tc: 'all', group: 'family', opening: null, period: 'all' }, list: { sort: 'new', result: 'all', q: '', analyzed: false },
  sortKey: 'games', sortDir: -1, sel: null, ply: 0, flip: false, review: null, token: 0, side: 'moves', timer: null, busy: null,
  mode: 'game', ex: null, threats: !!prefs.get('threats'),
};
kv.onError = (msg) => setStatus(`Could not save to browser storage: ${msg}. New games and analyses may not be kept.`);

/* ---------- theme ---------- */
(function theme() {
  const t = prefs.get('theme'); if (t) document.documentElement.dataset.theme = t;
  $('#themeBtn').onclick = () => {
    const dark = getComputedStyle(document.documentElement).colorScheme === 'dark';
    const next = dark ? 'light' : 'dark'; document.documentElement.dataset.theme = next; prefs.set('theme', next);
    if (!$('#stats').hidden) renderStats(); drawEval();
  };
})();

/* ---------- loading ---------- */
function setStatus(t) { $('#status').textContent = t; }
async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(r.status === 404 ? 'user not found' : 'HTTP ' + r.status);
  return r.json();
}

async function importGames(user, months) {
  $('#loadBtn').disabled = true;
  try {
    await kv.ready;
    setStatus('Finding archives...');
    const { archives } = await getJSON(`${API}${user}/games/archives`);
    const list = months ? archives.slice(-months) : archives;
    const cached = kv.get('games:' + user);
    const have = new Map(((cached && cached.games) || []).map((g) => [g.url, g]));
    // months before the last two are final, so skip the ones we already hold
    const need = list.filter((u, i) => i >= list.length - 2 || !(cached && cached.months && cached.months.includes(u)));
    let done = 0;
    for (let i = 0; i < need.length; i += 4) {
      const batch = await Promise.all(need.slice(i, i + 4).map((u) => getJSON(u).catch(() => ({ games: [] }))));
      batch.forEach((b) => b.games.forEach((g) => { const x = normalize(g, user); if (x) have.set(x.url, x); }));
      done += batch.length; setStatus(`Imported ${done} of ${need.length} months (${have.size} games)`);
    }
    const games = [...have.values()].sort((a, b) => a.end - b.end);
    kv.set('games:' + user, { games, months: list }); kv.persist();
    prefs.set('user', user);
    if (state.user !== user) { state.sel = null; state.review = null; $('#gameMeta').innerHTML = '<span class="muted">Pick a game from the list.</span>'; }
    state.user = user; state.games = games;
    setStatus(`${games.length} games for ${user}`);
    show();
  } catch (err) {
    setStatus(`Could not import: ${err.message}. Check the username and your connection.`);
  }
  $('#loadBtn').disabled = false;
}
$('#loadForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const user = $('#user').value.trim().toLowerCase(); if (user) importGames(user, +$('#months').value);
});

const DRAWS = ['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient'];
const DRAWHOW = { agreed: 'Agreement', repetition: 'Repetition', stalemate: 'Stalemate', insufficient: 'Insufficient material', '50move': '50-move rule', timevsinsufficient: 'Timeout vs insufficient material' };
const HOW = { checkmated: 'Checkmate', resigned: 'Resignation', timeout: 'Timeout', abandoned: 'Abandoned', win: 'Win' };
function normalize(g, user) {
  if (!g.pgn || g.rules !== 'chess') return null;
  const me = g.white.username.toLowerCase() === user ? 'white' : 'black';
  const opp = me === 'white' ? 'black' : 'white';
  const r = g[me].result;
  const res = r === 'win' ? 'W' : DRAWS.includes(r) ? 'D' : 'L';
  const m = g.pgn.match(/\[ECOUrl "([^"]+)"\]/);
  const slug = m ? (m[1].split('/openings/')[1] || '') : '';
  const variation = slug.replace(/-\d+\..*$/, '').replace(/-/g, ' ').trim() || 'Unknown opening';
  const eco = (g.pgn.match(/\[ECO "([^"]+)"\]/) || [])[1] || '';
  const raw = res === 'W' ? g[opp].result : r;
  const how = res === 'D' ? (DRAWHOW[r] || 'Draw') : (HOW[raw] || 'Other');
  return {
    url: g.url, pgn: g.pgn, end: g.end_time, tc: g.time_class, color: me, res, how, eco,
    tcontrol: g.time_control, rating: g[me].rating, oppName: g[opp].username, oppRating: g[opp].rating,
    variation, family: family(variation), ...endgameInfo(g.pgn),
  };
}
function family(name) {
  const w = name.split(' ');
  const i = w.findIndex((x) => /^(Defense|Opening|Game|Gambit|Attack|System|Indian)$/.test(x));
  return w.slice(0, i >= 0 ? i + 1 : Math.min(3, w.length)).join(' ');
}

/* ---------- phases and endgames ---------- */
function material(fen) {
  const m = { w: { n: 0, b: 0, r: 0, q: 0, v: 0 }, b: { n: 0, b: 0, r: 0, q: 0, v: 0 } };
  for (const ch of fen.split(' ')[0]) {
    const l = ch.toLowerCase(); if (!/[nbrq]/.test(l)) continue;
    const s = m[ch === l ? 'b' : 'w']; s[l]++; s.v += VAL[l];
  }
  return m;
}
function isEndgame(fen) { const m = material(fen); return m.w.v <= 13 && m.b.v <= 13; }
function endType(fen) {
  const m = material(fen); const both = (k) => m.w[k] + m.b[k];
  if (both('q')) return 'Queen endgame';
  if (both('r') && (both('n') || both('b'))) return 'Rook and minor piece';
  if (both('r')) return 'Rook endgame';
  if (both('n') || both('b')) return 'Minor piece endgame';
  return 'Pawn endgame';
}
function endgameInfo(pgn) {
  try {
    const ch = new Chess(); if (!ch.load_pgn(pgn)) return { endgame: false };
    const mv = ch.history(); const rep = new Chess();
    for (let i = 0; i < mv.length; i++) {
      rep.move(mv[i]);
      if (i >= 20 && i % 2 === 1 && isEndgame(rep.fen())) return { endgame: true, endPly: i + 1, endKind: endType(rep.fen()) };
    }
  } catch (_) { /* ignore unparsable games */ }
  return { endgame: false };
}
function phaseOf(fens, i) { if (i < 20) return 'opening'; return isEndgame(fens[i]) ? 'endgame' : 'middlegame'; }

function show() {
  annotate(state.games);
  $('#empty').hidden = true; $('#tabs').hidden = false;
  const tcs = ['all', ...new Set(state.games.map((g) => g.tc))];
  $('#fTc').innerHTML = tcs.map((t, i) => `<button data-v="${t}" class="${i ? '' : 'on'}">${t === 'all' ? 'All time controls' : t[0].toUpperCase() + t.slice(1)}</button>`).join('');
  state.filter = { color: 'all', tc: 'all', group: 'family', opening: null, period: 'all' };
  ['#fColor', '#fPeriod', '#fGroup'].forEach((id) => $(id).querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', i === 0)));
  tab('stats'); renderList();
}
/* adds rating change (against your previous game in the same time control) and game length */
function annotate(gs) {
  const last = {};
  gs.forEach((g) => {
    g.delta = last[g.tc] != null ? g.rating - last[g.tc] : null; last[g.tc] = g.rating;
    if (g.moveCount == null) { const n = [...g.pgn.matchAll(/(\d+)\.\s/g)].map((m) => +m[1]); g.moveCount = n.length ? Math.max(...n) : 0; }
  });
}

/* ---------- tabs and filters ---------- */
function tab(name) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  if (name !== 'review' && state.mode !== 'game') leaveMode();
  if (name !== 'play') stopClock();
  liveStop();
  // stats needs imported games, and review needs them or an open game (a practice game counts)
  const empty = !state.games.length && (name === 'stats' || (name === 'review' && !state.sel));
  $('#empty').hidden = !empty;
  ['stats', 'review', 'train', 'play'].forEach((t) => { $('#' + t).hidden = t !== name || empty; });
  if (empty) return;
  if (name === 'stats') renderStats(); else if (name === 'review') drawEval(); else if (name === 'train') openTrain(); else openPlay();
}
$('#tabs').addEventListener('click', (e) => { if (e.target.dataset.tab) tab(e.target.dataset.tab); });
$('#empty').addEventListener('click', (e) => { if (e.target.closest('[data-goto="play"]')) tab('play'); });
function seg(id, key) {
  $(id).addEventListener('click', (e) => {
    if (!e.target.dataset.v) return;
    state.filter[key] = e.target.dataset.v; state.filter.opening = null;
    $(id).querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.target));
    renderStats(); renderList();
  });
}
seg('#fColor', 'color'); seg('#fTc', 'tc'); seg('#fGroup', 'group'); seg('#fPeriod', 'period');
function filtered() {
  const f = state.filter;
  const cutoff = f.period === 'all' ? 0 : Date.now() / 1000 - +f.period * 86400;
  return state.games.filter((g) => (f.color === 'all' || g.color === f.color) && (f.tc === 'all' || g.tc === f.tc) && g.end >= cutoff);
}

/* ---------- stats ---------- */
function wdl(gs) { return { w: gs.filter((g) => g.res === 'W').length, d: gs.filter((g) => g.res === 'D').length, l: gs.filter((g) => g.res === 'L').length }; }
function bar(s, n) { return `<div class="wdl" title="${s.w} won, ${s.d} drawn, ${s.l} lost"><i style="width:${pct(s.w, n)}%"></i><i style="width:${pct(s.d, n)}%"></i><i style="width:${pct(s.l, n)}%"></i></div>`; }
function rowBlock(label, x, extra) {
  const w = wdl(x);
  return `<div class="row${extra ? ' rowLink' : ''}" ${extra || ''}><div class="lab"><span>${esc(label)}</span><span class="muted">${x.length} games, ${pct(w.w, x.length)}% won</span></div>${bar(w, x.length)}</div>`;
}
function groupBy(gs, fn) { const m = new Map(); gs.forEach((g) => { const k = fn(g); if (!m.has(k)) m.set(k, []); m.get(k).push(g); }); return m; }

function renderStats() {
  const gs = filtered(); const s = wdl(gs);
  const score = gs.length ? Math.round(((s.w + s.d / 2) / gs.length) * 100) : 0;
  const last = gs.length ? gs[gs.length - 1].rating : '-';
  const peak = gs.length ? Math.max(...gs.map((g) => g.rating)) : '-';
  let best = 0, cur = 0; gs.forEach((g) => { cur = g.res === 'W' ? cur + 1 : 0; best = Math.max(best, cur); });
  const avgOpp = gs.length ? Math.round(gs.reduce((a, g) => a + g.oppRating, 0) / gs.length) : '-';
  $('#tiles').innerHTML = [[gs.length, 'games'], [pct(s.w, gs.length) + '%', 'win rate'], [score + '%', 'score (draw counts half)'],
    [last, 'latest rating'], [peak, 'peak rating'], [best, 'longest win streak'], [avgOpp, 'average opponent']]
    .map(([b, t]) => `<div class="tile"><b>${b}</b><span>${t}</span></div>`).join('');

  $('#colorSplit').innerHTML = ['white', 'black'].map((c) => rowBlock(c[0].toUpperCase() + c.slice(1), gs.filter((g) => g.color === c))).join('');

  const key = state.filter.group; const map = groupBy(gs, (g) => g[key]);
  const rows = [...map].map(([name, x]) => {
    const w = wdl(x);
    return { name, games: x.length, w: w.w, d: w.d, l: w.l, win: pct(w.w, x.length), score: pct(w.w + w.d / 2, x.length), asWhite: x.filter((g) => g.color === 'white').length };
  });
  const sorted = rows.slice().sort((a, b) => (state.sortKey === 'name' ? a.name.localeCompare(b.name) : a[state.sortKey] - b[state.sortKey]) * state.sortDir);
  const cols = [['name', 'Opening'], ['games', 'Games'], ['win', 'Win %'], ['score', 'Score %'], ['', 'Results'], ['asWhite', 'As white']];
  $('#openTable').innerHTML = `<thead><tr>${cols.map(([k, t]) => `<th data-k="${k}">${t}${k && k === state.sortKey ? (state.sortDir < 0 ? ' ▾' : ' ▴') : ''}</th>`).join('')}</tr></thead><tbody>${
    sorted.slice(0, 80).map((r) => `<tr class="click" data-name="${esc(r.name)}"><td class="name">${esc(r.name)}</td><td>${r.games}</td><td>${r.win}%</td><td>${r.score}%</td><td>${bar(r, r.games)}</td><td>${r.asWhite}</td></tr>`).join('')}</tbody>`;

  const eligible = rows.filter((r) => r.games >= 5).sort((a, b) => b.score - a.score);
  const pick = (r) => rowBlock(r.name, map.get(r.name), `data-name="${esc(r.name)}"`);
  $('#bestWorst').innerHTML = eligible.length >= 2
    ? `<p class="muted" style="margin:0 0 .6rem">Openings with at least 5 games, by score</p>${eligible.slice(0, 3).map(pick).join('')}<hr style="border:0;border-top:1px solid var(--line);margin:.8rem 0">${eligible.slice(-3).reverse().map(pick).join('')}`
    : '<p class="muted">Play at least 5 games in an opening to see it here.</p>';

  const ends = groupBy(gs.filter((g) => g.res !== 'D'), (g) => `${g.res === 'W' ? 'You won by' : 'You lost by'} ${g.how.toLowerCase()}`);
  $('#endings').innerHTML = [...ends].sort((a, b) => b[1].length - a[1].length).map(([k, x]) => `<div class="row"><div class="lab"><span>${esc(k)}</span><span class="muted">${x.length} games (${pct(x.length, gs.length)}%)</span></div></div>`).join('')
    + `<div class="row"><div class="lab"><span>Drawn</span><span class="muted">${s.d} games (${pct(s.d, gs.length)}%)</span></div></div>`;

  const buckets = [['Opponent 50+ points higher', (g) => g.oppRating - g.rating >= 50], ['Within 50 points', (g) => Math.abs(g.oppRating - g.rating) < 50], ['Opponent 50+ points lower', (g) => g.rating - g.oppRating >= 50]];
  $('#vsStrength').innerHTML = buckets.map(([l, f]) => rowBlock(l, gs.filter(f))).join('');

  const colChart = (el, labels, keyFn) => {
    const m = groupBy(gs, keyFn); const mx = Math.max(1, ...[...m.values()].map((x) => x.length));
    $(el).innerHTML = labels.map((d, i) => {
      const x = m.get(i) || []; const w = wdl(x); const hgt = (x.length / mx) * 100;
      return `<div class="wd"><div class="col" title="${x.length} games"><div style="height:${hgt}%;display:flex;flex-direction:column-reverse"><i style="flex:${w.w}"></i><i style="flex:${w.d}"></i><i style="flex:${w.l}"></i></div></div><b>${d}</b><br><span class="muted" style="margin:0">${x.length ? pct(w.w, x.length) + '%' : '-'}</span></div>`;
    }).join('');
  };
  colChart('#weekdays', ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], (g) => (new Date(g.end * 1000).getDay() + 6) % 7);
  colChart('#hours', ['0-3', '3-6', '6-9', '9-12', '12-15', '15-18', '18-21', '21-24'], (g) => Math.floor(new Date(g.end * 1000).getHours() / 3));

  // tilt: how you do right after a loss or a win (next game started within an hour)
  const afterL = [], afterW = [];
  for (let i = 1; i < gs.length; i++) { if (gs[i].end - gs[i - 1].end <= 3600) (gs[i - 1].res === 'L' ? afterL : gs[i - 1].res === 'W' ? afterW : []).push(gs[i]); }
  let bestRun = 0, curRun = 0, worstRun = 0, curLoss = 0;
  gs.forEach((g) => { curRun = g.res === 'W' ? curRun + 1 : 0; bestRun = Math.max(bestRun, curRun); curLoss = g.res === 'L' ? curLoss + 1 : 0; worstRun = Math.max(worstRun, curLoss); });
  const overall = pct(s.w, gs.length), wL = pct(wdl(afterL).w, afterL.length), wW = pct(wdl(afterW).w, afterW.length);
  $('#tilt').innerHTML = gs.length < 10 ? '<p class="muted" style="margin:0">Play at least 10 games in this selection to see streak and tilt numbers.</p>' : `
    <div class="tiles">
      <div class="tile"><b>${afterL.length ? wL + '%' : '-'}</b><span>win rate right after a loss (${afterL.length} games)</span></div>
      <div class="tile"><b>${afterW.length ? wW + '%' : '-'}</b><span>win rate right after a win (${afterW.length} games)</span></div>
      <div class="tile"><b>${overall}%</b><span>win rate overall</span></div>
      <div class="tile"><b>${bestRun}</b><span>longest win streak</span></div>
      <div class="tile"><b>${worstRun}</b><span>longest losing streak</span></div>
    </div>
    ${afterL.length >= 8 && wL + 8 <= overall ? `<p class="callout" style="margin:0">You win ${overall - wL} points less often straight after a loss. A short break between games may help.</p>` : ''}`;

  const eg = gs.filter((g) => g.endgame); const ew = wdl(eg);
  const kinds = groupBy(eg, (g) => g.endKind);
  const cap = gs.length ? `${eg.length} of ${gs.length} games (${pct(eg.length, gs.length)}%) reached an endgame, with ${pct(ew.w, eg.length)}% wins there.` : '';
  $('#endTable').innerHTML = `<caption class="muted" style="text-align:left;padding-bottom:.5rem;margin:0">${cap}</caption><thead><tr><th>Endgame type</th><th>Games</th><th>Win %</th><th>Results</th></tr></thead><tbody>${
    [...kinds].sort((a, b) => b[1].length - a[1].length).map(([k, x]) => { const w = wdl(x); return `<tr><td>${k}</td><td>${x.length}</td><td>${pct(w.w, x.length)}%</td><td>${bar(w, x.length)}</td></tr>`; }).join('')}</tbody>`;
  drawRating(gs); renderInsights();
}
function pickOpening(name) { state.filter.opening = name; renderList(); tab('review'); }
$('#openTable').addEventListener('click', (e) => {
  const th = e.target.closest('th');
  if (th && th.dataset.k) {
    state.sortDir = state.sortKey === th.dataset.k ? -state.sortDir : (th.dataset.k === 'name' ? 1 : -1); state.sortKey = th.dataset.k; return renderStats();
  }
  const tr = e.target.closest('tbody tr'); if (tr) pickOpening(tr.dataset.name);
});
$('#bestWorst').addEventListener('click', (e) => { const r = e.target.closest('[data-name]'); if (r) pickOpening(r.dataset.name); });

/* The logical (CSS) height is read once and kept in data-h. Reading the height attribute every time
   was a bug: this function overwrites that attribute with h * dpr, so on phones (dpr 2 to 3) the
   canvas grew taller on every redraw. The CSS height is pinned so the layout never depends on it. */
function fitCanvas(c) {
  if (!c.dataset.h) c.dataset.h = c.getAttribute('height');
  const h = +c.dataset.h; const dpr = Math.min(window.devicePixelRatio || 1, 3); const w = c.clientWidth;
  c.style.height = h + 'px'; c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  const x = c.getContext('2d'); x.scale(dpr, dpr); return { x, w, h };
}
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

function drawRating(gs) {
  const c = $('#ratingChart'); if (!c.clientWidth) return; const { x, w, h } = fitCanvas(c);
  x.clearRect(0, 0, w, h); if (!gs.length) return;
  const series = groupBy(gs, (g) => g.tc);
  const all = gs.map((g) => g.rating);
  const lo = Math.min(...all) - 20, hi = Math.max(...all) + 20;
  const t0 = gs[0].end, t1 = gs[gs.length - 1].end || t0 + 1;
  const px = (t) => 42 + ((t - t0) / (t1 - t0 || 1)) * (w - 56);
  const py = (r) => h - 24 - ((r - lo) / (hi - lo)) * (h - 40);
  x.font = '12px "Source Sans 3", system-ui'; x.strokeStyle = css('--line'); x.lineWidth = 1;
  for (let i = 0; i <= 3; i++) { const r = lo + ((hi - lo) * i) / 3; x.beginPath(); x.moveTo(42, py(r)); x.lineTo(w - 8, py(r)); x.stroke(); x.fillStyle = css('--muted'); x.fillText(Math.round(r), 4, py(r) + 4); }
  const colors = [css('--accent'), '#d9ac2f', '#17a99e', '#d4483e', '#8a63d2'];
  [...series].forEach(([tc, arr], i) => {
    const col = colors[i % colors.length]; x.strokeStyle = col; x.lineWidth = 2; x.beginPath();
    arr.forEach((g, j) => (j ? x.lineTo(px(g.end), py(g.rating)) : x.moveTo(px(g.end), py(g.rating)))); x.stroke();
    x.fillStyle = col; x.fillRect(w - 90, 8 + i * 16, 10, 10); x.fillStyle = css('--fg'); x.fillText(tc, w - 74, 18 + i * 16);
  });
  x.fillStyle = css('--muted'); x.fillText(new Date(t0 * 1000).toLocaleDateString(), 42, h - 6);
  x.textAlign = 'right'; x.fillText(new Date(t1 * 1000).toLocaleDateString(), w - 8, h - 6); x.textAlign = 'left';
}

/* ---------- game list ---------- */
const accMemo = new Map();
function accOf(g) {
  if (!accMemo.has(g.url)) { const x = kv.get('anx:' + g.url); accMemo.set(g.url, x ? x.acc : null); }
  return accMemo.get(g.url);
}
const SORTS = {
  new: (a, b) => b.end - a.end, old: (a, b) => a.end - b.end,
  oppHi: (a, b) => b.oppRating - a.oppRating, oppLo: (a, b) => a.oppRating - b.oppRating,
  dBest: (a, b) => (b.delta ?? -1e9) - (a.delta ?? -1e9), dWorst: (a, b) => (a.delta ?? 1e9) - (b.delta ?? 1e9),
  long: (a, b) => b.moveCount - a.moveCount, short: (a, b) => a.moveCount - b.moveCount,
  accHi: (a, b) => (accOf(b) ?? -1) - (accOf(a) ?? -1), accLo: (a, b) => (accOf(a) ?? 101) - (accOf(b) ?? 101),
};
function listGames() {
  const o = state.filter.opening; const k = state.filter.group; const L = state.list;
  return filtered().filter((g) => (!o || g[k] === o) && (L.result === 'all' || g.res === L.result) && (!L.analyzed || accOf(g) != null)
    && (!L.q || g.oppName.toLowerCase().includes(L.q) || g.variation.toLowerCase().includes(L.q))).sort(SORTS[L.sort]);
}
function renderList() {
  const gs = listGames();
  $('#listNote').textContent = state.filter.opening ? `(${state.filter.opening})` : `(${gs.length})`;
  const row = (g, i) => {
    const d = g.delta; const dl = d == null ? '' : `<span class="dl ${d > 0 ? 'up' : d < 0 ? 'down' : 'flat'}">${d > 0 ? '+' : ''}${d}</span>`;
    const acc = accOf(g); const ac = acc != null ? ` · ${acc}% accuracy` : '';
    const on = state.sel && state.sel.g.url === g.url ? ' on' : '';
    return `<button class="g${on}" data-i="${i}"><span class="r ${g.res}">${g.res}</span>vs ${esc(g.oppName)} (${g.oppRating})${dl}<small>${new Date(g.end * 1000).toLocaleDateString()} · ${g.tc} · ${g.color} · ${g.moveCount} moves${ac}<br>${esc(g.how)} \u00B7 ${esc(g.variation)}</small></button>`;
  };
  $('#gameList').innerHTML = (state.filter.opening ? '<button class="g" data-clear="1">Show all openings</button>' : '')
    + (gs.slice(0, 200).map(row).join('') || '<p class="muted">No games match these filters.</p>')
    + (gs.length > 200 ? `<p class="muted">Showing 200 of ${gs.length}. Narrow the filters to see the rest.</p>` : '');
}
$('#lq').addEventListener('input', () => { state.list.q = $('#lq').value.trim().toLowerCase(); renderList(); });
$('#lsort').addEventListener('change', () => { state.list.sort = $('#lsort').value; renderList(); });
$('#lan').addEventListener('change', () => { state.list.analyzed = $('#lan').checked; renderList(); });
$('#lres').addEventListener('click', (e) => {
  if (!e.target.dataset.v) return; state.list.result = e.target.dataset.v;
  $('#lres').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.target)); renderList();
});
$('#csvBtn').addEventListener('click', () => {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['date', 'time_class', 'color', 'opponent', 'opponent_rating', 'my_rating', 'rating_change', 'result', 'ended_by', 'moves', 'opening', 'eco', 'accuracy', 'url'];
  const lines = listGames().map((g) => [new Date(g.end * 1000).toISOString(), g.tc, g.color, g.oppName, g.oppRating, g.rating, g.delta, g.res, g.how, g.moveCount, g.variation, g.eco, accOf(g), g.url].map(q).join(','));
  const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${state.user}-games.csv`; document.body.appendChild(a); a.click(); a.remove();
});
$('#gameList').addEventListener('click', (e) => {
  const b = e.target.closest('.g'); if (!b) return;
  if (b.dataset.clear) { state.filter.opening = null; return renderList(); }
  document.querySelectorAll('.g').forEach((x) => x.classList.toggle('on', x === b));
  openGame(listGames()[+b.dataset.i]);
});

/* ---------- game viewer ---------- */
function parseClocks(pgn) {
  return [...pgn.matchAll(/\[%clk (\d+):(\d+):(\d+(?:\.\d+)?)\]/g)].map((m) => +m[1] * 3600 + +m[2] * 60 + +m[3]);
}
function prepare(g) {
  const ch = new Chess(); ch.load_pgn(g.pgn);
  const moves = ch.history({ verbose: true });
  const start = (g.pgn.match(/\[FEN "([^"]+)"\]/) || [])[1];
  const rep = new Chess(start || undefined); const fens = [rep.fen()];
  moves.forEach((m) => { rep.move(m.san); fens.push(rep.fen()); });
  const clocks = parseClocks(g.pgn);
  const inc = +(String(g.tcontrol || '').split('+')[1] || 0);
  const base = +String(g.tcontrol || '').split('+')[0].split('/').pop() || null;
  const spent = moves.map((m, i) => { const prev = i >= 2 ? clocks[i - 2] : base; return clocks[i] != null && prev != null ? Math.max(0, prev - clocks[i] + inc) : null; });
  return { g, moves, fens, clocks, spent, base };
}
function openGame(g) {
  state.token++; stopPlay(); resetMode();
  state.sel = prepare(g);
  state.ply = 0; state.flip = g.color === 'black'; state.review = null;
  $('#progress').hidden = true; $('#bAnalyze').disabled = !!state.busy;
  const cached = kv.get('an2:' + g.url);
  if (cached && cached.evals && cached.evals.length === state.sel.fens.length) state.review = buildReview(state.sel, cached.evals, cached.depth);
  renderMeta(); renderGame(); renderSide();
}
/* How the game ended. chess.com's PGN has a Termination tag such as "name won by resignation". */
function finishText(g) {
  const term = (g.pgn.match(/\[Termination "([^"]+)"\]/) || [])[1];
  if (term) { const u = state.user; return term.toLowerCase().startsWith(u.toLowerCase() + ' ') ? 'You' + term.slice(u.length) : term; }
  const how = (g.how || '').toLowerCase();
  return g.res === 'D' ? 'Draw' + (how && how !== 'draw' ? ' by ' + how : '') : (g.res === 'W' ? 'You won' : 'You lost') + ' by ' + how;
}
function resultScore(g) { return g.res === 'D' ? '\u00BD-\u00BD' : (g.res === 'W') === (g.color === 'white') ? '1-0' : '0-1'; }
function renderMeta() {
  const { g } = state.sel; const d = new Date(g.end * 1000);
  $('#gameMeta').innerHTML = `<b>${esc(g.variation)}</b><span class="fin fin-${g.res}">${esc(finishText(g))}</span><span class="muted" style="margin:0">${g.eco ? g.eco + ' \u00B7 ' : ''}${g.tc} ${esc(g.tcontrol || '')} \u00B7 ${d.toLocaleDateString()}</span>${/^https?:/.test(g.url) ? `<a href="${esc(g.url)}" target="_blank" rel="noopener">Open on chess.com</a>` : ''}`;
}
const fmtClock = (s) => { if (s == null) return '-'; const m = Math.floor(s / 60), r = Math.floor(s % 60); return s >= 3600 ? `${Math.floor(s / 3600)}:${String(m % 60).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`; };
const START = { p: 8, n: 2, b: 2, r: 2, q: 1 };
function capturedBy(fen) {
  const cnt = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
  for (const ch of fen.split(' ')[0]) { const l = ch.toLowerCase(); if (cnt.w[l] === undefined) continue; cnt[ch === l ? 'b' : 'w'][l]++; }
  const lost = (c) => Object.keys(START).flatMap((k) => Array(Math.max(0, START[k] - cnt[c][k])).fill(k));
  const sc = (c) => Object.keys(START).reduce((a, k) => a + cnt[c][k] * VAL[k], 0);
  return { byWhite: lost('b'), byBlack: lost('w'), diff: sc('w') - sc('b') };
}
const G = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛' };

const board = makeBoard($('#boardBox'));
/* loose pieces on the board, when "Show threats" is on: yours red, theirs green */
function threatMarks(fen) {
  if (!state.threats || !state.sel) return null;
  const me = state.sel.g.color[0]; const marks = {};
  loosePieces(fen).forEach((x) => { marks[x.sq] = x.color === me ? 'risk' : 'loose'; });
  return marks;
}
function renderThreatNote(fen, last) {
  const el = $('#threatNote');
  if (!state.threats || !state.sel) { el.hidden = true; return; }
  const me = state.sel.g.color[0]; const loose = loosePieces(fen);
  const name = (x) => `${PIECE_NAME[x.piece]} on ${x.sq}`;
  const mine = loose.filter((x) => x.color === me), theirs = loose.filter((x) => x.color !== me);
  const parts = [];
  const t = lastMoveThreats(fen, last);
  if (t.length) {
    const byMe = pieceColor(boardMap(fen)[last.to]) === me;
    parts.push(`${byMe ? 'Your' : 'Their'} last move attacks ${t.map((x) => (byMe ? 'their ' : 'your ') + name(x)).join(' and ')}.`);
  }
  parts.push(mine.length ? `Your loose pieces (solid red ring): ${mine.map(name).join(', ')}.` : 'None of your pieces are loose.');
  if (theirs.length) parts.push(`Their loose pieces you could take (dashed green ring): ${theirs.map(name).join(', ')}.`);
  el.textContent = parts.join(' '); el.hidden = false;
}

function renderGame() {
  const s = state.sel; if (!s) return;
  updateModeButtons(); $('#boardBox').dataset.mode = state.mode;
  if (state.mode === 'explore') return renderExplore();
  const last = s.moves[state.ply - 1];
  const rv = state.review; const cl = rv && state.ply ? rv.cls[state.ply - 1] : null;
  let view = { fen: s.fens[state.ply], flip: state.flip, last, arrows: [], badge: null, movable: null };
  if (state.mode === 'guess') view = { ...view, ...guessView() };
  else if (cl) {
    if (cl.sym) view.badge = { sq: last.to, t: cl.t, sym: cl.sym };
    if (['inacc', 'mist', 'blun'].includes(cl.t)) {
      view.arrows.push(uciArrow(rv.evals[state.ply - 1].best, ARROW.best));
      if (cl.drop >= 20) view.arrows.push(uciArrow(rv.evals[state.ply].best, ARROW.ref, 0.6, 0.12));
    }
  }
  view.marks = threatMarks(view.fen);
  board.set(view);
  renderBars(view.fen); renderMoves(); renderEval(); renderThreatNote(view.fen, view.last);
  teachSync();
}
function renderBars(fen) {
  const s = state.sel; const g = s.g; const cb = capturedBy(fen);
  const clk = (white) => { // last clock reading for this side at the current ply
    let i = state.ply - 1; while (i >= 0 && (i % 2 === 0) !== white) i--;
    return i >= 0 ? s.clocks[i] : s.base;
  };
  const me = g.color;
  const data = {
    white: { name: me === 'white' ? (state.user || 'You') : g.oppName, rating: me === 'white' ? g.rating : g.oppRating, cap: cb.byWhite, adv: cb.diff, acc: state.review ? state.review.acc.w : null },
    black: { name: me === 'black' ? (state.user || 'You') : g.oppName, rating: me === 'black' ? g.rating : g.oppRating, cap: cb.byBlack, adv: -cb.diff, acc: state.review ? state.review.acc.b : null },
  };
  const hideAcc = state.mode === 'guess';
  const atEnd = state.mode === 'game' && s.moves.length > 0 && state.ply === s.moves.length;
  const myScore = g.res === 'W' ? 1 : g.res === 'D' ? 0.5 : 0;
  const chip = (c) => { if (!atEnd) return ''; const sc = c === g.color ? myScore : 1 - myScore; return `<span class="resChip ${sc === 1 ? 'won' : sc === 0 ? 'lost' : 'drawn'}" title="${esc(finishText(g))}">${sc === 1 ? '1' : sc === 0 ? '0' : '\u00BD'}</span>`; };
  const line = (c) => { const d = data[c]; const plus = d.adv > 0 ? ` +${d.adv}` : ''; return `<span class="nm">${esc(d.name)}</span><span class="rt">${d.rating}</span><span class="cap">${d.cap.map((k) => G[k]).join('')}<b>${plus}</b></span>${d.acc != null && !hideAcc ? `<span class="acc">${d.acc}% accuracy</span>` : ''}${chip(c)}<span class="clock" title="Time left">${fmtClock(clk(c === 'white'))}</span>`; };
  const top = state.flip ? 'white' : 'black', bot = state.flip ? 'black' : 'white';
  $('#topBar').innerHTML = line(top); $('#botBar').innerHTML = line(bot);
}

function renderMoves() {
  const s = state.sel; const rv = state.review; let h = '';
  const upto = state.mode === 'guess' ? state.ply : s.moves.length; // guessing: hide the moves still to come
  s.moves.slice(0, upto).forEach((m, i) => {
    if (i % 2 === 0) h += `<span class="n">${i / 2 + 1}.</span>`;
    const c = rv && rv.cls[i];
    const dot = c ? `<span class="bg k-${c.t}" title="${c.label}">${c.sym}</span>` : '';
    const t = s.spent[i] != null ? `<small>${s.spent[i] < 10 ? s.spent[i].toFixed(1) : Math.round(s.spent[i])}s</small>` : '';
    h += `<button class="mv${state.ply === i + 1 ? ' on' : ''}" data-p="${i + 1}"><span>${m.san}${dot}</span>${t}</button>`;
  });
  if (upto === s.moves.length) h += `<div class="endrow fin-${s.g.res}">${esc(finishText(s.g))} <b>${resultScore(s.g)}</b></div>`;
  const box = $('#sMoves'); const keep = box.scrollTop; box.innerHTML = h;
  const on = box.querySelector('.mv.on');
  if (on) { const t = on.offsetTop; if (t < box.scrollTop || t + on.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = Math.max(0, t - box.clientHeight / 2); } else box.scrollTop = keep;
}
$('#sMoves').addEventListener('click', (e) => { const b = e.target.closest('.mv'); if (b) go(+b.dataset.p); });
/* go to a ply of the game (leaves explore mode); nav() steps within the current mode */
function go(p) {
  if (!state.sel || state.mode === 'guess') return;
  if (state.mode === 'explore') resetMode();
  state.ply = Math.max(0, Math.min(state.sel.moves.length, p)); renderGame();
}
function nav(d) {
  if (!state.sel || state.mode === 'guess') return;
  if (state.mode === 'explore') { const ex = state.ex; return exGo(d === 'start' ? 0 : d === 'end' ? ex.moves.length : ex.cur + d); }
  go(d === 'start' ? 0 : d === 'end' ? 1e9 : state.ply + d);
}
function stopPlay() { if (state.timer) { clearInterval(state.timer); state.timer = null; $('#bPlay').textContent = 'Play'; } }
$('#bPlay').onclick = () => {
  if (state.timer) return stopPlay(); if (!state.sel || state.mode !== 'game') return;
  if (state.ply >= state.sel.moves.length) go(0);
  $('#bPlay').textContent = 'Pause';
  state.timer = setInterval(() => { if (state.ply >= state.sel.moves.length || state.mode !== 'game') return stopPlay(); go(state.ply + 1); }, 900);
};
$('#bStart').onclick = () => nav('start'); $('#bPrev').onclick = () => nav(-1);
$('#bNext').onclick = () => nav(1); $('#bEnd').onclick = () => nav('end');
$('#bFlip').onclick = () => { state.flip = !state.flip; renderGame(); };
$('#threatsChk').checked = state.threats;
$('#threatsChk').addEventListener('change', () => { state.threats = $('#threatsChk').checked; prefs.set('threats', state.threats); renderGame(); });
document.addEventListener('keydown', (e) => {
  if ($('#review').hidden || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); nav(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); nav(1); }
  else if (e.key === 'Home') nav('start'); else if (e.key === 'End') nav('end');
  else if (e.key === ' ' && document.activeElement.tagName !== 'BUTTON') { e.preventDefault(); $('#bPlay').click(); }
  else if (e.key.toLowerCase() === 'f') $('#bFlip').click();
  else if (e.key.toLowerCase() === 'e') $('#bExplore').click();
  else if (e.key === 'Escape' && state.mode !== 'game') leaveMode();
});
$('#sideTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return; state.side = b.dataset.s; renderSide();
});
function renderSide() {
  document.querySelectorAll('#sideTabs button').forEach((b) => b.classList.toggle('on', b.dataset.s === state.side));
  $('#sMoves').hidden = state.side !== 'moves'; $('#sSummary').hidden = state.side !== 'summary'; $('#sMoments').hidden = state.side !== 'moments'; $('#sNotes').hidden = state.side !== 'notes';
  const rv = state.review; const s = state.sel;
  const nb = $('#notesBox'); nb.disabled = !s; if (document.activeElement !== nb) nb.value = s ? (kv.get('note:' + s.g.url) || '') : '';
  if (!s) { $('#sSummary').innerHTML = $('#sMoments').innerHTML = '<p class="pending">Pick a game first.</p>'; return; }
  if (!rv) { $('#sSummary').innerHTML = $('#sMoments').innerHTML = '<p class="pending">Press Analyze with Stockfish to fill this in.</p>'; return; }
  const me = s.g.color === 'white' ? 'w' : 'b';
  const rowsQ = [['brill', 'Brilliant'], ['best', 'Best'], ['good', 'Good'], ['inacc', 'Inaccuracy'], ['mist', 'Mistake'], ['blun', 'Blunder']];
  const phases = ['opening', 'middlegame', 'endgame'].filter((p) => rv.phase[me][p] != null);
  const spentMine = s.spent.filter((v, i) => v != null && s.moves[i].color === me);
  const avgT = spentMine.length ? (spentMine.reduce((a, b) => a + b, 0) / spentMine.length).toFixed(1) : null;
  const slowest = spentMine.length ? Math.max(...spentMine) : null;
  const types = Object.entries(rv.types).filter(([, n]) => n).sort((a, b) => b[1] - a[1]);
  $('#sSummary').innerHTML = `
    <div class="sumGrid"><div class="big"><b>${rv.acc.w}%</b><span>White accuracy</span></div><div class="big"><b>${rv.acc.b}%</b><span>Black accuracy</span></div></div>
    <table class="qt"><thead><tr><th>Move quality</th><th>White</th><th>Black</th></tr></thead><tbody>${rowsQ.map(([k, l]) => `<tr><td><span class="dot k-${k}" style="margin:0 .4rem 0 0"></span>${l}</td><td>${rv.counts.w[k]}</td><td>${rv.counts.b[k]}</td></tr>`).join('')}</tbody></table>
    <div class="facts">
      <p>What went wrong in your mistakes and blunders: ${types.length ? types.map(([k, n]) => `${MTYPES[k].label.toLowerCase()} ${n}`).join(', ') : 'nothing, there were none'}.</p>
      <p>Your accuracy by phase: ${phases.map((p) => `${p} ${rv.phase[me][p]}%`).join(', ') || 'not enough moves'}.</p>
      <p>Missed tactics (yours): ${rv.missed[me]}. Brilliant moves (yours): ${rv.counts[me].brill}.</p>
      ${avgT ? `<p>Average time per move: ${avgT}s. Longest think: ${Math.round(slowest)}s.</p>` : ''}
      <p>Opening: ${esc(s.g.variation)}${s.g.eco ? ' (' + s.g.eco + ')' : ''}. Engine depth ${rv.depth || '?'}.</p>
    </div>`;
  const mine = rv.cls.map((c, i) => ({ c, i })).filter((x) => x.c.t === 'brill' || x.c.drop >= 10).sort((a, b) => (b.c.t === 'brill') - (a.c.t === 'brill') || b.c.drop - a.c.drop).slice(0, 8);
  $('#sMoments').innerHTML = mine.length ? mine.map(({ c, i }) => {
    const m = s.moves[i]; const who = m.color === me ? 'You' : s.g.oppName;
    const kind = c.ex && c.ex.type !== 'opp' ? `, ${MTYPES[c.ex.type].label.toLowerCase()}` : '';
    const why = c.ex ? `<small class="why">${esc(c.ex.text)}</small>` : '';
    return `<button class="moment" data-p="${i + 1}"><span class="badge k-${c.t}">${c.label}</span> ${moveName(i, m.san)}<small>${esc(who)}${kind}${c.ex && c.ex.tag ? `, ${c.ex.tag.label.toLowerCase()}` : ''}</small>${why}</button>`;
  }).join('') : '<p class="pending">No big swings in this game.</p>';
}
$('#sMoments').addEventListener('click', (e) => { const b = e.target.closest('.moment'); if (b) { go(+b.dataset.p); } });

/* ---------- Stockfish game analysis ---------- */
/* Evaluates every position of a prepared game. Returns null if cancelled(). */
async function runEvals(s, depth, cancelled, onStep) {
  const eng = await getEngine('main');
  await eng.newGame();
  const evals = [];
  for (let i = 0; i < s.fens.length; i++) {
    if (cancelled()) return null;
    evals.push(await evalPosition(eng, s.fens[i], depth));
    if (onStep) onStep(i + 1, s.fens.length);
  }
  return evals;
}

/* A brilliant move is a near-best move that gives up a piece for less than it is worth,
   in a position that was not already won, and leaves you at least roughly equal. */
function isSacrifice(fen, mv) {
  if (mv.piece === 'p' || mv.piece === 'k') return false;
  const after = new Chess(fen); after.move(mv.san);
  const caps = after.moves({ verbose: true }).filter((x) => x.to === mv.to && x.flags.includes('c'));
  if (!caps.length) return false;
  const gain = mv.captured ? VAL[mv.captured] : 0;
  const low = Math.min(...caps.map((x) => VAL[x.piece]));
  return VAL[mv.piece] - gain >= 2 && low < VAL[mv.piece];
}

/* evals is [{cp, best, pv}] for every position; everything else is derived from it, so it can be cached */
function buildReview(s, evals, depth) {
  const cls = []; const acc = { w: [], b: [] }; const phaseAcc = { w: {}, b: {} };
  const counts = { w: {}, b: {} }; const missed = { w: 0, b: 0 }; const types = {};
  ['brill', 'best', 'good', 'inacc', 'mist', 'blun'].forEach((k) => { counts.w[k] = 0; counts.b[k] = 0; });
  Object.keys(MTYPES).forEach((k) => { types[k] = 0; });
  const me = s.g.color[0];
  const spentMine = s.spent.filter((v, i) => v != null && s.moves[i].color === me);
  const avgSpent = spentMine.length ? spentMine.reduce((a, b) => a + b, 0) / spentMine.length : null;
  s.moves.forEach((m, i) => {
    const mover = m.color === 'w' ? 1 : -1;
    const before = winPct(evals[i].cp * mover), after = winPct(evals[i + 1].cp * mover);
    const drop = Math.max(0, before - after);
    const bu = evals[i].best; const played = uciOf(m);
    let c = bu && played === bu ? CLS[0] : clsOf(drop);
    const a = moveAcc(bu && played === bu ? 0 : drop);
    acc[m.color].push(a);
    const ph = phaseOf(s.fens, i); (phaseAcc[m.color][ph] = phaseAcc[m.color][ph] || []).push(a);
    let bestSan = null, bestTactical = false;
    if (bu && bu !== '(none)') {
      const t = new Chess(s.fens[i]);
      const mv = t.move({ from: bu.slice(0, 2), to: bu.slice(2, 4), promotion: bu[4] });
      bestSan = mv && mv.san; bestTactical = !!(mv && (mv.flags.includes('c') || /[+#]/.test(mv.san)));
    }
    const brilliant = drop <= 2 && before < 90 && after >= 40 && isSacrifice(s.fens[i], m);
    if (brilliant) c = [0, 'brill', '!!', 'Brilliant'];
    const miss = !brilliant && drop >= 20 && bestTactical; if (miss) missed[m.color]++;
    counts[m.color][c[1]]++;
    let ex = null;
    if (['inacc', 'mist', 'blun'].includes(c[1])) {
      try { ex = m.color === me ? explainMove(s, evals, i, drop, avgSpent) : explainOpp(s, evals, i); } catch (_) { ex = null; }
      if (ex && m.color === me && drop >= 20) types[ex.type]++;
    }
    cls.push({ t: c[1], sym: c[2], label: c[3], drop, bestSan, missed: miss, ex });
  });
  const avg = (x) => (x.length ? Math.round(x.reduce((p, q) => p + q, 0) / x.length) : 0);
  const phase = { w: {}, b: {} };
  ['w', 'b'].forEach((c) => Object.keys(phaseAcc[c]).forEach((p) => { phase[c][p] = avg(phaseAcc[c][p]); }));
  return { evals, cls, counts, missed, phase, depth, types, acc: { w: avg(acc.w), b: avg(acc.b) } };
}

$('#bAnalyze').addEventListener('click', async () => {
  const s = state.sel; if (!s) return;
  if (state.busy) { $('#coach').textContent = 'The engine is busy with the batch analysis. Stop it first, or wait for it to finish.'; return; }
  stopPlay(); if (state.mode !== 'game') leaveMode();
  const token = ++state.token; const depth = +$('#depth').value;
  state.busy = 'single'; $('#bAnalyze').disabled = true; $('#progress').hidden = false; $('#progressBar').style.width = '0';
  $('#coach').textContent = 'Loading Stockfish...';
  let evals = null;
  try {
    evals = await runEvals(s, depth, () => token !== state.token, (i, n) => {
      $('#progressBar').style.width = (i / n) * 100 + '%'; $('#coach').textContent = `Analyzing position ${i} of ${n}`;
    });
  } catch (err) { $('#coach').textContent = err.message; }
  state.busy = null; $('#bAnalyze').disabled = false;
  if (!evals) { $('#progress').hidden = true; return; }
  state.review = saveAnalysis(s, evals, depth);
  $('#progress').hidden = true;
  state.side = 'summary'; renderSide(); renderGame(); renderInsights(); renderList();
});

/* ---------- batch insights: analyse recent games, then summarise mistakes, phases and openings ---------- */
const ins = { running: false, token: 0 };
const rvMemo = new Map();
function saveAnalysis(s, evals, depth) {
  kv.set('an2:' + s.g.url, { evals, depth }); rvMemo.clear();
  const rv = buildReview(s, evals, depth); const c = s.g.color === 'white' ? 'w' : 'b';
  kv.set('anx:' + s.g.url, { acc: rv.acc[c], blun: rv.counts[c].blun }); accMemo.delete(s.g.url);
  kv.set('pz:' + s.g.url, { v: PZ_VERSION, list: puzzlesFrom(s.g, s, rv) });
  return rv;
}
/* { s, rv } for an analyzed game, or null */
function reviewFor(g) {
  const c = kv.get('an2:' + g.url); if (!c || !c.evals) return null;
  const key = g.url + ':' + c.evals.length + ':' + c.depth; if (rvMemo.has(key)) return rvMemo.get(key);
  const s = prepare(g); if (!s.moves.length || c.evals.length !== s.fens.length) return null;
  const r = { s, rv: buildReview(s, c.evals, c.depth) }; rvMemo.set(key, r); return r;
}
/* the most recent n games in the current color, time control and period filters */
function recentGames(n) { return filtered().reverse().slice(0, n); }
function insightResults(n) {
  const out = [];
  recentGames(n).forEach((g) => { const r = reviewFor(g); if (r) out.push({ g, ...r }); });
  return out.reverse();
}
$('#batchBtn').addEventListener('click', async () => {
  if (ins.running) { ins.token++; return; }
  if (state.busy) { $('#batchMsg').textContent = 'The engine is busy with a single game. Try again when it finishes.'; return; }
  const n = +$('#batchN').value; const token = ++ins.token;
  ins.running = true; state.busy = 'batch'; $('#bAnalyze').disabled = true; $('#batchBtn').textContent = 'Stop'; $('#batchBar').hidden = false;
  const list = recentGames(n); let done = 0;
  try {
    for (const g of list) {
      if (token !== ins.token) break;
      const s = prepare(g); done++;
      const cached = kv.get('an2:' + g.url);
      if (cached && cached.evals && cached.evals.length === s.fens.length) {
        if (!kv.get('anx:' + g.url) || !kv.get('pz:' + g.url)) saveAnalysis(s, cached.evals, cached.depth);
        renderInsights(); continue;
      }
      if (!s.moves.length) continue;
      $('#batchMsg').textContent = `Analyzing game ${done} of ${list.length}...`;
      const evals = await runEvals(s, BATCH_DEPTH, () => token !== ins.token, (i, m) => {
        $('#batchBar span').style.width = (((done - 1) + i / m) / list.length) * 100 + '%';
      });
      if (!evals) break;
      saveAnalysis(s, evals, BATCH_DEPTH); renderInsights(); renderList();
    }
  } catch (err) { $('#batchMsg').textContent = err.message; }
  ins.running = false; state.busy = null; $('#batchBtn').textContent = 'Analyze recent games'; $('#batchBar').hidden = true; $('#bAnalyze').disabled = false;
  renderInsights();
});

function renderInsights() {
  const n = +$('#batchN').value; const pool = recentGames(n); const res = insightResults(n); const box = $('#insights');
  if (!ins.running) $('#batchMsg').textContent = `${res.length} of the last ${pool.length} games in this selection are analyzed.`;
  if (!res.length) { box.innerHTML = '<p class="muted" style="margin:0">Analyze your recent games to see your accuracy, what kind of mistakes you make, where they happen and which positions keep going wrong. Analysis runs on your device and takes a few seconds per game.</p>'; return; }
  const mine = res.map(({ g, rv }) => { const c = g.color === 'white' ? 'w' : 'b'; return { g, acc: rv.acc[c], phase: rv.phase[c], counts: rv.counts[c], missed: rv.missed[c] }; });
  const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
  const sum = (k) => mine.reduce((a, m) => a + m.counts[k], 0); const per = (v) => (v / mine.length).toFixed(1);
  const phases = ['opening', 'middlegame', 'endgame'].map((p) => [p, avg(mine.map((m) => m.phase[p]).filter((v) => v != null))]);
  const known = phases.filter((p) => p[1] != null); const weakest = known.length ? known.reduce((a, b) => (b[1] < a[1] ? b : a)) : null;
  const tiles = [[avg(mine.map((m) => m.acc)) + '%', 'average accuracy'], [per(sum('blun')), 'blunders per game'], [per(sum('mist')), 'mistakes per game'],
    [per(sum('inacc')), 'inaccuracies per game'], [per(mine.reduce((a, m) => a + m.missed, 0)), 'missed tactics per game'], [sum('brill'), 'brilliant moves in total']];
  const prof = mistakeProfile(res);

  // what goes wrong
  const typeRows = Object.entries(prof.types).filter(([, v]) => v).sort((a, b) => b[1] - a[1]);
  const leak = prof.errors >= 8 && typeRows[0][1] > (typeRows[1] ? typeRows[1][1] : 0)
    ? `<p class="callout"><b>Biggest leak: ${MTYPES[typeRows[0][0]].label.toLowerCase()}.</b> ${MTYPES[typeRows[0][0]].tip}</p>`
    : (prof.errors && prof.errors < 8 ? '<p class="muted" style="margin:.4rem 0 0">Analyze more games to see a clear pattern. With fewer than 8 mistakes, one game can change the picture.</p>' : '');
  const typesHtml = prof.errors ? `${typeRows.map(([k, v]) => `<div class="row"><div class="lab"><span>${MTYPES[k].label}</span><span class="muted">${v} (${pct(v, prof.errors)}%)</span></div><div class="meter"><i style="width:${pct(v, prof.errors)}%"></i></div></div>`).join('')}${leak}`
    : '<p class="muted">No mistakes or blunders in these games.</p>';

  // mistakes and the clock
  const oneIn = (e, m) => (e ? `1 in ${Math.max(1, Math.round(m / e))} moves` : 'none of your moves');
  const calm = prof.moves - prof.movesTime, calmErr = prof.errors - prof.errTime;
  let clockHtml;
  if (!prof.movesTime && !res.some(({ s }) => s.clocks.length)) clockHtml = '<p class="muted">These games have no clock data.</p>';
  else {
    const rateT = prof.movesTime ? prof.errTime / prof.movesTime : 0, rateC = calm ? calmErr / calm : 0;
    let tip = '';
    if (prof.movesTime >= 10 && rateT > 2 * rateC && prof.errTime >= 2) tip = 'Time trouble is costing you games. Play routine opening moves faster so you keep a reserve for the end.';
    else if (prof.errors >= 5 && prof.errFast / prof.errors >= 0.3) tip = 'Many of your mistakes come on moves you played quickly. When there is a check, a capture or a threat on the board, take a few seconds to look at the reply.';
    clockHtml = `<div class="row"><div class="lab"><span>Mistakes and blunders in time trouble</span><span class="muted">${prof.errTime} of ${prof.errors} (${pct(prof.errTime, prof.errors)}%)</span></div><div class="meter"><i style="width:${pct(prof.errTime, prof.errors)}%"></i></div></div>
      <div class="row"><div class="lab"><span>Played much faster than usual</span><span class="muted">${prof.errFast} of ${prof.errors} (${pct(prof.errFast, prof.errors)}%)</span></div><div class="meter"><i style="width:${pct(prof.errFast, prof.errors)}%"></i></div></div>
      <p class="muted" style="margin:.2rem 0 0">With time on your clock you go wrong on ${oneIn(calmErr, calm)}. With under 10% of your time left it is ${oneIn(prof.errTime, prof.movesTime)} (${prof.movesTime} moves in time trouble).</p>
      ${tip ? `<p class="callout">${tip}</p>` : ''}`;
  }

  // positions that keep going wrong
  const rep = prof.repeated.slice(0, 6);
  const repHtml = rep.length ? `<h2 style="margin-top:1rem">Repeated mistakes <span class="muted">Positions where you went wrong in more than one game</span></h2><div class="reps">${rep.map((x) => {
    const bySan = [...groupBy(x.list, (y) => y.san)].sort((a, b) => b[1].length - a[1].length);
    const y = bySan[0][1][0];
    const arrows = [uciArrow(y.best, ARROW.best), uciArrow(y.uci, ARROW.ref, 0.7, 0.12)];
    return `<div class="rep">${miniBoard(x.fen, { flip: x.color === 'b', arrows })}<div><b>${esc(y.g.family)}, move ${Math.floor(y.i / 2) + 1}</b>
      <p>You reached this position ${x.reached} times and went wrong in ${x.games}. You played <b>${esc(bySan[0][0])}</b> (red arrow)${bySan.length > 1 ? ' and other moves' : ''}. Better: <b>${esc(y.bestSan || '?')}</b> (green arrow).</p>
      <button data-url="${esc(y.g.url)}" data-ply="${y.i + 1}">Open the latest game</button></div></div>`;
  }).join('')}</div>` : '';

  const byOpen = groupBy(mine, (m) => m.g.family);
  const orows = [...byOpen].filter(([, x]) => x.length >= 2).map(([k, x]) => {
    const fs = prof.firstSlip.get(k) || [];
    return [k, x.length, avg(x.map((m) => m.acc)), fs.length ? Math.round(fs.reduce((a, b) => a + b, 0) / fs.length) : null];
  }).sort((a, b) => a[2] - b[2]);
  const hh = (v) => Math.max(6, v);
  const worst = mine.slice().sort((a, b) => a.acc - b.acc).slice(0, 5);
  const reviewHtml = `<h2 style="margin-top:1rem">Games to review first <span class="muted">Lowest accuracy among the analyzed games</span></h2>${worst.map((m) => `<button class="moment" data-url="${esc(m.g.url)}"><b>${m.acc}%</b> accuracy vs ${esc(m.g.oppName)} (${m.g.oppRating})<small>${new Date(m.g.end * 1000).toLocaleDateString()} · ${m.g.res === 'W' ? 'won' : m.g.res === 'L' ? 'lost' : 'drawn'} · ${m.counts.blun} blunders, ${m.counts.mist} mistakes · ${esc(m.g.variation)}</small></button>`).join('')}`;
  const nPz = res.reduce((a, { g, s, rv }) => { const p = kv.get('pz:' + g.url); return a + (p ? p.list.length : puzzlesFrom(g, s, rv).length); }, 0);
  box.innerHTML = `
    <div class="tiles">${tiles.map(([b, t]) => `<div class="tile"><b>${b}</b><span>${t}</span></div>`).join('')}</div>
    ${nPz ? `<div class="trainCta"><p style="margin:0"><b>${nPz} of your mistakes</b> from these games are ready to practise as puzzles.</p><button class="primary" data-act="train">Train these mistakes</button></div>` : ''}
    <div class="grid2 even">
      <div><h2>What goes wrong <span class="muted">Your mistakes and blunders by type</span></h2>${typesHtml}</div>
      <div><h2>Mistakes and the clock</h2>${clockHtml}</div>
    </div>
    <div class="grid2">
      <div><h2>Accuracy by phase</h2>${phases.map(([p, v]) => `<div class="row"><div class="lab"><span>${p[0].toUpperCase() + p.slice(1)}</span><span class="muted">${v == null ? 'no data' : v + '%'}</span></div><div class="meter"><i style="width:${v || 0}%"></i></div></div>`).join('')}
        ${weakest ? `<p class="muted" style="margin:.4rem 0 0">Your weakest phase is the ${weakest[0]}. Review the games where your ${weakest[0]} accuracy dropped.</p>` : ''}</div>
      <div><h2>Accuracy, oldest to newest game</h2><div class="trend">${mine.map((m) => `<i style="height:${hh(m.acc)}%" class="${m.g.res}" title="${new Date(m.g.end * 1000).toLocaleDateString()} vs ${esc(m.g.oppName)}: ${m.acc}% (${m.g.res === 'W' ? 'won' : m.g.res === 'L' ? 'lost' : 'drawn'})"></i>`).join('')}</div></div>
    </div>
    ${repHtml}
    ${reviewHtml}
    ${orows.length ? `<h2 style="margin-top:1rem">Accuracy by opening <span class="muted">Openings with at least 2 analyzed games, weakest first. "First slip" is the average move of your first inaccuracy or worse.</span></h2><div class="scroll"><table><thead><tr><th>Opening</th><th>Games</th><th>Accuracy</th><th>First slip</th></tr></thead><tbody>${orows.slice(0, 8).map(([k, c, a, f]) => `<tr><td class="name">${esc(k)}</td><td>${c}</td><td>${a}%</td><td>${f == null ? '-' : 'move ' + f}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
}
$('#batchN').addEventListener('change', renderInsights);
$('#insights').addEventListener('click', (e) => {
  if (e.target.closest('[data-act="train"]')) return tab('train');
  const b = e.target.closest('[data-url]'); if (!b) return;
  const g = state.games.find((x) => x.url === b.dataset.url); if (!g) return;
  tab('review'); openGame(g); if (b.dataset.ply) go(+b.dataset.ply); renderList();
});

/* ---------- evaluation bar, coach and graph ---------- */
function evText(cp) { return Math.abs(cp) >= 9000 ? (cp > 0 ? 'M' : '-M') + (10000 - Math.abs(cp)) : (cp > 0 ? '+' : '') + (cp / 100).toFixed(1); }
/* short form for the narrow bar: +0.4, -3.2, +12, M3 */
function evShort(cp) { if (Math.abs(cp) >= 9000) return (cp > 0 ? 'M' : '-M') + (10000 - Math.abs(cp)); const v = cp / 100; return (v > 0 ? '+' : '') + (Math.abs(v) >= 10 ? Math.round(v) : v.toFixed(1)); }
function setEvalBar(cp) {
  const fill = $('#evalFill'); const num = $('#evalNum'); const bar = $('#evalBar');
  // the light part is White's share of the winning chances, drawn from White's side of the board
  const h = cp == null ? 50 : winPct(cp);
  fill.style.height = h + '%'; fill.style.bottom = state.flip ? 'auto' : '0'; fill.style.top = state.flip ? '0' : 'auto';
  if (cp == null) { num.textContent = ''; bar.setAttribute('aria-label', 'Evaluation not available'); return; }
  // the number sits at the end of whoever is ahead, in the color that contrasts with that end
  const atBottom = (cp >= 0) !== state.flip;
  num.textContent = evShort(cp); num.style.top = atBottom ? 'auto' : '0'; num.style.bottom = atBottom ? '0' : 'auto';
  num.style.color = cp >= 0 ? 'var(--evalb)' : 'var(--evalw)';
  bar.setAttribute('aria-label', `Evaluation ${evText(cp)}: ${Math.abs(cp) < 30 ? 'about equal' : (cp > 0 ? 'White' : 'Black') + ' is better'}`);
}
function coachHtml(s, rv, ply) {
  const cp = rv.evals[ply].cp;
  if (!ply) return `<div class="coachHead"><b>Starting position</b><span class="muted" style="margin:0">Evaluation ${evText(cp)}</span></div>`;
  const c = rv.cls[ply - 1]; const m = s.moves[ply - 1]; const ex = c.ex;
  let head = `<span class="badge k-${c.t}">${c.label}</span>`;
  if (ex && ex.type !== 'opp') head += `<span class="badge type">${MTYPES[ex.type].label}</span>`;
  else if (c.missed) head += '<span class="badge k-mist">Missed tactic</span>';
  if (ex && ex.tag) head += `<span class="badge tag">${ex.tag.label}</span>`;
  head += `<b>${moveName(ply - 1, m.san)}</b><span class="muted" style="margin:0">Evaluation ${evText(cp)}</span>`;
  if (ply === s.moves.length) head += `<span class="badge fin-${s.g.res}">${esc(finishText(s.g))}</span>`;
  if (!ex) {
    const hint = ['inacc', 'mist', 'blun'].includes(c.t) && c.bestSan ? `<p class="why">Engine preferred ${esc(c.bestSan)} (green arrow).</p>` : '';
    return `<div class="coachHead">${head}</div>${hint}<div class="acts">${teachBtnHtml('review')}</div>`;
  }
  const mineMove = ex.type !== 'opp';
  const acts = [];
  if (ex.refUci.length) acts.push(`<button data-act="ref">${mineMove ? 'See their best reply' : 'See the best answer'}</button>`);
  if (mineMove && ex.bestUci.length) acts.push('<button data-act="best">See the better move</button>');
  if (mineMove) acts.push('<button data-act="try">Try another move</button>');
  acts.push(teachBtnHtml('review'));
  const legend = `<span class="legend"><i class="sw sw-best"></i>better move${c.drop >= 20 ? '<i class="sw sw-ref"></i>best reply' : ''}</span>`;
  const old = mineMove && !ex.detailed ? '<p class="muted small">This game was analyzed by an older version. Analyze it again for a fuller explanation.</p>' : '';
  return `<div class="coachHead">${head}</div><p class="why">${esc(ex.text)}${ex.tag ? ' ' + esc(ex.tag.text) : ''}</p><div class="acts">${acts.join('')}${legend}</div>${old}`;
}
function renderEval() {
  const s = state.sel; const rv = state.review; const coach = $('#coach');
  coach.hidden = state.mode !== 'game';
  if (state.mode === 'guess') { setEvalBar(null); drawEval(); return; }
  if (!rv) {
    setEvalBar(null);
    if (!$('#bAnalyze').disabled) coach.innerHTML = s ? '<span class="muted" style="margin:0">Press Analyze with Stockfish for evaluations, accuracy, and an explanation of every mistake.</span>' : '';
    drawEval(); return;
  }
  setEvalBar(rv.evals[state.ply].cp);
  coach.innerHTML = coachHtml(s, rv, state.ply);
  drawEval();
}
$('#coach').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b || !state.review || !state.ply) return;
  const s = state.sel; const i = state.ply - 1; const ex = state.review.cls[i].ex; if (!ex) return;
  if (b.dataset.act === 'ref') startExplore(s.fens[i + 1], ex.refUci, 1, s.moves[i], ex.type === 'opp' ? 'The best answer' : 'Their best reply');
  else if (b.dataset.act === 'best') startExplore(s.fens[i], ex.bestUci, 1, s.moves[i - 1], 'The better move');
  else if (b.dataset.act === 'try') startExplore(s.fens[i], [], 0, s.moves[i - 1], 'Your own moves');
});
function drawEval() {
  const c = $('#evalChart'); if (!c.clientWidth) return; const { x, w, h } = fitCanvas(c); x.clearRect(0, 0, w, h);
  const rv = state.review;
  if (!rv) { x.fillStyle = css('--muted'); x.font = '14px "Source Sans 3", system-ui'; x.fillText('Analyze the game to see how the evaluation moved.', 4, 26); return; }
  const n = rv.evals.length; const px = (i) => 4 + (i / (n - 1 || 1)) * (w - 8); const py = (cp) => h - (winPct(cp) / 100) * h;
  const upto = state.mode === 'guess' ? state.ply : n - 1; // guessing: do not show the future
  const ev = rv.evals.slice(0, upto + 1);
  x.beginPath(); x.moveTo(px(0), h); ev.forEach((e, i) => x.lineTo(px(i), py(e.cp))); x.lineTo(px(ev.length - 1), h); x.closePath();
  x.fillStyle = css('--accent'); x.globalAlpha = 0.25; x.fill(); x.globalAlpha = 1;
  x.fillStyle = css('--line'); x.fillRect(0, h / 2, w, 1);
  x.strokeStyle = css('--accent'); x.lineWidth = 2; x.beginPath(); ev.forEach((e, i) => (i ? x.lineTo(px(i), py(e.cp)) : x.moveTo(px(i), py(e.cp)))); x.stroke();
  const colors = { brill: css('--brill'), mist: css('--mist'), blun: css('--blun') };
  rv.cls.forEach((cl, i) => { if (i + 1 <= upto && colors[cl.t]) { x.fillStyle = colors[cl.t]; x.beginPath(); x.arc(px(i + 1), py(rv.evals[i + 1].cp), 4, 0, 7); x.fill(); } });
  x.fillStyle = css('--fg'); x.fillRect(px(state.ply) - 1, 0, 2, h);
}
(function scrub() {
  const c = $('#evalChart'); let down = false;
  const at = (e) => { if (!state.review || state.mode === 'guess') return; const r = c.getBoundingClientRect(); go(Math.round(((e.clientX - r.left - 4) / (r.width - 8)) * (state.review.evals.length - 1))); };
  c.addEventListener('pointerdown', (e) => { down = true; c.setPointerCapture(e.pointerId); at(e); });
  c.addEventListener('pointermove', (e) => { if (down) at(e); });
  c.addEventListener('pointerup', () => { down = false; });
})();
/* Redraw only the charts, and only when the width changes. Phones fire resize events when the
   address bar collapses while scrolling (height only), which must not rebuild the page. */
let lastW = window.innerWidth; let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (window.innerWidth === lastW) return; lastW = window.innerWidth;
    if (!$('#stats').hidden) drawRating(filtered()); else drawEval();
  }, 150);
});

$('#notesBox').addEventListener('input', () => { if (state.sel) kv.set('note:' + state.sel.g.url, $('#notesBox').value); });

/* ---------- start: reopen the last username from storage, or from ?u=name ---------- */
async function boot() {
  await kv.ready;
  const q = new URLSearchParams(location.search).get('u');
  const user = (q || prefs.get('user') || '').toLowerCase();
  if (!user) return;
  $('#user').value = user;
  const cached = kv.get('games:' + user);
  if (cached && cached.games && cached.games.length) {
    state.user = user; state.games = cached.games; setStatus(`${cached.games.length} saved games for ${user}. Press Import games to refresh.`); show();
  } else importGames(user, +$('#months').value);
}
