# -*- coding: utf-8 -*-
"""Ведёт ход модели через окно Stultus: отправляет сообщение, разрешает снимки,
останавливается на карточке вопросов (печатает их) или по концу хода.

  python tests/drive.py send "текст"     — отправить и ждать
  python tests/drive.py answer "1=900 мм;2=да" — ответить на карточку (номер=текст; без номера — первый вариант)
  python tests/drive.py wait             — просто ждать конца хода
  python tests/drive.py feed [N]         — последние N записей ленты
"""
import json, sys, time, os
sys.path.insert(0, os.path.dirname(__file__))
import dev

WAIT = int(os.environ.get('DRIVE_WAIT', '1500'))


def snap():
    return dev.js(dev.SNAPSHOT)


def show(entries):
    for f in entries:
        if 'tool' in f:
            print('  [%s] %s %s — %s' % (f['state'], f['tool'], f.get('label', ''), (f.get('result') or '').replace('\n', ' ')[:160]))
        elif 'card' in f:
            print('  [card%s] %s: %s' % ('' if not f.get('done') else ' done', f['card'], (f.get('text') or '').replace('\n', ' ')[:200]))
        else:
            print('  [%s] %s' % (f['msg'], (f.get('text') or '').replace('\n', ' ')[:400]))


def open_question():
    return dev.js("""var card = [].slice.call(document.querySelectorAll('.card--questions:not(.is-done)')).pop(); if (!card) return null;
      return JSON.stringify([].map.call(card.querySelectorAll('.ask__q'), function (q) { return {q: q.querySelector('.ask__title').textContent, options: [].map.call(q.querySelectorAll('.ask__opt'), function (b) { return b.textContent; })}; }));""")


def wait_turn():
    t0 = time.time(); seen = 0
    while time.time() - t0 < WAIT:
        time.sleep(12)
        r = dev.js("var b=document.querySelector('.card--shot:not(.is-done) [data-act=allow]'); if(!b) return 'no'; b.click(); return 'allowed'")
        if r == 'allowed':
            print('  → снимок разрешён')
        s = snap()
        feed = s['feed']
        if len(feed) > seen:
            show(feed[seen:]); seen = len(feed)
        if s['state'] != 'busy':
            q = open_question()
            if q:
                print('\nВОПРОСЫ МОДЕЛИ:'); print(json.dumps(q, ensure_ascii=False, indent=1)); return 'question'
            print('\nход окончен; расход:', s.get('usage'), '| hint:', s.get('hint'))
            return 'done'
    print('\nвремя вышло'); return 'timeout'


def answer(spec):
    parts = [p.strip() for p in spec.split(';') if p.strip()]
    mapping = {}
    for i, p in enumerate(parts):
        if '=' in p:
            k, v = p.split('=', 1); mapping[int(k) - 1] = v.strip()
        else:
            mapping[i] = p
    js = """var card = [].slice.call(document.querySelectorAll('.card--questions:not(.is-done)')).pop(); if (!card) return 'no card';
      var answers = %s; var qs = card.querySelectorAll('.ask__q');
      qs.forEach(function (q, i) { var a = answers[i]; var opts = [].slice.call(q.querySelectorAll('.ask__opt'));
        if (a === undefined || a === '') { if (opts[0]) opts[0].click(); else { var inp = q.querySelector('.ask__custom'); inp.value = 'на твоё усмотрение'; inp.dispatchEvent(new Event('input')); } return; }
        var hit = opts.filter(function (b) { return b.textContent.trim().toLowerCase() === String(a).trim().toLowerCase(); })[0];
        if (hit) hit.click(); else { var inp2 = q.querySelector('.ask__custom'); inp2.value = a; inp2.dispatchEvent(new Event('input')); } });
      var s = card.querySelector('.card__options .btn--primary'); s.click(); return 'answered ' + qs.length;""" % json.dumps({str(k): v for k, v in mapping.items()} and [mapping.get(i, '') for i in range(max(mapping) + 1)], ensure_ascii=False)
    return dev.js(js)


if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'send':
        dev.js("document.getElementById('input').value = %s; document.getElementById('btnSend').click(); return 'sent'" % json.dumps(sys.argv[2]))
        print('отправлено'); wait_turn()
    elif cmd == 'answer':
        print(answer(sys.argv[2])); wait_turn()
    elif cmd == 'wait':
        wait_turn()
    elif cmd == 'feed':
        show(snap()['feed'][-int(sys.argv[2] if len(sys.argv) > 2 else 8):])
