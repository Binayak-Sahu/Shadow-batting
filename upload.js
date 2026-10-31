// upload.js — send session recordings to YOUR private GitHub repo.
//
// The token is stored only in this browser (localStorage 'sm.gh'), never in
// the settings object (settings are copied into every recording file).
// Recordings wait in a queue (IndexedDB) until they upload, so a session
// done without internet uploads the next time the app is opened online.

const KEY = 'sm.gh';
const DB_NAME = 'shadow-mirror';
const STORE = 'uploadQueue';
const MAX_QUEUE = 30;

export const DEFAULT_REPO = 'Binayak-Sahu/shadow-batting-recordings';

export function getGh() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null');
    return { repo: (v && v.repo) || DEFAULT_REPO, token: (v && v.token) || '', auto: v ? v.auto !== false : true };
  } catch (e) {
    return { repo: DEFAULT_REPO, token: '', auto: true };
  }
}
export function setGh(gh) {
  try { localStorage.setItem(KEY, JSON.stringify(gh)); return true; } catch (e) { return false; }
}
export const ghReady = (gh = getGh()) => !!(gh.auto && gh.token && /^[\w.-]+\/[\w.-]+$/.test(gh.repo));

// ------------------------------------------------------------ IndexedDB queue
function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'path' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => { d.close(); resolve(out && 'result' in out ? out.result : undefined); };
    t.onerror = () => { d.close(); reject(t.error); };
  });
}
export async function queueAdd(item) {
  const all = await queueList();
  if (all.length >= MAX_QUEUE) await queueRemove(all[0].path); // drop the oldest
  return tx('readwrite', (s) => s.put(item));
}
export const queueList = async () => ((await tx('readonly', (s) => s.getAll())) || []).sort((a, b) => a.added - b.added);
export const queueRemove = (path) => tx('readwrite', (s) => s.delete(path));

// ------------------------------------------------------------ GitHub API
async function api(gh, path, init = {}) {
  const res = await fetch(`https://api.github.com/repos/${gh.repo}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${gh.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {}),
    },
  });
  return res;
}

function explain(status) {
  if (status === 401) return 'Token not accepted — paste it again (it may have expired).';
  if (status === 403) return 'Token can’t write to this repo — give it Contents: Read and write.';
  if (status === 404) return 'Repo not found — check the name, and that the token includes this repo.';
  if (status === 409 || status === 422) return 'GitHub refused the file (it may already exist).';
  return `GitHub error ${status}.`;
}

/** Check token + repo. Returns { ok, msg }. */
export async function testConnection(gh = getGh()) {
  if (!gh.token) return { ok: false, msg: 'Paste your token first.' };
  try {
    const res = await api(gh, '');
    if (!res.ok) return { ok: false, msg: explain(res.status) };
    const info = await res.json();
    const canPush = info.permissions ? info.permissions.push : true;
    if (!canPush) return { ok: false, msg: explain(403) };
    return { ok: true, msg: `Connected to ${info.full_name}${info.private ? ' (private ✓)' : ' — WARNING: this repo is PUBLIC'}.` };
  } catch (e) {
    return { ok: false, msg: 'No internet, or GitHub could not be reached.' };
  }
}

async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function putFile(gh, item) {
  const res = await api(gh, `/contents/${item.path.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: item.message, content: await blobToBase64(item.blob) }),
  });
  if (res.status === 422) {
    // already uploaded earlier (e.g. the app closed before it noted success)
    const head = await api(gh, `/contents/${item.path.split('/').map(encodeURIComponent).join('/')}`);
    if (head.ok) return;
  }
  if (!res.ok) throw Object.assign(new Error(explain(res.status)), { status: res.status });
}

/** Path in the repo: recordings/2026-10-31/14-05-ffd-12reps.json.gz */
export function recordingPath(rec, ext, reps) {
  const d = new Date(rec.data.date);
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  return `recordings/${day}/${time}-${rec.data.info.shot || 'ffd'}-${reps}reps.${ext}`;
}

let flushing = null;
/**
 * Upload everything in the queue. onStatus(text, kind) reports progress.
 * Safe to call often; only one flush runs at a time.
 */
export function flushQueue(onStatus = () => {}) {
  if (flushing) return flushing;
  flushing = (async () => {
    const gh = getGh();
    let items = [];
    try { items = await queueList(); } catch (e) { return; }
    if (!items.length) return;
    if (!ghReady(gh)) { onStatus(`${items.length} recording(s) waiting — set up GitHub upload in Settings.`, 'warn'); return; }
    if (!navigator.onLine) { onStatus(`${items.length} recording(s) waiting for internet.`, 'warn'); return; }
    let done = 0;
    for (const item of items) {
      onStatus(`Uploading recording ${done + 1} of ${items.length}…`, '');
      try {
        await putFile(gh, item);
        await queueRemove(item.path);
        done++;
      } catch (e) {
        const why = e.status ? e.message : 'No internet connection.';
        onStatus(`Upload failed — ${why} ${items.length - done} recording(s) waiting; will retry when the app is next opened online.`, 'warn');
        return;
      }
    }
    onStatus(`Uploaded to GitHub ✓ (${done} recording${done > 1 ? 's' : ''})`, 'good');
  })().finally(() => { flushing = null; });
  return flushing;
}
