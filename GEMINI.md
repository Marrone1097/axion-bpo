# Google Gemini no AXION

## Visão geral

- **`axion-gemini.js`** — Cliente `AXION_GEMINI.generateText(prompt, opts)`.
- **Provedores:** **Google Gemini** ou **Groq** (Llama — [console.groq.com](https://console.groq.com), grátis).
- **`axion-cloud.js`** — `invokeGemini` / `invokeGroq` chamam as Edge Functions no Supabase.
- **Edge Functions** — `gemini-proxy` (`GEMINI_API_KEY`), `groq-proxy` (`GROQ_API_KEY`).

Se o Gemini der erro de cota, use **Groq** em Integrações (IA) e faça deploy de `groq-proxy`.

## Deploy rápido (Supabase)

1. Chave em [Google AI Studio](https://aistudio.google.com/apikey).
2. No projeto Supabase: **Secrets** → `GEMINI_API_KEY` = sua chave.
3. Deploy: `supabase functions deploy gemini-proxy --project-ref <SEU_PROJECT_REF>`
4. **Groq:** `supabase secrets set GROQ_API_KEY=...` → `supabase functions deploy groq-proxy`
5. No app: **Integrações (IA)** → provedor + “Preferir proxy” e teste.

## Uso no código

```js
const { text, via } = await AXION_GEMINI.generateText('Sua pergunta em português.', {
  systemInstruction: 'Seja breve.',
  model: 'gemini-1.5-flash'
});
```

## Opcional: chave no navegador

Só para testes locais. A API Google costuma bloquear **CORS** no browser; use o proxy em produção.

## UI

- Botão flutuante **✨** — assistente com contexto opcional do cliente.
- Aba **Integrações (IA)** — modelo, preferência de proxy, chave local, teste.
