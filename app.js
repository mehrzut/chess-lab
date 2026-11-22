/* Chess Lab: imports games from chess.com's public API, shows opening and endgame stats,
   and reviews games with Stockfish running in the browser. No server is needed. */

const $ = (s) => document.querySelector(s);
const API = 'https://api.chess.com/pub/player/';
const PIECE_URL = 'https://cdn.jsdelivr.net/gh/lichess-org/lila@master/public/piece/cburnett/';
const SF_URLS = [
  'https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js',
  'https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js',
];
const state = {
  user: '', games: [], filter: { color: 'all', tc: 'all', group: 'family', opening: null, period: 'all' }, list: { sort: 'new', result: 'all', q: '', analyzed: false },
  sortKey: 'games', sortDir: -1, sel: null, ply: 0, flip: false, review: null, token: 0, side: 'moves', timer: null, busy: null,
};

/* ---------- small storage helpers (all wrapped: storage can be blocked) ---------- */
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem('chesslab:' + k)); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem('chesslab:' + k, JSON.stringify(v)); return true; } catch (_) { return false; } },
};

/* ---------- theme ---------- */
(function theme() {
  const t = store.get('theme'); if (t) document.documentElement.dataset.theme = t;
  $('#themeBtn').onclick = () => {
    const dark = getComputedStyle(document.documentElement).colorScheme === 'dark';
    const next = dark ? 'light' : 'dark'; document.documentElement.dataset.theme = next; store.set('theme', next);
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
    setStatus('Finding archives...');
    const { archives } = await getJSON(`${API}${user}/games/archives`);
    const list = months ? archives.slice(-months) : archives;
    const cached = store.get('games:' + user);
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
    store.set('games:' + user, { games, months: list });
    store.set('user', user);
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
  const how = res === 'D' ? 'Draw' : (HOW[raw] || 'Other');
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
const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
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
  $('#stats').hidden = name !== 'stats'; $('#review').hidden = name !== 'review';
  if (name === 'stats') renderStats(); else drawEval();
}
$('#tabs').addEventListener('click', (e) => { if (e.target.dataset.tab) tab(e.target.dataset.tab); });
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
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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

function fitCanvas(c) {
  const dpr = window.devicePixelRatio || 1; const w = c.clientWidth; const h = +c.getAttribute('height');
  c.width = w * dpr; c.height = h * dpr; const x = c.getContext('2d'); x.scale(dpr, dpr); return { x, w, h };
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
  if (!accMemo.has(g.url)) { const x = store.get('anx:' + g.url); accMemo.set(g.url, x ? x.acc : null); }
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
    return `<button class="g" data-i="${i}"><span class="r ${g.res}">${g.res}</span>vs ${esc(g.oppName)} (${g.oppRating})${dl}<small>${new Date(g.end * 1000).toLocaleDateString()} · ${g.tc} · ${g.color} · ${g.moveCount} moves${ac}<br>${esc(g.variation)}</small></button>`;
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
  const rep = new Chess(); const fens = [rep.fen()];
  moves.forEach((m) => { rep.move(m.san); fens.push(rep.fen()); });
  const clocks = parseClocks(g.pgn);
  const inc = +(String(g.tcontrol || '').split('+')[1] || 0);
  const base = +String(g.tcontrol || '').split('+')[0].split('/').pop() || null;
  const spent = moves.map((m, i) => { const prev = i >= 2 ? clocks[i - 2] : base; return clocks[i] != null && prev != null ? Math.max(0, prev - clocks[i] + inc) : null; });
  return { g, moves, fens, clocks, spent, base };
}
function openGame(g) {
  state.token++; stopPlay();
  state.sel = prepare(g);
  state.ply = 0; state.flip = g.color === 'black'; state.review = null;
  $('#progress').hidden = true; $('#bAnalyze').disabled = !!state.busy;
  const cached = store.get('an2:' + g.url);
  if (cached && cached.evals) state.review = buildReview(state.sel, cached.evals, cached.depth);
  renderMeta(); renderGame(); renderSide();
}
function renderMeta() {
  const { g } = state.sel; const d = new Date(g.end * 1000);
  const res = g.res === 'W' ? 'You won' : g.res === 'L' ? 'You lost' : 'Draw';
  $('#gameMeta').innerHTML = `<b>${esc(g.variation)}</b><span class="muted" style="margin:0">${g.eco ? g.eco + ' · ' : ''}${res} by ${esc(g.how.toLowerCase())} · ${g.tc} ${esc(g.tcontrol || '')} · ${d.toLocaleDateString()}</span><a href="${esc(g.url)}" target="_blank" rel="noopener">Open on chess.com</a>`;
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

function renderGame() {
  const s = state.sel; if (!s) return;
  const fen = s.fens[state.ply]; const rows = fen.split(' ')[0].split('/');
  const cells = [];
  rows.forEach((row, r) => { let f = 0; for (const ch of row) { if (/\d/.test(ch)) { for (let i = 0; i < +ch; i++) cells.push({ r, f: f++ }); } else cells.push({ r, f: f++, p: ch }); } });
  const last = s.moves[state.ply - 1]; const cl = state.review && state.ply ? state.review.cls[state.ply - 1] : null;
  const order = state.flip ? cells.slice().reverse() : cells;
  const first = order[0];
  $('#board').innerHTML = order.map((c, idx) => {
    const dark = (c.r + c.f) % 2 === 1; const n = 'abcdefgh'[c.f] + (8 - c.r);
    const hl = last && (last.from === n || last.to === n) ? ' hl' : '';
    const pc = c.p ? `<img alt="" draggable="false" src="${PIECE_URL}${c.p === c.p.toUpperCase() ? 'w' : 'b'}${c.p.toUpperCase()}.svg">` : '';
    const col = idx >= 56 ? `<span class="co f">${'abcdefgh'[c.f]}</span>` : '';
    const rk = idx % 8 === 0 ? `<span class="co r">${8 - c.r}</span>` : '';
    const mk = cl && last && last.to === n && cl.sym ? `<span class="mk k-${cl.t}">${cl.sym}</span>` : '';
    return `<div class="sq ${dark ? 'd' : 'l'}${hl}">${rk}${col}${pc}${mk}</div>`;
  }).join('');
  drawArrows(); renderBars(); renderMoves(); renderEval();
}
function drawArrows() {
  const svg = $('#arrows'); svg.innerHTML = '';
  const rv = state.review; const s = state.sel; if (!rv || !state.ply) return;
  const c = rv.cls[state.ply - 1]; if (!c || !['inacc', 'mist', 'blun'].includes(c.t)) return;
  const best = rv.evals[state.ply - 1].best; if (!best || best === '(none)') return;
  const pt = (sq) => { let f = 'abcdefgh'.indexOf(sq[0]), r = 8 - +sq[1]; if (state.flip) { f = 7 - f; r = 7 - r; } return [f + .5, r + .5]; };
  const [x1, y1] = pt(best.slice(0, 2)), [x2, y2] = pt(best.slice(2, 4));
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len, hx = x2 - ux * .32, hy = y2 - uy * .32;
  svg.innerHTML = `<g opacity=".85" fill="#3d9f68" stroke="#3d9f68"><line x1="${x1}" y1="${y1}" x2="${hx}" y2="${hy}" stroke-width=".16" stroke-linecap="round"/><polygon stroke="none" points="${x2},${y2} ${hx - uy * .22},${hy + ux * .22} ${hx + uy * .22},${hy - ux * .22}"/></g>`;
}
function renderBars() {
  const s = state.sel; const g = s.g; const cb = capturedBy(s.fens[state.ply]);
  const clk = (white) => { // last clock reading for this side at the current ply
    let i = state.ply - 1; while (i >= 0 && (i % 2 === 0) !== white) i--;
    return i >= 0 ? s.clocks[i] : s.base;
  };
  const me = g.color; const opp = me === 'white' ? 'black' : 'white';
  const data = {
    white: { name: me === 'white' ? state.user : g.oppName, rating: me === 'white' ? g.rating : g.oppRating, cap: cb.byWhite, adv: cb.diff, acc: state.review ? state.review.acc.w : null },
    black: { name: me === 'black' ? state.user : g.oppName, rating: me === 'black' ? g.rating : g.oppRating, cap: cb.byBlack, adv: -cb.diff, acc: state.review ? state.review.acc.b : null },
  };
  const line = (c) => { const d = data[c]; const plus = d.adv > 0 ? ` +${d.adv}` : ''; return `<span class="nm">${esc(d.name)}</span><span class="rt">${d.rating}</span><span class="cap">${d.cap.map((k) => G[k]).join('')}<b>${plus}</b></span>${d.acc != null ? `<span class="acc">${d.acc}% accuracy</span>` : ''}<span class="clock" title="Time left">${fmtClock(clk(c === 'white'))}</span>`; };
  const top = state.flip ? 'white' : 'black', bot = state.flip ? 'black' : 'white';
  $('#topBar').innerHTML = line(top); $('#botBar').innerHTML = line(bot);
}

function renderMoves() {
  const s = state.sel; const rv = state.review; let h = '';
  s.moves.forEach((m, i) => {
    if (i % 2 === 0) h += `<span class="n">${i / 2 + 1}.</span>`;
    const c = rv && rv.cls[i];
    const dot = c && c.t !== 'good' && c.t !== 'best' ? `<span class="dot k-${c.t}" title="${c.label}"></span>` : '';
    const t = s.spent[i] != null ? `<small>${s.spent[i] < 10 ? s.spent[i].toFixed(1) : Math.round(s.spent[i])}s</small>` : '';
    h += `<button class="mv${state.ply === i + 1 ? ' on' : ''}" data-p="${i + 1}"><span>${m.san}${dot}</span>${t}</button>`;
  });
  const box = $('#sMoves'); const keep = box.scrollTop; box.innerHTML = h;
  const on = box.querySelector('.mv.on');
  if (on) { const t = on.offsetTop; if (t < box.scrollTop || t + on.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = Math.max(0, t - box.clientHeight / 2); } else box.scrollTop = keep;
}
$('#sMoves').addEventListener('click', (e) => { const b = e.target.closest('.mv'); if (b) go(+b.dataset.p); });
function go(p) { if (!state.sel) return; state.ply = Math.max(0, Math.min(state.sel.moves.length, p)); renderGame(); }
function stopPlay() { if (state.timer) { clearInterval(state.timer); state.timer = null; $('#bPlay').textContent = 'Play'; } }
$('#bPlay').onclick = () => {
  if (state.timer) return stopPlay(); if (!state.sel) return;
  if (state.ply >= state.sel.moves.length) go(0);
  $('#bPlay').textContent = 'Pause';
  state.timer = setInterval(() => { if (state.ply >= state.sel.moves.length) return stopPlay(); go(state.ply + 1); }, 900);
};
$('#bStart').onclick = () => go(0); $('#bPrev').onclick = () => go(state.ply - 1);
$('#bNext').onclick = () => go(state.ply + 1); $('#bEnd').onclick = () => go(1e9);
$('#bFlip').onclick = () => { state.flip = !state.flip; renderGame(); };
document.addEventListener('keydown', (e) => {
  if ($('#review').hidden || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); go(state.ply - 1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); go(state.ply + 1); }
  else if (e.key === 'Home') go(0); else if (e.key === 'End') go(1e9);
  else if (e.key === ' ' && document.activeElement.tagName !== 'BUTTON') { e.preventDefault(); $('#bPlay').click(); }
  else if (e.key.toLowerCase() === 'f') $('#bFlip').click();
});
$('#sideTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return; state.side = b.dataset.s; renderSide();
});
function renderSide() {
  document.querySelectorAll('#sideTabs button').forEach((b) => b.classList.toggle('on', b.dataset.s === state.side));
  $('#sMoves').hidden = state.side !== 'moves'; $('#sSummary').hidden = state.side !== 'summary'; $('#sMoments').hidden = state.side !== 'moments'; $('#sNotes').hidden = state.side !== 'notes';
  const rv = state.review; const s = state.sel;
  const nb = $('#notesBox'); nb.disabled = !s; if (document.activeElement !== nb) nb.value = s ? (store.get('note:' + s.g.url) || '') : '';
  if (!s) { $('#sSummary').innerHTML = $('#sMoments').innerHTML = '<p class="pending">Pick a game first.</p>'; return; }
  if (!rv) { $('#sSummary').innerHTML = $('#sMoments').innerHTML = '<p class="pending">Press Analyze with Stockfish to fill this in.</p>'; return; }
  const me = s.g.color === 'white' ? 'w' : 'b';
  const rowsQ = [['brill', 'Brilliant'], ['best', 'Best'], ['good', 'Good'], ['inacc', 'Inaccuracy'], ['mist', 'Mistake'], ['blun', 'Blunder']];
  const phases = ['opening', 'middlegame', 'endgame'].filter((p) => rv.phase[me][p] != null);
  const spentMine = s.spent.filter((v, i) => v != null && s.moves[i].color === me);
  const avgT = spentMine.length ? (spentMine.reduce((a, b) => a + b, 0) / spentMine.length).toFixed(1) : null;
  const slowest = spentMine.length ? Math.max(...spentMine) : null;
  $('#sSummary').innerHTML = `
    <div class="sumGrid"><div class="big"><b>${rv.acc.w}%</b><span>White accuracy</span></div><div class="big"><b>${rv.acc.b}%</b><span>Black accuracy</span></div></div>
    <table class="qt"><thead><tr><th>Move quality</th><th>White</th><th>Black</th></tr></thead><tbody>${rowsQ.map(([k, l]) => `<tr><td><span class="dot k-${k}" style="margin:0 .4rem 0 0"></span>${l}</td><td>${rv.counts.w[k]}</td><td>${rv.counts.b[k]}</td></tr>`).join('')}</tbody></table>
    <div class="facts">
      <p>Your accuracy by phase: ${phases.map((p) => `${p} ${rv.phase[me][p]}%`).join(', ') || 'not enough moves'}.</p>
      <p>Missed tactics (yours): ${rv.missed[me]}. Brilliant moves (yours): ${rv.counts[me][ 'brill' ]}.</p>
      ${avgT ? `<p>Average time per move: ${avgT}s. Longest think: ${Math.round(slowest)}s.</p>` : ''}
      <p>Opening: ${esc(s.g.variation)}${s.g.eco ? ' (' + s.g.eco + ')' : ''}. Engine depth ${rv.depth || '?'}.</p>
    </div>`;
  const mine = rv.cls.map((c, i) => ({ c, i })).filter((x) => x.c.t === 'brill' || x.c.drop >= 10).sort((a, b) => (b.c.t === 'brill') - (a.c.t === 'brill') || b.c.drop - a.c.drop).slice(0, 8);
  $('#sMoments').innerHTML = mine.length ? mine.map(({ c, i }) => {
    const m = s.moves[i]; const num = Math.floor(i / 2) + 1; const who = m.color === me ? 'You' : s.g.oppName;
    return `<button class="moment" data-p="${i + 1}"><span class="badge k-${c.t}">${c.label}</span> ${num}${m.color === 'w' ? '.' : '...'} ${m.san}<small>${esc(who)}${c.drop >= 10 && c.bestSan ? `, engine preferred ${c.bestSan}` : ''}${c.missed ? ', missed a tactic' : ''}</small></button>`;
  }).join('') : '<p class="pending">No big swings in this game.</p>';
}
$('#sMoments').addEventListener('click', (e) => { const b = e.target.closest('.moment'); if (b) { go(+b.dataset.p); } });

/* ---------- Stockfish ---------- */
let enginePromise = null;
function getEngine() {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    let src = null;
    for (const u of SF_URLS) { try { const r = await fetch(u); if (r.ok) { src = await r.text(); break; } } catch (_) { /* try next */ } }
    if (!src) throw new Error('Could not download Stockfish. Check your connection and try again.');
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    const eng = { w, handler: null };
    w.onmessage = (e) => { const l = typeof e.data === 'string' ? e.data : ''; if (eng.handler) eng.handler(l); };
    await new Promise((res) => { eng.handler = (l) => { if (l.startsWith('uciok')) res(); }; w.postMessage('uci'); });
    // Stockfish 10 defaults to Contempt 24, which inflates the score of the side to move
    // (the start position reads about +1.2). Zero it so evaluations are neutral.
    w.postMessage('setoption name Contempt value 0');
    await engineReady(eng);
    return eng;
  })();
  enginePromise.catch(() => { enginePromise = null; });
  return enginePromise;
}
function engineReady(eng) {
  return new Promise((res) => { eng.handler = (l) => { if (l === 'readyok') { eng.handler = null; res(); } }; eng.w.postMessage('isready'); });
}
/* Evaluates every position of a prepared game. Returns null if cancelled(). */
async function runEvals(s, depth, cancelled, onStep) {
  const eng = await getEngine();
  eng.w.postMessage('ucinewgame'); await engineReady(eng);
  const evals = [];
  for (let i = 0; i < s.fens.length; i++) {
    if (cancelled()) return null;
    evals.push(await evalFen(eng, s.fens[i], depth));
    if (onStep) onStep(i + 1, s.fens.length);
  }
  return evals;
}
function evalFen(eng, fen, depth) {
  const ch = new Chess(fen); const turn = fen.split(' ')[1]; const sgn = turn === 'w' ? 1 : -1;
  if (ch.game_over()) return Promise.resolve({ cp: ch.in_checkmate() ? -sgn * 10000 : 0, best: null });
  return new Promise((res) => {
    let last = null;
    eng.handler = (l) => {
      if (l.startsWith('info') && l.includes(' score ') && !/bound/.test(l)) {
        const m = l.match(/score (cp|mate) (-?\d+)/); if (m) last = { t: m[1], v: +m[2] };
      } else if (l.startsWith('bestmove')) {
        eng.handler = null; let cp = 0;
        if (last) cp = last.t === 'cp' ? last.v : (last.v > 0 ? 10000 - last.v : -10000 - last.v);
        res({ cp: cp * sgn, best: l.split(' ')[1] });
      }
    };
    eng.w.postMessage('position fen ' + fen); eng.w.postMessage('go depth ' + depth);
  });
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
const winPct = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * Math.max(-1500, Math.min(1500, cp)))) - 1);
/* Thresholds are drops in win probability for the side that moved, in percentage points.
   They follow the scale Lichess uses: 10 inaccuracy, 20 mistake, 30 blunder. */
const CLS = [[2, 'best', '', 'Best'], [10, 'good', '', 'Good'], [20, 'inacc', '?!', 'Inaccuracy'], [30, 'mist', '?', 'Mistake'], [101, 'blun', '??', 'Blunder']];

/* evals is [{cp, best}] for every position; everything else is derived from it, so it can be cached */
function buildReview(s, evals, depth) {
  const cls = []; const acc = { w: [], b: [] }; const phaseAcc = { w: {}, b: {} };
  const counts = { w: {}, b: {} }; const missed = { w: 0, b: 0 };
  ['brill', 'best', 'good', 'inacc', 'mist', 'blun'].forEach((k) => { counts.w[k] = 0; counts.b[k] = 0; });
  s.moves.forEach((m, i) => {
    const mover = m.color === 'w' ? 1 : -1;
    const before = winPct(evals[i].cp * mover), after = winPct(evals[i + 1].cp * mover);
    const drop = Math.max(0, before - after);
    const bu = evals[i].best; const played = m.from + m.to + (m.promotion || '');
    let c = bu && played === bu ? CLS[0] : CLS.find((x) => drop <= x[0]);
    const a = Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * (bu && played === bu ? 0 : drop)) - 3.1669));
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
    cls.push({ t: c[1], sym: c[2], label: c[3], drop, bestSan, missed: miss });
  });
  const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);
  const phase = { w: {}, b: {} };
  ['w', 'b'].forEach((c) => Object.keys(phaseAcc[c]).forEach((p) => { phase[c][p] = avg(phaseAcc[c][p]); }));
  return { evals, cls, counts, missed, phase, depth, acc: { w: avg(acc.w), b: avg(acc.b) } };
}

$('#bAnalyze').addEventListener('click', async () => {
  const s = state.sel; if (!s) return;
  if (state.busy) { $('#coach').textContent = 'The engine is busy with the batch analysis. Stop it first, or wait for it to finish.'; return; }
  stopPlay();
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

/* ---------- batch insights: analyse recent games, then summarise tactics, phases and openings ---------- */
const ins = { running: false, token: 0 };
const rvMemo = new Map();
function saveAnalysis(s, evals, depth) {
  store.set('an2:' + s.g.url, { evals, depth }); rvMemo.clear();
  const rv = buildReview(s, evals, depth); const c = s.g.color === 'white' ? 'w' : 'b';
  store.set('anx:' + s.g.url, { acc: rv.acc[c], blun: rv.counts[c].blun }); accMemo.delete(s.g.url);
  return rv;
}
function reviewFor(g) {
  const c = store.get('an2:' + g.url); if (!c || !c.evals) return null;
  const key = g.url + ':' + c.evals.length + ':' + c.depth; if (rvMemo.has(key)) return rvMemo.get(key);
  const s = prepare(g); if (!s.moves.length || c.evals.length !== s.fens.length) return null;
  const rv = buildReview(s, c.evals, c.depth); rvMemo.set(key, rv); return rv;
}
function recentGames(n) { return state.games.slice().reverse().slice(0, n); }
function insightResults(n) {
  const out = [];
  recentGames(n).forEach((g) => { const rv = reviewFor(g); if (rv) out.push({ g, rv }); });
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
      const cached = store.get('an2:' + g.url);
      if (cached && cached.evals && cached.evals.length === s.fens.length) { if (!store.get('anx:' + g.url)) saveAnalysis(s, cached.evals, cached.depth); renderInsights(); continue; }
      if (!s.moves.length) continue;
      $('#batchMsg').textContent = `Analyzing game ${done} of ${list.length}...`;
      const evals = await runEvals(s, 10, () => token !== ins.token, (i, m) => {
        $('#batchBar span').style.width = (((done - 1) + i / m) / list.length) * 100 + '%';
      });
      if (!evals) break;
      saveAnalysis(s, evals, 10); renderInsights(); renderList();
    }
  } catch (err) { $('#batchMsg').textContent = err.message; }
  ins.running = false; state.busy = null; $('#batchBtn').textContent = 'Analyze recent games'; $('#batchBar').hidden = true; $('#bAnalyze').disabled = false;
  renderInsights();
});
function renderInsights() {
  const n = +$('#batchN').value; const res = insightResults(n); const box = $('#insights');
  $('#batchMsg').textContent = ins.running ? $('#batchMsg').textContent : `${res.length} of your last ${Math.min(n, state.games.length)} games are analyzed.`;
  if (!res.length) { box.innerHTML = '<p class="muted" style="margin:0">Analyze your recent games to see your accuracy, tactics and weakest phase. Analysis runs on your device and takes about 15 to 30 seconds per game.</p>'; return; }
  const mine = res.map(({ g, rv }) => { const c = g.color === 'white' ? 'w' : 'b'; return { g, acc: rv.acc[c], phase: rv.phase[c], counts: rv.counts[c], missed: rv.missed[c] }; });
  const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
  const sum = (k) => mine.reduce((a, m) => a + m.counts[k], 0); const per = (v) => (v / mine.length).toFixed(1);
  const phases = ['opening', 'middlegame', 'endgame'].map((p) => [p, avg(mine.map((m) => m.phase[p]).filter((v) => v != null))]);
  const known = phases.filter((p) => p[1] != null); const weakest = known.length ? known.reduce((a, b) => (b[1] < a[1] ? b : a)) : null;
  const tiles = [[avg(mine.map((m) => m.acc)) + '%', 'average accuracy'], [per(sum('blun')), 'blunders per game'], [per(sum('mist')), 'mistakes per game'],
    [per(sum('inacc')), 'inaccuracies per game'], [per(mine.reduce((a, m) => a + m.missed, 0)), 'missed tactics per game'], [sum('brill'), 'brilliant moves in total']];
  const byOpen = groupBy(mine, (m) => m.g.family);
  const orows = [...byOpen].filter(([, x]) => x.length >= 2).map(([k, x]) => [k, x.length, avg(x.map((m) => m.acc))]).sort((a, b) => a[2] - b[2]);
  const hh = (v) => Math.max(6, v);
  const worst = mine.slice().sort((a, b) => a.acc - b.acc).slice(0, 5);
  const reviewHtml = `<h2 style="margin-top:1rem">Games to review first <span class="muted">Lowest accuracy among the analyzed games</span></h2>${worst.map((m) => `<button class="moment" data-url="${esc(m.g.url)}"><b>${m.acc}%</b> accuracy vs ${esc(m.g.oppName)} (${m.g.oppRating})<small>${new Date(m.g.end * 1000).toLocaleDateString()} · ${m.g.res === 'W' ? 'won' : m.g.res === 'L' ? 'lost' : 'drawn'} · ${m.counts.blun} blunders, ${m.counts.mist} mistakes · ${esc(m.g.variation)}</small></button>`).join('')}`;
  box.innerHTML = `
    <div class="tiles">${tiles.map(([b, t]) => `<div class="tile"><b>${b}</b><span>${t}</span></div>`).join('')}</div>
    <div class="grid2">
      <div><h2>Accuracy by phase</h2>${phases.map(([p, v]) => `<div class="row"><div class="lab"><span>${p[0].toUpperCase() + p.slice(1)}</span><span class="muted">${v == null ? 'no data' : v + '%'}</span></div><div class="meter"><i style="width:${v || 0}%"></i></div></div>`).join('')}
        ${weakest ? `<p class="muted" style="margin:.4rem 0 0">Your weakest phase is the ${weakest[0]}. Review the games where your ${weakest[0]} accuracy dropped.</p>` : ''}</div>
      <div><h2>Accuracy, oldest to newest game</h2><div class="trend">${mine.map((m) => `<i style="height:${hh(m.acc)}%" class="${m.g.res}" title="${new Date(m.g.end * 1000).toLocaleDateString()} vs ${esc(m.g.oppName)}: ${m.acc}% (${m.g.res === 'W' ? 'won' : m.g.res === 'L' ? 'lost' : 'drawn'})"></i>`).join('')}</div></div>
    </div>
    ${reviewHtml}
    ${orows.length ? `<h2 style="margin-top:1rem">Accuracy by opening <span class="muted">Openings with at least 2 analyzed games, weakest first</span></h2><div class="scroll"><table><thead><tr><th>Opening</th><th>Games</th><th>Accuracy</th></tr></thead><tbody>${orows.slice(0, 8).map(([k, c, a]) => `<tr><td class="name">${esc(k)}</td><td>${c}</td><td>${a}%</td></tr>`).join('')}</tbody></table></div>` : ''}`;
}
$('#batchN').addEventListener('change', renderInsights);
$('#insights').addEventListener('click', (e) => {
  const b = e.target.closest('[data-url]'); if (!b) return;
  const g = state.games.find((x) => x.url === b.dataset.url); if (g) { openGame(g); tab('review'); }
});

function evText(cp) { return Math.abs(cp) >= 9000 ? (cp > 0 ? 'M' : '-M') : (cp > 0 ? '+' : '') + (cp / 100).toFixed(1); }
function renderEval() {
  const s = state.sel; const rv = state.review; const fill = $('#evalFill'); const coach = $('#coach'); const num = $('#evalNum');
  if (!rv) {
    fill.style.height = '50%'; fill.style.bottom = '0'; fill.style.top = 'auto'; num.textContent = '';
    if (!$('#bAnalyze').disabled) coach.textContent = s ? 'Press Analyze with Stockfish for evaluations, accuracy, mistakes and brilliant moves.' : '';
    drawEval(); return;
  }
  const cp = rv.evals[state.ply].cp; let h = winPct(cp); if (state.flip) h = 100 - h;
  fill.style.height = h + '%'; fill.style.bottom = state.flip ? 'auto' : '0'; fill.style.top = state.flip ? '0' : 'auto';
  num.textContent = evText(cp); num.style.top = (cp >= 0) !== state.flip ? 'auto' : '0'; num.style.bottom = (cp >= 0) !== state.flip ? '0' : 'auto';
  num.style.color = (cp >= 0) ? 'var(--evalb)' : 'var(--evalw)';
  const c = state.ply ? rv.cls[state.ply - 1] : null; const m = state.ply ? s.moves[state.ply - 1] : null;
  const bad = c && ['inacc', 'mist', 'blun'].includes(c.t);
  coach.innerHTML = c
    ? `<span class="badge k-${c.t}">${c.label}</span>${c.missed ? '<span class="badge k-mist">Missed tactic</span>' : ''}<b>${Math.floor((state.ply - 1) / 2) + 1}${m.color === 'w' ? '.' : '...'} ${m.san}</b><span class="muted" style="margin:0">Evaluation ${evText(cp)}${bad && c.bestSan ? `. Engine preferred ${c.bestSan} (green arrow).` : ''}</span>`
    : `<b>Starting position</b><span class="muted" style="margin:0">Evaluation ${evText(cp)}</span>`;
  drawEval();
}
function drawEval() {
  const c = $('#evalChart'); if (!c.clientWidth) return; const { x, w, h } = fitCanvas(c); x.clearRect(0, 0, w, h);
  const rv = state.review;
  if (!rv) { x.fillStyle = css('--muted'); x.font = '14px "Source Sans 3", system-ui'; x.fillText('Analyze the game to see how the evaluation moved.', 4, 26); return; }
  const n = rv.evals.length; const px = (i) => 4 + (i / (n - 1 || 1)) * (w - 8); const py = (cp) => h - (winPct(cp) / 100) * h;
  x.beginPath(); x.moveTo(px(0), h); rv.evals.forEach((e, i) => x.lineTo(px(i), py(e.cp))); x.lineTo(px(n - 1), h); x.closePath();
  x.fillStyle = css('--accent'); x.globalAlpha = 0.25; x.fill(); x.globalAlpha = 1;
  x.fillStyle = css('--line'); x.fillRect(0, h / 2, w, 1);
  x.strokeStyle = css('--accent'); x.lineWidth = 2; x.beginPath(); rv.evals.forEach((e, i) => (i ? x.lineTo(px(i), py(e.cp)) : x.moveTo(px(i), py(e.cp)))); x.stroke();
  const colors = { brill: css('--brill'), mist: css('--mist'), blun: css('--blun') };
  rv.cls.forEach((cl, i) => { if (colors[cl.t]) { x.fillStyle = colors[cl.t]; x.beginPath(); x.arc(px(i + 1), py(rv.evals[i + 1].cp), 4, 0, 7); x.fill(); } });
  x.fillStyle = css('--fg'); x.fillRect(px(state.ply) - 1, 0, 2, h);
}
(function scrub() {
  const c = $('#evalChart'); let down = false;
  const at = (e) => { if (!state.review) return; const r = c.getBoundingClientRect(); go(Math.round(((e.clientX - r.left - 4) / (r.width - 8)) * (state.review.evals.length - 1))); };
  c.addEventListener('pointerdown', (e) => { down = true; c.setPointerCapture(e.pointerId); at(e); });
  c.addEventListener('pointermove', (e) => { if (down) at(e); });
  c.addEventListener('pointerup', () => { down = false; });
})();
window.addEventListener('resize', () => { if (!$('#stats').hidden) renderStats(); else drawEval(); });

/* ---------- start: reopen the last username from cache, or from ?u=name ---------- */
(function boot() {
  const q = new URLSearchParams(location.search).get('u');
  const user = (q || store.get('user') || '').toLowerCase();
  if (!user) return;
  $('#user').value = user;
  const cached = store.get('games:' + user);
  if (cached && cached.games && cached.games.length) {
    state.user = user; state.games = cached.games; setStatus(`${cached.games.length} saved games for ${user}. Press Import games to refresh.`); show();
  } else importGames(user, +$('#months').value);
})();

$('#notesBox').addEventListener('input', () => { if (state.sel) store.set('note:' + state.sel.g.url, $('#notesBox').value); });
