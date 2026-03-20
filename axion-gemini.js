/**
 * AXION — IA em texto: Google Gemini ou Groq (Llama) via Edge Function ou chave local (só Gemini).
 */
(function (global) {
  'use strict';

  var KEY = 'axion_gemini_api_key';
  var MODEL_KEY = 'axion_gemini_model';
  var GROQ_MODEL_KEY = 'axion_groq_model';
  var PROVIDER_KEY = 'axion_llm_provider';
  var PROXY_PREF = 'axion_gemini_prefer_proxy';
  var DEFAULT_MODEL = 'gemini-1.5-flash';
  var DEFAULT_GROQ_MODEL = 'llama-3.1-8b-instant';

  function getProvider() {
    var p = (localStorage.getItem(PROVIDER_KEY) || 'gemini').trim().toLowerCase();
    return p === 'groq' ? 'groq' : 'gemini';
  }

  function setProvider(p) {
    localStorage.setItem(PROVIDER_KEY, p === 'groq' ? 'groq' : 'gemini');
  }

  function getModel() {
    return (localStorage.getItem(MODEL_KEY) || '').trim() || DEFAULT_MODEL;
  }

  function setModel(m) {
    if (m) localStorage.setItem(MODEL_KEY, String(m).trim());
    else localStorage.removeItem(MODEL_KEY);
  }

  function getGroqModel() {
    return (localStorage.getItem(GROQ_MODEL_KEY) || '').trim() || DEFAULT_GROQ_MODEL;
  }

  function setGroqModel(m) {
    if (m) localStorage.setItem(GROQ_MODEL_KEY, String(m).trim());
    else localStorage.removeItem(GROQ_MODEL_KEY);
  }

  function getApiKey() {
    return (localStorage.getItem(KEY) || '').trim();
  }

  function setApiKey(k) {
    if (k) localStorage.setItem(KEY, String(k).trim());
    else localStorage.removeItem(KEY);
  }

  function preferProxy() {
    return localStorage.getItem(PROXY_PREF) !== '0';
  }

  function setPreferProxy(on) {
    if (on) localStorage.removeItem(PROXY_PREF);
    else localStorage.setItem(PROXY_PREF, '0');
  }

  async function directGenerate(prompt, opts) {
    var apiKey = getApiKey();
    if (!apiKey) {
      throw new Error(
        'Sem chave da API no navegador. Faça deploy da Edge Function gemini-proxy (chave no servidor) ou cole a chave em Integrações (IA).'
      );
    }
    opts = opts || {};
    var model = opts.model || getModel();
    var url =
      'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(model) +
      ':generateContent?key=' +
      encodeURIComponent(apiKey);
    var body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: opts.temperature != null ? opts.temperature : 0.7,
        maxOutputTokens: opts.maxTokens || opts.maxOutputTokens || 2048
      }
    };
    if (opts.systemInstruction) {
      body.systemInstruction = { parts: [{ text: String(opts.systemInstruction) }] };
    }
    var res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    var json = await res.json().catch(function () {
      return {};
    });
    if (!res.ok) {
      var msg = (json.error && json.error.message) || res.statusText || 'Erro na API Gemini';
      if (!res.status || res.status === 0) {
        msg += ' (possível bloqueio CORS — use o proxy Supabase).';
      }
      throw new Error(msg);
    }
    var text = '';
    try {
      var c = json.candidates && json.candidates[0];
      if (c && c.content && c.content.parts) {
        text = c.content.parts
          .map(function (p) {
            return p.text || '';
          })
          .join('');
      }
    } catch (e) {}
    return { text: text, raw: json, via: 'direct' };
  }

  async function generateGroq(prompt, opts) {
    opts = opts || {};
    var model = opts.model || getGroqModel();
    if (preferProxy() && global.AXION_CLOUD && typeof global.AXION_CLOUD.invokeGroq === 'function') {
      var r = await global.AXION_CLOUD.invokeGroq({
        prompt: prompt,
        model: model,
        systemInstruction: opts.systemInstruction,
        temperature: opts.temperature,
        max_tokens: opts.maxTokens || opts.maxOutputTokens
      });
      return {
        text: (r && r.text) || '',
        raw: r && r.raw,
        via: 'proxy-groq'
      };
    }
    throw new Error(
      'Groq: faça login na nuvem, marque “Preferir proxy”, faça deploy de groq-proxy e defina o secret GROQ_API_KEY no Supabase. Chave em console.groq.com'
    );
  }

  async function generateGemini(prompt, opts) {
    opts = opts || {};
    var model = opts.model || getModel();

    if (preferProxy() && global.AXION_CLOUD && typeof global.AXION_CLOUD.invokeGemini === 'function') {
      try {
        var r = await global.AXION_CLOUD.invokeGemini({
          prompt: prompt,
          model: model,
          systemInstruction: opts.systemInstruction,
          temperature: opts.temperature,
          maxOutputTokens: opts.maxTokens || opts.maxOutputTokens
        });
        return {
          text: (r && r.text) || '',
          raw: r && r.raw,
          via: 'proxy'
        };
      } catch (e) {
        if (getApiKey()) {
          return directGenerate(prompt, opts);
        }
        throw e;
      }
    }

    return directGenerate(prompt, opts);
  }

  /**
   * @param {string} prompt
   * @param {{ model?: string, systemInstruction?: string, temperature?: number, maxTokens?: number }} [opts]
   * @returns {Promise<{ text: string, raw?: object, via: string }>}
   */
  async function generateText(prompt, opts) {
    prompt = String(prompt || '').trim();
    if (!prompt) throw new Error('Informe um texto para a IA.');
    opts = opts || {};
    if (getProvider() === 'groq') {
      return generateGroq(prompt, opts);
    }
    return generateGemini(prompt, opts);
  }

  global.AXION_GEMINI = {
    getProvider: getProvider,
    setProvider: setProvider,
    getModel: getModel,
    setModel: setModel,
    getGroqModel: getGroqModel,
    setGroqModel: setGroqModel,
    getApiKey: getApiKey,
    setApiKey: setApiKey,
    preferProxy: preferProxy,
    setPreferProxy: setPreferProxy,
    generateText: generateText
  };
})(typeof window !== 'undefined' ? window : globalThis);
