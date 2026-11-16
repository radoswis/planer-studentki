const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WD = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];
const MAX_DATA = 1_000_000; // limit rozmiaru danych w chmurze (1 MB)

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/api/data') return data(req, env);
    if (url.pathname === '/api/plan' && req.method === 'POST') return plan(req, env);
    return env.ASSETS.fetch(req);
  }
};

// Dane planera w chmurze (Cloudflare KV) – wspólne dla wszystkich urządzeń
async function data(req, env) {
  if (req.method === 'GET') {
    const v = await env.DATA.get('state');
    return json(v ? JSON.parse(v) : { data: null, rev: 0 }, 200, { 'Cache-Control': 'no-store' });
  }
  if (req.method === 'PUT' || req.method === 'POST') {
    const body = await req.text();
    if (body.length > MAX_DATA) return json({ error: 'za duże dane' }, 413);
    let d;
    try { d = JSON.parse(body).data; } catch { return json({ error: 'zły JSON' }, 400); }
    if (!d || !Array.isArray(d.tasks) || typeof d.colors !== 'object') return json({ error: 'złe dane' }, 400);
    const rev = Date.now();
    await env.DATA.put('state', JSON.stringify({ data: d, rev }));
    return json({ rev });
  }
  return json({ error: 'method' }, 405);
}

async function plan(req, env) {
  try {
    let { title = '', subject, desc, deadline, today, busy = {}, steps: given } = await req.json();
    if (!subject || !desc || !DATE.test(deadline || '') || !DATE.test(today || '')) return json({ error: 'bad input' }, 400);
    desc = String(desc).slice(0, 2000); title = String(title).slice(0, 120); subject = String(subject).slice(0, 80);
    const last = addD(deadline, -1);
    const cal = [];
    for (let d = today; d <= last && cal.length < 60; d = addD(d, 1)) {
      const b = busy && typeof busy === 'object' ? Number(busy[d]) || 0 : 0;
      cal.push(`${d} ${WD[new Date(d + 'T12:00:00Z').getUTCDay()]}${b ? ` (zajęte: ${b})` : ''}`);
    }
    if (!cal.length) cal.push(`${today} ${WD[new Date(today + 'T12:00:00Z').getUTCDay()]}`);

    // Tryb "przeplanuj": kroki już istnieją, AI tylko dobiera im dni
    const redate = Array.isArray(given) && given.length > 0;
    if (redate) given = given.slice(0, 30).map(s => String(s).slice(0, 80));

    const system = `Jesteś planerem nauki dla studentki psychologii (wzrokowiec). Układasz jej harmonogram pracy nad zadaniem przed zjazdem/terminem.
Opis zadania pisze sama studentka, zwykłym językiem – jak do asystenta. Może zawierać: co trzeba zrobić, ile tego jest, co jest trudne, oraz PROŚBY dotyczące planu (np. "nie w weekendy", "w środy mam pracę", "zacznij od rozdziału 4", "krótsze sesje", "powtórka dzień przed"). Prośby studentki są ważniejsze niż zasady domyślne – zawsze je respektuj.
Zasady domyślne (gdy studentka nie prosi inaczej):
- konkretne kroki po 1–2 h, nazwane tak, by wiadomo było co zrobić (np. "Czytanie rozdz. 3 + notatki", "Slajdy 1–8", "Fiszki z pojęć"),
- najpierw materiał, potem nauka/przygotowanie, na końcu powtórka (dzień–dwa przed terminem),
- max 2 kroki dziennie z tego zadania, rozkładaj równomiernie, omijaj dni oznaczone jako zajęte jeśli to możliwe,
- trudniejsze rzeczy daj wcześniej i więcej czasu,
- nazwy kroków po polsku, max 60 znaków, bez dat w nazwie.
${redate ? 'Kroki są JUŻ ustalone – NIE zmieniaj ich nazw, liczby ani kolejności, tylko przypisz każdemu dzień (kolejne kroki nie mogą mieć wcześniejszej daty niż poprzednie).\n' : ''}Używaj WYŁĄCZNIE dat z podanej listy dni. Odpowiedz WYŁĄCZNIE poprawnym JSON, bez komentarzy: {"steps":[{"text":"...","date":"RRRR-MM-DD"}]}`;
    const prompt = `${title ? `Zadanie: ${title}\n` : ''}Przedmiot: ${subject}
Termin (deadline): ${deadline} ${WD[new Date(deadline + 'T12:00:00Z').getUTCDay()]}
Opis od studentki:
"""
${desc}
"""
${redate ? `Kroki do rozplanowania (w tej kolejności):\n${given.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n` : ''}Dostępne dni (dziś = pierwszy):
${cal.join('\n')}`;
    const r = await env.AI.run(MODEL, { messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], max_tokens: 1500, temperature: 0.3 });
    const raw = typeof r.response === 'string' ? r.response : JSON.stringify(r.response);
    const m = raw.match(/\{[\s\S]*\}/);
    const clamp = d => (d < today ? today : d > last ? (last < today ? today : last) : d);
    let steps = (JSON.parse(m[0]).steps || []).filter(s => s && typeof s.text === 'string' && DATE.test(s.date));
    if (redate) {
      if (steps.length !== given.length) return json({ error: 'no plan' }, 422);
      // zachowaj oryginalne nazwy i kolejność, daty nie mogą się cofać
      let prev = today;
      steps = given.map((text, i) => { const d = clamp(steps[i].date); prev = d < prev ? prev : d; return { text, date: prev }; });
      return json({ steps });
    }
    steps = steps.map(s => ({ text: s.text.slice(0, 80), date: clamp(s.date) })).sort((a, b) => a.date.localeCompare(b.date));
    if (!steps.length || steps.length > 30) return json({ error: 'no plan' }, 422);
    return json({ steps });
  } catch (e) {
    return json({ error: 'ai failed' }, 502);
  }
}

const json = (o, s = 200, h = {}) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', ...h } });
function addD(s, n) { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
