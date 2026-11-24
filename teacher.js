/* Personal teacher: a language model explains what Stockfish already worked out.
   Stockfish and the rules in learn.js decide everything (the best move, what a move allows,
   the type of mistake). The model gets those facts plus a short profile of the student and
   only puts them into words. It never judges a move itself: a move the student asks about
   is checked by Stockfish first, and any move in an answer that Stockfish did not supply is
   marked as unchecked.
   The model is any OpenAI-compatible chat API, called straight from the browser with the
   student's own key (free tiers of Groq, Gemini, OpenRouter or Mistral, or a local Ollama). Settings and the key stay in this browser's local storage; the profile (what the
   student tends to get wrong, saved lessons) lives in IndexedDB under 'teacher:mem'. */

const TEACH_PROVIDERS = {
  groq: {
    name: 'Groq', base: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys',
    model: 'openai/gpt-oss-120b', backupModel: 'llama-3.3-70b-versatile', prefer: [/^openai\/gpt-oss-120b$/, /^llama-3\.3-70b-versatile$/, /llama-4-maverick/, /llama-4/],
    limits: 'Free, no card needed: about 1,000 questions a day, a few per minute.',
    steps: ['Open <a href="https://console.groq.com/keys" target="_blank" rel="noopener">console.groq.com/keys</a> and sign in with Google, GitHub or email.', 'Press <b>Create API Key</b>, give it any name, and submit.', 'Copy the key (it starts with <code>gsk_</code>) straight away, because Groq shows it only once. Paste it below.'],
    privacy: 'Groq does not train on what you send.',
  },
  gemini: {
    name: 'Google Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', keyUrl: 'https://aistudio.google.com/apikey',
    model: 'gemini-flash-lite-latest', backupModel: 'gemini-flash-latest', prefer: [/^gemini-flash-lite-latest$/, /^gemini-[\d.]+-flash-lite$/, /^gemma-\d+-\d+b-it$/, /^gemini-flash-latest$/],
    limits: 'Free, no card needed. Flash-Lite allows a few hundred questions a day; the bigger Flash models only about 20.',
    steps: ['Open <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> and sign in with a Google account.', 'Accept the terms. Google often makes a project and a key for you; if not, press <b>Create API key</b>.', 'Copy the key and paste it below.'],
    privacy: 'On the free tier, Google may use what you send to improve its products, and people may read it. Google\'s terms also restrict the free tier in the EU, UK and Switzerland, so pick Groq there.',
  },
  openrouter: {
    name: 'OpenRouter (free models)', base: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/settings/keys',
    model: 'openrouter/free', backupModel: 'openrouter/free', prefer: [/^google\/gemma-\d+-\d+b-it:free$/, /^openrouter\/free$/], filter: (id) => /:free$/.test(id) || id === 'openrouter/free',
    limits: 'Free models only (ending in :free), so nothing is charged: about 50 questions a day.',
    steps: ['Open <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noopener">openrouter.ai/settings/keys</a> and sign in.', 'Press <b>Create API Key</b>, name it, and create it.', 'Copy the key (it starts with <code>sk-or-</code>) and paste it below.'],
    privacy: 'Some free models on OpenRouter log what you send.',
  },
  mistral: {
    name: 'Mistral', base: 'https://api.mistral.ai/v1', keyUrl: 'https://console.mistral.ai/api-keys',
    model: 'mistral-small-latest', backupModel: 'mistral-medium-latest', prefer: [/^mistral-small-latest$/, /^mistral-medium-latest$/],
    limits: 'The free Experiment plan needs a phone number but no card.',
    steps: ['Open <a href="https://console.mistral.ai/api-keys" target="_blank" rel="noopener">console.mistral.ai/api-keys</a> and sign in.', 'Choose the free <b>Experiment</b> plan if it asks, and verify your phone number.', 'Press <b>Create new key</b>, copy it and paste it below.'],
    privacy: 'On the free Experiment plan, Mistral may use what you send to improve its models.',
  },
  ollama: {
    name: 'Ollama on this computer', base: 'http://localhost:11434/v1', editBase: true, keyOptional: true, model: '', prefer: [/llama3/, /qwen/, /gemma/],
    limits: 'Free and unlimited, but it needs a fast computer.',
    steps: ['Install Ollama from <a href="https://ollama.com" target="_blank" rel="noopener">ollama.com</a> and download a model, for example <code>ollama pull llama3.2</code>.', 'If Chess Lab runs on a website (not localhost), start Ollama with <code>OLLAMA_ORIGINS</code> set to that site\'s address so the browser may call it.', 'No key is needed. Press Refresh list to pick a model.'],
    privacy: 'Everything stays on your computer.',
  },
  custom: {
    name: 'Other (OpenAI-compatible)', base: '', editBase: true, keyOptional: true, model: '', prefer: [],
    limits: '',
    steps: ['Enter the service\'s OpenAI-compatible address (it usually ends in <code>/v1</code>), and a key if it needs one.', 'The service must allow calls from a web page (CORS).'],
    privacy: '',
  },
};
const TEACH_RECOMMENDED = 'groq';
/* ids that are not chat models (embeddings, speech, images, moderation and so on) */
const NOT_CHAT = /embed|tts|image|imagen|veo|audio|live|whisper|guard|aqa|transcri|moderation|rerank|-native-|computer-use|robotics|lyria|learnlm|ocr|realtime|search/i;

const teach = { convos: new Map(), pending: null, topMemo: new Map(), forgetArmed: false, cool: {} };

/* ---------- settings ---------- */
/* Two slots, main and backup, each a service and a model. Keys and addresses are kept per
   service, so a backup on the same service shares the key. On Groq every model has its own
   free allowance, so a second model there doubles what one key can do. */
function tcfg() {
  const c = prefs.get('teacher') || {};
  const slot = (x, d) => ({ provider: x && (x.provider === '' || TEACH_PROVIDERS[x.provider]) ? x.provider : d, model: (x && x.model) || '' });
  return {
    main: slot(c.main, TEACH_RECOMMENDED), backup: slot(c.backup, TEACH_RECOMMENDED),
    keys: { ...(c.keys || {}) }, lists: { ...(c.lists || {}) },
    base: { ollama: TEACH_PROVIDERS.ollama.base, custom: '', ...(c.base || {}) },
    tone: c.tone === 'kind' ? 'kind' : 'roast',
  };
}
const tsave = (c) => prefs.set('teacher', c);
const sprov = (s) => TEACH_PROVIDERS[s.provider];
const sbase = (c, s) => ((sprov(s).editBase ? c.base[s.provider] : sprov(s).base) || '').trim().replace(/\/+$/, '');
function smodel(c, s) {
  if (s.model) return s.model;
  const P = sprov(s); if (s !== c.backup) return P.model || '';
  return s.provider === c.main.provider ? (P.backupModel || '') : (P.model || '');
}
const sready = (c, s) => !!(s.provider && sbase(c, s) && smodel(c, s) && (sprov(s).keyOptional || c.keys[s.provider]));
const sname = (c, s) => `${sprov(s).name} · ${smodel(c, s)}`;
const tready = (c = tcfg()) => sready(c, c.main) || sready(c, c.backup);

/* ---------- the chat API ---------- */
const failure = (message, o = {}) => Object.assign(new Error(message), o);
function apiHeaders(c, s) {
  const h = { 'Content-Type': 'application/json' }; const key = (c.keys[s.provider] || '').trim();
  if (key) h.Authorization = 'Bearer ' + key;
  return h;
}
const noReach = (s) => (s.provider === 'ollama'
  ? 'Could not reach Ollama. Check that it is running, and that OLLAMA_ORIGINS allows this site.'
  : `Could not reach ${sprov(s).name}. Check your connection and the address, then try again.`);
async function apiError(r, c, s) {
  let msg = '';
  try { const j = await r.json(); const e = Array.isArray(j) ? j[0] && j[0].error : j.error; msg = e ? (typeof e === 'string' ? e : e.message || '') : ''; } catch (_) { /* not JSON */ }
  const name = sprov(s).name; const st = r.status;
  if (st === 401 || st === 403 || /api.?key|unauthori[sz]ed|invalid.*(key|token)/i.test(msg)) return failure(`${name} did not accept the key. Check it in teacher settings.`);
  if (st === 429) return failure(`${name} says you have used up the free allowance for ${smodel(c, s)} for now.`, { limit: true });
  if (st === 404 || /model.*(not found|does not exist|not supported|unavailable)/i.test(msg)) return failure(`${name} does not offer the model "${smodel(c, s)}". Pick another one in teacher settings.`);
  if (st >= 500) return failure(`${name} had a problem answering (error ${st}).`);
  return failure(`${name} turned the request down (error ${st})${msg ? ': ' + String(msg).slice(0, 200) : '.'}`);
}
/* reasoning models think before answering; a short think is plenty for rewording facts,
   and on Groq the thinking counts against the free tokens-per-minute allowance */
const lowEffort = (model) => /gpt-oss|^gemini-(2\.5|[3-9])/.test(model);
/* one request to one slot, streamed: onText(textSoFar) on every piece */
async function chatOnce(c, s, messages, onText, signal) {
  const model = smodel(c, s); let r;
  const send = (extra) => fetch(sbase(c, s) + '/chat/completions', {
    method: 'POST', headers: apiHeaders(c, s), signal,
    body: JSON.stringify({ model, messages, stream: true, temperature: c.tone === 'roast' ? 0.6 : 0.3, ...extra }),
  });
  try {
    r = await send(lowEffort(model) ? { reasoning_effort: 'low' } : {});
    if (r.status === 400 && lowEffort(model) && /reasoning/i.test(await r.clone().text())) r = await send({}); // a model that turns the setting down
  } catch (e) { if (e.name === 'AbortError') throw e; throw failure(noReach(s)); }
  if (!r.ok) throw await apiError(r, c, s);
  let out = '';
  if (!(r.headers.get('content-type') || '').includes('event-stream') || !r.body) { // a service that ignores stream: true
    const j = await r.json(); out = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || ''; if (out) onText(out);
  } else {
    const rd = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await rd.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n'); buf = parts.pop();
      for (const ln of parts) {
        const l = ln.trim(); if (!l.startsWith('data:')) continue;
        const d = l.slice(5).trim(); if (!d || d === '[DONE]') continue;
        let j; try { j = JSON.parse(d); } catch (_) { continue; }
        if (j.error) throw failure(`${sprov(s).name}: ${j.error.message || 'the answer stopped with an error'}.`, { partial: !!out });
        const t = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (t) { out += t; onText(out); }
      }
    }
  }
  if (!out.trim()) throw failure(`${sprov(s).name} sent back an empty answer.`);
  return out;
}
/* Main first, then the backup if the main one fails before writing anything (a used-up free
   allowance, a server error, a wrong model, no connection). A slot that hits its limit sits
   out for a minute, so the next questions go straight to the other one.
   Resolves { text, slot, fellBack, why }. */
async function aiChat(messages, onText, signal) {
  const c = tcfg(); const now = Date.now();
  const slots = [c.main, c.backup].filter((s, k) => sready(c, s) && !(k === 1 && s.provider === c.main.provider && smodel(c, s) === smodel(c, c.main)));
  if (!slots.length) throw failure('Set up the teacher first: press Settings.');
  const resting = (s) => (teach.cool[sname(c, s)] || 0) > now;
  const order = slots.filter((s) => !resting(s)).concat(slots.filter(resting));
  let first = null;
  for (const s of order) {
    let wrote = false;
    try {
      const text = await chatOnce(c, s, messages, (t) => { wrote = true; onText(t); }, signal);
      return { text, slot: s, fellBack: s !== c.main, why: first };
    } catch (e) {
      if (e.name === 'AbortError' || wrote || e.partial) throw e;
      if (e.limit) teach.cool[sname(c, s)] = Date.now() + 60000;
      if (first) throw failure(`${first.message} The backup failed too: ${e.message}`);
      first = e;
    }
  }
  throw failure(first.message + (first.limit ? ' Wait a minute and try again, or add a backup model in teacher settings.' : ''));
}
async function aiModels(c, s) {
  let r;
  try { r = await fetch(sbase(c, s) + '/models', { headers: apiHeaders(c, s) }); } catch (_) { throw failure(noReach(s)); }
  if (!r.ok) throw await apiError(r, c, s);
  const j = await r.json(); const P = sprov(s);
  let ids = (j.data || j.models || []).map((m) => String(m.id || m.name || '').replace(/^models\//, '')).filter((id) => id && !NOT_CHAT.test(id));
  if (P.filter) ids = ids.filter(P.filter);
  return [...new Set(ids)].sort();
}
const verDesc = (a, b) => b.localeCompare(a, undefined, { numeric: true });
/* the best model in a list by the service's preferences; for the backup (avoid = the main
   model) the service's suggested backup comes first */
function pickModel(P, list, cur, avoid) {
  if (cur && list.includes(cur) && cur !== avoid) return cur;
  const ok = list.filter((id) => id !== avoid);
  if (avoid != null && P.backupModel && ok.includes(P.backupModel)) return P.backupModel;
  for (const re of P.prefer || []) { const hit = ok.filter((id) => re.test(id)).sort(verDesc)[0]; if (hit) return hit; }
  return ok.includes(P.model) ? P.model : ok[0] || '';
}

/* ---------- what the teacher knows about you ---------- */
function tmem() {
  const m = kv.get('teacher:mem') || {};
  return { about: m.about || '', lessons: m.lessons || [], flags: m.flags || [], games: m.games || [] };
}
const tmemSave = (m) => kv.set('teacher:mem', m);
/* called by Play and learn: kind 'flag' { type, cls } when the coach stops a move, 'game' { res, flagged, corrected, kept, acc } at the end */
function teachNote(kind, d) {
  const m = tmem();
  if (kind === 'flag') m.flags = [...m.flags, { t: Date.now(), type: d.type || 'other', cls: d.cls }].slice(-200);
  else if (kind === 'game') m.games = [...m.games, { t: Date.now(), ...d }].slice(-100);
  tmemSave(m);
}
const typeName = (k) => (MTYPES[k] ? MTYPES[k].label.toLowerCase() : 'other mistakes');
const countBy = (arr, fn) => { const o = {}; arr.forEach((x) => { const k = fn(x); o[k] = (o[k] || 0) + 1; }); return Object.entries(o).sort((a, b) => b[1] - a[1]); };
/* plain sentences about the student, worked out from their own data */
function profileFacts() {
  const L = []; const m = tmem();
  if (m.about.trim()) L.push(`In their own words: "${m.about.trim().slice(0, 500)}"`);
  const last = {}; state.games.forEach((g) => { if (g.rating) last[g.tc] = g.rating; });
  const rt = Object.entries(last).map(([tc, v]) => `${tc} ${v}`);
  if (rt.length) L.push(`Current chess.com ratings: ${rt.join(', ')}.`);

  // analyzed chess.com games (the latest 60)
  const items = state.games.filter((g) => kv.has('an2:' + g.url)).slice(-60).map((g) => { const r = reviewFor(g); return r ? { g, ...r } : null; }).filter(Boolean);
  if (items.length) {
    const prof = mistakeProfile(items); const n = items.length;
    const mine = items.map(({ g, rv }) => ({ g, acc: rv.acc[g.color[0]], phase: rv.phase[g.color[0]] }));
    const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
    L.push(`Analyzed chess.com games: ${n}. Average accuracy ${avg(mine.map((x) => x.acc))}%, ${(prof.errors / n).toFixed(1)} mistakes and blunders per game.`);
    const types = Object.entries(prof.types).filter(([, v]) => v).sort((a, b) => b[1] - a[1]).slice(0, 4);
    if (types.length) L.push(`Their most common mistakes in those games: ${types.map(([k, v]) => `${typeName(k)} ${v} (${pct(v, prof.errors)}%)`).join(', ')}.`);
    if (prof.errors >= 5 && prof.movesTime) L.push(`${pct(prof.errTime, prof.errors)}% of those mistakes came in time trouble, and ${pct(prof.errFast, prof.errors)}% on moves played much faster than usual.`);
    const ph = ['opening', 'middlegame', 'endgame'].map((p) => [p, avg(mine.map((x) => x.phase[p]).filter((v) => v != null))]).filter((x) => x[1] != null);
    if (ph.length > 1) { const w = ph.reduce((a, b) => (b[1] < a[1] ? b : a)); L.push(`Accuracy by phase: ${ph.map(([p, v]) => `${p} ${v}%`).join(', ')}. Weakest: ${w[0]}.`); }
    const op = [...groupBy(mine, (x) => x.g.family)].filter(([, x]) => x.length >= 2).map(([k, x]) => [k, x.length, avg(x.map((y) => y.acc))]).sort((a, b) => a[2] - b[2]).slice(0, 2);
    if (op.length) L.push(`Weakest openings by accuracy: ${op.map(([k, c, a]) => `${k} (${c} games, ${a}%)`).join('; ')}.`);
    if (prof.repeated.length) L.push(`Positions they got wrong in more than one game: ${prof.repeated.length}.`);
  }

  // practice games in Play and learn
  if (m.games.length || m.flags.length) {
    const wdl = { W: 0, D: 0, L: 0 }; m.games.forEach((g) => { wdl[g.res] = (wdl[g.res] || 0) + 1; });
    if (m.games.length) L.push(`Practice games against Stockfish in Chess Lab: ${m.games.length} finished (${wdl.W} won, ${wdl.D} drawn, ${wdl.L} lost).`);
    const fl = m.flags.slice(-60);
    if (fl.length) {
      const fixed = m.games.reduce((a, g) => a + (g.corrected || 0), 0), stopped = m.games.reduce((a, g) => a + (g.flagged || 0), 0);
      L.push(`Mistakes the coach stopped in practice games (latest ${fl.length}): ${countBy(fl, (x) => x.type).slice(0, 4).map(([k, v]) => `${typeName(k)} ${v}`).join(', ')}.${stopped >= 5 ? ` They found a better move themselves after ${pct(fixed, stopped)}% of the stops.` : ''}`);
    }
  }

  // puzzles built from their mistakes
  const urls = new Set(state.games.map((g) => g.url)); const by = {};
  kv.keys('pz:').forEach((k) => {
    if (!urls.has(k.slice(3))) return;
    ((kv.get(k) || {}).list || []).forEach((p) => { const s = srsOf(p.id); if (!s) return; const t = (by[p.type] = by[p.type] || { n: 0, ok: 0 }); t.n += s.n; t.ok += s.ok; });
  });
  const tries = Object.values(by).reduce((a, x) => a + x.n, 0);
  if (tries) {
    const ok = Object.values(by).reduce((a, x) => a + x.ok, 0);
    const hard = Object.entries(by).filter(([, x]) => x.n >= 3).sort((a, b) => a[1].ok / a[1].n - b[1].ok / b[1].n)[0];
    L.push(`Puzzles from their own mistakes: ${ok} of ${tries} attempts solved (${pct(ok, tries)}%).${hard ? ` Hardest type: ${typeName(hard[0])} (${hard[1].ok} of ${hard[1].n}).` : ''}`);
  }
  if (m.lessons.length) L.push(`Lessons they asked to remember: ${m.lessons.slice(-6).map((x) => `"${x.text}"`).join('; ')}.`);
  return L;
}

/* ---------- the position the teacher talks about ---------- */
const sideWord = (c) => (c === 'w' ? 'White' : 'Black');
function evWords(cp) {
  if (Math.abs(cp) >= 9000) return `${cp > 0 ? 'White' : 'Black'} has a forced mate in ${Math.max(1, 10000 - Math.abs(cp))}`;
  return Math.abs(cp) < 30 ? `about equal (${evText(cp)})` : `${cp > 0 ? 'White' : 'Black'} is better (${evText(cp)} pawns)`;
}
function matWords(fen, me) {
  const b = matBal(fen) * (me === 'w' ? 1 : -1);
  return !b ? 'material is equal' : `the student is ${b > 0 ? 'up' : 'down'} ${Math.abs(b)} point${Math.abs(b) === 1 ? '' : 's'} of material`;
}
function moveLabelAt(fen, san) { const p = fen.split(' '); return `${p[5] || 1}${p[1] === 'w' ? '.' : '...'} ${san}`; }
const phaseAt = (fen) => (+fen.split(' ')[5] <= 10 ? 'opening' : isEndgame(fen) ? 'endgame' : 'middlegame');
/* explanation texts that only describe what the move allows (they never name the better move) */
const SPOILER_FREE = ['mateAllowed', 'allowedTactic', 'threat', 'hung'];

/* Game review: the move that leads to the position on the board */
function reviewCtx() {
  const s = state.sel; const rv = state.review; const ply = state.ply;
  if (!s || !rv || !ply || !rv.cls[ply - 1]) return null;
  const i = ply - 1; const m = s.moves[i]; const c = rv.cls[i]; const me = s.g.color[0];
  const eb = rv.evals[i], ea = rv.evals[ply];
  return {
    id: `review:${s.g.url}:${ply}`, where: 'review', me, mine: m.color === me, mover: m.color,
    fenBefore: s.fens[i], fenAfter: s.fens[ply], san: m.san, uci: uciOf(m), label: moveName(i, m.san),
    cls: { t: c.t, label: c.label, drop: c.drop }, cpBefore: eb.cp, cpAfter: ea.cp,
    bestUci: eb.best, bestPv: pvOf(eb), refUci: ea.best,
    best: playLine(s.fens[i], pvOf(eb), 8), ref: playLine(s.fens[ply], pvOf(ea), 8),
    ex: c.ex, hint: null, hideBest: false, tag: c.ex && c.ex.tag,
    lastBefore: s.moves[i - 1] || null, lastAfter: m,
    recent: () => s.moves.slice(Math.max(0, i - 5), i).map((x) => x.san),
    // what was really played next; every game move was analyzed, so these are checked too
    next: s.moves.slice(ply, ply + 6).map((x, k) => ({ mv: x, uci: uciOf(x), fen: s.fens[ply + k + 1] })),
    nextTags: rv.cls.slice(ply, ply + 6).map((x) => x && x.label),
    context: [`The student plays ${sideWord(me)} against ${s.g.oppName}${s.g.oppRating ? ` (rated ${s.g.oppRating})` : ''}.`, s.g.variation ? `Opening: ${s.g.variation}.` : '', `Game phase: ${phaseOf(s.fens, i)}.`].filter(Boolean).join(' '),
  };
}
/* Play and learn: the move the coach just stopped. Until the student asks to see the better
   move, the facts leave it out, so the teacher cannot give it away. */
function playCtx() {
  const f = pl.flag; if (!f || pl.phase !== 'flagged') return null;
  const e = f.entry; const after = pl.ch.fen();
  return {
    id: `play:${pl.tok}:${pl.log.length}:${e.uci}`, where: 'play', me: pl.color, mine: true, mover: pl.color,
    fenBefore: f.before, fenAfter: after, san: e.san, uci: e.uci, label: moveLabelAt(f.before, e.san),
    cls: { t: e.t, label: e.label, drop: e.drop }, cpBefore: f.pre.cp, cpAfter: f.post.cp,
    bestUci: f.pre.best, bestPv: pvOf(f.pre), refUci: f.post.best,
    best: playLine(f.before, pvOf(f.pre), 8), ref: playLine(after, pvOf(f.post), 8),
    ex: f.ex, hint: hintText(f), hideBest: !f.better, tag: null, lastBefore: null, lastAfter: null,
    recent: () => pl.ch.history().slice(0, -1).slice(-5), next: null, nextTags: null,
    context: `This is a practice game. The student plays ${sideWord(pl.color)} against ${levelName(pl.elo)}. Game phase: ${phaseAt(f.before)}.`,
  };
}
const teachCtx = (where) => (where === 'play' ? playCtx() : reviewCtx());

/* Stockfish's three best moves in the position before the move */
async function topLines(fen, where) {
  if (teach.topMemo.has(fen)) return teach.topMemo.get(fen);
  if (new Chess(fen).game_over()) return [];
  try {
    const eng = await engineFor(where);
    const r = await eng.search(fen, { depth: 12, multipv: 3 });
    const out = r.lines.map((l) => ({ cp: l.cp, steps: playLine(fen, l.pv, 8) })).filter((x) => x.steps.length);
    teach.topMemo.set(fen, out); return out;
  } catch (_) { return null; }
}
/* the 'live' engine; explore mode's running search is stopped first and restarted afterwards */
async function engineFor(where) {
  if (where === 'review' && state.mode === 'explore') { liveStop(); teach.restartExplore = true; }
  return getEngine('live');
}
function restartExplore() {
  if (!teach.restartExplore) return; teach.restartExplore = false;
  if (state.mode === 'explore' && state.ex) { state.ex.linesFen = null; renderGame(); }
}

/* Everything is spelled out in words: the model reads piece lists and sentences reliably,
   but misreads a FEN (it once said a queen was captured when a knight was, and called a
   pawn-defended knight undefended). */
function factsText(ctx, top) {
  const L = [];
  const wp = (cp, s) => Math.round(winPct(cp * s));
  const opp = ctx.me === 'w' ? 'b' : 'w';
  const mine = (c) => (c === ctx.me ? 'the student' : 'the opponent');
  L.push('POSITION', `- ${ctx.context}`, `- The student is ${sideWord(ctx.me)}; the opponent is ${sideWord(opp)}.`);
  const recent = ctx.recent ? ctx.recent() : [];
  if (recent.length) L.push(`- The moves just before: ${recentText(ctx.fenBefore, recent)}`);
  L.push(`- Pieces on the board before the move. ${piecesText(ctx.fenBefore)}`, `- Before the move, ${matWords(ctx.fenBefore, ctx.me)}.`);
  L.push('', 'THE MOVE', `- ${ctx.label}, played by ${ctx.mine ? 'the student' : "the student's opponent"} (${sideWord(ctx.mover)}).`);
  const played = playLine(ctx.fenBefore, [ctx.uci])[0];
  if (played) moveFacts(ctx.fenBefore, played.mv).forEach((x) => L.push('- ' + x));
  const ms = ctx.mover === 'w' ? 1 : -1;
  L.push(`- Stockfish's verdict: ${ctx.cls.label}. ${ctx.mine ? "The student's" : "The opponent's"} winning chances went from ${wp(ctx.cpBefore, ms)}% to ${wp(ctx.cpAfter, ms)}%.`);
  L.push(`- Evaluation before the move: ${evWords(ctx.cpBefore)}. After: ${evWords(ctx.cpAfter)}.`);
  const before = wp(ctx.cpBefore, ms);
  if (before <= 15) L.push(`- ${sideWord(ctx.mover)} was already losing before this move (winning chances ${before}%). Every move loses, so a good verdict here means the least bad option, not a good position.`);
  if (ctx.cls.t === 'brill') L.push('- The app calls a move brilliant when it is close to the best move and gives up material for less than it is worth.');
  const isBest = ctx.uci === ctx.bestUci;
  if (isBest) L.push("- This was Stockfish's top choice.");
  else if (!ctx.hideBest && ctx.best.length) {
    const word = ['inacc', 'mist', 'blun'].includes(ctx.cls.t) ? 'Better move' : "Stockfish's top choice";
    L.push(`- ${word}: ${ctx.best[0].mv.san}. Stockfish's line, move by move: ${lineWords(ctx.fenBefore, ctx.best.slice(0, 6))}`);
  }
  if (ctx.ref.length) {
    const ref = ctx.ref.slice(0, 6);
    L.push(`- After the move, Stockfish's best reply and line, move by move: ${lineWords(ctx.fenAfter, ref)}`);
    if (played) {
      const cap = capturesIn([played.mv, ...ref.map((x) => x.mv)]);
      if (cap.w.length || cap.b.length) L.push(`- Counting the move and that line: ${['w', 'b'].map((c) => `${sideWord(c)} (${mine(c)}) captures ${cap[c].length ? cap[c].join(', ') : 'nothing'}`).join('; ')}. At the end of the line, ${matWords(ref[ref.length - 1].fen, ctx.me)}.`);
    }
  }
  if (ctx.next && ctx.next.length) L.push(`- What was actually played next in the game, with Stockfish's verdict on each move: ${lineWords(ctx.fenAfter, ctx.next, ctx.nextTags)}`);
  else if (ctx.where === 'review') L.push('- This was the last move of the game.');
  if (ctx.ex && ctx.ex.type !== 'opp' && MTYPES[ctx.ex.type]) {
    L.push(`- Mistake type (from the app's rules): ${MTYPES[ctx.ex.type].label}.`);
    const txt = ctx.hideBest ? (SPOILER_FREE.includes(ctx.ex.type) ? ctx.ex.text : ctx.hint) : ctx.ex.text;
    if (txt) L.push(`- The app's explanation: ${txt}`);
  } else if (ctx.ex && ctx.ex.type === 'opp') L.push(`- The app's explanation: ${ctx.ex.text}`);
  if (ctx.tag) L.push(`- Clock: ${ctx.tag.text}`);
  const lp = loosePieces(ctx.fenAfter);
  if (lp.length) L.push(`- Loose pieces after the move (attacked and not defended, or attacked by something cheaper; a quick check that ignores pins): ${lp.map((x) => `${sideWord(x.color)}'s ${PIECE_NAME[x.piece]} on ${x.sq} (${mine(x.color)})`).join(', ')}.`);
  else L.push('- After the move, no piece of either side is loose (attacked and undefended, or attacked by something cheaper).');
  if (!ctx.hideBest && top && top.length > 1) {
    L.push('', `STOCKFISH'S BEST MOVES FOR ${sideWord(ctx.mover).toUpperCase()} IN THE POSITION BEFORE THE MOVE (best first)`);
    top.forEach((l) => L.push(`- ${l.steps[0].mv.san}: ${evWords(l.cp)}. Line: ${lineText(ctx.fenBefore, l.steps.slice(0, 6))}`));
  }
  if (ctx.hideBest) L.push('', 'NOTE: The student is still looking for a better move themselves, so the better move is deliberately left out of these facts.');
  return L.join('\n');
}
const TONES = {
  roast: "You are a cheeky, sarcastic chess teacher inside Chess Lab, talking with one student who asked to be roasted. Tease their bad moves with playful, funny insults, like a friend who coaches by mocking (for example: \"Your knight didn't develop, it emigrated.\" or \"Bold of you to give away a rook for free. Generous, even.\"). At most one short joke per answer, and only about what really happened in FACTS, then get straight to the point: the lesson matters more than the joke. Mock the moves, never the person: nothing about their intelligence, looks, identity or life outside chess, no swearing, nothing cruel. When they play well, give grudging, funny praise.",
  kind: 'You are a warm, encouraging chess teacher inside Chess Lab, talking with one student.',
};
function systemPrompt(ctx) {
  const rules = [
    TONES[tcfg().tone] || TONES.roast,
    '',
    "How this works: Stockfish, a chess engine, has already analysed the position, and the app's rules have worked out what kind of mistake a move was. Those results are in FACTS below and they are correct. FACTS also spell out the board in words: which pieces stand where, what each move captures, which pieces defend what, and what happened next. Your only job is to explain them so the student understands and remembers the idea.",
    '',
    'Rules:',
    '1. Every claim about the board must come from FACTS. Never work out yourself which piece stands where, what was captured, or whether a piece is defended, hanging or trapped. If FACTS do not say it, do not say it.',
    '2. Never invent or calculate moves, lines or evaluations. Only mention moves that appear in FACTS or in a "STOCKFISH CHECKED" note, written exactly as given (standard notation such as Nf3, exd5, O-O), with the move number FACTS give it.',
    '3. A question that names no move is about THE MOVE: answer it from FACTS. Only when the student names a specific move that is not in FACTS or a STOCKFISH CHECKED note, say Stockfish has not checked it yet and ask them to type it in notation (like Nf3).',
    '4. If the question rests on something FACTS contradict (for example that a piece was free when FACTS say it was defended), say so plainly and explain what really happened. If one of your earlier answers in this chat contradicts FACTS, FACTS win: correct it in one short sentence.',
    "5. For the opponent's move, explain why they played it: what it captured or threatened, what the student could reply (Stockfish's best reply), and what each side ended up with. When the opponent was already losing, say their move was the least bad option.",
    '6. Otherwise say plainly what went wrong and why, naming the pattern (loose piece, fork, pin, skewer, back rank, king safety and so on), and what the better move does instead.',
    '7. Be short, clear and direct: 2 or 3 sentences, about 60 words at most. No bullet points, no headings, no introduction, and do not repeat the question or the facts back. Go longer only when the student asks for more detail.',
    '8. Use the STUDENT PROFILE only when it matters: if this is a mistake they make often, say so in a few words. Do not recite the profile.',
    "9. Match the student's level and use plain words. Talk to the student as \"you\". Never claim to be Stockfish.",
  ];
  if (ctx.hideBest) {
    rules.push('10. The student is still looking for a better move. Do not name, hint at or guess a specific move, piece to move or square. Help them search: explain what their move allows and what to look at (checks, captures, threats, loose pieces). End with one short question for them to think about, not with a takeaway.');
  } else {
    rules.push('10. In your first answer about this position, end with one line that starts with "Takeaway:" followed by one habit to remember, in 12 words or fewer. It must follow from what happened in FACTS.');
  }
  return rules.join('\n');
}
function firstQuestion(ctx) {
  if (ctx.hideBest) return "Help me see what's wrong with my move, without telling me the answer.";
  if (!ctx.mine) return ['inacc', 'mist', 'blun'].includes(ctx.cls.t) ? 'What did my opponent get wrong, and how could I punish it?' : 'Explain this move by my opponent.';
  if (['inacc', 'mist', 'blun'].includes(ctx.cls.t)) return 'Explain my mistake.';
  return 'Why is this a good move?';
}
function suggestions(ctx, cv) {
  const asked = new Set(cv.msgs.filter((x) => x.role === 'user').map((x) => x.text));
  let list;
  if (ctx.hideBest) list = ['Give me another hint', 'What does my move allow?'];
  else if (!ctx.mine) list = ['How do I spot chances like this?', 'Explain it more simply'];
  else if (['inacc', 'mist', 'blun'].includes(ctx.cls.t)) list = ['Explain it more simply', 'Why is the better move better?', 'Is this a mistake I make often?', 'What should I check before moving next time?'];
  else list = ['What were the other good options?', 'Explain it more simply'];
  return list.filter((q) => !asked.has(q)).slice(0, 3);
}

/* ---------- moves the student asks about: Stockfish checks them first ---------- */
const Q_SAN = /(?<![\w-])([O0]-[O0]-[O0]|[O0]-[O0]|[KQRBN][a-h]?[1-8]?x?[a-h][1-8](?:=?[QRBN])?|[a-h]x[a-h][1-8](?:=?[QRBN])?|[a-h][1-8](?:=?[QRBN])?)[+#]?(?![\w-])/g;
function askedMoves(q) {
  const out = [];
  for (const m of q.matchAll(Q_SAN)) {
    const tok = m[1].replace(/0/g, 'O');
    // "my knight on e5" names a square, not a pawn move
    if (/^[a-h][1-8]/.test(tok) && /\b(on|to|at|from|square|of)\s*$/i.test(q.slice(0, m.index))) continue;
    if (!out.includes(tok)) out.push(tok);
  }
  return out.slice(0, 3);
}
async function checkAsked(ctx, toks) {
  const notes = [], lines = [];
  const eng = await engineFor(ctx.where);
  for (const tok of toks) {
    let found = false;
    for (const [fen, before] of [[ctx.fenBefore, true], [ctx.fenAfter, false]]) {
      const ch = new Chess(fen); let mv = null;
      try { mv = ch.move(tok, { sloppy: true }); } catch (_) { mv = null; }
      if (!mv) continue;
      found = true;
      const uci = uciOf(mv); const label = moveLabelAt(fen, mv.san);
      if (before && uci === ctx.uci) { notes.push(`- ${label} is the move that was actually played (see FACTS).`); break; }
      const post = await evalPosition(eng, ch.fen(), COACH_DEPTH);
      const ref = before ? { cp: ctx.cpBefore, best: ctx.bestUci, pv: ctx.bestPv } : { cp: ctx.cpAfter, best: ctx.refUci };
      const ms = mv.color === 'w' ? 1 : -1; const isBest = uci === ref.best;
      const drop = isBest ? 0 : Math.max(0, winPct(ref.cp * ms) - winPct(post.cp * ms));
      const verdict = isBest ? "Stockfish's top choice" : clsOf(drop)[3];
      const steps = playLine(fen, [uci, ...post.pv], 8);
      const who = mv.color === ctx.me ? 'the student' : 'the opponent';
      let s = `- ${label}${before && ctx.mine ? ` (instead of ${ctx.san})` : ''}, a move for ${who}: ${verdict}. Winning chances for ${who} after it: ${Math.round(winPct(post.cp * ms))}% (with Stockfish's best move: ${Math.round(winPct(ref.cp * ms))}%). Stockfish's line: ${lineText(fen, steps)}. Evaluation after it: ${evWords(post.cp)}.`;
      if (mv.color === ctx.me && drop >= 10 && ref.pv) {
        let ex = null;
        try { ex = explainMove({ moves: [mv], fens: [fen, ch.fen()], clocks: [], spent: [], base: null }, [ref, post], 0, drop, null); } catch (_) { ex = null; }
        if (ex && MTYPES[ex.type]) {
          const txt = ctx.hideBest && !SPOILER_FREE.includes(ex.type) ? '' : ex.text;
          s += ` App rules: ${MTYPES[ex.type].label}.${txt ? ' ' + txt : ''}`;
        }
      }
      notes.push(s);
      lines.push({ root: fen, steps, rootLast: before ? ctx.lastBefore : ctx.lastAfter, title: `${mv.san}, checked by Stockfish` });
      break;
    }
    if (!found) notes.push(`- ${tok}: not a legal move in the position before the move or right after it.`);
  }
  return { text: notes.length ? 'STOCKFISH CHECKED THE MOVES IN THIS QUESTION\n' + notes.join('\n') : '', lines };
}

/* ---------- conversations ---------- */
function convo(id) {
  if (!teach.convos.has(id)) teach.convos.set(id, { id, msgs: [], asked: [], open: false, busy: false, status: '', err: '', ctrl: null, ver: 0, lines: [], top: null });
  return teach.convos.get(id);
}
const bump = (cv) => { cv.ver++; teachSync(); };
function ctxLines(ctx, cv) {
  const out = [];
  const add = (root, steps, rootLast, title) => { if (steps && steps.length) out.push({ root, steps, rootLast, title }); };
  add(ctx.fenBefore, playLine(ctx.fenBefore, [ctx.uci]), ctx.lastBefore, 'The move played');
  add(ctx.fenAfter, ctx.ref, ctx.lastAfter, ctx.mine ? 'Their best reply' : 'The best answer');
  if (!ctx.hideBest) { add(ctx.fenBefore, ctx.best, ctx.lastBefore, "Stockfish's line"); (cv.top || []).forEach((l) => add(ctx.fenBefore, l.steps, ctx.lastBefore, "Stockfish's line")); }
  add(ctx.fenAfter, ctx.next, ctx.lastAfter, 'What happened in the game');
  return out.concat(cv.asked);
}

async function teachAsk(where, q) {
  q = (q || '').trim(); if (!q) return;
  const ctx = teachCtx(where); if (!ctx) return;
  if (!tready()) { teach.pending = { where, q }; openTeachDlg(); return; }
  const cv = convo(ctx.id); if (cv.busy) return;
  cv.msgs = cv.msgs.filter((x) => !x.failed);
  const um = { role: 'user', text: q, send: q }; cv.msgs.push(um);
  cv.open = true; cv.busy = true; cv.err = ''; cv.status = "Getting Stockfish's facts..."; bump(cv);
  let am = null;
  try {
    if (!ctx.hideBest && !cv.top) cv.top = await topLines(ctx.fenBefore, where);
    const toks = cv.msgs.length > 1 ? askedMoves(q) : [];
    if (toks.length) {
      cv.status = `Stockfish is checking ${toks.join(', ')}...`; bump(cv);
      const chk = await checkAsked(ctx, toks);
      if (chk.text) um.send = q + '\n\n' + chk.text;
      cv.asked.push(...chk.lines);
    }
    restartExplore();
    const fresh = teachCtx(where); const c2 = fresh && fresh.id === ctx.id ? fresh : ctx; // e.g. the better move was revealed meanwhile
    const prof = profileFacts();
    const sys = `${systemPrompt(c2)}\n\nSTUDENT PROFILE (worked out by the app from the student's own games and practice)\n${prof.length ? prof.map((x) => '- ' + x).join('\n') : '- Nothing is known about this student yet.'}\n\nFACTS\n${factsText(c2, cv.top)}`;
    const hist = cv.msgs.filter((x) => !x.failed && (x.role === 'user' || x.text)).slice(-7).map((x) => ({ role: x.role, content: x.send || x.text }));
    am = { role: 'assistant', text: '', streaming: true }; cv.msgs.push(am);
    cv.status = 'The teacher is writing...'; cv.ctrl = new AbortController(); bump(cv);
    const res = await aiChat([{ role: 'system', content: sys }, ...hist], (t) => { am.text = t; if (cv.status) { cv.status = ''; bump(cv); } else paintStream(cv); }, cv.ctrl.signal);
    am.streaming = false; am.text = res.text;
    if (res.fellBack) am.via = `Answered by the backup, ${sname(tcfg(), res.slot)}, because ${res.why && res.why.limit ? 'the main model used up its free allowance for now' : 'the main model did not answer'}.`;
    const tk = splitTakeaway(am.text); am.takeaway = tk.takeaway;
    announce('The teacher says: ' + plainText(am.text));
  } catch (e) {
    restartExplore();
    if (am) am.streaming = false;
    if (e.name === 'AbortError') { if (am && !am.text) cv.msgs.pop(); }
    else {
      if (am && !am.text) cv.msgs.pop();
      if (!am || !am.text) um.failed = true;
      cv.err = e.message; announce(e.message);
    }
  }
  cv.busy = false; cv.status = ''; cv.ctrl = null; bump(cv);
}
function teachOpen(where) {
  const ctx = teachCtx(where); if (!ctx) return;
  const cv = convo(ctx.id);
  if (cv.msgs.length) { cv.open = true; bump(cv); focusPanel(where); return; }
  if (!tready()) { teach.pending = { where, q: firstQuestion(ctx) }; openTeachDlg(); return; }
  teachAsk(where, firstQuestion(ctx));
  focusPanel(where);
}
function focusPanel(where) {
  const p = panelOf(where); if (!p || p.hidden) return;
  p.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  p.focus({ preventScroll: true });
}

/* ---------- rendering ---------- */
const panelOf = (where) => (where === 'play' ? $('#pTeach') : $('#teach'));
/* which conversation each panel shows right now (null hides it) */
function shownConvo(where) {
  if (where === 'play') {
    if ($('#play').hidden) return null;
    const ctx = playCtx(); const cv = ctx && teach.convos.get(ctx.id);
    return cv && cv.open ? { cv, ctx } : null;
  }
  if (!state.sel || state.mode === 'guess') return null;
  if (state.mode === 'explore') { // keep the conversation beside the line you are stepping through
    const cv = teach.last && teach.convos.get(teach.last.id);
    return cv && cv.open && teach.last.id.startsWith(`review:${state.sel.g.url}:`) ? { cv, ctx: teach.last } : null;
  }
  const ctx = reviewCtx(); const cv = ctx && teach.convos.get(ctx.id);
  if (ctx) teach.last = ctx;
  return cv && cv.open ? { cv, ctx } : null;
}
function teachSync() {
  ['review', 'play'].forEach((where) => {
    const p = panelOf(where); if (!p) return;
    const sc = shownConvo(where);
    if (!sc) { p.hidden = true; p.dataset.key = ''; return; }
    const key = `${sc.cv.id}:${sc.cv.ver}:${sc.ctx.hideBest}`;
    p.hidden = false;
    if (p.dataset.key === key) return;
    p.dataset.key = key; renderPanel(p, where, sc.cv, sc.ctx);
  });
  // the button in the coach box and on the Play card says whether a conversation is open
  [['review', '#coach'], ['play', '#pCard']].forEach(([where, box]) => {
    const b = document.querySelector(box + ' [data-act="teach"]'); const h = teachBtnHtml(where); if (b && b.outerHTML !== h) b.outerHTML = h;
  });
}
function renderPanel(p, where, cv, ctx) {
  const c = tcfg(); const input = p.querySelector('input');
  const typed = input ? input.value : ''; const hadFocus = input && document.activeElement === input;
  cv.lines = ctxLines(ctx, cv);
  const known = knownMoves(cv.lines);
  const msgs = cv.msgs.map((x, k) => (x.role === 'user'
    ? `<div class="tMsg me${x.failed ? ' failed' : ''}"><span class="sr">You asked: </span>${esc(x.text)}</div>`
    : `<div class="tMsg ai${x.streaming ? ' streaming' : ''}" data-mi="${k}"><span class="sr">Teacher: </span>${answerHtml(x, k, known, where)}</div>`)).join('');
  const sugg = !cv.busy && cv.msgs.some((x) => x.role === 'assistant') ? suggestions(ctx, cv) : [];
  const foot = ['Stockfish checks any move you type, like Nf3 or exd5.'];
  if (msgs.includes('class="mvx"')) foot.push('Moves with a dotted underline were not checked: click one to check it.');
  else if (where === 'review' && msgs.includes('class="mvc"')) foot.push('Click a move in an answer to step through its line.');
  p.innerHTML = `
    <div class="teachHead"><span class="teacherAvatar" aria-hidden="true">${icon('cap')}</span><span class="modeTag">Teacher</span><b>${esc(ctx.label)}</b>${ctx.hideBest ? '<span class="badge tag">Hint mode</span>' : ''}
      <span class="tWho">${esc(sready(c, c.main) ? sname(c, c.main) : sready(c, c.backup) ? sname(c, c.backup) : 'Not set up')}</span>
      <span class="tEnd"><button type="button" class="ghost" data-t="settings">${icon('gear')} Settings</button><button type="button" class="ghost" data-t="close" aria-label="Close the teacher">${icon('x')} Close</button></span></div>
    <div class="tLog">${msgs}</div>
    ${cv.status ? `<p class="tStatus"><span class="spin" aria-hidden="true"></span>${esc(cv.status)}</p>` : ''}
    ${cv.err ? `<div class="tErr" role="alert"><p>${esc(cv.err)}</p><div class="acts"><button type="button" data-t="retry">Try again</button><button type="button" data-t="settings">Teacher settings</button></div></div>` : ''}
    ${sugg.length ? `<div class="tSuggest" aria-label="Suggested questions">${sugg.map((q) => `<button type="button" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>` : ''}
    <form class="tAsk"><label for="tq-${where}" class="sr">Ask the teacher a question</label>
      <input id="tq-${where}" autocomplete="off" spellcheck="false" placeholder="Ask a question, for example: why not ${esc(sampleMove(ctx))}?">
      ${cv.busy ? '<button type="button" data-t="stop">Stop</button>' : '<button class="primary">Ask</button>'}</form>
    <p class="tFoot">${foot.join(' ')}</p>`;
  const inp = p.querySelector('input'); if (inp) { inp.value = typed; if (hadFocus) inp.focus(); }
}
/* a legal move for the placeholder that is not the answer */
function sampleMove(ctx) {
  try {
    const ms = new Chess(ctx.fenBefore).moves().filter((m) => !/[+#x]/.test(m) && uciOf(new Chess(ctx.fenBefore).move(m)) !== ctx.bestUci && m !== ctx.san);
    return ms.find((m) => /^[NB]/.test(m)) || ms[0] || 'Nf3';
  } catch (_) { return 'Nf3'; }
}
function paintStream(cv) {
  if (cv.raf) return;
  cv.raf = requestAnimationFrame(() => {
    cv.raf = 0;
    ['review', 'play'].forEach((where) => {
      const p = panelOf(where); if (!p || p.hidden || !p.dataset.key.startsWith(cv.id + ':')) return;
      const k = cv.msgs.length - 1; const el = p.querySelector(`.tMsg.ai[data-mi="${k}"]`); if (!el) return;
      el.innerHTML = '<span class="sr">Teacher: </span>' + answerHtml(cv.msgs[k], k, knownMoves(cv.lines), where);
    });
  });
}

/* every SAN move in the lines Stockfish supplied -> where to step through it, with its move
   number, so "30.Qxh6" only counts as checked when some line has Qxh6 as move 30 */
function knownMoves(lines) {
  const m = new Map();
  lines.forEach((l, li) => {
    const nums = stepNums(l.root, l.steps.length);
    l.steps.forEach((x, k) => { const san = x.mv.san.replace(/[+#]$/, ''); if (!m.has(san)) m.set(san, []); m.get(san).push({ li, k: k + 1, n: nums[k].n }); });
  });
  return m;
}
/* a move number before a move: "12.", "12...", "12…", "12. ..." or a bare "12 " before a piece move */
const A_SAN = /(?<![\w-])(\d+(?:\.\s?(?:\.\.|…)?|…)\s?|\d+\s(?=[KQRBNO]))?(O-O-O|O-O|[KQRBN][a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?|[a-h]x[a-h][1-8](?:=[QRBN])?|[a-h][1-8](?:=[QRBN])?)([+#])?(?![\w-])/g;
function movesHtml(h, known, where) {
  return h.replace(A_SAN, (all, num, san, chk) => {
    const at = known.get(san) || []; const n = num ? parseInt(num, 10) : null;
    const hit = n == null ? at[0] : at.find((x) => x.n === n); const bare = /^[a-h][1-8](=[QRBN])?$/.test(san);
    if (bare && !num) return all; // "the pawn on e5" is a square, not a move
    const pre = num || ''; const txt = san + (chk || '');
    if (hit) {
      return where === 'review'
        ? `${pre}<button type="button" class="mvc" data-li="${hit.li}" data-k="${hit.k}" title="Checked by Stockfish. Click to step through the line.">${txt}</button>`
        : `${pre}<span class="mvc" title="Checked by Stockfish">${txt}</span>`;
    }
    return `${pre}<button type="button" class="mvx" data-ask="${san}" title="Not checked by Stockfish. Click to check it.">${txt}<span class="sr"> (not checked by Stockfish)</span></button>`;
  });
}
function inlineMd(s, known, where) {
  let h = esc(s).replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![*\w])/g, '$1<i>$2</i>');
  h = movesHtml(h, known, where);
  return h;
}
function splitTakeaway(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  for (let k = lines.length - 1; k >= 0; k--) {
    const m = lines[k].match(/^\s*[*_]*\s*takeaway\s*:?\s*[*_]*\s*:?\s*(.+?)\s*[*_]*\s*$/i);
    if (m) return { body: lines.slice(0, k).concat(lines.slice(k + 1)).join('\n'), takeaway: m[1].replace(/\*\*/g, '').trim() };
    if (lines[k].trim()) break;
  }
  return { body: text, takeaway: null };
}
function answerHtml(x, k, known, where) {
  const { body, takeaway } = x.streaming ? { body: x.text, takeaway: null } : splitTakeaway(x.text);
  let html = ''; let list = false;
  body.replace(/\r/g, '').split('\n').forEach((raw) => {
    const ln = raw.trim().replace(/^#{1,6}\s+/, '');
    const li = ln.match(/^[-*•]\s+(.*)/);
    if (!ln) { if (list) { html += '</ul>'; list = false; } return; }
    if (li) { if (!list) { html += '<ul>'; list = true; } html += `<li>${inlineMd(li[1], known, where)}</li>`; return; }
    if (list) { html += '</ul>'; list = false; }
    html += `<p>${inlineMd(ln, known, where)}</p>`;
  });
  if (list) html += '</ul>';
  if (takeaway) {
    html += `<div class="takeaway"><p><b>Takeaway:</b> ${inlineMd(takeaway, known, where)}</p>${x.saved ? '<span class="tSaved">Saved to your profile</span>' : `<button type="button" data-t="remember" data-mi="${k}">Remember this</button>`}</div>`;
  }
  if (x.via) html += `<p class="tVia">${esc(x.via)}</p>`;
  return html || '<p class="muted" style="margin:0">...</p>';
}
const plainText = (t) => t.replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim();

/* ---------- panel actions ---------- */
function panelClick(where, e) {
  const sc = shownConvo(where); if (!sc) return;
  const { cv, ctx } = sc; const t = e.target.closest('button'); if (!t) return;
  const act = t.dataset.t;
  if (act === 'settings') return openTeachDlg();
  if (act === 'close') { cv.open = false; bump(cv); return; }
  if (act === 'stop') { if (cv.ctrl) cv.ctrl.abort(); return; }
  if (act === 'retry') { const last = [...cv.msgs].reverse().find((x) => x.role === 'user'); cv.err = ''; if (last) { cv.msgs = cv.msgs.filter((x) => x !== last); teachAsk(where, last.text); } return; }
  if (act === 'remember') {
    const m = cv.msgs[+t.dataset.mi]; if (!m || !m.takeaway || m.saved) return;
    const mem = tmem(); const kind = ctx.ex && MTYPES[ctx.ex.type] ? MTYPES[ctx.ex.type].label : ctx.cls.label;
    mem.lessons = [...mem.lessons, { t: Date.now(), text: m.takeaway.slice(0, 240), from: `${kind}, ${ctx.label}` }].slice(-30);
    tmemSave(mem); m.saved = true; bump(cv); announce('Saved to your profile. The teacher will remember it.');
    return;
  }
  if (t.dataset.q) return teachAsk(where, t.dataset.q);
  if (t.dataset.ask) return teachAsk(where, `What about ${t.dataset.ask}?`);
  if (t.dataset.li != null && where === 'review') {
    const l = cv.lines[+t.dataset.li]; if (!l) return;
    teach.last = ctx; startExplore(l.root, l.steps.map((x) => x.uci), +t.dataset.k, l.rootLast, l.title);
  }
}
['review', 'play'].forEach((where) => {
  const p = panelOf(where); if (!p) return;
  p.addEventListener('click', (e) => panelClick(where, e));
  p.addEventListener('submit', (e) => {
    e.preventDefault(); const inp = p.querySelector('input'); const q = inp ? inp.value.trim() : '';
    const sc = shownConvo(where); if (!q || !sc || sc.cv.busy) return;
    inp.value = ''; teachAsk(where, q);
  });
});
$('#coach').addEventListener('click', (e) => { if (e.target.closest('[data-act="teach"]')) teachOpen('review'); });
$('#pCard').addEventListener('click', (e) => { if (e.target.closest('[data-act="teach"]')) teachOpen('play'); });
/* the button in the coach box and on the Play card */
function teachBtnHtml(where) {
  const ctx = teachCtx(where); const cv = ctx && teach.convos.get(ctx.id);
  const open = cv && cv.open; const has = cv && cv.msgs.length;
  return `<button data-act="teach" class="teachBtn"${open ? ' aria-expanded="true"' : ''}>${icon('cap')} ${has ? (open ? 'Teacher is open below' : 'Back to the teacher') : 'Ask the teacher'}</button>`;
}

/* ---------- settings dialog ---------- */
/* The main and backup slots are drawn by slotHtml into #tdMain and #tdBackup; every control
   carries data-slot (main or backup) and data-f (what it sets). */
const SLOT_NAME = { main: 'main AI', backup: 'backup AI' };
function openTeachDlg() {
  const d = $('#teachDlg'); fillDlg(); if (!d.open) d.showModal();
}
function slotHtml(c, which) {
  const s = c[which]; const off = !s.provider;
  const opts = (which === 'backup' ? [['', 'No backup']] : []).concat(Object.entries(TEACH_PROVIDERS).map(([k, v]) => [k, v.name + (k === TEACH_RECOMMENDED ? ' (recommended)' : '')]));
  let h = `<div class="field"><label for="td-${which}-prov" class="flabel">Service</label><select id="td-${which}-prov" data-slot="${which}" data-f="prov">${opts.map(([k, l]) => `<option value="${k}"${k === s.provider ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
  if (off) return h + '<p class="small muted" style="margin:0">Without a backup, the teacher stops when the main AI runs out of free questions until its allowance comes back.</p>';
  const P = sprov(s); const shared = which === 'backup' && s.provider === c.main.provider;
  if (shared) h += `<p class="small muted tdNote">Uses the same ${P.keyOptional ? 'address' : 'key'} as the main AI. Pick a different model${s.provider === 'groq' ? ': on Groq every model has its own free allowance, so this doubles what one key can do' : ''}.</p>`;
  else {
    h += `<div class="tdHelp">${P.limits ? `<p class="tdLimits">${esc(P.limits)}</p>` : ''}<p class="flabel">${P.keyOptional ? 'How to set it up' : 'Get a free key'}</p><ol>${P.steps.map((x) => `<li>${x}</li>`).join('')}</ol></div>`;
    if (P.editBase) h += `<div class="field"><label for="td-${which}-base" class="flabel">Address</label><input id="td-${which}-base" data-slot="${which}" data-f="base" value="${esc(c.base[s.provider] || '')}" placeholder="https://.../v1" autocomplete="off" spellcheck="false"></div>`;
    if (s.provider !== 'ollama') {
      h += `<div class="field"><label for="td-${which}-key" class="flabel">${P.keyOptional ? 'API key (optional)' : 'API key'}</label>
        <div class="row2"><input id="td-${which}-key" type="password" data-slot="${which}" data-f="key" value="${esc(c.keys[s.provider] || '')}" autocomplete="off" spellcheck="false" aria-describedby="td-${which}-keynote"><button type="button" data-slot="${which}" data-f="show" aria-pressed="false" aria-controls="td-${which}-key">Show</button></div>
        <p id="td-${which}-keynote" class="small muted" style="margin:0">Saved only in this browser, and sent only to ${esc(P.name)}.</p></div>`;
    }
  }
  const list = c.lists[s.provider] || []; const cur = smodel(c, s);
  const all = cur && !list.includes(cur) ? [cur, ...list] : list;
  h += `<div class="field"><label for="td-${which}-model" class="flabel">Model</label><div class="row2"><select id="td-${which}-model" data-slot="${which}" data-f="model">${all.length ? all.map((id) => `<option${id === cur ? ' selected' : ''}>${esc(id)}</option>`).join('') : '<option value="">Press Refresh list</option>'}</select><button type="button" data-slot="${which}" data-f="load">Refresh list</button></div></div>`;
  h += `<p class="small tdMsg" id="td-${which}-msg" role="status"></p>`;
  return h;
}
function fillSlots() {
  const c = tcfg(); const f = document.activeElement && document.activeElement.closest('#teachDlg') ? document.activeElement.id : null;
  $('#tdMain').innerHTML = slotHtml(c, 'main'); $('#tdBackup').innerHTML = slotHtml(c, 'backup');
  if (f && document.getElementById(f)) document.getElementById(f).focus();
  const names = [...new Set([c.main, c.backup].filter((s) => s.provider).map((s) => sprov(s).name))];
  const priv = [...new Set([c.main, c.backup].filter((s) => s.provider).map((s) => sprov(s).privacy).filter(Boolean))];
  $('#tdPriv').textContent = `When you ask the teacher, the position, Stockfish's findings and the profile below are sent to ${names.join(' or ') || 'the AI service'}. ${priv.join(' ')}`;
}
function fillDlg() {
  const c = tcfg();
  fillSlots();
  $('#tdTone').querySelectorAll('button').forEach((b) => { const on = b.dataset.v === c.tone; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  $('#tdAbout').value = tmem().about;
  fillProfile(); $('#tdTestMsg').textContent = ''; $('#tdTestMsg').className = 'small';
}
function fillProfile() {
  const L = profileFacts().filter((x) => !x.startsWith('In their own words') && !x.startsWith('Lessons they asked'));
  $('#tdProfile').innerHTML = L.length ? L.map((x) => `<li>${esc(x)}</li>`).join('') : '<li class="muted" style="margin:0">Nothing yet. Analyze some games, play a practice game or solve puzzles, and the teacher learns what you tend to get wrong.</li>';
  const ls = tmem().lessons;
  $('#tdLessons').innerHTML = ls.length ? ls.slice().reverse().map((x, k) => `<li><span>${esc(x.text)}<small>${esc(x.from || '')}</small></span><button type="button" class="ghost" data-del="${ls.length - 1 - k}" aria-label="Delete the lesson: ${esc(x.text)}">Delete</button></li>`).join('')
    : '<li class="muted" style="margin:0">None yet. Press Remember this under one of the teacher\'s takeaways to keep it here.</li>';
}
const slotMsg = (which, text, cls = '') => { const el = document.getElementById(`td-${which}-msg`); if (el) { el.className = `small tdMsg ${cls}`; el.textContent = text; } };
async function loadModels(which, quiet) {
  const c = tcfg(); const s = c[which]; if (!s.provider) return;
  const P = sprov(s);
  if (!sbase(c, s)) { if (!quiet) slotMsg(which, 'Enter the address first.', 'bad'); return; }
  if (!P.keyOptional && !c.keys[s.provider]) { if (!quiet) slotMsg(which, 'Paste your key first.', 'bad'); return; }
  slotMsg(which, 'Loading the models...');
  try {
    const list = await aiModels(c, s);
    if (!list.length) throw failure('No chat models were found for this key.');
    const c2 = tcfg(); c2.lists[s.provider] = list;
    const avoid = which === 'backup' && c2.backup.provider === c2.main.provider ? smodel(c2, c2.main) : null;
    c2[which].model = pickModel(P, list, c2[which].model, avoid);
    // the other slot on the same service gets a sensible pick from the fresh list too
    const other = which === 'main' ? 'backup' : 'main';
    if (c2[other].provider === s.provider && !list.includes(c2[other].model)) c2[other].model = pickModel(P, list, '', other === 'backup' ? c2.main.model : null);
    tsave(c2); fillSlots();
    slotMsg(which, `${list.length} model${list.length === 1 ? '' : 's'} found. Using ${c2[which].model}.`);
  } catch (err) { slotMsg(which, err.message, 'bad'); }
}
function slotChange(e) {
  const el = e.target; const which = el.dataset.slot; const f = el.dataset.f; if (!which || !f) return;
  const c = tcfg(); const s = c[which];
  if (f === 'prov') {
    s.provider = el.value; s.model = ''; tsave(c); fillSlots();
    if (s.provider && (c.lists[s.provider] || []).length) { const c2 = tcfg(); const P = sprov(c2[which]); c2[which].model = pickModel(P, c2.lists[s.provider], '', which === 'backup' && c2.backup.provider === c2.main.provider ? smodel(c2, c2.main) : null); tsave(c2); fillSlots(); }
    else if (s.provider && (sprov(s).keyOptional || c.keys[s.provider])) loadModels(which, true);
  } else if (f === 'key') { c.keys[s.provider] = el.value.trim(); tsave(c); if (c.keys[s.provider]) loadModels(which, true); }
  else if (f === 'base') { c.base[s.provider] = el.value.trim(); tsave(c); }
  else if (f === 'model') { if (el.value) { s.model = el.value; tsave(c); } }
}
$('#teachDlg').addEventListener('change', slotChange);
$('#teachDlg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-f]'); if (!b) return;
  const which = b.dataset.slot;
  if (b.dataset.f === 'load') loadModels(which, false);
  else if (b.dataset.f === 'show') {
    const inp = document.getElementById(`td-${which}-key`); if (!inp) return;
    const show = inp.type === 'password'; inp.type = show ? 'text' : 'password';
    b.textContent = show ? 'Hide' : 'Show'; b.setAttribute('aria-pressed', String(show));
  }
});
$('#tdTone').addEventListener('click', (e) => {
  const b = e.target.closest('[data-v]'); if (!b) return;
  const c = tcfg(); c.tone = b.dataset.v; tsave(c); fillDlg();
});
/* asks each slot on its own, so a broken backup does not hide behind a working main AI */
$('#tdTest').addEventListener('click', async () => {
  const c = tcfg(); const out = $('#tdTestMsg');
  const slots = ['main', 'backup'].filter((w) => c[w].provider);
  if (!slots.some((w) => sready(c, c[w]))) { out.className = 'small bad'; out.textContent = 'Paste a key and pick a model first.'; return; }
  out.className = 'small'; out.textContent = 'Asking the teacher...';
  const res = await Promise.all(slots.map(async (w) => {
    const s = c[w]; if (!sready(c, s)) return [w, false, 'not set up yet'];
    try { await chatOnce(c, s, [{ role: 'user', content: 'Reply with exactly these words: Ready to teach.' }], () => {}); return [w, true, `works (${smodel(c, s)})`]; }
    catch (err) { return [w, false, err.message]; }
  }));
  out.className = 'small ' + (res.every((x) => x[1]) ? 'good' : res.some((x) => x[1]) ? '' : 'bad');
  out.textContent = res.map(([w, , t]) => `${w === 'main' ? 'Main' : 'Backup'}: ${t}`).join(' ');
});
$('#tdAbout').addEventListener('input', () => { const m = tmem(); m.about = $('#tdAbout').value.slice(0, 600); tmemSave(m); });
$('#tdLessons').addEventListener('click', (e) => {
  const b = e.target.closest('[data-del]'); if (!b) return;
  const m = tmem(); m.lessons.splice(+b.dataset.del, 1); tmemSave(m); fillProfile(); announce('Lesson deleted.');
});
$('#tdForget').addEventListener('click', () => {
  // two clicks, so one stray tap does not wipe the history
  if (!teach.forgetArmed) {
    teach.forgetArmed = true; $('#tdForget').textContent = 'Click again to forget';
    setTimeout(() => { teach.forgetArmed = false; $('#tdForget').textContent = 'Forget lessons and practice history'; }, 3000);
    return;
  }
  teach.forgetArmed = false; $('#tdForget').textContent = 'Forget lessons and practice history';
  const m = tmem(); tmemSave({ about: m.about, lessons: [], flags: [], games: [] }); fillProfile(); announce('Saved lessons and practice history forgotten.');
});
$('#teachDlg').addEventListener('close', () => {
  // a key typed but not yet committed (no change event) still counts
  const c = tcfg();
  ['main', 'backup'].forEach((w) => { const k = document.getElementById(`td-${w}-key`); if (k && c[w].provider) c.keys[c[w].provider] = k.value.trim(); });
  tsave(c);
  const pend = teach.pending; teach.pending = null;
  ['review', 'play'].forEach((w) => { const p = panelOf(w); if (p) p.dataset.key = ''; }); teachSync(); // the model name in an open panel may have changed
  if (pend && tready()) { teachAsk(pend.where, pend.q); focusPanel(pend.where); }
});
$('#teachBtn').addEventListener('click', openTeachDlg);
