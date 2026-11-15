const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname !== '/api/plan' || req.method !== 'POST') return env.ASSETS.fetch(req);
    try {
      const { title, subject, desc, deadline, today, busy = {} } = await req.json();
      if (!subject || !desc || !/^\d{4}-\d{2}-\d{2}$/.test(deadline || '')) return json({ error: 'bad input' }, 400);
      const last = addD(deadline, -1);
      const WD = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];
      const cal = [];
      for (let d = today; d <= last && cal.length < 60; d = addD(d, 1)) cal.push(`${d} ${WD[new Date(d + 'T12:00:00Z').getUTCDay()]}${busy[d] ? ` (zajęte: ${busy[d]})` : ''}`);
      const system = `Jesteś planerem nauki dla studentki psychologii (wzrokowiec). Układasz jej harmonogram pracy nad zadaniem przed zjazdem/terminem.
Opis zadania pisze sama studentka, zwykłym językiem – jak do asystenta. Może zawierać: co trzeba zrobić, ile tego jest, co jest trudne, oraz PROŚBY dotyczące planu (np. "nie w weekendy", "w środy mam pracę", "zacznij od rozdziału 4", "krótsze sesje", "powtórka dzień przed"). Prośby studentki są ważniejsze niż zasady domyślne – zawsze je respektuj.
Zasady domyślne (gdy studentka nie prosi inaczej):
- konkretne kroki po 1–2 h, nazwane tak, by wiadomo było co zrobić (np. "Czytanie rozdz. 3 + notatki", "Slajdy 1–8", "Fiszki z pojęć"),
- najpierw materiał, potem nauka/przygotowanie, na końcu powtórka (dzień–dwa przed terminem),
- max 2 kroki dziennie z tego zadania, rozkładaj równomiernie, omijaj dni oznaczone jako zajęte jeśli to możliwe,
- trudniejsze rzeczy daj wcześniej i więcej czasu,
- nazwy kroków po polsku, max 60 znaków, bez dat w nazwie.
Używaj WYŁĄCZNIE dat z podanej listy dni. Odpowiedz WYŁĄCZNIE poprawnym JSON, bez komentarzy: {"steps":[{"text":"...","date":"RRRR-MM-DD"}]}`;
      const prompt = `${title ? `Zadanie: ${title}\n` : ''}Przedmiot: ${subject}
Termin (deadline): ${deadline} ${WD[new Date(deadline + 'T12:00:00Z').getUTCDay()]}
Opis od studentki:
"""
${desc}
"""
Dostępne dni (dziś = pierwszy):
${cal.join('\n')}`;
      const r = await env.AI.run(MODEL, { messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], max_tokens: 1500, temperature: 0.3 });
      const raw = typeof r.response === 'string' ? r.response : JSON.stringify(r.response);
      const m = raw.match(/\{[\s\S]*\}/);
      const steps = (JSON.parse(m[0]).steps || [])
        .filter(s => s && typeof s.text === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.date))
        .map(s => ({ text: s.text.slice(0, 80), date: s.date < today ? today : s.date > last ? last : s.date }))
        .sort((a, b) => a.date.localeCompare(b.date));
      if (!steps.length || steps.length > 30) return json({ error: 'no plan' }, 422);
      return json({ steps });
    } catch (e) {
      return json({ error: 'ai failed' }, 502);
    }
  }
};

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
function addD(s, n) { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
