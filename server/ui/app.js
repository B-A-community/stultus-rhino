/*
  Stultus Rhino — окно чата. Страница живёт на gateway (/ui/), в Rhino её
  показывает тонкий хост (C#, WebView2).

  Две связи:
    * с хостом: chrome.webview.postMessage({id, name, payload}) → Stultus.receive({id, result});
      всё, чего хост не умеет сам, делают Python-скрипты инструментов из tools.js,
      которые хост исполняет в Rhino;
    * с gateway: WebSocket, JSON-конверты (см. docs/PROTOCOL.md).

  Инструменты модели исполняет Rhino; сюда приходит tool_call от gateway,
  мы зовём хост и отправляем tool_result обратно. Снимок вьюпорта — только
  после нажатия кнопки пользователем.
*/
(function () {
  'use strict';

  // ---------- Мост к хосту (C# в Rhino) -----------------------------------
  var pendingHost = {};
  var hostSeq = 0;

  function host(name, payload) {
    return new Promise(function (resolve, reject) {
      var id = 'h' + (++hostSeq);
      if (!window.chrome || !window.chrome.webview) { reject(new Error('Нет моста Rhino: ' + name)); return; }
      pendingHost[id] = { resolve: resolve, reject: reject };
      try { window.chrome.webview.postMessage(JSON.stringify({ id: id, name: name, payload: payload || {} })); }
      catch (e) { delete pendingHost[id]; reject(e); }
    });
  }

  // Python-скрипт инструмента из tools.js: аргументы уходят как __stultus_args__,
  // ответ — переменная result скрипта (dict), хост возвращает её в result.
  function tool(name, args, opts) {
    var tools = window.StultusTools && window.StultusTools.tools;
    if (!tools || !tools[name]) return Promise.reject(new Error('Нет скрипта инструмента: ' + name));
    var a = Object.assign({ host_version: state.instance && state.instance.plugin }, args || {});
    return host('python', Object.assign({ tool: name, code: tools[name], args: a, undo: 'none' }, opts || {})).then(function (r) {
      if (!r || r.ok === false) return r;
      var v = r.result;
      if (v && typeof v === 'object') return Object.assign({ ok: true }, v);
      return { ok: true, value: v, output: r.output };
    });
  }

  // Имена вызовов как в Stultus (SketchUp): часть идёт хосту напрямую,
  // часть — Python-скриптам. render.js пользуется этими же именами.
  var NATIVE = { ready: 1, save_history: 1, save_sessions: 1, clear_history: 1, restore_history: 1, save_settings: 1, save_accent: 1, log: 1, open_url: 1, undo: 1, execute_python: 1, turn_end: 1, update_host: 1 };
  var PY = {
    scene_state: function (p) { return tool('scene_state', p); },
    select: function (p) { return tool('select', p); },
    screenshot: function (p) { return tool('screenshot', p); },
    named_views: function (p) { return tool('named_views', p, { undo: (p.action === 'list' || p.action === 'activate') ? 'none' : 'turn', turn: p.turn, turn_label: p.turn_label, label: 'вид ' + (p.name || '') }); },
    save_attachment: function (p) { return tool('attachments', { action: 'save', name: p.name, base64: p.base64 }); },
    read_attachment: function (p) { return tool('attachments', { action: 'read', path: p.path }); },
    cache_render: function (p) { return tool('render_assets', { action: 'store', id: p.id, image: p.image, source: p.source, preview: p.preview }); },
    render_chunk: function (p) { return tool('render_assets', { action: 'chunk', id: p.id, index: p.index, total: p.total, data: p.data }); },
    get_render: function (p) { return tool('render_assets', { action: 'read', id: p.id }); },
    export_render: function (p) { return tool('render_assets', { action: 'export_to', id: p.id, path: p.path }); },
    save_render: function (p) { return tool('render_assets', { action: 'export', id: p.id }); }
  };
  function rb(name, payload) {
    payload = payload || {};
    if (PY[name]) return PY[name](payload);
    if (NATIVE[name]) return host(name, payload);
    return Promise.reject(new Error('Неизвестный вызов хоста: ' + name));
  }

  // Ошибки страницы — в журнал плагина: внутри Rhino консоли у окна нет.
  window.addEventListener('error', function (e) {
    try { host('log', { text: 'error: ' + e.message + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno }); } catch (_) {}
  });
  window.addEventListener('unhandledrejection', function (e) {
    try { host('log', { text: 'rejection: ' + (e.reason && e.reason.message || e.reason) }); } catch (_) {}
  });

  window.Stultus = {
    log: function (text) { rb('log', { text: String(text) }).catch(function () {}); },
    receive: function (msg) {
      var p = pendingHost[msg.id];
      if (!p) return;
      delete pendingHost[msg.id];
      p.resolve(msg.result);
    },
    // Хост зовёт это при каждом изменении выделения в Rhino: описание
    // (по-русски, с блоками и габаритами) считает Python-скрипт.
    selectionChanged: function () {
      clearTimeout(state.selectionTimer);
      state.selectionTimer = setTimeout(refreshSelection, 120);
    },
    // Хост зовёт при смене документа (открыт другой файл): окно перезагружается,
    // потому что переписка и цвет привязаны к файлу.
    documentChanged: function () { location.reload(); },
    selection: function (sel) {
      state.selection = sel || null;
      renderContext();
    },
    // Текст для строки контекста в композере; его же берёт ui.js.
    contextText: function (sceneOn) {
      var sel = state.selection && state.selection.text ? state.selection.text : 'ничего не выделено';
      return (sceneOn ? 'Контекст сцены' : 'Без контекста') + ' · ' + sel;
    }
  };

  // ---------- Состояние ---------------------------------------------------
  var state = {
    settings: {},
    providers: [],
    sessions: {},      // { claude: 'uuid', codex: 'thread' } — в файле модели
    instance: null,
    messages: [],      // то, что сохраняем в модель: {role, text, tools:[{name,label,ok}]}
    ws: null,
    wsState: 'disconnected',
    busy: false,
    turn: 0,
    reconnectTimer: null,
    reconnectDelay: 1000,
    current: null,     // текущий ответ: {el, bodyEl, text, tools:[]}
    usage: null,
    selection: null,   // { count, text, by_type, definitions } — живое выделение из Rhino
    selectionTimer: null,
    hostUpdate: null,  // { name, version } — пакет плагина на gateway, если хост устарел
    archive: null,     // { count, at } — удалённая переписка, которую можно вернуть
    turnOps: 0,        // сколько успешных execute_python было в текущем ходе
    turnOpened: false, // открыта ли запись Undo этого хода (первый успешный вызов)
    turnLabel: '',
    recipes: [],       // копилка приёмов с gateway
    accent: 'lime',    // цвет этого окна (хранится в файле модели)
    attachments: []    // картинки к следующему сообщению: {name, mime, base64 (оригинал), thumb, path}
  };

  // Десять цветов окна: свой у каждой открытой модели, чтобы окна не путались.
  var ACCENTS = [
    ['lime', '#d6f58a'], ['amber', '#f5c76a'], ['coral', '#f0917f'], ['rose', '#f0a3cb'], ['violet', '#bfa6f2'],
    ['blue', '#8fb8f5'], ['cyan', '#7fd9e0'], ['mint', '#8fe3b4'], ['sand', '#e3d2a3'], ['grey', '#c9cdc5']
  ];

  var $ = function (id) { return document.getElementById(id); };
  var app = $('app'), chat = $('chat'), input = $('input');
  var renders = window.StultusRender({ rb: rb, chat: chat, send: send, scroll: scrollDown, hideEmpty: hideEmpty,
    persist: persist, remember: function (message) { finishCurrent(); state.messages.push(message); } });

  // ---------- Рендер ------------------------------------------------------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Минимальный markdown: код-блоки, инлайн-код, жирный, списки, абзацы.
  function renderMarkdown(text) {
    var parts = String(text).split(/```/);
    var html = '';
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        var code = parts[i].replace(/^[a-zA-Z0-9_-]*\n/, '');
        html += '<pre><code>' + escapeHtml(code) + '</code></pre>';
      } else {
        var t = escapeHtml(parts[i]);
        t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
        t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
        t = t.replace(/(^|\n)((?:[-*] .*(?:\n|$))+)/g, function (_m, pre, list) {
          var items = list.trim().split('\n').map(function (l) { return '<li>' + l.replace(/^[-*] /, '') + '</li>'; }).join('');
          return pre + '<ul>' + items + '</ul>';
        });
        html += t;
      }
    }
    return html;
  }

  function scrollDown() { chat.scrollTop = chat.scrollHeight; }

  function hideEmpty() { var e = $('chatEmpty'); if (e) e.hidden = true; }

  function addMessage(role, text, opts) {
    hideEmpty();
    var el = $('tplMessage').content.firstElementChild.cloneNode(true);
    el.classList.add('msg--' + role);
    el.querySelector('.msg__role').textContent =
      role === 'user' ? 'Вы' : role === 'assistant' ? ((opts && opts.provider) || 'Модель') : '';
    var body = el.querySelector('.msg__body');
    if (role === 'assistant') body.innerHTML = renderMarkdown(text || '');
    else body.textContent = text || '';
    if (role === 'system' || role === 'error') el.querySelector('.msg__role').remove();
    chat.appendChild(el);
    scrollDown();
    return el;
  }

  function addTool(call) {
    hideEmpty();
    var el = $('tplTool').content.firstElementChild.cloneNode(true);
    el.dataset.state = 'running';
    el.dataset.callId = call.call_id;
    el.querySelector('.tool__name').textContent = call.name;
    el.querySelector('.tool__label').textContent = toolLabel(call);
    el.querySelector('.tool__state').textContent = 'выполняется…';
    el.querySelector('.tool__args').textContent = toolArgsPreview(call);
    chat.appendChild(el);
    scrollDown();
    return el;
  }

  function toolLabel(call) {
    var a = call.args || {};
    if (call.name === 'execute_python') return a.label || (String(a.code || '').split('\n')[0].slice(0, 80));
    if (call.name === 'take_screenshot') return a.reason || '';
    if (call.name === 'render_viewport') return 'Постпродакшн текущего кадра';
    if (call.name === 'ask_user') return a.question || '';
    if (call.name === 'select') return a.mode === 'clear' ? 'снять выделение' : 'выделить ' + ((a.ids || []).length) + ' объект(ов)';
    if (call.name === 'named_views') return 'именованные виды: ' + (a.action || 'list') + (a.name ? ' «' + a.name + '»' : '');
    return '';
  }

  function toolArgsPreview(call) {
    var a = call.args || {};
    if (call.name === 'execute_python') return String(a.code || '');
    return JSON.stringify(a, null, 2);
  }

  function finishTool(el, ok, resultText) {
    el.dataset.state = ok ? 'ok' : 'error';
    el.querySelector('.tool__state').textContent = ok ? 'готово' : 'ошибка';
    el.querySelector('.tool__result').textContent = resultText || '';
    if (!ok) el.open = true;
  }

  function setStatus(s, text) {
    state.wsState = s;
    app.dataset.state = state.busy ? 'busy' : s;
    $('connStatus').querySelector('.topbar__statusText').textContent = text;
  }

  function setBusy(b) {
    if (!b) renders.cancel();
    state.busy = b;
    app.dataset.state = b ? 'busy' : state.wsState;
    $('btnSend').disabled = b;
    $('btnCancel').hidden = !b;
  }

  function hint(text) { $('composerHint').textContent = text || ''; }

  function renderContext() {
    var el = $('contextLabel');
    if (el) el.textContent = window.Stultus.contextText($('attachScene').checked);
  }

  // ---------- История -----------------------------------------------------
  function restoreHistory(messages) {
    renders.cancel();
    chat.querySelectorAll('.msg, .tool, .card, .render').forEach(function (n) { n.remove(); });
    state.messages = messages || [];
    state.messages.forEach(function (m) {
      if (m.render) { renders.restore(m.render); return; }
      if (m.role === 'user') { var ue = addMessage('user', m.text); if (m.attachments && m.attachments.length) showImages(ue, m.attachments); }
      else if (m.role === 'assistant') {
        (m.tools || []).forEach(function (t) {
          var el = addTool({ call_id: '', name: t.name, args: { label: t.label, reason: t.label, question: t.label } });
          el.querySelector('.tool__args').textContent = '';
          if (t.name === 'размышление') el.classList.add('tool--thinking');
          finishTool(el, t.ok !== false, '');
        });
        // Ход без текста (только вызовы) — пузыря не было и при живом ходе.
        if (m.text) addMessage('assistant', m.text, { provider: m.provider });
      }
    });
    if (state.messages.length) hideEmpty();
  }

  function persist() {
    rb('save_history', { messages: state.messages }).catch(function () {});
  }

  function persistSessions() {
    rb('save_sessions', { sessions: state.sessions }).catch(function () {});
  }

  // ---------- Gateway -----------------------------------------------------
  function connect() {
    if (state.ws) { try { state.ws.close(); } catch (e) {} state.ws = null; }
    clearTimeout(state.reconnectTimer);
    var url = wsUrl();
    if (!url) { setStatus('disconnected', 'адрес gateway не задан'); return; }
    setStatus('connecting', 'подключение…');
    var ws;
    try { ws = new WebSocket(url); } catch (e) { setStatus('disconnected', 'плохой адрес'); return; }
    state.ws = ws;
    ws.onopen = function () {
      state.reconnectDelay = 1000;
      send({ type: 'hello', token: state.settings.token || '', instance: state.instance, sessions: state.sessions, plugin: (state.instance && state.instance.plugin) || '' });
    };
    ws.onmessage = function (ev) {
      var msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handle(msg);
    };
    ws.onclose = function (ev) {
      if (state.ws !== ws) return;
      state.ws = null;
      if (state.busy) { setBusy(false); finishCurrent(); addMessage('error', 'Соединение с gateway оборвалось посреди хода.'); endTurn(); }
      setStatus('disconnected', ev.code === 4401 ? 'пропуск не принят' : 'нет связи');
      if (ev.code !== 4401) {
        state.reconnectTimer = setTimeout(connect, state.reconnectDelay);
        state.reconnectDelay = Math.min(state.reconnectDelay * 2, 15000);
      }
    };
    ws.onerror = function () {};
  }

  // Страница отдана сервером — WebSocket идёт на тот же адрес. Локальная
  // страница-заглушка (хост без связи) берёт адрес из настроек.
  function gatewayBase() {
    var base = (state.settings.gateway || '').trim().replace(/\/+$/, '');
    if (/^https?:\/\//.test(location.href)) return location.origin;
    return base;
  }
  function wsUrl() {
    var base = gatewayBase();
    if (!base) return '';
    return base.replace(/^http/, 'ws') + '/ws';
  }

  function send(obj) {
    if (!state.ws || state.ws.readyState !== 1) return false;
    state.ws.send(JSON.stringify(obj));
    return true;
  }

  function handle(msg) {
    switch (msg.type) {
      case 'render_status': renders.status(msg); break;
      case 'render_result': renders.result(msg); break;
      case 'render_chunk': renders.chunk(msg); break;
      case 'welcome':
        state.providers = msg.providers || [];
        setStatus('connected', 'gateway ' + (msg.version || ''));
        fillProviders();
        if (msg.host_outdated) offerHostUpdate(msg);
        break;
      case 'turn_start':
        break;
      case 'status':
        hint(msg.text || '');
        break;
      case 'text':
        appendText(msg.delta || '');
        break;
      case 'thinking':
        appendThinking(msg.delta || '');
        break;
      case 'text_replace':
        replaceText(msg.text || '');
        break;
      case 'tool_call':
        onToolCall(msg);
        break;
      case 'ask':
        // Вопрос от gateway (ограничитель расхода) приходит в старой форме.
        onAsk({ questions: msg.questions || [{ question: msg.question, options: msg.options }] });
        break;
      case 'session':
        if (msg.provider && msg.id) { state.sessions[msg.provider] = msg.id; persistSessions(); }
        break;
      case 'done':
        onDone(msg);
        break;
      case 'recipes':
        state.recipes = msg.recipes || [];
        renderRecipes();
        break;
      case 'error':
        finishCurrent();
        addMessage('error', msg.message || 'Ошибка gateway');
        setBusy(false);
        hint('');
        endTurn();
        break;
    }
  }

  function fillProviders() {
    var ps = $('providerSelect'), ms = $('modelSelect');
    ps.innerHTML = '';
    state.providers.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.label + (p.configured ? '' : ' (не настроен)');
      o.disabled = !p.configured;
      ps.appendChild(o);
    });
    var wanted = state.settings.provider;
    var ok = state.providers.some(function (p) { return p.id === wanted && p.configured; });
    if (!ok) {
      var first = state.providers.filter(function (p) { return p.configured; })[0];
      wanted = first ? first.id : (state.providers[0] && state.providers[0].id);
    }
    ps.value = wanted || '';
    fillModels();
  }

  function fillModels() {
    var ms = $('modelSelect');
    var p = currentProvider();
    ms.innerHTML = '';
    if (!p) return;
    (p.models || []).forEach(function (m) {
      var o = document.createElement('option');
      o.value = m.id; o.textContent = m.label || m.id;
      ms.appendChild(o);
    });
    var wanted = state.settings.model;
    if (!(p.models || []).some(function (m) { return m.id === wanted; })) wanted = p.default || ((p.models || [])[0] || {}).id;
    ms.value = wanted || '';
  }

  function currentProvider() {
    var id = $('providerSelect').value;
    return state.providers.filter(function (p) { return p.id === id; })[0] || null;
  }

  // ---------- Ход ---------------------------------------------------------
  function sendChat() {
    var text = input.value.trim();
    if (state.attachments.length && !text) text = 'Смотри приложенные изображения.';
    if (!text || state.busy) return;
    if (!state.ws || state.ws.readyState !== 1) { hint('Нет связи с gateway — проверьте настройки.'); return; }
    var provider = $('providerSelect').value, model = $('modelSelect').value;
    if (!provider) { hint('Провайдер не выбран.'); return; }

    input.value = '';
    hint('');
    var atts = state.attachments; state.attachments = []; renderAttachments();
    var userEl = addMessage('user', text);
    if (atts.length) showImages(userEl, atts);
    state.messages.push({ role: 'user', text: text, at: new Date().toISOString(),
      attachments: atts.map(function (a) { return { name: a.name, path: a.path, thumb: a.thumb }; }) });
    setBusy(true);
    state.turn += 1;
    state.turnOps = 0;
    state.turnOpened = false;
    state.turnLabel = text.replace(/\s+/g, ' ').slice(0, 50);
    startCurrent(provider);

    // Выделение уходит всегда: это то, о чём пользователь говорит «это».
    // Галочка решает только, класть ли полный снимок сцены.
    var full = $('attachScene').checked;
    var go = function (scene) {
      // Оригиналы картинок — модели; миниатюры остаются только в окне.
      send({ type: 'chat', turn: state.turn, text: text, provider: provider, model: model, scene: scene || null, sessions: state.sessions,
        attachments: atts.map(function (a) { return { name: a.name, mime: a.mime, base64: a.base64 }; }) });
    };
    rb('scene_state', { full: full }).then(go, function () { go(null); });
  }

  // Текущий ход модели. Текст идёт пузырями: каждый вызов инструмента
  // закрывает пузырь, следующий текст открывает новый — так порядок
  // «сказал → сделал → сказал» читается и в окне, и в истории.
  function startCurrent(provider) {
    state.current = { provider: provider, text: '', tools: [], el: null, body: null };
  }

  function providerLabel(id) {
    var p = state.providers.filter(function (x) { return x.id === id; })[0];
    return p ? p.label : id;
  }

  function ensureBubble() {
    var c = state.current;
    finishThinking();
    if (c.el && c.el === chat.lastElementChild) return;
    if (c.el) commitText();
    c.el = addMessage('assistant', '', { provider: providerLabel(c.provider) });
    c.el.classList.add('is-streaming');
    c.body = c.el.querySelector('.msg__body');
    c.text = '';
  }

  // Закрыть пузырь: текст (и накопленные к нему вызовы) — в историю.
  function commitText() {
    var c = state.current;
    if (!c || !c.el) return;
    c.el.classList.remove('is-streaming');
    if (c.text) {
      state.messages.push({ role: 'assistant', text: c.text, tools: c.tools, provider: providerLabel(c.provider), at: new Date().toISOString() });
      c.tools = [];
    } else {
      c.el.remove();
    }
    c.el = null; c.body = null; c.text = '';
  }

  function appendText(delta) {
    if (!state.current) startCurrent($('providerSelect').value);
    ensureBubble();
    // Разделитель абзацев от провайдера в начале нового пузыря — пустые
    // строки сверху; пузырь начинается с текста.
    if (!state.current.text) delta = delta.replace(/^\s+/, '');
    if (!delta) return;
    state.current.text += delta;
    state.current.body.innerHTML = renderMarkdown(state.current.text);
    scrollDown();
  }

  function replaceText(text) {
    if (!state.current) startCurrent($('providerSelect').value);
    ensureBubble();
    state.current.text = text;
    state.current.body.innerHTML = renderMarkdown(text);
    scrollDown();
  }

  // Размышление модели — строка в ленте, как вызов инструмента: свёрнута,
  // в заголовке первая фраза, внутри полный текст. Новая строка на каждый
  // блок размышлений (после текста или инструмента).
  function appendThinking(delta) {
    if (!state.current) startCurrent($('providerSelect').value);
    var c = state.current;
    if (!c.think || c.think.el !== chat.lastElementChild) {
      if (c.el) commitText();
      hideEmpty();
      var el = $('tplTool').content.firstElementChild.cloneNode(true);
      el.dataset.state = 'running';
      el.classList.add('tool--thinking');
      el.querySelector('.tool__name').textContent = 'размышление';
      el.querySelector('.tool__state').textContent = 'думает…';
      el.querySelector('.tool__args').textContent = '';
      chat.appendChild(el);
      c.think = { el: el, text: '', record: { name: 'размышление', label: '', ok: true } };
      c.tools.push(c.think.record);
    }
    c.think.text += delta;
    var first = c.think.text.replace(/\s+/g, ' ').trim();
    c.think.record.label = first.slice(0, 90);
    c.think.el.querySelector('.tool__label').textContent = c.think.record.label;
    c.think.el.querySelector('.tool__result').textContent = c.think.text;
    scrollDown();
  }

  function finishThinking() {
    var c = state.current;
    if (!c || !c.think) return;
    c.think.el.dataset.state = 'ok';
    c.think.el.querySelector('.tool__state').textContent = 'готово';
    c.think = null;
  }

  function finishCurrent() {
    var c = state.current;
    if (!c) return;
    finishThinking();
    commitText();
    if (c.tools.length) {
      state.messages.push({ role: 'assistant', text: '', tools: c.tools, provider: providerLabel(c.provider), at: new Date().toISOString() });
    }
    state.current = null;
  }

  function onDone(msg) {
    finishCurrent();
    setBusy(false);
    hint('');
    endTurn();
    offerRemember();
    if (msg.usage) {
      state.usage = msg.usage;
      var u = msg.usage;
      $('usage').textContent = 'ход: ' + fmt(u.input || 0) + ' вх / ' + fmt(u.output || 0) + ' вых' +
        (u.cached ? ' (из кэша ' + fmt(u.cached) + ')' : '') + (u.cost != null ? ' · $' + Number(u.cost).toFixed(3) : '');
    }
    persist();
  }

  function fmt(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }

  // «Запомнить приём»: под последним ответом модели, если в ходе были
  // изменения модели. Нажатие просит модель опросить пользователя и сохранить
  // приём в копилку через инструмент save_recipe.
  function offerRemember() {
    if (state.turnOps === 0) return;
    var bubbles = chat.querySelectorAll('.msg--assistant');
    var last = bubbles[bubbles.length - 1];
    if (!last || last.querySelector('.msg__actions')) return;
    var box = document.createElement('div'); box.className = 'msg__actions';
    var b = document.createElement('button'); b.type = 'button'; b.className = 'btn msg__remember'; b.textContent = 'Запомнить приём';
    b.onclick = function () {
      if (state.busy) return;
      box.remove();
      input.value = 'Запомни это действие как приём в копилку. Сначала спроси меня через ask_user обо всём, что надо сделать параметрами (размеры, место, количество, материал, имена), и о названии приёма, потом сохрани через save_recipe.';
      sendChat();
    };
    box.appendChild(b); last.appendChild(box); scrollDown();
  }

  // ---------- Вложения (картинки) ----------
  // Оригинал сохраняется в папку «<проект>-content» рядом с файлом модели и
  // уходит модели как есть; миниатюра (canvas, 240 px) — только для ленты.
  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader(); r.onload = function () { resolve(String(r.result).split(',')[1] || ''); }; r.onerror = function () { reject(r.error); }; r.readAsDataURL(file);
    });
  }
  function makeThumb(dataUrl) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        var max = 240, k = Math.min(1, max / Math.max(img.width, img.height));
        var c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.7));
      };
      img.onerror = function () { resolve(''); };
      img.src = dataUrl;
    });
  }
  function addFiles(files) {
    var list = [].slice.call(files || []).filter(function (f) { return f && /^image\//.test(f.type); });
    if (!list.length) { hint('Приложить можно только изображения.'); return; }
    list.forEach(function (file) {
      var name = file.name || ('image_' + Date.now() + '.png');
      fileToBase64(file).then(function (b64) {
        return makeThumb('data:' + file.type + ';base64,' + b64).then(function (thumb) {
          var att = { name: name, mime: file.type, base64: b64, thumb: thumb, path: null, bytes: file.size };
          state.attachments.push(att); renderAttachments();
          // Оригинал — на диск, в папку проекта.
          return rb('save_attachment', { name: name, base64: b64 }).then(function (r) {
            if (r && r.ok) { att.path = r.path; att.name = r.path.split(/[\\/]/).pop(); renderAttachments(); }
            else hint('Не удалось сохранить вложение: ' + (r && r.error));
          });
        });
      }).catch(function (e) { hint('Не удалось прочитать файл: ' + e.message); });
    });
  }
  function renderAttachments() {
    var box = $('attachments'); if (!box) return;
    box.innerHTML = '';
    box.hidden = !state.attachments.length;
    state.attachments.forEach(function (a, i) {
      var el = document.createElement('div'); el.className = 'attachment'; el.title = a.name + (a.bytes ? ' · ' + Math.round(a.bytes / 1024) + ' КБ' : '');
      var img = document.createElement('img'); img.src = a.thumb || ('data:' + a.mime + ';base64,' + a.base64); img.alt = a.name; el.appendChild(img);
      var nm = document.createElement('div'); nm.className = 'attachment__name'; nm.textContent = a.name; el.appendChild(nm);
      var rm = document.createElement('button'); rm.type = 'button'; rm.className = 'attachment__remove'; rm.textContent = '✕'; rm.title = 'Убрать';
      rm.onclick = function () { state.attachments.splice(i, 1); renderAttachments(); };
      el.appendChild(rm); box.appendChild(el);
    });
  }
  function showImages(msgEl, atts) {
    var box = document.createElement('div'); box.className = 'msg__images';
    atts.forEach(function (a) {
      if (!a.thumb) return;
      var img = document.createElement('img'); img.src = a.thumb; img.alt = a.name || ''; img.title = a.path || a.name || '';
      img.onclick = function () {
        // По клику — оригинал с диска, не миниатюра.
        if (a.path) rb('read_attachment', { path: a.path }).then(function (r) { if (r && r.ok && window.StultusLightbox) window.StultusLightbox('data:' + (a.mime || 'image/png') + ';base64,' + r.base64, a.name); else if (window.StultusLightbox) window.StultusLightbox(a.thumb, a.name); });
        else if (window.StultusLightbox) window.StultusLightbox(a.thumb, a.name);
      };
      box.appendChild(img);
    });
    if (box.children.length) msgEl.appendChild(box);
  }
  $('btnAttach').onclick = function () { $('fileInput').click(); };
  $('fileInput').onchange = function () { addFiles(this.files); this.value = ''; };
  input.addEventListener('paste', function (e) {
    var items = e.clipboardData && e.clipboardData.files;
    if (items && items.length) { e.preventDefault(); addFiles(items); }
  });
  document.addEventListener('dragover', function (e) { if (e.dataTransfer && [].slice.call(e.dataTransfer.types).indexOf('Files') >= 0) { e.preventDefault(); app.classList.add('is-drop'); } });
  document.addEventListener('dragleave', function () { app.classList.remove('is-drop'); });
  document.addEventListener('drop', function (e) { app.classList.remove('is-drop'); if (e.dataTransfer && e.dataTransfer.files.length) { e.preventDefault(); addFiles(e.dataTransfer.files); } });

  // ---------- Копилка приёмов ----------
  function renderRecipes() {
    var list = $('recipesList'); if (!list) return;
    list.innerHTML = '';
    if (!state.recipes.length) { var e = document.createElement('div'); e.className = 'recipes__empty'; e.textContent = 'Пока пусто. После удачного действия нажмите «Запомнить приём» под ответом модели.'; list.appendChild(e); return; }
    state.recipes.forEach(function (r) {
      var el = document.createElement('div'); el.className = 'recipe';
      var head = document.createElement('div'); head.className = 'recipe__head';
      var name = document.createElement('span'); name.className = 'recipe__name'; name.textContent = r.name;
      var meta = document.createElement('span'); meta.className = 'recipe__meta'; meta.textContent = (r.at || '').slice(0, 10) + (r.uses ? ' · ' + r.uses + '×' : '');
      head.appendChild(name); head.appendChild(meta); el.appendChild(head);
      if (r.description) { var d = document.createElement('div'); d.className = 'recipe__desc'; d.textContent = r.description; el.appendChild(d); }
      if (r.params && r.params.length) {
        var ul = document.createElement('ul'); ul.className = 'recipe__params';
        r.params.forEach(function (p) { var li = document.createElement('li'); li.textContent = p.name + (p.default != null ? ' = ' + p.default : '') + (p.description ? ' — ' + p.description : ''); ul.appendChild(li); });
        el.appendChild(ul);
      }
      if (r.code) { var det = document.createElement('details'); var sm = document.createElement('summary'); sm.textContent = 'код'; var pre = document.createElement('pre'); pre.textContent = r.code; det.appendChild(sm); det.appendChild(pre); el.appendChild(det); }
      var acts = document.createElement('div'); acts.className = 'recipe__actions';
      var use = document.createElement('button'); use.type = 'button'; use.className = 'btn'; use.textContent = 'Применить';
      use.onclick = function () { $('recipes').hidden = true; input.value = 'Примени приём «' + r.name + '» из копилки.'; input.focus(); };
      var del = document.createElement('button'); del.type = 'button'; del.className = 'btn btn--danger'; del.textContent = 'Удалить';
      del.onclick = function () { if (confirm('Удалить приём «' + r.name + '» из копилки?')) send({ type: 'recipe_delete', id: r.id }); };
      acts.appendChild(use); acts.appendChild(del); el.appendChild(acts);
      list.appendChild(el);
    });
  }

  // ---------- Тема и цвет окна ----------
  // Вся палитра считается из выбранного цвета: тёмная тема — графит Graphite с
  // нейтралями, чуть подкрашенными под оттенок; светлая — серые интерфейса
  // Rhino 8 (окна #f0f0f0, панели белые, рамки #ccc) с тем же оттенком.
  function hexToHsl(hex) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex); if (!m) return [86, 84, 75];
    var r = parseInt(m[1], 16) / 255, g = parseInt(m[2], 16) / 255, b = parseInt(m[3], 16) / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, h = 0, sat = 0;
    if (max !== min) {
      var d = max - min; sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0); else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
      h *= 60;
    }
    return [h, sat * 100, l * 100];
  }
  function hsl(h, s, l, a) { return a == null ? 'hsl(' + h.toFixed(0) + ' ' + s.toFixed(0) + '% ' + l.toFixed(0) + '%)' : 'hsl(' + h.toFixed(0) + ' ' + s.toFixed(0) + '% ' + l.toFixed(0) + '% / ' + a + ')'; }
  function applyScheme() {
    var theme = app.dataset.theme === 'light' ? 'light' : 'dark';
    var id = state.accent || 'lime';
    var found = ACCENTS.filter(function (a) { return a[0] === id; })[0] || ACCENTS[0];
    var c = hexToHsl(found[1]), h = c[0], as = c[1], al = c[2];
    var v = {};
    if (theme === 'dark') {
      var n = 9; // насыщенность нейтралей
      v['--bg'] = hsl(h, n, 10.5); v['--bg-2'] = hsl(h, n, 11.5); v['--surface'] = hsl(h, n, 13.5); v['--surface-2'] = hsl(h, n, 14.5); v['--surface-3'] = hsl(h, n, 13);
      v['--raised'] = hsl(h, n, 17); v['--line'] = hsl(h, n, 21.5); v['--line-2'] = hsl(h, n, 18); v['--border-strong'] = hsl(h, n, 27); v['--panel-bg'] = hsl(h, n, 12.5);
      v['--code-bg'] = hsl(h, n, 8.5); v['--code-fg'] = hsl(h, 8, 75); v['--input-bg'] = hsl(h, n, 9.5);
      v['--text'] = hsl(h, 12, 92); v['--text-2'] = hsl(h, 6, 73); v['--muted'] = hsl(h, 5, 64); v['--quiet'] = hsl(h, 4, 48);
      v['--accent'] = found[1]; v['--accent-text'] = found[1]; v['--accent-ink'] = hsl(h, 30, 15); v['--accent-hover'] = hsl(h, as, Math.min(al + 6, 95)); v['--accent-dim'] = hsl(h, 25, 55);
      v['--accent-soft'] = hsl(h, as, al, 0.07); v['--accent-mid'] = hsl(h, as, al, 0.2); v['--accent-strong'] = hsl(h, as, al, 0.27); v['--accent-sel'] = hsl(h, as, al, 0.33);
      v['--overlay'] = hsl(h, 10, 7, 0.78); v['--btn-hover'] = '#ffffff09';
    } else {
      var t = 5; // лёгкий оттенок на серых Rhino
      v['--bg'] = hsl(h, t, 94); v['--bg-2'] = hsl(h, t, 92); v['--surface'] = '#ffffff'; v['--surface-2'] = hsl(h, t, 97.5); v['--surface-3'] = hsl(h, t, 95.5);
      v['--raised'] = hsl(h, t, 90); v['--line'] = hsl(h, t, 81); v['--line-2'] = hsl(h, t, 86); v['--border-strong'] = hsl(h, t, 73); v['--panel-bg'] = '#ffffff';
      v['--code-bg'] = hsl(h, t, 96); v['--code-fg'] = hsl(h, 10, 24); v['--input-bg'] = '#ffffff';
      v['--text'] = hsl(h, 10, 12); v['--text-2'] = hsl(h, 6, 28); v['--muted'] = hsl(h, 5, 38); v['--quiet'] = hsl(h, 4, 54);
      v['--accent'] = found[1]; v['--accent-text'] = hsl(h, Math.max(as, 45), 33); v['--accent-ink'] = hsl(h, 30, 14); v['--accent-hover'] = hsl(h, as, Math.max(al - 7, 40)); v['--accent-dim'] = hsl(h, 40, 45);
      v['--accent-soft'] = hsl(h, as, 45, 0.08); v['--accent-mid'] = hsl(h, as, 45, 0.22); v['--accent-strong'] = hsl(h, as, 45, 0.35); v['--accent-sel'] = hsl(h, as, 45, 0.3);
      v['--overlay'] = hsl(h, 5, 85, 0.72); v['--btn-hover'] = '#00000009';
    }
    var root = document.documentElement.style;
    Object.keys(v).forEach(function (k) { root.setProperty(k, v[k]); });
    document.documentElement.style.colorScheme = theme;
    var picker = $('accentPicker');
    if (picker) picker.querySelectorAll('.accent__swatch').forEach(function (s) { s.setAttribute('aria-pressed', String(s.dataset.accent === found[0])); });
  }
  function applyTheme(theme) { app.dataset.theme = theme === 'light' ? 'light' : 'dark'; applyScheme(); }
  function applyAccent(id) { state.accent = id; applyScheme(); }
  function buildAccentPicker() {
    var picker = $('accentPicker'); if (!picker) return;
    picker.innerHTML = '';
    ACCENTS.forEach(function (a) {
      var s = document.createElement('button'); s.type = 'button'; s.className = 'accent__swatch'; s.dataset.accent = a[0];
      s.style.background = a[1]; s.title = a[0]; s.setAttribute('aria-pressed', 'false');
      s.onclick = function () { applyAccent(a[0]); picker.hidden = true; rb('save_accent', { accent: a[0] }).catch(function () {}); };
      picker.appendChild(s);
    });
  }

  // ---------- Инструменты -------------------------------------------------
  function onToolCall(msg) {
    if (!state.current) startCurrent($('providerSelect').value);
    finishThinking();
    // Пришёл инструмент — текущий пузырь закрывается, следующий текст
    // откроет новый (см. ensureBubble).
    commitText();
    // Служебный вызов: gateway ждёт, пока кадр ляжет на диск, и просит
    // скопировать его по указанному пути. В ленте он не показывается.
    if (msg.name === 'render_export') return renders.exportDone(msg);
    var record = { name: msg.name, label: toolLabel(msg), ok: null };
    state.current.tools.push(record);

    if (msg.name === 'take_screenshot') return onScreenshotRequest(msg, record);
    if (msg.name === 'render_viewport') return renders.request(msg, record);
    if (msg.name === 'ask_user') return onAskTool(msg, record);

    var el = addTool(msg);
    var run;
    if (msg.name === 'execute_python') {
      // Весь ход — одна запись Undo у пользователя: хост открывает её на
      // первом вызове хода (имя — задание) и закрывает по концу хода.
      run = rb('execute_python', { code: msg.args.code, label: msg.args.label, turn: state.turn, turn_label: 'Stultus: ' + (state.turnLabel || msg.args.label || '') })
        .then(function (result) { state.turnOpened = true; if (result && result.ok !== false) state.turnOps += 1; return result; });
    }
    else if (msg.name === 'named_views') run = rb('named_views', Object.assign({ turn: state.turn, turn_label: 'Stultus: ' + (state.turnLabel || '') }, msg.args || {}));
    else if (msg.name === 'get_scene') run = rb('scene_state', { full: true });
    else if (msg.name === 'select') run = rb('select', msg.args || {});
    else if (msg.name === 'undo') run = rb('undo', { turn: state.turn });
    else run = Promise.reject(new Error('Неизвестный инструмент: ' + msg.name));

    run.then(function (result) {
      var ok = result && result.ok !== false;
      record.ok = ok;
      var text = formatResult(msg.name, result);
      finishTool(el, ok, text);
      var payload = { type: 'tool_result', call_id: msg.call_id, ok: ok, content: text };
      if (ok && result.base64 && result.mime) {
        // Картинка — в карточку инструмента и модели.
        var img = document.createElement('img'); img.className = 'tool__image is-zoomable'; img.alt = 'Изображение';
        img.src = 'data:' + result.mime + ';base64,' + result.base64;
        img.onclick = function () { if (window.StultusLightbox) window.StultusLightbox(img.src, img.alt); };
        el.appendChild(img); el.open = true; scrollDown();
        payload.image = { mime: result.mime, base64: result.base64 };
      }
      send(payload);
    }, function (err) {
      record.ok = false;
      finishTool(el, false, String(err && err.message || err));
      send({ type: 'tool_result', call_id: msg.call_id, ok: false, content: String(err && err.message || err) });
    });
  }

  function formatResult(name, result) {
    if (!result) return 'нет ответа';
    if (name === 'execute_python') {
      var lines = [];
      if (result.ok === false) {
        lines.push('ОШИБКА: ' + result.error);
        if (result.traceback) lines.push(result.traceback);
        if (result.removed) lines.push('Объекты, созданные этим вызовом (' + result.removed + '), удалены. Изменения существующих объектов остались — проверь состояние перед следующим шагом.');
      } else if (result.result !== undefined && result.result !== null && result.result !== '') {
        lines.push('result: ' + (typeof result.result === 'string' ? result.result : JSON.stringify(result.result)));
      }
      if (result.output) lines.push('stdout:\n' + result.output);
      if (!lines.length) lines.push('выполнено' + (result.seconds != null ? ' за ' + result.seconds + ' с' : '') + ', вывода нет');
      return lines.join('\n');
    }
    var copy = Object.assign({}, result); delete copy.ok; delete copy.base64; delete copy.output;
    return JSON.stringify(copy, null, 1);
  }

  function onScreenshotRequest(msg, record) {
    hideEmpty();
    var card = $('tplShot').content.firstElementChild.cloneNode(true);
    var a = msg.args || {};
    var desc = (a.reason || 'Модель хочет посмотреть на результат.') +
      (a.view ? '\nВид: ' + a.view : '') + (a.zoom_extents ? ' · показать всё' : '') + (a.display_mode ? ' · режим ' + a.display_mode : '');
    card.querySelector('.card__text').textContent = desc;
    chat.appendChild(card); scrollDown();

    card.querySelector('[data-act="allow"]').onclick = function () {
      card.classList.add('is-done');
      rb('screenshot', { view: a.view, zoom_extents: !!a.zoom_extents, display_mode: a.display_mode, width: 1280, height: 800 }).then(function (r) {
        if (!r || r.ok === false) {
          record.ok = false;
          send({ type: 'tool_result', call_id: msg.call_id, ok: false, content: 'Снимок не удался: ' + (r && r.error) });
          return;
        }
        record.ok = true;
        var img = card.querySelector('.card__preview');
        img.src = 'data:' + r.mime + ';base64,' + r.base64; img.hidden = false;
        send({ type: 'tool_result', call_id: msg.call_id, ok: true, content: 'Снимок вьюпорта ' + r.width + 'x' + r.height + (a.view ? ', вид ' + a.view : ''), image: { mime: r.mime, base64: r.base64 } });
      });
    };
    card.querySelector('[data-act="deny"]').onclick = function () {
      card.classList.add('is-done');
      record.ok = false;
      send({ type: 'tool_result', call_id: msg.call_id, ok: false, content: 'Пользователь отказал в снимке. Продолжай без него или спроси, что именно проверить.' });
    };
  }

  function onAskTool(msg, record) {
    record.ok = true;
    var a = msg.args || {};
    var questions = Array.isArray(a.questions) && a.questions.length ? a.questions : (a.question ? [{ question: a.question, options: a.options }] : []);
    onAsk({ questions: questions });
    send({ type: 'tool_result', call_id: msg.call_id, ok: true, content: 'Вопросы (' + questions.length + ') показаны пользователю. Закончи ход и жди — ответы на все придут одним сообщением. Ничего не строй.' });
  }

  // Карточка вопросов: у каждого вопроса варианты-кнопки и поле «свой
  // вариант», внизу одна кнопка «Ответить» — все ответы уходят одним
  // сообщением. Как в Claude Code и ChatGPT.
  function onAsk(msg) {
    hideEmpty();
    var questions = (msg.questions || []).filter(function (q) { return q && q.question; });
    if (!questions.length) return;
    var card = $('tplAsk').content.firstElementChild.cloneNode(true);
    card.classList.add('card--questions');
    card.querySelector('.card__title').textContent = questions.length > 1 ? 'Уточним ' + questions.length + ' детали' : 'Уточним одну деталь';
    var text = card.querySelector('.card__text'); text.hidden = true;
    var box = card.querySelector('.card__options'); box.classList.add('ask');
    var answers = questions.map(function () { return { picked: [], custom: '' }; });

    function answered(i) { return answers[i].custom.trim() !== '' || answers[i].picked.length > 0; }
    function refresh() { submit.disabled = !answers.every(function (_a, i) { return answered(i); }); }

    questions.forEach(function (q, i) {
      var block = document.createElement('div'); block.className = 'ask__q';
      var title = document.createElement('div'); title.className = 'ask__title';
      title.textContent = (questions.length > 1 ? (i + 1) + '. ' : '') + q.question;
      block.appendChild(title);
      var opts = document.createElement('div'); opts.className = 'ask__options';
      var buttons = [];
      (q.options || []).forEach(function (opt) {
        var b = document.createElement('button'); b.type = 'button'; b.className = 'btn ask__opt'; b.textContent = opt;
        b.setAttribute('aria-pressed', 'false');
        b.onclick = function () {
          var idx = answers[i].picked.indexOf(opt);
          if (q.multi) { if (idx >= 0) answers[i].picked.splice(idx, 1); else answers[i].picked.push(opt); }
          else { answers[i].picked = idx >= 0 ? [] : [opt]; }
          buttons.forEach(function (x) { x.setAttribute('aria-pressed', String(answers[i].picked.indexOf(x.textContent) >= 0)); });
          refresh();
        };
        buttons.push(b); opts.appendChild(b);
      });
      block.appendChild(opts);
      var custom = document.createElement('input'); custom.type = 'text'; custom.className = 'ask__custom';
      custom.placeholder = (q.options || []).length ? 'Свой вариант…' : 'Ваш ответ…';
      custom.setAttribute('aria-label', 'Свой вариант ответа');
      custom.oninput = function () { answers[i].custom = custom.value; refresh(); };
      custom.onkeydown = function (e) { if (e.key === 'Enter' && !submit.disabled) { e.preventDefault(); submit.click(); } };
      block.appendChild(custom);
      card.appendChild(block);
    });

    var submit = document.createElement('button'); submit.type = 'button'; submit.className = 'btn btn--primary'; submit.textContent = 'Ответить ↗';
    submit.disabled = true;
    submit.onclick = function () {
      if (submit.disabled || state.busy) return;
      var lines = questions.map(function (q, i) {
        var parts = answers[i].picked.slice();
        if (answers[i].custom.trim()) parts.push(answers[i].custom.trim());
        return (questions.length > 1 ? (i + 1) + '. ' : '') + q.question + ' — ' + parts.join('; ');
      });
      card.classList.add('is-done');
      card.querySelectorAll('.ask__opt, .ask__custom').forEach(function (el) { el.disabled = true; });
      input.value = (questions.length > 1 ? 'Ответы:\n' : 'Ответ: ') + lines.join('\n');
      sendChat();
    };
    box.appendChild(submit);
    card.appendChild(box);
    chat.appendChild(card); scrollDown();
    var first = card.querySelector('.ask__custom'); if (first && !questions[0].options) first.focus();
    state.messages.push({ role: 'assistant', text: (questions.length > 1 ? 'Вопросы:\n' : 'Вопрос: ') + questions.map(function (q, i) { return (questions.length > 1 ? (i + 1) + '. ' : '') + q.question + ((q.options || []).length ? ' [' + q.options.join(' / ') + ']' : ''); }).join('\n'), tools: [], provider: providerLabel($('providerSelect').value), at: new Date().toISOString() });
  }

  // ---------- Настройки ---------------------------------------------------
  function openSettings() {
    $('setGateway').value = state.settings.gateway || '';
    $('setToken').value = state.settings.token || '';
    $('settingsInfo').textContent = state.instance ? ('Rhino ' + state.instance.app_version + ' · плагин ' + state.instance.plugin + ' · окно ' + ((window.StultusTools && window.StultusTools.version) || '?') + ' · ' + state.instance.model_title) : '';
    $('settings').hidden = false;
  }

  // Адрес — база gateway (http://сервер:8792). Окно грузится с него же,
  // поэтому смена адреса — это переход на страницу нового сервера.
  function saveSettings() {
    var base = $('setGateway').value.trim().replace(/\/+$/, '');
    if (/^wss?:\/\//.test(base)) base = base.replace(/^ws/, 'http').replace(/\/ws$/, '');
    if (base && !/^https?:\/\//.test(base)) base = 'http://' + base;
    var s = { gateway: base, token: $('setToken').value.trim() };
    rb('save_settings', { settings: s }).then(function (r) {
      state.settings = (r && r.settings) || Object.assign(state.settings, s);
      $('settings').hidden = true;
      if (base && /^https?:\/\//.test(location.href) && location.origin !== base) { location.href = base + '/ui/index.html'; return; }
      connect();
    });
  }

  // Хост устарел: gateway говорит минимальную версию и даёт пакет .yak.
  // Хост скачивает его и ставит через yak; подхватится после перезапуска Rhino.
  function offerHostUpdate(msg) {
    state.hostUpdate = msg.package || null;
    var text = 'Плагин Stultus Rhino устарел (у вас ' + ((state.instance && state.instance.plugin) || '?') + ', нужна ' + msg.host_min + ').';
    var el = addMessage('system', text + (msg.package ? ' На сервере есть пакет ' + msg.package.version + '.' : ' Пакета на сервере нет — попросите новый .yak у администратора.'));
    if (!msg.package) return;
    var box = document.createElement('div'); box.className = 'msg__actions';
    var b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = 'Обновить плагин';
    b.onclick = function () {
      b.disabled = true; b.textContent = 'Скачиваю и устанавливаю…';
      rb('update_host', { url: gatewayBase() + '/download/' + encodeURIComponent(msg.package.name), version: msg.package.version }).then(function (r) {
        b.textContent = r && r.ok !== false ? 'Установлено — перезапустите Rhino' : 'Не удалось: ' + (r && r.error);
      }, function (e) { b.textContent = 'Не удалось: ' + e.message; b.disabled = false; });
    };
    box.appendChild(b); el.appendChild(box); scrollDown();
  }

  // Конец хода: хост закрывает запись Undo этого хода.
  function endTurn() {
    if (!state.turnOpened) return;
    state.turnOpened = false;
    rb('turn_end', { turn: state.turn }).catch(function () {});
  }

  // Выделение считает Python-скрипт (имена, блоки, габариты) — по сигналу хоста.
  function refreshSelection() {
    tool('scene_state', { full: false }).then(function (r) {
      if (r && r.ok !== false && r.selection_summary) { state.selection = r.selection_summary; renderContext(); }
    }).catch(function () {});
  }

  function saveChoice() {
    var s = { provider: $('providerSelect').value, model: $('modelSelect').value, attach_scene: $('attachScene').checked };
    Object.assign(state.settings, s);
    rb('save_settings', { settings: s }).catch(function () {});
  }

  // ---------- События -----------------------------------------------------
  $('btnSend').onclick = sendChat;
  $('btnCancel').onclick = function () { renders.cancel(); send({ type: 'cancel' }); hint('Останавливаю…'); };
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendChat(); }
  });
  $('btnSettings').onclick = openSettings;
  $('btnCloseSettings').onclick = function () { $('settings').hidden = true; };
  $('btnSaveSettings').onclick = saveSettings;
  // «Удалить историю» убирает переписку в архив внутри файла модели,
  // «Восстановить» возвращает её. Модель после удаления начинает с чистого
  // листа (сессии тоже в архиве), после восстановления — продолжает.
  function setArchive(info) {
    state.archive = info || null;
    var b = $('btnRestore');
    if (!b) return;
    b.disabled = !state.archive;
    b.title = state.archive ? 'Восстановить удалённую историю (' + state.archive.count + ' сообщ.)' : 'Восстановить историю — архив пуст';
  }
  function clearHistory() {
    if (state.busy) return;
    rb('clear_history').then(function (r) {
      state.sessions = {}; restoreHistory([]); $('chatEmpty').hidden = false; $('usage').textContent = '';
      $('settings').hidden = true;
      setArchive(r && r.archive);
      hint(r && r.archived ? 'История убрана в архив: ' + r.archived + ' сообщ. Кнопка ↺ вернёт её.' : '');
    });
  }
  function restoreArchive() {
    if (state.busy || !state.archive) return;
    rb('restore_history').then(function (r) {
      if (!r || r.ok === false) { hint('Не удалось восстановить: ' + (r && r.error)); return; }
      state.sessions = r.sessions || {};
      restoreHistory(r.messages || []);
      if (!(r.messages || []).length) $('chatEmpty').hidden = false;
      setArchive(r.archive);
      hint(r.restored ? 'Восстановлено сообщений: ' + r.restored : '');
    });
  }
  $('btnTheme').onclick = function () {
    var next = app.dataset.theme === 'light' ? 'dark' : 'light';
    applyTheme(next); state.settings.theme = next;
    rb('save_settings', { settings: { theme: next } }).catch(function () {});
  };
  $('btnAccent').onclick = function (e) { e.stopPropagation(); var p = $('accentPicker'); p.hidden = !p.hidden; };
  document.addEventListener('click', function (e) { var p = $('accentPicker'); if (p && !p.hidden && !p.contains(e.target)) p.hidden = true; });
  $('btnRecipes').onclick = function () { renderRecipes(); $('recipes').hidden = false; };
  $('btnCloseRecipes').onclick = function () { $('recipes').hidden = true; };
  $('recipes').addEventListener('keydown', function (e) { if (e.key === 'Escape') $('recipes').hidden = true; });
  $('btnClearHistory').onclick = clearHistory;
  $('btnNew').onclick = clearHistory;
  $('btnRestore').onclick = restoreArchive;
  $('providerSelect').onchange = function () { fillModels(); saveChoice(); };
  $('modelSelect').onchange = saveChoice;
  $('attachScene').onchange = function () { saveChoice(); renderContext(); };

  // ---------- Старт -------------------------------------------------------
  function boot() {
    rb('ready').then(function (r) {
      state.settings = r.settings || {};
      state.instance = r.instance || null;
      state.sessions = r.sessions || {};
      // В шапке — имя файла; несохранённая модель — так и говорим, с путём в подсказке.
      var mt = $('modelTitle');
      mt.textContent = state.instance ? (state.instance.model_file || 'Файл не сохранён') : '';
      mt.title = state.instance && state.instance.model_path ? state.instance.model_path : 'Модель ещё не сохранена в файл';
      buildAccentPicker();
      applyTheme(state.settings.theme);
      applyAccent(r.accent || 'lime');
      $('attachScene').checked = state.settings.attach_scene !== false;
      state.selection = null;
      renderContext();
      setArchive(r.archive);
      restoreHistory(r.history || []);
      if (!state.settings.gateway && !/^https?:\/\//.test(location.href)) openSettings();
      connect();
      refreshSelection();
    }, function (err) {
      addMessage('error', 'Хост Rhino не ответил: ' + err.message);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
