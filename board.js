/* Board rendering and input, shared by game review, explore mode, guess-the-move and the
   trainer. Moves can be made by clicking a piece and then a square, or by dragging. */

const PIECE_URL = 'https://cdn.jsdelivr.net/gh/lichess-org/lila@master/public/piece/cburnett/';
const FILES = 'abcdefgh';

function fenCells(fen) {
  const cells = [];
  fen.split(' ')[0].split('/').forEach((row, r) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) { for (let i = 0; i < +ch; i++) { cells.push({ sq: FILES[f] + (8 - r), r, f }); f++; } }
      else { cells.push({ sq: FILES[f] + (8 - r), r, f, p: ch }); f++; }
    }
  });
  return cells;
}
const pieceImg = (p) => `<img alt="" draggable="false" src="${PIECE_URL}${p === p.toUpperCase() ? 'w' : 'b'}${p.toUpperCase()}.svg">`;

/* o: { flip, last: {from,to}, badge: {sq, t, sym}, marks: {sq: 'cls'}, sel, dests: [sq], hide: sq, coords } */
function boardHtml(fen, o = {}) {
  const cells = fenCells(fen); const order = o.flip ? cells.slice().reverse() : cells;
  const coords = o.coords !== false; const dests = new Set(o.dests || []);
  return order.map((c, idx) => {
    const dark = (c.r + c.f) % 2 === 1;
    let cls = 'sq ' + (dark ? 'd' : 'l');
    if (o.last && (o.last.from === c.sq || o.last.to === c.sq)) cls += ' hl';
    if (o.sel === c.sq) cls += ' sel';
    if (o.marks && o.marks[c.sq]) cls += ' ' + o.marks[c.sq];
    if (dests.has(c.sq)) cls += c.p ? ' dest cap' : ' dest';
    const pc = c.p && o.hide !== c.sq ? pieceImg(c.p) : '';
    const col = coords && idx >= 56 ? `<span class="co f">${FILES[c.f]}</span>` : '';
    const rk = coords && idx % 8 === 0 ? `<span class="co r">${8 - c.r}</span>` : '';
    const mk = o.badge && o.badge.sq === c.sq && o.badge.sym ? `<span class="mk k-${o.badge.t}">${o.badge.sym}</span>` : '';
    return `<div class="${cls}" data-sq="${c.sq}">${rk}${col}${pc}${mk}</div>`;
  }).join('');
}

/* arrows: [{ from, to, color, op, w }] in square names; viewBox is 0 0 8 8 */
function arrowsSvg(arrows, flip) {
  const pt = (sq) => { let f = FILES.indexOf(sq[0]), r = 8 - +sq[1]; if (flip) { f = 7 - f; r = 7 - r; } return [f + 0.5, r + 0.5]; };
  return (arrows || []).filter((a) => a && a.from && a.to && a.from !== a.to).map((a) => {
    const [x1, y1] = pt(a.from), [x2, y2] = pt(a.to); const w = a.w || 0.16; const head = w * 2;
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len, hx = x2 - ux * head, hy = y2 - uy * head;
    return `<g opacity="${a.op ?? 0.85}" fill="${a.color}" stroke="${a.color}"><line x1="${x1}" y1="${y1}" x2="${hx}" y2="${hy}" stroke-width="${w}" stroke-linecap="round"/><polygon stroke="none" points="${x2},${y2} ${hx - uy * head * 0.7},${hy + ux * head * 0.7} ${hx + uy * head * 0.7},${hy - ux * head * 0.7}"/></g>`;
  }).join('');
}
const uciArrow = (u, color, op, w) => (u && u.length >= 4 ? { from: u.slice(0, 2), to: u.slice(2, 4), color, op, w } : null);

/* An interactive board inside `box` (which holds a .board div and an svg.arrows).
   set({ fen, flip, last, badge, marks, arrows, movable, onMove }) then it redraws.
   movable: null (view only), 'w', 'b' or 'turn' (whichever side is to move). */
function makeBoard(box) {
  const el = box.querySelector('.board'); const svg = box.querySelector('.arrows');
  el.setAttribute('role', 'group'); el.setAttribute('aria-label', 'Chess board. To move by keyboard, use the move box below it.');
  const b = { o: { fen: null }, sel: null, dests: [], drag: null };

  const canMove = (sq) => {
    const { fen, movable } = b.o; if (!fen || !movable) return false;
    const turn = fen.split(' ')[1]; if (movable !== 'turn' && movable !== turn) return false;
    const cell = fenCells(fen).find((c) => c.sq === sq); if (!cell || !cell.p) return false;
    return (cell.p === cell.p.toUpperCase() ? 'w' : 'b') === turn;
  };
  const destsOf = (sq) => { try { return new Chess(b.o.fen).moves({ square: sq, verbose: true }).map((m) => m.to); } catch (_) { return []; } };
  const squareAt = (e) => {
    const r = el.getBoundingClientRect(); let f = Math.floor(((e.clientX - r.left) / r.width) * 8), rk = Math.floor(((e.clientY - r.top) / r.height) * 8);
    if (f < 0 || f > 7 || rk < 0 || rk > 7) return null;
    if (b.o.flip) { f = 7 - f; rk = 7 - rk; }
    return FILES[f] + (8 - rk);
  };
  function render() {
    const o = b.o; if (!o.fen) { el.innerHTML = ''; svg.innerHTML = ''; return; }
    el.classList.toggle('movable', !!o.movable);
    el.innerHTML = boardHtml(o.fen, { flip: o.flip, last: o.last, badge: o.badge, marks: o.marks, sel: b.sel, dests: b.dests, hide: b.drag && b.drag.moved ? b.sel : null });
    svg.innerHTML = arrowsSvg(o.arrows, o.flip);
  }
  function select(sq) { b.sel = sq; b.dests = sq ? destsOf(sq) : []; }
  function play(from, to) {
    const cell = fenCells(b.o.fen).find((c) => c.sq === from);
    const promo = cell && cell.p && cell.p.toLowerCase() === 'p' && (to[1] === '8' || to[1] === '1') ? 'q' : undefined;
    select(null); render();
    if (b.o.onMove) b.o.onMove({ from, to, promotion: promo });
  }

  el.addEventListener('pointerdown', (e) => {
    if (!b.o.movable || e.button > 0) return;
    const sq = squareAt(e); if (!sq) return;
    if (b.sel && b.dests.includes(sq)) { e.preventDefault(); return play(b.sel, sq); }
    if (canMove(sq)) {
      e.preventDefault(); select(sq);
      const img = el.querySelector(`[data-sq="${sq}"] img`);
      const size = el.getBoundingClientRect().width / 8;
      const ghost = img ? img.cloneNode() : null;
      if (ghost) { ghost.className = 'ghost'; ghost.style.width = ghost.style.height = size + 'px'; box.appendChild(ghost); }
      b.drag = { ghost, size, moved: false, x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId); render(); moveGhost(e);
    } else { select(null); render(); }
  });
  function moveGhost(e) {
    const d = b.drag; if (!d || !d.ghost) return;
    const r = box.getBoundingClientRect();
    d.ghost.style.left = (e.clientX - r.left - d.size / 2) + 'px'; d.ghost.style.top = (e.clientY - r.top - d.size / 2) + 'px';
  }
  el.addEventListener('pointermove', (e) => {
    const d = b.drag; if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) { d.moved = true; render(); }
    moveGhost(e);
  });
  const endDrag = (e) => {
    const d = b.drag; if (!d) return; b.drag = null;
    if (d.ghost) d.ghost.remove();
    const sq = e && squareAt(e);
    if (d.moved && sq && sq !== b.sel && b.dests.includes(sq)) return play(b.sel, sq);
    if (d.moved) select(null);
    render();
  };
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', () => endDrag(null));

  b.set = (o) => {
    const posChanged = o.fen !== b.o.fen || o.movable !== b.o.movable;
    b.o = { ...o }; if (posChanged) select(null);
    if (!b.drag) render();
  };
  b.hint = (marks) => { b.o.marks = marks; render(); };
  return b;
}

/* Keyboard alternative to dragging: a field that takes moves like Nf3, exd5 or O-O. */
function moveFormHtml(id, disabled) {
  const d = disabled ? ' disabled' : '';
  return `<form class="typeMove" data-form="move"><label for="${id}" class="sr">Type a move</label><input id="${id}" placeholder="Or type a move, for example Nf3" autocomplete="off" spellcheck="false"${d}><button${d}>Play</button></form>`;
}
function parseTypedMove(fen, text) {
  const t = (text || '').trim(); if (!t) return null;
  let r = null; try { r = new Chess(fen).move(t, { sloppy: true }); } catch (_) { r = null; }
  return r ? { from: r.from, to: r.to, promotion: r.promotion } : null;
}
const badMoveText = (t) => `"${t.trim()}" is not a legal move here. Use moves like Nf3, exd5 or O-O.`;

/* a small static board for lists (no coordinates, no input) */
function miniBoard(fen, o = {}) {
  return `<div class="mini"><div class="board">${boardHtml(fen, { ...o, coords: false })}</div><svg class="arrows" viewBox="0 0 8 8" aria-hidden="true">${arrowsSvg(o.arrows, o.flip)}</svg></div>`;
}
