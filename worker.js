const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname !== '/api/plan' || req.method !== 'POST') return env.ASSETS.fetch(req);
    try {
      const { subject, desc, deadline, today, busy = {} } = await req.json();
      if (!subject || !desc || !/^\d{4}-\d{2}-\d{2}$/.test(deadline || '')) return json({ error: 'bad input' }, 400);
      const last = addD(deadline, -1);
      const prompt = `Jesteś planerem nauki dla studentki psychologii (wzrokowiec).
Przedmiot: ${subject}
Do zrobienia: ${desc}
Dziś: ${today}. Deadline (zjazd): ${deadline}. Kroki planuj od ${today} do ${last} włącznie.
Dni już zajęte (data: liczba kroków): ${JSON.stringify(busy)} – unikaj ich przeciążania.
Zasady: rozbij pracę na konkretne kroki po 1–2 h (np. "Czytanie fragmentu 1", "Slajdy 1–8"), nauka i powtórka do egzaminu na końcu, max 2 kroki dziennie z tego zadania, krótkie polskie nazwy.
Odpowiedz WYŁĄCZNIE JSON: {"steps":[{"text":"...","date":"RRRR-MM-DD"}]}`;
      const r = await env.AI.run(MODEL, { messages: [{ role: 'user', content: prompt }], max_tokens: 800 });
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
