/* Learning helpers: why a move was bad, which pieces are loose, mistake patterns across
   games, and puzzles (with spaced repetition) built from your own mistakes.
   Everything here works from the stored engine evaluations, so nothing needs re-analysis. */

const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const PIECE_NAME = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const winPct = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * Math.max(-1500, Math.min(1500, cp)))) - 1);
/* Thresholds are drops in win probability for the side that moved, in percentage points.
   They follow the scale Lichess uses: 10 inaccuracy, 20 mistake, 30 blunder. */
const CLS = [[2, 'best', '\u2605', 'Best'], [10, 'good', '\u2713', 'Good'], [20, 'inacc', '?!', 'Inaccuracy'], [30, 'mist', '?', 'Mistake'], [101, 'blun', '??', 'Blunder']];
const clsOf = (drop) => CLS.find((x) => drop <= x[0]);
/* per-move accuracy from the win-probability drop (the formula Lichess publishes) */
const moveAcc = (drop) => Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * drop) - 3.1669));
const uciOf = (m) => m.from + m.to + (m.promotion || '');
const posKey = (fen) => fen.split(' ').slice(0, 4).join(' ');
const moveName = (i, san) => `${Math.floor(i / 2) + 1}${i % 2 ? '...' : '.'} ${san}`;

const MTYPES = {
  hung: { label: 'Hung material', tip: 'Before you let go of a piece, check two things: can it be taken where it lands, and what did it stop defending?' },
  threat: { label: 'Missed their threat', tip: 'After every opponent move, ask what it attacks. Deal with threats before carrying on with your own plan.' },
  allowedTactic: { label: 'Walked into a tactic', tip: 'Before each move, look at every check and capture your opponent could reply with. Forks, pins and skewers start there.' },
  mateAllowed: { label: 'Allowed mate', tip: 'Check your king first: after your move, look at every check your opponent can give.' },
  mateMissed: { label: 'Missed mate', tip: 'When the enemy king is exposed, look at every check before anything else.' },
  missedWin: { label: 'Missed free material', tip: 'Look for loose enemy pieces and captures on every move. You are leaving material on the board.' },
  missedTactic: { label: 'Missed a tactic', tip: 'Scan checks, captures and threats, in that order, before choosing a quiet move.' },
  positional: { label: 'Weaker plan', tip: 'Nothing was lost straight away, but the position got worse. Compare your plan with the engine line in game review.' },
};

/* ---------- material and attacks ---------- */
function matBal(fen) { // White minus Black, pawns included
  let s = 0;
  for (const ch of fen.split(' ')[0]) { const l = ch.toLowerCase(); if (VAL[l] == null) continue; s += (ch === l ? -1 : 1) * VAL[l]; }
  return s;
}
const pieceColor = (p) => (p === p.toUpperCase() ? 'w' : 'b');
const sqFR = (sq) => [sq.charCodeAt(0) - 97, +sq[1] - 1];
const frSq = (f, r) => String.fromCharCode(97 + f) + (r + 1);
function boardMap(fen) {
  const m = {};
  fen.split(' ')[0].split('/').forEach((row, i) => { let f = 0; for (const ch of row) { if (/\d/.test(ch)) f += +ch; else { m[frSq(f, 7 - i)] = ch; f++; } } });
  return m;
}
const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
function attacksFrom(m, sq) {
  const p = m[sq]; if (!p) return [];
  const t = p.toLowerCase(); const white = p !== t; const [f, r] = sqFR(sq); const out = [];
  const on = (x, y) => x >= 0 && x < 8 && y >= 0 && y < 8;
  const step = (dirs) => dirs.forEach(([a, b]) => { if (on(f + a, r + b)) out.push(frSq(f + a, r + b)); });
  const slide = (dirs) => dirs.forEach(([a, b]) => {
    let x = f + a, y = r + b;
    while (on(x, y)) { const s = frSq(x, y); out.push(s); if (m[s]) break; x += a; y += b; }
  });
  if (t === 'p') step([[-1, white ? 1 : -1], [1, white ? 1 : -1]]);
  else if (t === 'n') step(KNIGHT);
  else if (t === 'k') step(KING);
  else {
    if (t !== 'r') slide([[1, 1], [1, -1], [-1, 1], [-1, -1]]);
    if (t !== 'b') slide([[1, 0], [-1, 0], [0, 1], [0, -1]]);
  }
  return out;
}
function attackMap(m) {
  const a = { w: {}, b: {} };
  for (const s of Object.keys(m)) { const c = pieceColor(m[s]); for (const t of attacksFrom(m, s)) (a[c][t] = a[c][t] || []).push(s); }
  return a;
}
/* A piece is loose when it is attacked and either undefended or attacked by something
   cheaper. This is a quick visual check (it ignores pins), not a full exchange count. */
function loosePieces(fen) {
  const m = boardMap(fen); const a = attackMap(m); const out = [];
  for (const sq of Object.keys(m)) {
    const p = m[sq]; const t = p.toLowerCase(); if (t === 'k') continue;
    const c = pieceColor(p); const opp = c === 'w' ? 'b' : 'w';
    const att = a[opp][sq] || []; if (!att.length) continue;
    const def = a[c][sq] || [];
    const cheapest = Math.min(...att.map((s) => (m[s].toLowerCase() === 'k' ? 100 : VAL[m[s].toLowerCase()])));
    if (!def.length || cheapest < VAL[t]) out.push({ sq, color: c, piece: t });
  }
  return out;
}
const isLoose = (fen, sq) => loosePieces(fen).some((x) => x.sq === sq);
/* pieces the last-moved piece now attacks that are loose or worth more than it */
function lastMoveThreats(fen, last) {
  if (!last) return [];
  const m = boardMap(fen); const mover = m[last.to]; if (!mover) return [];
  const loose = new Set(loosePieces(fen).map((x) => x.sq));
  const c = pieceColor(mover); const v = VAL[mover.toLowerCase()] || 0;
  return attacksFrom(m, last.to).filter((s) => m[s] && pieceColor(m[s]) !== c && m[s].toLowerCase() !== 'k' && (loose.has(s) || VAL[m[s].toLowerCase()] > v))
    .map((s) => ({ sq: s, piece: m[s].toLowerCase(), by: mover.toLowerCase() }));
}

/* ---------- the board in words (for the teacher) ----------
   A language model misreads FEN strings: it will call a defended piece hanging or say a
   queen was captured when a knight was. So the teacher gets the board spelled out:
   piece lists, what each move does, and who attacks and defends the squares involved. */
const SIDE = { w: 'White', b: 'Black' };
const PIECE_ORDER = 'kqrbnp';
const pieceAt = (m, sq) => `${SIDE[pieceColor(m[sq])]}'s ${PIECE_NAME[m[sq].toLowerCase()]} on ${sq}`;
const pieceList = (m, sqs) => (sqs.length ? sqs.map((s) => pieceAt(m, s)).join(', ') : '');
/* "White: king g1, queen h3, rooks a1 and d1, pawns b3, c2 ..." for each side */
function piecesText(fen) {
  const m = boardMap(fen);
  return ['w', 'b'].map((c) => {
    const parts = [...PIECE_ORDER].map((t) => {
      const sqs = Object.keys(m).filter((s) => m[s] === (c === 'w' ? t.toUpperCase() : t)).sort();
      if (!sqs.length) return '';
      return `${PIECE_NAME[t]}${sqs.length > 1 ? 's' : ''} ${sqs.length > 1 ? sqs.slice(0, -1).join(', ') + ' and ' + sqs[sqs.length - 1] : sqs[0]}`;
    }).filter(Boolean);
    return `${SIDE[c]}: ${parts.join(', ')}.`;
  }).join(' ');
}
/* the square a capture removes a piece from (differs from mv.to only en passant) */
const capturedSq = (mv) => (mv.flags.includes('e') ? mv.to[0] + mv.from[1] : mv.to);
/* short form for lines: "White pawn g4 takes queen f5, check" */
function stepWords(mv) {
  if (mv.flags.includes('k') || mv.flags.includes('q')) return `${SIDE[mv.color]} castles ${mv.flags.includes('k') ? 'kingside' : 'queenside'}`;
  let s = `${SIDE[mv.color]} ${PIECE_NAME[mv.piece]} ${mv.from} ${mv.captured ? `takes ${PIECE_NAME[mv.captured]} ${capturedSq(mv)}` : `to ${mv.to}`}`;
  if (mv.promotion) s += `, becomes a ${PIECE_NAME[mv.promotion]}`;
  if (/#$/.test(mv.san)) s += ', checkmate'; else if (/\+$/.test(mv.san)) s += ', check';
  return s;
}
/* a line with every move spelled out: "29.gxf5 (White pawn g4 takes queen f5) 29...Bxh6 (...)" */
function lineWords(fen, steps, tags) {
  const san = lineText(fen, steps).split(' ');
  return steps.map((x, i) => `${san[i]}${tags && tags[i] ? ` [${tags[i]}]` : ''} (${stepWords(x.mv)})`).join(' ');
}
/* what each side captures in a sequence of moves, e.g. { w: ['queen'], b: ['knight', 'bishop'] } */
function capturesIn(mvs) {
  const out = { w: [], b: [] };
  mvs.forEach((mv) => { if (mv.captured) out[mv.color].push(PIECE_NAME[mv.captured]); });
  return out;
}
/* Facts about one move, worked out from the board before it: what it does, whether the
   piece it took was defended, and whether the piece that moved can be taken where it lands.
   Attacks are counted the quick way (pins and pieces lined up behind each other are ignored). */
function moveFacts(fenBefore, mv) {
  const L = []; const m = boardMap(fenBefore); const me = mv.color; const opp = me === 'w' ? 'b' : 'w';
  const castle = mv.flags.includes('k') || mv.flags.includes('q');
  let s = castle ? stepWords(mv) : `${SIDE[me]}'s ${PIECE_NAME[mv.piece]} moves from ${mv.from} to ${mv.to}`;
  if (mv.captured) s += ` and captures ${pieceAt(m, capturedSq(mv))}${mv.flags.includes('e') ? ' en passant' : ''}`;
  if (mv.promotion) s += ` and becomes a ${PIECE_NAME[mv.promotion]}`;
  if (/#$/.test(mv.san)) s += '. It is checkmate'; else if (/\+$/.test(mv.san)) s += ', giving check';
  L.push(s + '.');
  if (mv.captured) {
    const def = attackMap(m)[opp][capturedSq(mv)] || [];
    L.push(`Before the move, ${pieceAt(m, capturedSq(mv))} was ${def.length ? `defended by ${pieceList(m, def)}` : 'not defended by any piece'}.`);
  }
  if (castle) return L;
  const ch = new Chess(fenBefore); ch.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
  const m2 = boardMap(ch.fen()); const a2 = attackMap(m2);
  const att = a2[opp][mv.to] || [], def = a2[me][mv.to] || [];
  const here = pieceAt(m2, mv.to);
  if (att.length) L.push(`After the move, ${here} can be captured by ${pieceList(m2, att)}; it is ${def.length ? `defended by ${pieceList(m2, def)}` : 'not defended by any piece'}.`);
  else L.push(`After the move, nothing can capture ${here}.`);
  const hits = attacksFrom(m2, mv.to).filter((t) => m2[t] && pieceColor(m2[t]) === opp && m2[t].toLowerCase() !== 'k');
  if (hits.length) L.push(`From ${mv.to} it now attacks ${pieceList(m2, hits)}.`);
  return L;
}
/* "26.g4 Bg5 27.Ra1 Rh8 28.f3": the moves (SAN) that led to fen, numbered backwards from it */
function recentText(fen, sans) {
  const p = fen.split(' ');
  let w = p[1] !== 'w'; // the side that made the last move
  let n = (+p[5] || 1) - (w ? 0 : 1);
  const out = [];
  for (let i = sans.length - 1; i >= 0; i--) { out.unshift({ san: sans[i], n, w }); if (w) n--; w = !w; }
  return out.map((x, k) => (x.w ? `${x.n}.${x.san}` : k === 0 ? `${x.n}...${x.san}` : x.san)).join(' ');
}
/* move number and side of each step of a line that starts at fen */
function stepNums(fen, count) {
  const p = fen.split(' '); const n0 = +p[5] || 1; const w0 = p[1] === 'w';
  return Array.from({ length: count }, (_, k) => ({ n: n0 + Math.floor((k + (w0 ? 0 : 1)) / 2), w: w0 ? k % 2 === 0 : k % 2 === 1 }));
}

/* ---------- engine lines ---------- */
const pvOf = (e) => (e && e.pv && e.pv.length ? e.pv : (e && e.best && e.best !== '(none)' ? [e.best] : []));
function playLine(fen, ucis, max = 10) {
  const out = []; let ch;
  try { ch = new Chess(fen); } catch (_) { return out; }
  for (const u of (ucis || []).slice(0, max)) {
    const mv = ch.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || undefined });
    if (!mv) break;
    out.push({ mv, uci: u, fen: ch.fen() });
  }
  return out;
}
function lineText(fen, steps) {
  const p = fen.split(' '); let n = +p[5] || 1; let w = p[1] === 'w';
  return steps.map((x, i) => { const pre = w ? `${n}.` : (i === 0 ? `${n}...` : ''); if (!w) n++; w = !w; return pre + x.mv.san; }).join(' ');
}
const biggest = (steps) => steps.reduce((a, x) => (!a || VAL[x.mv.captured] > VAL[a.mv.captured] ? x : a), null);
/* the captures `side` comes out ahead with in a line, after equal trades cancel out
   (a queen trade on the way to winning a pawn is "wins a pawn", not "wins your queen") */
function netWon(steps, side) {
  const back = steps.filter((x) => x.mv.color !== side && x.mv.captured).map((x) => VAL[x.mv.captured]);
  return steps.filter((x) => x.mv.color === side && x.mv.captured).filter((x) => {
    const k = back.indexOf(VAL[x.mv.captured]); if (k < 0) return true;
    back.splice(k, 1); return false;
  });
}

/* ---------- time ---------- */
function isTimeTrouble(s, i) { const c = s.clocks[i]; return c != null && !!s.base && c < Math.max(10, s.base * 0.1); }
function timeTag(s, i, avgSpent) {
  if (isTimeTrouble(s, i)) return { k: 'time', label: 'Time trouble', text: `You had ${fmtClock(s.clocks[i])} left on your clock.` };
  const sp = s.spent[i];
  if (sp != null && s.base >= 180 && avgSpent && sp < Math.max(1, avgSpent * 0.35)) {
    return { k: 'fast', label: 'Played fast', text: `You spent ${sp.toFixed(1)}s here, against your average of ${avgSpent.toFixed(1)}s a move.` };
  }
  return null;
}

/* ---------- why a move was bad ---------- */
function situation(cpB, cpA) {
  const b = winPct(cpB), a = winPct(cpA);
  if (b >= 80 && a < 60) return 'You were winning, and this gives most of it away. ';
  if (b >= 40 && b < 80 && a < 25) return 'The position was fine, and after this you are clearly worse. ';
  return '';
}
/* Your move i (an inaccuracy or worse). Returns { type, text, refSan, refLine, refUci,
   bestSan, bestLine, bestUci, tag, detailed }. The refutation is the engine's best reply
   after your move, which the analysis already stored with the next position. */
function explainMove(s, evals, i, drop, avgSpent) {
  const m = s.moves[i]; const me = m.color; const sg = me === 'w' ? 1 : -1;
  const eb = evals[i], ea = evals[i + 1];
  const cpB = eb.cp * sg, cpA = ea.cp * sg;
  const ref = playLine(s.fens[i + 1], pvOf(ea)), best = playLine(s.fens[i], pvOf(eb));
  const ex = {
    refSan: ref[0] ? ref[0].mv.san : null, refLine: lineText(s.fens[i + 1], ref.slice(0, 6)), refUci: ref.map((x) => x.uci),
    bestSan: best[0] ? best[0].mv.san : null, bestLine: lineText(s.fens[i], best.slice(0, 6)), bestUci: best.map((x) => x.uci),
    tag: timeTag(s, i, avgSpent), detailed: !!(ea.pv && ea.pv.length > 1),
  };
  const done = (type, text) => Object.assign(ex, { type, text: situation(cpB, cpA) + text });
  const isMate = (cp) => Math.abs(cp) >= 9000; const mateN = (cp) => Math.max(1, 10000 - Math.abs(cp));

  if (isMate(cpA) && cpA < 0 && !(isMate(cpB) && cpB < 0)) return done('mateAllowed', `This allows mate in ${mateN(cpA)}: ${ex.refLine}.`);
  if (isMate(cpB) && cpB > 0 && !(isMate(cpA) && cpA > 0)) return done('mateMissed', `You had mate in ${mateN(cpB)}, starting with ${ex.bestSan}: ${ex.bestLine}.`);

  // material your move loses: follow their best reply up to your own answer, so recaptures count
  const base = matBal(s.fens[i]) * sg;
  let loss = 0, k = 0;
  if (ref.length >= 2) { k = Math.min(6, ref.length); if (k % 2) k--; loss = base - matBal(ref[k - 1].fen) * sg; }
  if (loss >= 1) {
    const line = ref.slice(0, k);
    const big = biggest(netWon(line, me === 'w' ? 'b' : 'w'));
    if (!big) {
      const promo = line.find((x) => x.mv.color !== me && x.mv.promotion);
      if (promo) return done('allowedTactic', `This lets them promote a pawn with ${promo.mv.san}: ${ex.refLine}.`);
      return done(loss >= 2 ? 'allowedTactic' : 'positional', `This lets them win material: ${ex.refLine}.`);
    }
    const word = PIECE_NAME[big.mv.captured]; const sq = big.mv.to;
    if (big !== ref[0]) {
      // a pawn that drops a few moves later is a slow error, not a tactic
      if (loss < 2) return done('positional', `This lets them win a pawn a few moves later: ${ex.refLine}.`);
      return done('allowedTactic', `This walks into ${ex.refSan}, which wins your ${word}: ${ex.refLine}.`);
    }
    const before = boardMap(s.fens[i])[sq];
    const stayed = m.to !== sq && before && pieceColor(before) === me && before.toLowerCase() === big.mv.captured;
    if (stayed && isLoose(s.fens[i], sq)) return done('threat', `Your ${word} on ${sq} was already under attack, and this move does not save it. ${ex.refSan} wins it: ${ex.refLine}.`);
    if (m.to === sq) return done('hung', `This puts your ${word} on ${sq} where it can be taken: ${ex.refLine}.`);
    return done('hung', `This leaves your ${word} on ${sq} unprotected. ${ex.refSan} wins it: ${ex.refLine}.`);
  }

  // material the better move would have won: follow it up to their answer
  if (best.length >= 2) {
    let k2 = Math.min(6, best.length); if (k2 % 2) k2--;
    const gain = matBal(best[k2 - 1].fen) * sg - base;
    if (gain >= 2) {
      const big = biggest(netWon(best.slice(0, k2), me));
      return done('missedWin', `You could have won ${big ? 'a ' + PIECE_NAME[big.mv.captured] : 'material'} with ${ex.bestSan}: ${ex.bestLine}.`);
    }
  }
  const bm = best[0] && best[0].mv;
  if (bm && drop >= 20 && (bm.captured || /[+#]/.test(bm.san))) return done('missedTactic', `${ex.bestSan} was the strong, forcing move: ${ex.bestLine}.`);
  return done('positional', `Nothing is lost straight away, but your position gets worse${ex.refSan ? `, and ${ex.refSan} is a strong reply` : ''}. Better was ${ex.bestSan}${ex.bestLine ? `: ${ex.bestLine}` : ''}.`);
}
/* the opponent's move i went wrong: what was the punishment, and did you find it? */
function explainOpp(s, evals, i) {
  const ref = playLine(s.fens[i + 1], pvOf(evals[i + 1]));
  if (!ref.length) return null;
  const line = lineText(s.fens[i + 1], ref.slice(0, 6)); const next = s.moves[i + 1];
  const found = next && uciOf(next) === ref[0].uci;
  return {
    type: 'opp', refSan: ref[0].mv.san, refLine: line, refUci: ref.map((x) => x.uci),
    text: `Your opponent went wrong here. The best answer was ${ref[0].mv.san}: ${line}.${next ? (found ? ' You found it.' : ` You played ${next.san}.`) : ''}`,
  };
}

/* ---------- patterns across games ---------- */
/* items: [{ g, s, rv }] for analyzed games. Counts your mistakes and blunders by type and
   by clock, finds positions where you went wrong more than once, and the move where each
   opening first slips (your first inaccuracy or worse). */
function mistakeProfile(items) {
  const types = {}; Object.keys(MTYPES).forEach((k) => { types[k] = 0; });
  const p = { types, errors: 0, moves: 0, movesTime: 0, errTime: 0, errFast: 0, games: items.length };
  const spots = new Map(); const seen = new Map(); const firstSlip = new Map();
  items.forEach(({ g, s, rv }) => {
    const me = g.color[0]; let first = null;
    s.moves.forEach((m, i) => {
      if (m.color !== me) return;
      const c = rv.cls[i]; const key = posKey(s.fens[i]);
      if (!seen.has(key)) seen.set(key, new Set()); seen.get(key).add(g.url);
      const tt = isTimeTrouble(s, i); p.moves++; if (tt) p.movesTime++;
      if (c.drop >= 10 && c.ex) {
        if (first == null) first = Math.floor(i / 2) + 1;
        if (!spots.has(key)) spots.set(key, { fen: s.fens[i], color: me, list: [] });
        spots.get(key).list.push({ g, i, san: m.san, uci: uciOf(m), bestSan: c.ex.bestSan, best: rv.evals[i].best, t: c.t, label: c.label });
      }
      if (c.drop < 20 || !c.ex) return;
      p.errors++; types[c.ex.type]++;
      if (tt) p.errTime++;
      if (c.ex.tag && c.ex.tag.k === 'fast') p.errFast++;
    });
    if (first != null) { if (!firstSlip.has(g.family)) firstSlip.set(g.family, []); firstSlip.get(g.family).push(first); }
  });
  p.repeated = [...spots.values()]
    .map((x) => ({ ...x, games: new Set(x.list.map((y) => y.g.url)).size, reached: seen.get(posKey(x.fen)).size }))
    .filter((x) => x.games >= 2).sort((a, b) => b.games - a.games || b.reached - a.reached);
  p.firstSlip = firstSlip;
  return p;
}

/* ---------- puzzles from your mistakes ---------- */
const PZ_VERSION = 2;
function puzzlesFrom(g, s, rv) {
  const me = g.color[0]; const sg = me === 'w' ? 1 : -1; const out = [];
  rv.cls.forEach((c, i) => {
    const m = s.moves[i]; if (m.color !== me || c.drop < 20 || !c.ex) return;
    const e = rv.evals[i]; if (!e.best || e.best === '(none)' || e.best === uciOf(m)) return;
    if (winPct(e.cp * sg) < 15) return; // already lost: no fair answer to find
    const prev = s.moves[i - 1];
    out.push({
      id: g.url + '#' + i, url: g.url, i, fen: s.fens[i], color: me, best: e.best, bestSan: c.ex.bestSan, bestLine: c.ex.bestLine,
      played: m.san, playedUci: uciOf(m), t: c.t, label: c.label, type: c.ex.type, text: c.ex.text, drop: Math.round(c.drop),
      last: prev ? { from: prev.from, to: prev.to } : null, end: g.end, opp: g.oppName, opening: g.variation, moveNo: Math.floor(i / 2) + 1,
    });
  });
  return out;
}
/* Leitner boxes: a puzzle you solve moves up a box and comes back later (1, 3, 7, 21,
   then 60 days); one you miss drops to box 1 and comes back tomorrow. */
const BOX_DAYS = [0, 1, 3, 7, 21, 60];
const DAY_MS = 86400000;
const srsOf = (id) => kv.get('srs:' + id);
function srsRecord(id, outcome) {
  const s = { box: 0, due: 0, n: 0, ok: 0, ...(srsOf(id) || {}) }; const now = Date.now();
  s.n++; s.last = now;
  if (outcome === 'ok') { s.ok++; s.box = Math.min(BOX_DAYS.length - 1, s.box + 1); s.due = now + BOX_DAYS[s.box] * DAY_MS; }
  else if (outcome === 'hint') { s.ok++; s.box = Math.max(1, s.box); s.due = now + DAY_MS; }
  else { s.box = 1; s.due = now + DAY_MS; }
  kv.set('srs:' + id, s);
  return s;
}
