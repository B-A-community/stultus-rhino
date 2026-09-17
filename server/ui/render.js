/* Postproduction cards. No network or credentials here; all work goes through gateway. */
window.StultusRender = function (api) {
  'use strict';
  var jobs = {};
  function imageUrl(base64) { return 'data:image/png;base64,' + base64; }
  function element(tag, name, text) { var el = document.createElement(tag); el.className = name; if (text) el.textContent = text; return el; }
  // Миниатюра по клику раскрывается на всё окно; клик или Escape закрывает.
  var lightbox = null;
  function openLightbox(src, alt) {
    closeLightbox();
    lightbox = element('div', 'lightbox');
    lightbox.setAttribute('role', 'dialog');
    lightbox.setAttribute('aria-label', alt || 'Изображение');
    var img = element('img', 'lightbox__image'); img.src = src; img.alt = alt || '';
    var hint = element('div', 'lightbox__hint', 'Клик или Esc — закрыть');
    lightbox.appendChild(img); lightbox.appendChild(hint);
    lightbox.onclick = closeLightbox;
    document.body.appendChild(lightbox);
    document.addEventListener('keydown', onLightboxKey);
  }
  function closeLightbox() {
    if (!lightbox) return;
    lightbox.remove(); lightbox = null;
    document.removeEventListener('keydown', onLightboxKey);
  }
  function onLightboxKey(e) { if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); } }
  window.StultusLightbox = openLightbox;
  function zoomable(img) {
    img.classList.add('is-zoomable');
    img.title = 'Открыть крупно';
    img.onclick = function () { if (img.src && !img.hidden) openLightbox(img.src, img.alt); };
  }
  function status(msg) {
    var job = jobs[msg.id]; if (!job) return;
    job.card.querySelector('.card__text').textContent = msg.text;
    if (msg.failed) { job.record.ok = false; job.card.classList.add('is-failed', 'is-done'); delete jobs[msg.id]; }
  }
  function request(msg, record) {
    var id = msg.args.render_id;
    var card = document.getElementById('tplShot').content.firstElementChild.cloneNode(true);
    card.classList.add('card--render');
    card.querySelector('.card__title').textContent = 'Создать визуализацию этого вида?';
    var NOTE = 'Текущий кадр будет передан генератору Codex. Используются лимиты вашей подписки. Камера и модель останутся прежними.';
    var text = card.querySelector('.card__text');
    text.textContent = msg.args.prompt + (msg.args.save_path ? '\n\nСохранить в: ' + msg.args.save_path : '') + '\n\n' + NOTE;
    var allow = card.querySelector('[data-act=allow]'), deny = card.querySelector('[data-act=deny]');
    allow.textContent = 'Зафиксировать и создать ↗'; deny.textContent = 'Отмена';
    // «Изменить» — между «создать» и «отмена»: задание открывается в поле
    // ввода прямо в карточке, и на генерацию уходит то, что написал человек.
    var edit = element('button', 'btn', 'Изменить');
    edit.setAttribute('data-act', 'edit');
    allow.insertAdjacentElement('afterend', edit);
    // Размер: обычный или «большой кадр» 4K/6K/8K — снимок в заданную ширину,
    // сборка из плиток на gateway. Честно пишем цену: генерации и минуты.
    var sizes = msg.args.sizes || [{ id: '4k', label: '4K', width: 3840, generations: 7 }];
    var option = element('label', 'card__option');
    option.appendChild(document.createTextNode('Размер '));
    var select = document.createElement('select'); select.className = 'card__select';
    var normal = document.createElement('option'); normal.value = 'normal'; normal.textContent = 'обычный, около минуты'; select.appendChild(normal);
    sizes.forEach(function (s) {
      var o = document.createElement('option'); o.value = s.id;
      o.textContent = s.label + ' · ' + s.width + ' px · ' + s.generations + ' генераций, ~' + Math.round(s.generations * 0.8) + ' мин';
      select.appendChild(o);
    });
    var wanted = msg.args.size === 'large' ? '4k' : msg.args.size;
    if (wanted && sizes.some(function (s) { return s.id === wanted; })) select.value = wanted;
    option.appendChild(select);
    var hint = element('span', 'card__option-hint', 'Большие кадры собираются из плиток, у стыков возможны артефакты.');
    option.appendChild(hint);
    text.insertAdjacentElement('afterend', option);
    var editor = null;
    edit.onclick = function () {
      if (jobs[id] !== job || editor) return;
      editor = element('textarea', 'card__editor');
      editor.value = msg.args.prompt;
      editor.rows = 6;
      editor.setAttribute('aria-label', 'Задание для визуализации');
      text.textContent = NOTE;
      text.insertAdjacentElement('beforebegin', editor);
      edit.hidden = true;
      editor.focus();
      api.scroll();
    };
    var job = jobs[id] = { card: card, record: record, source: null };
    function chosenPrompt() {
      var v = editor ? editor.value.trim() : '';
      return v || msg.args.prompt;
    }
    allow.onclick = function () {
      if (jobs[id] !== job) return;
      var prompt = chosenPrompt();
      var size = select.value, chosen = null;
      sizes.forEach(function (s) { if (s.id === size) chosen = s; });
      var large = !!chosen, largeWidth = chosen ? chosen.width : 0;
      allow.disabled = deny.disabled = edit.disabled = select.disabled = true;
      if (editor) { editor.remove(); editor = null; }
      edit.hidden = true; option.remove();
      card.querySelector('.card__text').textContent = large ? 'Фиксирую текущий кадр в ' + largeWidth + ' px…' : 'Фиксирую текущий кадр…';
      api.rb('screenshot', large ? { framing: 'viewport', width: largeWidth } : { framing: 'viewport' }).then(function (r) {
        if (jobs[id] !== job) return;
        if (!r || !r.ok) throw new Error(r && r.error || 'Снимок не получен.');
        job.source = r.base64;
        var preview = card.querySelector('.card__preview'); preview.src = imageUrl(r.base64); preview.hidden = false; zoomable(preview);
        card.classList.add('is-done');
        card.querySelector('.card__title').textContent = 'Кадр зафиксирован';
        card.querySelector('.card__text').textContent = r.width + ' × ' + r.height + (large ? ' · большой кадр, собираю из плиток…' : ' · создаю визуализацию…') + '\n\nЗадание: ' + prompt;
        var edited = prompt !== msg.args.prompt;
        api.send({ type: 'tool_result', call_id: msg.call_id, ok: true,
          content: (edited ? 'Точный кадр вьюпорта разрешён для постпродакшна. Пользователь изменил задание, в генерацию уходит его текст.' : 'Точный кадр вьюпорта разрешён для постпродакшна.') + (large ? ' Пользователь выбрал большой кадр.' : ''),
          image: { mime: r.mime, base64: r.base64 }, capture: { framing: r.framing, width: r.width, height: r.height }, prompt: prompt, size: large ? size : 'normal' });
        api.scroll();
      }).catch(function (error) {
        if (jobs[id] !== job) return;
        status({ id: id, text: error.message, failed: true });
        api.send({ type: 'tool_result', call_id: msg.call_id, ok: false, content: error.message });
      });
    };
    deny.onclick = function () {
      if (jobs[id] !== job) return;
      if (editor) { editor.remove(); editor = null; }
      option.remove();
      record.ok = false; card.classList.add('is-done'); card.querySelector('.card__text').textContent = 'Создание визуализации отменено.'; delete jobs[id];
      api.send({ type: 'tool_result', call_id: msg.call_id, ok: false, content: 'Пользователь отменил визуализацию. Ничего не генерируй.' });
    };
    api.hideEmpty(); api.chat.appendChild(card); api.scroll();
  }
  function frame(id, prompt, large) {
    var el = element('section', 'render');
    var head = element('div', 'render__head'), title = element('span', 'render__title', large ? 'Постпродакшн · большой кадр' : 'Постпродакшн'), buttons = element('div', 'render__switch');
    var before = element('button', 'btn', 'Исходник'), after = element('button', 'btn', 'Результат');
    before.setAttribute('aria-pressed', 'false'); after.setAttribute('aria-pressed', 'true');
    buttons.appendChild(before); buttons.appendChild(after); head.appendChild(title); head.appendChild(buttons);
    var img = element('img', 'render__image'); img.alt = 'ИИ-визуализация выбранного ракурса'; img.hidden = true; zoomable(img);
    var footer = element('div', 'render__footer'), note = element('span', 'render__note', large ? 'ИИ-визуализация из плиток · проверьте стыки крупно' : 'ИИ-визуализация · сравните с исходником'), save = element('button', 'btn render__save', 'Сохранить PNG ↗');
    save.disabled = true; footer.appendChild(note); footer.appendChild(save);
    var info = element('div', 'render__status'); info.setAttribute('role', 'status');
    el.appendChild(head);
    // Задание, по которому сделан кадр (в том числе отредактированное).
    if (prompt) { var task = element('div', 'render__prompt', prompt); task.title = 'Задание для генерации'; el.appendChild(task); }
    el.appendChild(img); el.appendChild(footer); el.appendChild(info); api.chat.appendChild(el);
    function setImages(source, result) {
      img.src = imageUrl(result); img.hidden = false;
      before.onclick = function () { img.src = imageUrl(source); img.alt = 'Исходный кадр Rhino'; before.setAttribute('aria-pressed', 'true'); after.setAttribute('aria-pressed', 'false'); };
      after.onclick = function () { img.src = imageUrl(result); img.alt = 'ИИ-визуализация выбранного ракурса'; before.setAttribute('aria-pressed', 'false'); after.setAttribute('aria-pressed', 'true'); };
    }
    save.onclick = function () {
      save.disabled = true;
      api.rb('save_render', { id: id }).then(function (r) { info.textContent = !r.ok ? r.error : r.cancelled ? '' : 'Сохранено: ' + r.path; }).catch(function (e) { info.textContent = e.message; }).finally(function () { save.disabled = false; });
    };
    return { el: el, info: info, save: save, setImages: setImages };
  }
  // Полные большие кадры приходят кусками после render_result; куски пишет
  // Python-скрипт в файл по порядку, окно только передаёт их дальше по одному.
  var files = {};
  // saved[id] — обещание «кадр целиком лежит на диске»; его ждёт render_export.
  var saved = {};
  function result(msg) {
    var job = jobs[msg.id]; if (!job) return;
    job.record.ok = true; job.card.remove(); delete jobs[msg.id];
    var output = frame(msg.id, msg.prompt, msg.large); output.setImages(msg.source.base64, msg.image.base64);
    output.info.textContent = 'Сохраняю кадр на этом компьютере…';
    api.remember({ role: 'assistant', text: '', render: { id: msg.id, prompt: msg.prompt, large: !!msg.large }, at: new Date().toISOString() });
    var settle = {}; saved[msg.id] = { output: output, promise: new Promise(function (res, rej) { settle.res = res; settle.rej = rej; }) };
    if (msg.full) files[msg.id] = { output: output, full: msg.full, queue: Promise.resolve(), received: 0, settle: settle };
    api.rb('cache_render', { id: msg.id, image: msg.image.base64, source: msg.source.base64, preview: !!msg.full }).then(function (r) {
      if (!r.ok) { output.info.textContent = 'Не удалось сохранить кадр: ' + r.error; settle.rej(new Error(r.error)); return; }
      if (!msg.full) { output.info.textContent = ''; output.save.disabled = false; settle.res(); }
      else output.info.textContent = 'Получаю полный кадр ' + msg.full.width + ' × ' + msg.full.height + '…';
      api.persist();
    }).catch(function (e) { output.info.textContent = 'Не удалось сохранить кадр: ' + e.message; settle.rej(e); });
    api.scroll();
  }
  function chunk(msg) {
    var f = files[msg.id]; if (!f) return;
    f.queue = f.queue.then(function () {
      return api.rb('render_chunk', { id: msg.id, index: msg.index, total: msg.total, data: msg.data }).then(function (r) {
        if (!r.ok) throw new Error(r.error || 'ошибка записи');
        f.received++;
        if (r.done) {
          f.output.info.textContent = 'Полный кадр ' + f.full.width + ' × ' + f.full.height + ' (' + Math.round(f.full.bytes / 1048576) + ' МБ) сохранён на этом компьютере.';
          f.output.save.disabled = false; delete files[msg.id]; f.settle.res();
        } else f.output.info.textContent = 'Получаю полный кадр ' + f.full.width + ' × ' + f.full.height + '… ' + f.received + '/' + msg.total;
      });
    }).catch(function (e) { f.output.info.textContent = 'Полный кадр не сохранён: ' + e.message; delete files[msg.id]; f.settle.rej(e); });
  }
  // Gateway спрашивает, лёг ли кадр на диск, и просит скопировать по пути.
  function exportDone(msg) {
    var id = msg.args.render_id, path = (msg.args.save_path || '').trim();
    var entry = saved[id];
    var reply = function (ok, content) { api.send({ type: 'tool_result', call_id: msg.call_id, ok: ok, content: content }); };
    if (!entry) return reply(false, 'Кадр не найден в окне.');
    // Страховка: если куски так и не дошли, не держим ход вечно.
    var timeout = new Promise(function (_, rej) { setTimeout(function () { rej(new Error('полный кадр не дошёл за 5 минут')); }, 5 * 60 * 1000); });
    Promise.race([entry.promise, timeout]).then(function () {
      delete saved[id];
      if (!path) return reply(true, 'Кадр сохранён на компьютере пользователя; под ним кнопка «Сохранить PNG».');
      return api.rb('export_render', { id: id, path: path }).then(function (r) {
        if (!r.ok) { entry.output.info.textContent = 'Не удалось сохранить в ' + path + ': ' + r.error; return reply(true, 'Кадр в чате, но сохранить по пути не удалось: ' + r.error); }
        entry.output.info.textContent = 'Сохранено: ' + r.path;
        reply(true, 'Файл сохранён: ' + r.path + ' (' + Math.round(r.bytes / 1024) + ' КБ).');
      });
    }).catch(function (e) { delete saved[id]; reply(true, 'Кадр показан, но на диск не лёг: ' + e.message); });
  }
  function restore(data) {
    api.hideEmpty(); var output = frame(data.id, data.prompt, data.large); output.info.textContent = 'Загружаю сохранённый кадр…';
    api.rb('get_render', { id: data.id }).then(function (r) {
      if (!r.ok) { output.info.textContent = r.error; return; }
      output.setImages(r.source, r.image); output.save.disabled = false; output.info.textContent = '';
    }).catch(function (e) { output.info.textContent = e.message; });
  }
  function cancel() {
    Object.keys(jobs).forEach(function (id) { status({ id: id, text: 'Визуализация прервана. Можно повторить запрос.', failed: true }); });
  }
  return { request: request, status: status, result: result, chunk: chunk, exportDone: exportDone, restore: restore, cancel: cancel };
};
