import { DurableObject } from 'cloudflare:workers';
const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WD = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];
const MAX_DATA = 1_000_000; // limit rozmiaru danych w chmurze (1 MB, liczony w bajtach)

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    // Dane i przywracanie idą przez jeden Durable Object – sprawdzenie wersji i zapis są atomowe i zawsze aktualne
    if (url.pathname === '/api/data' || (url.pathname === '/api/restore' && req.method === 'POST') || (url.pathname === '/api/backups' && req.method === 'GET'))
      return env.STORE.get(env.STORE.idFromName('main')).fetch(req);
    if (url.pathname === '/api/plan' && req.method === 'POST') return plan(req, env);
    return env.ASSETS.fetch(req);
  }
};

const BACKUP_DAYS = 30; // automatyczne kopie trzymamy 30 dni
const BACKUP_KEY = /^backup-[\w-]+$/;

// Porządkuje dane: tylko znane pola, poprawne typy, daty RRRR-MM-DD, id liczbowe.
// Dzięki temu nic z chmury nie wstrzyknie kodu do strony. (Ta sama funkcja jest w index.html)
function clean(d) {
  d = d && typeof d === 'object' ? d : {};
  let n = 0;
  const id = v => { v = Number(v); return Number.isSafeInteger(v) ? v : Date.now() + ++n; };
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const date = v => (typeof v === 'string' && DATE.test(v) ? v : '');
  const objs = a => (Array.isArray(a) ? a.filter(x => x && typeof x === 'object') : []);
  const colors = {};
  if (d.colors && typeof d.colors === 'object') for (const [k, v] of Object.entries(d.colors)) {
    if (k === '__proto__') continue;
    const c = Number(v); colors[k.slice(0, 200)] = Number.isInteger(c) && c >= 0 && c < 16 ? c : 0;
  }
  return {
    tasks: objs(d.tasks).map(t => ({
      id: id(t.id), title: str(t.title, 500), subject: str(t.subject, 200), desc: str(t.desc, 4000), deadline: date(t.deadline),
      steps: objs(t.steps).map(s => ({ text: str(s.text, 500), date: date(s.date), done: s.done === true }))
    })),
    colors,
    wait: objs(d.wait).map(w => ({ id: id(w.id), title: str(w.title, 500), subject: str(w.subject, 200), deadline: date(w.deadline), done: w.done === true }))
  };
}

// Dane planera – jeden Durable Object dla wszystkich urządzeń. Każde żądanie czyta i zapisuje stan oraz kopie
// we własnej pamięci obiektu bez czekania na zewnętrzne usługi pomiędzy – dzięki temu nic się nie przeplata.
// KV: stare kopie (sprzed tej wersji) + lustro "state" (bezpieczne cofnięcie wersji aplikacji).
export class Store extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.mirrorQ = Promise.resolve();
    ctx.blockConcurrencyWhile(async () => {
      if ((await ctx.storage.get('state')) === undefined) { // pierwsze uruchomienie: przenieś dane z KV
        const raw = await env.DATA.get('state');
        await ctx.storage.put('state', raw ? JSON.parse(raw) : null);
        // dzisiejsza kopia z poprzedniej wersji już jest – nie nadpisujemy jej
        const day = new Date().toISOString().slice(0, 10);
        if (await env.DATA.get('backup-auto-' + day)) await ctx.storage.put('backupDay', day);
      }
    });
  }
  state() { return this.ctx.storage.get('state'); }
  // Zapis: odczyt, kopie i nowy stan w jednym ciągu operacji na pamięci obiektu (bez przeplatania)
  async write(data, why) {
    const st = this.ctx.storage, cur = await st.get('state');
    const next = { data: clean(data), rev: Math.max(Date.now(), (cur?.rev || 0) + 1) };
    const now = new Date(), day = now.toISOString().slice(0, 10), puts = { state: next };
    let undoKey = null;
    if (cur?.data) {
      if (why === 'restore') { // stan sprzed przywrócenia – zawsze osobna kopia (do cofnięcia)
        undoKey = 'backup-restore-' + now.toISOString().slice(0, 19).replace(/:/g, '-');
        puts[undoKey] = cur;
      }
      if ((await st.get('backupDay')) !== day) { puts['backup-auto-' + day] = cur; puts.backupDay = day; }
    }
    await st.put(puts); // wszystko naraz, atomowo
    this.mirror();
    if (undoKey || puts.backupDay) this.ctx.waitUntil(this.prune());
    return { ...next, undoKey };
  }
  // Lustro w KV: zapisy po kolei, zawsze najnowszy stan; błąd (np. limit zapisów KV) nie wpływa na dane
  mirror() {
    this.mirrorQ = this.mirrorQ.then(async () => {
      const s = await this.state();
      if (s && s.rev !== this.mirrored) { await this.env.DATA.put('state', JSON.stringify(s)); this.mirrored = s.rev; }
    }).catch(() => {});
    this.ctx.waitUntil(this.mirrorQ);
  }
  // usuwa kopie starsze niż BACKUP_DAYS
  async prune() {
    const old = new Date(Date.now() - BACKUP_DAYS * 864e5).toISOString().slice(0, 10);
    const keys = [...(await this.ctx.storage.list({ prefix: 'backup-' })).keys()].filter(k => stamp(k).slice(0, 10) < old);
    if (keys.length) await this.ctx.storage.delete(keys);
  }
  async backup(key) {
    return (await this.ctx.storage.get(key)) ?? JSON.parse((await this.env.DATA.get(key)) || 'null');
  }
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/api/backups') { // lista kopii albo jedna kopia (?key=...)
      const key = url.searchParams.get('key');
      if (key) {
        if (!BACKUP_KEY.test(key)) return json({ error: 'zły klucz' }, 400);
        const b = await this.backup(key);
        return b ? json(b, 200, { 'Cache-Control': 'no-store' }) : json({ error: 'brak' }, 404);
      }
      const names = new Set([...(await this.ctx.storage.list({ prefix: 'backup-' })).keys(), ...(await this.env.DATA.list({ prefix: 'backup-' })).keys.map(k => k.name)]);
      return json({ backups: [...names].sort((a, b) => stamp(b).localeCompare(stamp(a))) }, 200, { 'Cache-Control': 'no-store' });
    }
    if (url.pathname === '/api/restore') {
      let key;
      try { ({ key } = await req.json()); } catch { return json({ error: 'zły JSON' }, 400); }
      if (typeof key !== 'string' || !BACKUP_KEY.test(key)) return json({ error: 'zły klucz' }, 400);
      const b = await this.backup(key);
      if (!b?.data) return json({ error: 'brak kopii' }, 404);
      const r = await this.write(b.data, 'restore');
      return json({ data: r.data, rev: r.rev, undoKey: r.undoKey }, 200, { 'Cache-Control': 'no-store' });
    }
    if (req.method === 'GET') return json((await this.state()) || { data: null, rev: 0 }, 200, { 'Cache-Control': 'no-store' });
    if (req.method === 'PUT' || req.method === 'POST') {
      const body = await req.text();
      const TOO_BIG = json({ error: 'Za dużo danych – usuń stare zadania, aby zapisywać w chmurze.' }, 413);
      if (new TextEncoder().encode(body).length > MAX_DATA) return TOO_BIG;
      let d, base;
      try { ({ data: d, base } = JSON.parse(body)); } catch { return json({ error: 'zły JSON' }, 400); }
      if (!d || typeof d !== 'object' || !Array.isArray(d.tasks)) return json({ error: 'złe dane' }, 400);
      const cur = await this.state();
      // Inne urządzenie zapisało nowszą wersję – klient musi najpierw połączyć zmiany
      if (base != null && cur?.data && cur.rev > Number(base)) return json({ error: 'conflict', ...cur }, 409);
      try { return json({ rev: (await this.write(d)).rev }); } catch { return TOO_BIG; }
    }
    return json({ error: 'method' }, 405);
  }
}

// data z nazwy kopii, do sortowania od najnowszej
const stamp = k => (k.match(/\d{4}-\d{2}-\d{2}(T[\d-]+)?/) || [''])[0];

async function plan(req, env) {
  try {
    let { title = '', subject, desc, deadline, today, busy = {}, steps: given } = await req.json();
    if (!subject || !desc || !DATE.test(deadline || '') || !DATE.test(today || '')) return json({ error: 'bad input' }, 400);
    desc = String(desc).slice(0, 2000); title = String(title).slice(0, 120); subject = String(subject).slice(0, 80);
    const last = addD(deadline, -1);
    // Lista dni dla AI: przy długim terminie co któryś dzień, ale ostatnie 14 dni przed deadline'em zawsze w całości
    const total = Math.round((new Date(last) - new Date(today)) / 864e5) + 1;
    const tail = Math.min(14, Math.max(total, 0)), every = Math.max(1, Math.ceil((total - tail) / 50));
    const days = [];
    for (let i = 0; i < total - tail; i += every) days.push(addD(today, i));
    for (let i = total - tail; i < total; i++) days.push(addD(today, i));
    const cal = days.map(d => {
      const b = busy && typeof busy === 'object' ? Number(busy[d]) || 0 : 0;
      return `${d} ${WD[new Date(d + 'T12:00:00Z').getUTCDay()]}${b ? ` (zajęte: ${b})` : ''}`;
    });
    if (!cal.length) cal.push(`${today} ${WD[new Date(today + 'T12:00:00Z').getUTCDay()]}`);
    // Długi termin (np. egzamin za kilka miesięcy): więcej kroków i wyraźna prośba o rozłożenie na cały okres
    const long = total > 60, maxSteps = long ? 40 : 25;

    // Tryb "przeplanuj": kroki już istnieją, AI tylko dobiera im dni
    const redate = Array.isArray(given) && given.length > 0;
    // Nie obcinamy po cichu – za dużo kroków = błąd, klient użyje wtedy prostego algorytmu
    if (redate && given.length > 40) return json({ error: 'too many steps' }, 413);
    if (redate) given = given.map(s => String(s).slice(0, 120));

    const system = `Jesteś planerem nauki dla studentki psychologii (wzrokowiec). Układasz jej harmonogram pracy nad zadaniem przed zjazdem/terminem.
Opis zadania pisze sama studentka, zwykłym językiem – jak do asystenta. Może zawierać: co trzeba zrobić, ile tego jest, co jest trudne, oraz PROŚBY dotyczące planu (np. "nie w weekendy", "w środy mam pracę", "zacznij od rozdziału 4", "krótsze sesje", "powtórka dzień przed"). Prośby studentki są ważniejsze niż zasady domyślne – zawsze je respektuj.
Zasady domyślne (gdy studentka nie prosi inaczej):
- konkretne kroki po 1–2 h, nazwane tak, by wiadomo było co zrobić (np. "Czytanie rozdz. 3 + notatki", "Slajdy 1–8", "Fiszki z pojęć"),
- najpierw materiał, potem nauka/przygotowanie, na końcu powtórka (dzień–dwa przed terminem),
- max 2 kroki dziennie z tego zadania, rozkładaj równomiernie, omijaj dni oznaczone jako zajęte jeśli to możliwe,
- trudniejsze rzeczy daj wcześniej i więcej czasu,
- nazwy kroków po polsku, max 60 znaków, bez dat w nazwie,
${redate ? '' : `- ŁĄCZNIE najwyżej ${maxSteps} kroków (przy dużym materiale łącz rzeczy w większe kroki).\n`}${long ? `- Termin jest daleko (${total} dni, ok. ${Math.round(total / 7)} tygodni): rozłóż kroki równomiernie na CAŁY ten okres – mniej więcej co tydzień, aż do terminu, z powtórkami po drodze i na końcu. Nie zostawiaj miesięcy bez pracy, chyba że studentka prosi inaczej.\n` : ''}${redate ? `Kroki są JUŻ ustalone (${given.length}) – przypisz każdemu dzień, w tej samej kolejności (kolejne kroki nie mogą mieć wcześniejszej daty niż poprzednie). Lista "dates" ma mieć DOKŁADNIE ${given.length} dat.\n` : ''}Używaj WYŁĄCZNIE dat z podanej listy dni (przy dalekim terminie lista jest przerzedzona – to normalne, rozłóż pracę na cały okres).
W polu "own_schedule" wpisz true, jeśli studentka sama określiła, KIEDY ma pracować w czasie (np. "zacznij w marcu", "skończ materiał do kwietnia", "w lutym przerwa"), inaczej false.
W polu "avoid" wypisz dni tygodnia, których studentka prosi unikać (np. "nie w weekendy" → ["sobota","niedziela"], "w środy pracuję" → ["środa"]); pusta lista, jeśli nie ma takich próśb.
Odpowiedz WYŁĄCZNIE poprawnym JSON, bez komentarzy: ${redate ? '{"own_schedule":false,"avoid":["..."],"dates":["RRRR-MM-DD", ...]}' : '{"own_schedule":false,"avoid":["..."],"steps":[{"text":"...","date":"RRRR-MM-DD"}]}'}`;
    const prompt = `${title ? `Zadanie: ${title}\n` : ''}Przedmiot: ${subject}
Termin (deadline): ${deadline} ${WD[new Date(deadline + 'T12:00:00Z').getUTCDay()]}
Opis od studentki:
"""
${desc}
"""
${redate ? `Kroki do rozplanowania (w tej kolejności):\n${given.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n` : ''}Dostępne dni (dziś = pierwszy):
${cal.join('\n')}`;
    const r = await env.AI.run(MODEL, { messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], max_tokens: 3000, temperature: 0.3 });
    const raw = typeof r.response === 'string' ? r.response : JSON.stringify(r.response);
    const clamp = d => (d < today ? today : d > last ? (last < today ? today : last) : d);
    const ai = parseAI(raw, desc), avoid = ai.avoid;
    // dni, których studentka prosi unikać, egzekwuje serwer (AI czasem je ignoruje);
    // równomierne rozłożenie pomijamy, gdy studentka sama określiła ramy czasowe
    const finish = list => fixDays(ai.ownSchedule ? list : spread(list, today, last, busy, avoid), today, last, avoid, busy);
    let steps = ai.steps.filter(s => s && typeof s.text === 'string' && s.text.trim() && DATE.test(s.date));
    if (redate) {
      let ds = (ai.dates.length ? ai.dates : steps.map(s => s.date)).map(clamp).sort();
      // za mało dat (np. ucięta odpowiedź) – klient użyje prostego algorytmu
      if (!ds.length || ds.length < given.length / 2) return json({ error: 'no plan' }, 422);
      // AI podało inną liczbę dat – interpolujemy między jego datami, zachowując rozkład w czasie
      if (ds.length !== given.length) {
        const n = ds.length, m = given.length, at = i => new Date(ds[i] + 'T12:00:00Z').getTime();
        ds = given.map((_, i) => {
          const p = m === 1 ? 0 : i * (n - 1) / (m - 1), a = Math.floor(p), b = Math.ceil(p);
          return new Date(at(a) + (at(b) - at(a)) * (p - a)).toISOString().slice(0, 10);
        });
      }
      return json({ steps: finish(given.map((text, i) => ({ text, date: ds[i] }))) });
    }
    steps = steps.map(s => ({ text: s.text.slice(0, 80), date: clamp(s.date) })).sort((a, b) => a.date.localeCompare(b.date));
    if (!steps.length) return json({ error: 'no plan' }, 422);
    // za dużo kroków: zostaw limit, równomiernie z całego planu, zawsze z ostatnimi (powtórka przed terminem)
    const cap = maxSteps;
    if (steps.length > cap) { const n = steps.length; steps = Array.from({ length: cap }, (_, i) => steps[Math.round(i * (n - 1) / (cap - 1))]); }
    return json({ steps: finish(steps) });
  } catch (e) {
    return json({ error: 'ai failed' }, 502);
  }
}

const dow = d => new Date(d + 'T12:00:00Z').getUTCDay();
// Przy długim terminie AI lubi upchnąć wszystko w pierwszych tygodniach i zostawić miesiące pustki.
// Gdy w planie jest przerwa dłuższa niż 35 dni, rozkładamy kroki (w tej samej kolejności) równomiernie od dziś
// do 2 tygodni przed terminem; kroki z ostatnich 2 tygodni (powtórka) zostają. Omijamy dni zajęte i te, o które prosi studentka.
function spread(steps, today, last, busy, avoid) {
  const days = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);
  if (days(today, last) < 60 || steps.length < 3) return steps;
  // przerwy: od dziś do pierwszego kroku, między krokami i od ostatniego kroku do terminu
  const ds = [today, ...steps.map(s => s.date), last];
  if (Math.max(...ds.slice(1).map((d, i) => days(ds[i], d))) <= 35) return steps;
  const tailStart = addD(last, -13), end = addD(tailStart, -1), span = days(today, end);
  let body = steps.filter(s => s.date < tailStart), tail = steps.filter(s => s.date >= tailStart);
  // AI zostawiło prawie wszystko na ostatnie 2 tygodnie – na końcu zostają tylko 2 ostatnie kroki (powtórka)
  if (body.length < steps.length / 2) { body = steps.slice(0, -2); tail = steps.slice(-2); }
  const ok = d => d >= today && d <= end && !avoid.has(dow(d)) && !(busy && Number(busy[d]) > 0);
  let prev = today;
  const out = body.map((s, i) => {
    const base = addD(today, body.length === 1 ? 0 : Math.round(i * span / (body.length - 1)));
    let date = base;
    for (const o of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6]) { const d = addD(base, o); if (ok(d)) { date = d; break; } }
    if (date < prev) date = prev;
    prev = date;
    return { ...s, date };
  });
  return out.concat(tail);
}

// Przesuwa kroki z dni, których studentka chce unikać, na najbliższy dozwolony dzień; kolejność dat nie może się cofać
// Przy przesuwaniu: nie więcej niż 2 kroki dziennie z tego zadania, najpierw dni wolne od innych zadań
function fixDays(steps, today, last, avoid, busy) {
  const n = {}, isBusy = d => busy && typeof busy === 'object' && Number(busy[d]) > 0;
  let prev = today;
  return steps.map(s => {
    let date = s.date < prev ? prev : s.date;
    const bad = d => avoid.has(dow(d)) || (n[d] || 0) >= 2;
    if (bad(date)) {
      const cands = [];
      for (let o = 0; o <= 14; o++) for (const x of o ? [o, -o] : [0]) { const d = addD(date, x); if (d >= prev && d <= last && !bad(d)) cands.push(d); }
      date = cands.find(d => !isBusy(d)) || cands[0] || date;
    }
    n[date] = (n[date] || 0) + 1;
    prev = date;
    return { ...s, date };
  });
}

// Odpowiedź AI: kroki, daty (tryb przeplanowania) i dni tygodnia do unikania
// nazwa dnia (dowolna forma: "soboty", "sroda", "pt", "weekend") -> numery dni tygodnia
const plain = t => String(t).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l');
const DAY_STEMS = [[0, /^(niedz|ndz|nd$)/], [1, /^(pon|pn$)/], [2, /^(wt)/], [3, /^(sr)/], [4, /^(czw|cz$)/], [5, /^(pi|pt$)/], [6, /^(sob|sb$)/]];
const dayNums = name => { const w = plain(name).replace(/[^a-z]/g, ''); return /^weekend/.test(w) ? [6, 0] : DAY_STEMS.filter(([, re]) => re.test(w)).map(([i]) => i); };
// czy opis studentki w ogóle wspomina dany dzień (chroni przed zmyśleniem przez AI)
const DESC_STEMS = { 0: /niedziel|weekend/, 1: /poniedzial/, 2: /wtor|wtork/, 3: /srod|sroda/, 4: /czwart/, 5: /piat|piatk/, 6: /sobot|weekend/ };
function parseAI(raw, desc = '') {
  let j = null;
  try { const m = raw.match(/\{[\s\S]*\}/); j = m && JSON.parse(m[0]); } catch {}
  const names = Array.isArray(j?.avoid) ? j.avoid : ((raw.match(/"avoid"\s*:\s*\[([^\]]*)\]/) || [])[1] || '').split(',');
  const d = plain(desc);
  const avoid = new Set(names.flatMap(dayNums).filter(i => DESC_STEMS[i].test(d)));
  if (avoid.size >= 7) avoid.clear(); // nie da się unikać wszystkich dni
  const ownSchedule = j ? j.own_schedule === true : /"own_schedule"\s*:\s*true/.test(raw);
  const dates = Array.isArray(j?.dates) ? j.dates.filter(d => typeof d === 'string' && DATE.test(d))
    : !j && /"dates"/.test(raw) ? (raw.match(/\d{4}-\d{2}-\d{2}/g) || []) : [];
  return { avoid, dates, ownSchedule, steps: parseSteps(raw) };
}

// Odczyt kroków z odpowiedzi AI; gdy JSON jest ucięty/zepsuty, wyciąga pojedyncze kompletne kroki
function parseSteps(raw) {
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    const j = m && JSON.parse(m[0]);
    if (j && Array.isArray(j.steps)) return j.steps;
  } catch {}
  const re = /\{\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"date"\s*:\s*"(\d{4}-\d{2}-\d{2})"\s*\}/g;
  return [...raw.matchAll(re)].map(m => { try { return { text: JSON.parse(`"${m[1]}"`), date: m[2] }; } catch { return null; } }).filter(Boolean);
}

const json = (o, s = 200, h = {}) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', ...h } });
function addD(s, n) { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
