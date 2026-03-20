/**
 * AXION — Supabase: login, dados financeiros, tarefas, KV global, auditoria
 */
(function (global) {
  'use strict';

  var sb = null;
  var profile = null;
  var saveTimer = null;
  var taskTimer = null;
  var kvTimer = null;
  var DOMAIN = 'axion.local';

  /** Padrão do projeto — edite aqui se trocar de Supabase (localStorage continua tendo prioridade se já salvou). */
  var DEFAULT_SB_URL = 'https://ijsdmnhtqoxldvvstcov.supabase.co';
  var DEFAULT_SB_ANON =
    'sb_publishable_kkI1FjmmQ7K33JVqJHZjFQ_TQr3y2tX';

  var cacheTasks = null;
  var cacheKv = {};
  var cacheAudit = null;
  var teamList = [];

  function emailFromUsername(u) {
    var raw = String(u || '').trim();
    if (!raw) return 'user@' + DOMAIN;
    if (raw.indexOf('@') !== -1) {
      return raw.toLowerCase();
    }
    var s = raw.toLowerCase().replace(/[^a-z0-9._-]/g, '');
    if (!s) s = 'user';
    return s + '@' + DOMAIN;
  }

  function getConfig() {
    var u = (localStorage.getItem('axion_sb_url') || '').trim();
    var a = (localStorage.getItem('axion_sb_anon') || '').trim();
    if (!u) u = DEFAULT_SB_URL;
    if (!a) a = DEFAULT_SB_ANON;
    return { url: u, anon: a };
  }

  function setConfig(url, anon) {
    localStorage.setItem('axion_sb_url', (url || '').trim());
    localStorage.setItem('axion_sb_anon', (anon || '').trim());
  }

  async function ensureClient() {
    if (sb) return sb;
    var cfg = getConfig();
    if (!cfg.url || !cfg.anon) return null;
    var mod = await import('https://esm.sh/@supabase/supabase-js@2.49.1');
    sb = mod.createClient(cfg.url, cfg.anon, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    return sb;
  }

  function mapClientRow(row) {
    var ex = row.extra && typeof row.extra === 'object' ? row.extra : {};
    return Object.assign(
      { id: row.id, nome: row.nome, cnpj: row.cnpj || '', segmento: row.segmento || '' },
      ex
    );
  }

  function extraFromForm(dataRow) {
    var o = {};
    ['tel', 'email', 'end', 'cidade', 'uf', 'obs', 'bancos', 'acessos', 'docs', 'bancoId'].forEach(function (k) {
      if (dataRow[k] !== undefined && dataRow[k] !== '') o[k] = dataRow[k];
    });
    if (dataRow.logo) o.logo = dataRow.logo;
    return o;
  }

  async function loadSessionAndData(state, CFG_CURRENT_USER_REF) {
    var client = await ensureClient();
    if (!client) return { ok: false, reason: 'no_config' };

    var sess = await client.auth.getSession();
    if (!sess.data.session) return { ok: false, reason: 'no_session' };

    var uid = sess.data.session.user.id;
    var email = sess.data.session.user.email || '';

    var pr = await client.from('profiles').select('*').eq('id', uid).maybeSingle();
    if (pr.error) throw pr.error;
    profile = pr.data;
    if (!profile) return { ok: false, reason: 'no_profile' };

    var perRaw = profile.permissions;
    var permissions =
      perRaw && typeof perRaw === 'object' && !Array.isArray(perRaw) ? perRaw : {};
    var userObj = {
      id: uid,
      username: email.split('@')[0] || 'user',
      displayName: profile.display_name,
      role: profile.role,
      status: profile.status,
      clientIds: [],
      password: '',
      createdAt: (profile.created_at || '').slice(0, 10),
      permissions: permissions
    };

    var clientRows = [];
    if (profile.role === 'admin') {
      var all = await client.from('clients').select('*').order('id', { ascending: true });
      if (all.error) throw all.error;
      clientRows = all.data || [];
      userObj.clientIds = clientRows.map(function (r) {
        return r.id;
      });
    } else {
      var links = await client.from('user_clients').select('client_id').eq('user_id', uid);
      if (links.error) throw links.error;
      var ids = (links.data || []).map(function (r) {
        return r.client_id;
      });
      userObj.clientIds = ids;
      if (ids.length) {
        var cr = await client.from('clients').select('*').in('id', ids);
        if (cr.error) throw cr.error;
        clientRows = cr.data || [];
      }
    }

    state.clientes = clientRows.map(mapClientRow);
    state.clienteData = {};

    for (var i = 0; i < state.clientes.length; i++) {
      var cid = state.clientes[i].id;
      var cf = await client
        .from('client_financial_data')
        .select('data')
        .eq('client_id', cid)
        .maybeSingle();
      if (cf.error) throw cf.error;
      var raw = cf.data && cf.data.data;
      if (raw && typeof raw === 'object') {
        state.clienteData[String(cid)] = normalizeClientData(raw);
      } else {
        state.clienteData[String(cid)] = { pagar: [], receber: [], categorias: [] };
      }
    }

    var last = localStorage.getItem('axion_last_client_id');
    state.cliente =
      state.clientes.find(function (c) {
        return String(c.id) === String(last);
      }) ||
      state.clientes[0] ||
      null;

    if (typeof CFG_CURRENT_USER_REF === 'object' && CFG_CURRENT_USER_REF) {
      Object.assign(CFG_CURRENT_USER_REF, userObj);
    }

    return { ok: true, profile: profile, user: userObj };
  }

  function normalizeClientData(d) {
    var src = typeof d === 'object' && d ? d : {};
    var out = Object.assign({}, src);
    out.pagar = Array.isArray(src.pagar) ? src.pagar : [];
    out.receber = Array.isArray(src.receber) ? src.receber : [];
    out.categorias = Array.isArray(src.categorias) ? src.categorias : [];
    return out;
  }

  async function pushClientData(state) {
    var client = await ensureClient();
    if (!client || !profile) return;
    var uid = (await client.auth.getUser()).data.user?.id;
    if (!uid) return;

    var keys = Object.keys(state.clienteData || {});
    for (var k = 0; k < keys.length; k++) {
      var cid = parseInt(keys[k], 10);
      if (isNaN(cid)) continue;
      var payload = state.clienteData[keys[k]];
      var row = {
        client_id: cid,
        data: payload,
        updated_by: uid,
        updated_at: new Date().toISOString()
      };
      var up = await client.from('client_financial_data').upsert(row, { onConflict: 'client_id' });
      if (up.error) console.error('axion push client_financial_data', up.error);
    }
  }

  function debouncedPush(state) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      pushClientData(state).catch(function (e) {
        console.error(e);
      });
    }, 700);
  }

  async function login(username, password) {
    var client = await ensureClient();
    if (!client) throw new Error('Configure URL e chave anon do Supabase');
    var em = emailFromUsername(username);
    var res = await client.auth.signInWithPassword({ email: em, password: password });
    if (res.error) throw res.error;
    return res.data;
  }

  async function logout() {
    cacheTasks = null;
    cacheKv = {};
    cacheAudit = null;
    teamList = [];
    if (sb) await sb.auth.signOut();
    profile = null;
  }

  async function insertClient(state, dataRow, planoPadraoFn) {
    var client = await ensureClient();
    if (!client) throw new Error('Supabase não configurado');
    var uid = (await client.auth.getUser()).data.user?.id;
    if (!uid) throw new Error('Sessão inválida');
    var extra = extraFromForm(dataRow);
    var ins = await client
      .from('clients')
      .insert({
        nome: dataRow.nome,
        cnpj: dataRow.cnpj || '',
        segmento: dataRow.seg || dataRow.segmento || '',
        extra: extra
      })
      .select('id')
      .single();
    if (ins.error) throw ins.error;
    var newId = ins.data.id;
    var role = profile && profile.role;
    if (!role) {
      var pr = await client.from('profiles').select('role').eq('id', uid).maybeSingle();
      if (!pr.error && pr.data) role = pr.data.role;
    }
    if (role === 'operador') {
      var link = await client.from('user_clients').insert({ user_id: uid, client_id: newId });
      if (link.error && link.error.code !== '23505') throw link.error;
    }
    var cats = typeof planoPadraoFn === 'function' ? planoPadraoFn() : [];
    var cfdPayload = { pagar: [], receber: [], categorias: cats };
    await client.from('client_financial_data').upsert({
      client_id: newId,
      data: cfdPayload,
      updated_by: uid
    });
    return newId;
  }

  async function updateClientRow(dataRow, clientId) {
    var client = await ensureClient();
    if (!client) throw new Error('Supabase não configurado');
    var extra = extraFromForm(dataRow);
    var up = await client
      .from('clients')
      .update({
        nome: dataRow.nome,
        cnpj: dataRow.cnpj || '',
        segmento: dataRow.seg || dataRow.segmento || '',
        extra: extra
      })
      .eq('id', clientId);
    if (up.error) throw up.error;
  }

  async function deleteClientRow(clientId) {
    var client = await ensureClient();
    if (!client) throw new Error('Supabase não configurado');
    var del = await client.from('clients').delete().eq('id', clientId);
    if (del.error) throw del.error;
  }

  /* ─── Tarefas ─── */
  function getTasks() {
    return Array.isArray(cacheTasks) ? cacheTasks : [];
  }

  function setTasksAndSync(arr) {
    cacheTasks = Array.isArray(arr) ? arr : [];
    if (!profile || (profile.role !== 'admin' && profile.role !== 'operador')) return;
    clearTimeout(taskTimer);
    taskTimer = setTimeout(function () {
      syncTasksToDb().catch(function (e) {
        console.error('tasks sync', e);
      });
    }, 450);
  }

  async function syncTasksToDb() {
    var client = await ensureClient();
    if (!client || !profile) return;
    if (profile.role !== 'admin' && profile.role !== 'operador') return;
    var uid = (await client.auth.getUser()).data.user?.id;
    if (!uid) return;
    var arr = getTasks();
    var ex = await client.from('tasks').select('id');
    if (ex.error) {
      console.error(ex.error);
      return;
    }
    var newIds = new Set(arr.map(function (t) {
      return String(t.id);
    }));
    var rows = ex.data || [];
    for (var i = 0; i < rows.length; i++) {
      if (!newIds.has(rows[i].id)) {
        var d = await client.from('tasks').delete().eq('id', rows[i].id);
        if (d.error) console.error(d.error);
      }
    }
    for (var j = 0; j < arr.length; j++) {
      var t = arr[j];
      var tid = String(t.id);
      var cid = t.clienteId != null && t.clienteId !== '' ? parseInt(t.clienteId, 10) : null;
      if (isNaN(cid)) cid = null;
      var up = await client.from('tasks').upsert(
        {
          id: tid,
          client_id: cid,
          payload: t,
          updated_by: uid
        },
        { onConflict: 'id' }
      );
      if (up.error) console.error('task upsert', up.error);
    }
  }

  async function loadTasksFromDb() {
    var client = await ensureClient();
    if (!client || !profile) {
      cacheTasks = [];
      return;
    }
    if (profile.role !== 'admin' && profile.role !== 'operador') {
      cacheTasks = [];
      return;
    }
    var r = await client.from('tasks').select('id, client_id, payload, updated_at').order('updated_at', { ascending: true });
    if (r.error) {
      console.error(r.error);
      cacheTasks = [];
      return;
    }
    cacheTasks = (r.data || []).map(function (row) {
      var p = row.payload && typeof row.payload === 'object' ? Object.assign({}, row.payload) : {};
      p.id = row.id;
      if (row.client_id != null) p.clienteId = row.client_id;
      return p;
    });
  }

  /* ─── KV ─── */
  function getKv(key, fallback) {
    if (cacheKv.hasOwnProperty(key)) return cacheKv[key];
    return fallback !== undefined ? fallback : null;
  }

  function setKv(key, value) {
    cacheKv[key] = value;
    if (!profile || (profile.role !== 'admin' && profile.role !== 'operador')) return;
    clearTimeout(kvTimer);
    kvTimer = setTimeout(function () {
      pushKv(key).catch(function (e) {
        console.error('kv', e);
      });
    }, 400);
  }

  async function pushKv(key) {
    var client = await ensureClient();
    if (!client || !profile) return;
    if (profile.role !== 'admin' && profile.role !== 'operador') return;
    var uid = (await client.auth.getUser()).data.user?.id;
    var val = cacheKv[key];
    var up = await client.from('app_sync_kv').upsert(
      {
        key: key,
        value: val === undefined ? {} : val,
        updated_by: uid
      },
      { onConflict: 'key' }
    );
    if (up.error) console.error('app_sync_kv', up.error);
  }

  async function loadKvKey(key) {
    var client = await ensureClient();
    if (!client || !profile) return null;
    if (profile.role !== 'admin' && profile.role !== 'operador') return null;
    var r = await client.from('app_sync_kv').select('value').eq('key', key).maybeSingle();
    if (r.error || !r.data) return null;
    return r.data.value;
  }

  /* ─── Auditoria ─── */
  function getAuditLogs() {
    return Array.isArray(cacheAudit) ? cacheAudit : [];
  }

  async function clearAuditLogs() {
    var client = await ensureClient();
    if (!client || !profile) return;
    if (profile.role !== 'admin' && profile.role !== 'operador') return;
    var del = await client.from('audit_logs').delete().gte('id', 1);
    if (del.error) console.error('audit delete', del.error);
    cacheAudit = [];
  }

  async function loadAuditFromDb() {
    var client = await ensureClient();
    if (!client || !profile) {
      cacheAudit = [];
      return;
    }
    if (profile.role !== 'admin' && profile.role !== 'operador') {
      cacheAudit = [];
      return;
    }
    var r = await client
      .from('audit_logs')
      .select('payload, created_at')
      .order('created_at', { ascending: false })
      .limit(2000);
    if (r.error) {
      console.error(r.error);
      cacheAudit = [];
      return;
    }
    var raw = (r.data || []).slice().reverse();
    cacheAudit = raw.map(function (row) {
      var p = row.payload && typeof row.payload === 'object' ? Object.assign({}, row.payload) : {};
      if (!p.ts) p.ts = row.created_at;
      return p;
    });
  }

  async function insertAuditLog(log) {
    var client = await ensureClient();
    if (!client || !profile) return;
    if (profile.role !== 'admin' && profile.role !== 'operador') return;
    var uid = (await client.auth.getUser()).data.user?.id;
    var cid = log.clienteId != null ? parseInt(log.clienteId, 10) : null;
    if (isNaN(cid)) cid = null;
    var ins = await client.from('audit_logs').insert({
      user_id: uid,
      client_id: cid,
      payload: log
    });
    if (ins.error) console.error('audit insert', ins.error);
    else {
      if (!Array.isArray(cacheAudit)) cacheAudit = [];
      cacheAudit.push(log);
      if (cacheAudit.length > 2000) cacheAudit = cacheAudit.slice(-2000);
    }
  }

  async function loadTeamProfiles() {
    teamList = [];
    var client = await ensureClient();
    if (!client || !profile) return;
    if (profile.role === 'admin') {
      var r = await client.from('profiles').select('id, display_name, role').order('display_name');
      if (!r.error && r.data) {
        teamList = r.data.filter(function (p) {
          return p.role === 'admin' || p.role === 'operador';
        });
      }
    } else if (profile.role === 'operador') {
      var r2 = await client.from('profiles').select('id, display_name, role').order('display_name');
      if (!r2.error && r2.data) {
        teamList = r2.data.filter(function (p) {
          return p.role === 'admin' || p.role === 'operador';
        });
      }
    } else {
      teamList = [{ id: profile.id, display_name: profile.display_name, role: profile.role }];
    }
    global.AXION_TEAM_LIST = teamList.map(function (p) {
      return {
        id: p.id,
        username: (p.display_name || '').split(/\s/)[0].toLowerCase(),
        displayName: p.display_name,
        nome: p.display_name,
        role: p.role
      };
    });
  }

  function migrateLocalOnce() {
    try {
      if (localStorage.getItem('axion_migrated_v1') === '1') return;
      if (!sb || !profile || (profile.role !== 'admin' && profile.role !== 'operador')) return;

      if ((!cacheTasks || cacheTasks.length === 0) && localStorage.getItem('axion_tarefas_v2')) {
        var t = JSON.parse(localStorage.getItem('axion_tarefas_v2') || '[]');
        if (t.length) {
          cacheTasks = t;
          syncTasksToDb().catch(function () {});
        }
      }
      if ((cacheKv['tarefas_recorrentes'] || []).length === 0 && localStorage.getItem('axion_tarefas_recorrentes')) {
        cacheKv['tarefas_recorrentes'] = JSON.parse(localStorage.getItem('axion_tarefas_recorrentes') || '[]');
        pushKv('tarefas_recorrentes').catch(function () {});
      }
      if ((!cacheKv['ofx_apelidos'] || Object.keys(cacheKv['ofx_apelidos']).length === 0) && localStorage.getItem('ofx_apelidos')) {
        cacheKv['ofx_apelidos'] = JSON.parse(localStorage.getItem('ofx_apelidos') || '{}');
        pushKv('ofx_apelidos').catch(function () {});
      }
      if ((cacheKv['import_historico'] || []).length === 0 && localStorage.getItem('axion_imp_historico')) {
        cacheKv['import_historico'] = JSON.parse(localStorage.getItem('axion_imp_historico') || '[]');
        pushKv('import_historico').catch(function () {});
      }

      localStorage.setItem('axion_migrated_v1', '1');
    } catch (e) {
      console.warn('migrateLocalOnce', e);
    }
  }

  async function bootstrapCaches() {
    await loadTasksFromDb();
    var tr = await loadKvKey('tarefas_recorrentes');
    cacheKv['tarefas_recorrentes'] = Array.isArray(tr) ? tr : [];
    var ox = await loadKvKey('ofx_apelidos');
    cacheKv['ofx_apelidos'] = ox && typeof ox === 'object' ? ox : {};
    var im = await loadKvKey('import_historico');
    cacheKv['import_historico'] = Array.isArray(im) ? im : [];
    await loadAuditFromDb();
    await loadTeamProfiles();
    migrateLocalOnce();
  }

  /** Access token válido para Edge Functions (tenta refresh se necessário). */
  async function getAccessTokenForEdge(client) {
    var s = await client.auth.getSession();
    if (s.data.session && s.data.session.access_token) return s.data.session.access_token;
    var r = await client.auth.refreshSession();
    if (r.data && r.data.session && r.data.session.access_token) return r.data.session.access_token;
    throw new Error('Sessão expirada. Saia e entre de novo na nuvem.');
  }

  async function invokeAdminUser(payload) {
    var client = await ensureClient();
    if (!client || !profile || profile.role !== 'admin') {
      throw new Error('Apenas administrador');
    }
    var cfg = getConfig();
    var token = await getAccessTokenForEdge(client);
    var base = (cfg.url || '').replace(/\/$/, '');
    var res = await fetch(base + '/functions/v1/admin-user', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
        apikey: cfg.anon
      },
      body: JSON.stringify(payload)
    });
    var j = await res.json().catch(function () {
      return {};
    });
    if (!res.ok) {
      var msg = (j && (j.error || j.message)) || '';
      if (!msg) msg = 'HTTP ' + res.status;
      if (res.status === 404 || /not\s*found/i.test(String(msg))) {
        msg =
          'Função admin-user não encontrada (404). No Supabase: faça deploy da Edge Function admin-user e verifique a URL do projeto.';
      }
      throw new Error(msg);
    }
    return j;
  }

  /** Chama a Edge Function gemini-proxy (chave GEMINI_API_KEY no servidor). Requer sessão. */
  async function invokeGemini(payload) {
    var client = await ensureClient();
    if (!client || !profile) throw new Error('Faça login na nuvem para usar a IA.');
    var cfg = getConfig();
    var token = await getAccessTokenForEdge(client);
    var base = (cfg.url || '').replace(/\/$/, '');
    var res = await fetch(base + '/functions/v1/gemini-proxy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
        apikey: cfg.anon
      },
      body: JSON.stringify(payload || {})
    });
    var j = await res.json().catch(function () {
      return {};
    });
    if (!res.ok) {
      var msg = (j && (j.error || j.message)) || '';
      if (!msg) msg = 'HTTP ' + res.status;
      if (res.status === 404 || /not\s*found/i.test(String(msg))) {
        msg =
          'Função gemini-proxy não encontrada (404). Deploy: supabase functions deploy gemini-proxy e configure o secret GEMINI_API_KEY.';
      } else if (/invalid\s*jwt/i.test(String(msg))) {
        msg =
          'Sessão inválida (JWT). Saia do sistema, entre de novo na nuvem e confira em Configurações se a URL e a chave anon do Supabase são do mesmo projeto.';
      }
      throw new Error(msg);
    }
    return j;
  }

  /** Chama a Edge Function groq-proxy (chave GROQ_API_KEY no servidor). Requer sessão. */
  async function invokeGroq(payload) {
    var client = await ensureClient();
    if (!client || !profile) throw new Error('Faça login na nuvem para usar a IA.');
    var cfg = getConfig();
    var token = await getAccessTokenForEdge(client);
    var base = (cfg.url || '').replace(/\/$/, '');
    var res = await fetch(base + '/functions/v1/groq-proxy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
        apikey: cfg.anon
      },
      body: JSON.stringify(payload || {})
    });
    var j = await res.json().catch(function () {
      return {};
    });
    if (!res.ok) {
      var msg = (j && (j.error || j.message)) || '';
      if (!msg) msg = 'HTTP ' + res.status;
      if (res.status === 404 || /not\s*found/i.test(String(msg))) {
        msg =
          'Função groq-proxy não encontrada (404). Deploy: supabase functions deploy groq-proxy e secret GROQ_API_KEY.';
      } else if (/invalid\s*jwt/i.test(String(msg))) {
        msg =
          'Sessão inválida (JWT). Saia do sistema, entre de novo na nuvem e confira URL/chave anon do Supabase.';
      }
      throw new Error(msg);
    }
    return j;
  }

  async function listAdminUsers() {
    var client = await ensureClient();
    if (!client || !profile || profile.role !== 'admin') return [];
    var r = await client.rpc('admin_list_users');
    var rows = r.data || [];
    if (r.error) {
      console.warn('admin_list_users RPC:', r.error.message || r.error);
      var fb = await client.from('profiles').select('*').order('display_name', { ascending: true });
      if (fb.error) throw r.error;
      rows = fb.data || [];
    }
    var links = await client.from('user_clients').select('user_id, client_id');
    if (links.error) throw links.error;
    var byUser = {};
    (links.data || []).forEach(function (L) {
      if (!byUser[L.user_id]) byUser[L.user_id] = [];
      byUser[L.user_id].push(L.client_id);
    });
    return rows.map(function (p) {
      var em = p.email || '';
      if (!em && p.display_name) {
        em = String(p.display_name)
          .toLowerCase()
          .replace(/\s+/g, '.')
          .replace(/[^a-z0-9._-]/g, '') + '@axion.local';
      }
      var pr = p.permissions;
      var permissions = pr && typeof pr === 'object' && !Array.isArray(pr) ? pr : {};
      return {
        id: p.id,
        username: em.split('@')[0] || 'user',
        displayName: p.display_name,
        role: p.role,
        status: p.status,
        clientIds: byUser[p.id] || [],
        password: '',
        createdAt: (p.created_at || '').slice(0, 10),
        permissions: permissions
      };
    });
  }

  async function adminUpdateProfile(userId, fields) {
    var client = await ensureClient();
    if (!client || !profile || profile.role !== 'admin') throw new Error('Apenas administrador');
    var row = {
      display_name: fields.display_name,
      role: fields.role,
      status: fields.status
    };
    if (fields.permissions !== undefined) {
      row.permissions = fields.permissions;
    }
    var up = await client.from('profiles').update(row).eq('id', userId);
    if (up.error && row.permissions !== undefined) {
      var msg = String((up.error && (up.error.message || up.error.details)) || '');
      if (/permissions|column|schema|does not exist/i.test(msg)) {
        delete row.permissions;
        up = await client.from('profiles').update(row).eq('id', userId);
        if (!up.error) {
          console.warn(
            '[AXION] Coluna permissions ausente — rode a migração 009_profile_permissions.sql no Supabase.'
          );
        }
      }
    }
    if (up.error) throw up.error;
  }

  async function adminReplaceUserClients(userId, clientIds) {
    var client = await ensureClient();
    if (!client || !profile || profile.role !== 'admin') throw new Error('Apenas administrador');
    var del = await client.from('user_clients').delete().eq('user_id', userId);
    if (del.error) throw del.error;
    for (var i = 0; i < clientIds.length; i++) {
      var ins = await client.from('user_clients').insert({
        user_id: userId,
        client_id: clientIds[i]
      });
      if (ins.error) throw ins.error;
    }
  }

  global.AXION_CLOUD = {
    get client() {
      return sb;
    },
    get profile() {
      return profile;
    },
    ensureClient: ensureClient,
    getConfig: getConfig,
    setConfig: setConfig,
    emailFromUsername: emailFromUsername,
    loadSessionAndData: loadSessionAndData,
    debouncedPush: debouncedPush,
    /** Grava clienteData no Supabase imediatamente (sem debounce). */
    flushClientData: function (state) {
      return pushClientData(state);
    },
    /** Envia tarefas ao Supabase imediatamente. */
    flushTasks: function () {
      return syncTasksToDb();
    },
    login: login,
    logout: logout,
    insertClient: insertClient,
    updateClientRow: updateClientRow,
    deleteClientRow: deleteClientRow,
    mapClientRow: mapClientRow,
    bootstrapCaches: bootstrapCaches,
    getTasks: getTasks,
    setTasksAndSync: setTasksAndSync,
    getKv: getKv,
    setKv: setKv,
    getAuditLogs: getAuditLogs,
    insertAuditLog: insertAuditLog,
    refreshAudit: loadAuditFromDb,
    clearAuditLogs: clearAuditLogs,
    invokeAdminUser: invokeAdminUser,
    invokeGemini: invokeGemini,
    invokeGroq: invokeGroq,
    listAdminUsers: listAdminUsers,
    adminUpdateProfile: adminUpdateProfile,
    adminReplaceUserClients: adminReplaceUserClients,
    loadTeamProfiles: loadTeamProfiles
  };
})(typeof window !== 'undefined' ? window : globalThis);
