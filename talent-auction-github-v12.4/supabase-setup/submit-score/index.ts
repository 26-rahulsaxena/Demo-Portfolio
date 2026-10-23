// Talent Auction · Supabase Edge Function "submit-score"
//
// The browser sends { nickname, record }. The record is the whole game as a short move list (seed, problem, every
// bid / pass / clock run-out / next lot, the captain and the transfer). This function loads the SAME game code and
// data that the website runs, replays the game move by move with TA.verify.check (every AI move must be exactly what
// the AI would have done), recomputes the score, and only then saves it. A typed-in or edited score is refused.
//
// Setup: see SETUP-LEADERBOARD.txt. Turn OFF "Verify JWT" for this function (players are not logged in).
// Optional secrets (Edge Functions → Secrets):
//   SITE_URL                 where the game is hosted (default below)
//   LEADERBOARD_SECRET_KEY   only needed if your project has no SUPABASE_SERVICE_ROLE_KEY (new API keys): paste a secret key

const SITE_URL = (Deno.env.get('SITE_URL') || 'https://26-rahulsaxena.github.io/talent-auction/').replace(/\/?$/, '/');
const SB_URL = (Deno.env.get('SUPABASE_URL') || '').replace(/\/$/, '');

function secretKey(): string {
  const own = Deno.env.get('LEADERBOARD_SECRET_KEY');
  if (own) return own.trim();
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy.trim();
  try { // newer projects: a JSON map of secret keys
    const m = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
    const k = Object.values(m)[0];
    if (typeof k === 'string') return k;
  } catch (_e) { /* not set */ }
  return '';
}
const KEY = secretKey();

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Max-Age': '86400',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// ---------- the game code, loaded from the website (cached for 5 minutes) ----------
// deno-lint-ignore no-explicit-any
type Game = { TA: any; data: any; at: number };
let cache: Game | null = null;

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
  if (!r.ok) throw new Error('Could not load ' + url + ' (' + r.status + ')');
  return await r.text();
}

async function loadGame(force = false): Promise<Game> {
  if (!force && cache && Date.now() - cache.at < 5 * 60_000) return cache;
  const bust = '?v=' + Date.now();
  const [dataJs, code] = await Promise.all([
    fetchText(SITE_URL + 'talent_auction_data.js' + bust),
    fetchText(SITE_URL + 'talent-auction.js' + bust),
  ]);
  // deno-lint-ignore no-explicit-any
  const box: any = {};
  // The bundle is plain UMD: with `self` pointing at `box` it attaches everything to box.TA.
  new Function('self', 'window', 'module', 'exports', 'require',
    dataJs + '\n;self.TA_DATA = TA_DATA;\n' + code)(box, box, undefined, undefined, undefined);
  if (!box.TA || !box.TA.verify || !box.TA_DATA) throw new Error('The game files on ' + SITE_URL + ' have no leaderboard support yet');
  cache = { TA: box.TA, data: box.TA_DATA, at: Date.now() };
  return cache;
}

// ---------- nicknames: short, no real names checked here, nothing rude ----------
const RUDE = ['fuck', 'fuk', 'shit', 'bitch', 'cunt', 'nigg', 'fag', 'slut', 'whore', 'porn', 'asshole', 'penis', 'vagina',
  'boob', 'nazi', 'hitler', 'dick', 'pussy', 'bastard', 'chutiya', 'chutia', 'bhenchod', 'behenchod', 'madarchod',
  'bsdk', 'gandu', 'randi', 'harami', 'kamina', 'sexy', 'xxx'];
const RUDE_WORDS = ['rape', 'ass', 'kill', 'die', 'cum', 'tit', 'tits', 'mc', 'bc', 'sex', 'cock', 'lund', 'kutta'];

function cleanNickname(raw: unknown): { ok: true; name: string } | { ok: false; why: string } {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 16) return { ok: false, why: 'Nickname must be 2 to 16 characters' };
  if (!/^[A-Za-z0-9 _.-]+$/.test(name)) return { ok: false, why: 'Use only letters, numbers, spaces, dots, dashes or underscores' };
  if (!/[A-Za-z]/.test(name)) return { ok: false, why: 'Nickname needs at least one letter' };
  if ((name.match(/\d/g) || []).length > 4) return { ok: false, why: 'Too many numbers – please don’t use a phone number' };
  const flat = name.toLowerCase().replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's')
    .replace(/7/g, 't').replace(/[^a-z ]/g, '');
  const squashed = flat.replace(/ /g, '');
  if (RUDE.some((w) => squashed.includes(w)) || flat.split(' ').some((w) => RUDE_WORDS.includes(w)))
    return { ok: false, why: 'Please pick a friendlier nickname' };
  return { ok: true, name };
}

// ---------- database (PostgREST with the secret key; the browser can only read) ----------
function dbHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { apikey: KEY, 'Content-Type': 'application/json', ...extra };
  if (KEY.startsWith('eyJ')) h.Authorization = 'Bearer ' + KEY; // legacy JWT keys; new sb_secret_ keys go in apikey only
  return h;
}

async function countAbove(problem: string, score: number): Promise<number> {
  const r = await fetch(SB_URL + '/rest/v1/best_scores?select=nick_key&problem=eq.' + problem + '&score=gt.' + score,
    { method: 'HEAD', headers: dbHeaders({ Prefer: 'count=exact', Range: '0-0' }) });
  const cr = r.headers.get('content-range') || '';
  const n = Number(cr.split('/')[1]);
  return Number.isFinite(n) ? n : 0;
}

async function bestOf(problem: string, key: string): Promise<number | null> {
  const r = await fetch(SB_URL + '/rest/v1/best_scores?select=score&problem=eq.' + problem + '&nick_key=eq.' + encodeURIComponent(key),
    { headers: dbHeaders() });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows.length ? Number(rows[0].score) : null;
}

// ---------- handler ----------
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method === 'GET') { // health check: open the function URL in a browser
    try {
      const g = await loadGame();
      return json({ ok: true, game: 'Talent Auction', site: SITE_URL, dataVersion: g.data.meta.generatedAt, database: !!(SB_URL && KEY) });
    } catch (e) { return json({ ok: false, error: String((e as Error).message || e) }, 500); }
  }
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);
  if (!SB_URL || !KEY) return json({ ok: false, error: 'Leaderboard is not set up: the function has no database key' }, 500);

  let body: { nickname?: unknown; record?: unknown };
  try {
    const text = await req.text();
    if (text.length > 32_000) return json({ ok: false, error: 'Too large' }, 413);
    body = JSON.parse(text);
  } catch (_e) { return json({ ok: false, error: 'Bad request' }, 400); }

  const nick = cleanNickname(body.nickname);
  if (!nick.ok) return json({ ok: false, error: nick.why }, 400);

  // replay the game with the website's own code (reload once if the site was updated since we cached it)
  let g: Game, res;
  try {
    g = await loadGame();
    // deno-lint-ignore no-explicit-any
    const rec = body.record as any;
    if (rec && g.data.meta && rec.data !== g.data.meta.generatedAt) g = await loadGame(true);
    res = g.TA.verify.check(g.data, rec);
  } catch (e) { return json({ ok: false, error: 'Could not check the game: ' + String((e as Error).message || e) }, 500); }
  if (!res || !res.ok) return json({ ok: false, error: (res && res.why) || 'The game could not be verified' }, 422);

  // deno-lint-ignore no-explicit-any
  const rec = body.record as any;
  // deno-lint-ignore no-explicit-any
  const co = (g.data.companies || []).find((c: any) => (c.rounds || []).indexOf(res.problem) >= 0);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const row = {
    nickname: nick.name, problem: res.problem, company: co ? co.name : null,
    score: r2(res.final), ai_score: r2(res.ai), won: !!res.won, captain: res.captain || null,
    seed: res.seed, moves: res.moves, app_version: String(rec.app || '').slice(0, 20), data_version: String(rec.data || '').slice(0, 40),
  };
  const ins = await fetch(SB_URL + '/rest/v1/scores', { method: 'POST', headers: dbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(row) });
  if (ins.status === 409) return json({ ok: false, error: 'This game is already on the leaderboard under that nickname' }, 409);
  if (!ins.ok) return json({ ok: false, error: 'Could not save the score (' + ins.status + ')', detail: (await ins.text()).slice(0, 300) }, 500);

  const key = nick.name.toLowerCase();
  const best = (await bestOf(res.problem, key)) ?? row.score;
  const rank = (await countAbove(res.problem, best)) + 1;
  return json({ ok: true, nickname: nick.name, problem: res.problem, score: row.score, ai: row.ai_score, won: row.won,
    best, personalBest: row.score >= best - 1e-9, rank });
});
