/* Shared helpers and storage.
   Small settings (theme, last username) live in localStorage. Games, analyses, notes and
   puzzle progress live in IndexedDB, because localStorage is capped at about 5 MB and an
   active player's year of games can pass that. Everything is loaded into memory at start,
   so reads stay synchronous; writes go to IndexedDB in the background. */

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
/* one polite status message for screen readers (puzzle and guess results) */
function announce(text) { const el = document.getElementById('announce'); if (!el) return; el.textContent = ''; setTimeout(() => { el.textContent = text; }, 30); }

const PREF_KEYS = ['theme', 'user', 'threats'];
const prefs = {
  get(k) { try { return JSON.parse(localStorage.getItem('chesslab:' + k)); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem('chesslab:' + k, JSON.stringify(v)); return true; } catch (_) { return false; } },
};

const kv = (() => {
  const mem = new Map();
  let db = null; let warned = false;
  const api = { onError: null, persistent: false };
  const fail = (err) => {
    if (warned) return; warned = true;
    if (api.onError) api.onError(err && err.name === 'QuotaExceededError' ? 'your browser storage is full' : (err && err.message) || 'unknown error');
  };

  function open() {
    return new Promise((res, rej) => {
      if (!window.indexedDB) return rej(new Error('IndexedDB is not available'));
      const r = indexedDB.open('chesslab', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error('IndexedDB is blocked'));
    });
  }
  function loadAll() {
    return new Promise((res, rej) => {
      const c = db.transaction('kv', 'readonly').objectStore('kv').openCursor();
      c.onsuccess = () => { const cur = c.result; if (cur) { mem.set(cur.key, cur.value); cur.continue(); } else res(); };
      c.onerror = () => rej(c.error);
    });
  }
  function oldKeys() {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('chesslab:') && !PREF_KEYS.includes(k.slice(9))) out.push(k);
      }
    } catch (_) { /* storage blocked */ }
    return out;
  }
  /* Older versions kept everything in localStorage. Copy it across in one transaction and
     remove the old copies only after the copy has been committed. */
  function migrate() {
    const keys = oldKeys(); if (!keys.length) return Promise.resolve();
    const items = keys.map((k) => { let v = null; try { v = JSON.parse(localStorage.getItem(k)); } catch (_) { /* skip */ } return [k, k.slice(9), v]; })
      .filter(([, , v]) => v != null);
    if (!db) { items.forEach(([, key, v]) => mem.set(key, v)); return Promise.resolve(); }
    return new Promise((res) => {
      const t = db.transaction('kv', 'readwrite'); const st = t.objectStore('kv');
      items.forEach(([, key, v]) => { if (!mem.has(key)) { mem.set(key, v); st.put(v, key); } });
      t.oncomplete = () => { keys.forEach((k) => { try { localStorage.removeItem(k); } catch (_) { /* ignore */ } }); res(); };
      t.onerror = t.onabort = () => res();
    });
  }

  api.ready = (async () => {
    try { db = await open(); await loadAll(); api.persistent = true; } catch (_) { db = null; }
    await migrate();
  })();

  api.get = (k) => (mem.has(k) ? mem.get(k) : null);
  api.has = (k) => mem.has(k);
  api.keys = (prefix) => [...mem.keys()].filter((k) => k.startsWith(prefix));
  api.set = (k, v) => {
    mem.set(k, v);
    if (db) {
      try {
        const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k);
        t.onabort = () => fail(t.error);
      } catch (e) { fail(e); }
    } else {
      try { localStorage.setItem('chesslab:' + k, JSON.stringify(v)); } catch (e) { fail(e); }
    }
  };
  api.del = (k) => {
    mem.delete(k);
    if (db) { try { db.transaction('kv', 'readwrite').objectStore('kv').delete(k); } catch (_) { /* ignore */ } }
    else { try { localStorage.removeItem('chesslab:' + k); } catch (_) { /* ignore */ } }
  };
  /* ask the browser not to evict our data under storage pressure (granted silently or not at all) */
  api.persist = () => { try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (_) { /* ignore */ } };
  return api;
})();
