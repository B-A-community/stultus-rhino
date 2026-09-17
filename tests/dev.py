# -*- coding: utf-8 -*-
"""Прогон на живом Rhino через мост разработки хоста (127.0.0.1:8799) и локальный gateway (8792).
   python tests/dev.py python "print(1+1)"          — выполнить код
   python tests/dev.py tool scene_state '{"full":true}' — выполнить скрипт инструмента с gateway
   python tests/dev.py message ready '{}'            — вызов моста как со страницы
   python tests/dev.py js "document.title"           — JS в окне
   python tests/dev.py open | health | log
"""
import json, sys, urllib.request, re

HOST = 'http://127.0.0.1:8799'
GATEWAY = 'http://127.0.0.1:8792'

def call(path, body=None, base=HOST, timeout=600):
    data = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(base + path, data=data, headers={'content-type': 'application/json'}, method='POST' if data is not None else 'GET')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode('utf-8')
    except urllib.error.HTTPError as e:
        return 'HTTP %s: %s' % (e.code, e.read().decode('utf-8', 'replace'))

def tools():
    js = call('/ui/tools.js', base=GATEWAY)
    m = re.search(r'window\.StultusTools = (\{.*\});', js, re.S)
    return json.loads(m.group(1))['tools']

def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'health'
    if cmd == 'health': print(call('/health'))
    elif cmd == 'open': print(call('/open', {}))
    elif cmd == 'log': print(json.loads(call('/log'))['log'][-6000:])
    elif cmd == 'python': print(call('/python', {'code': sys.argv[2], 'args': json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}}))
    elif cmd == 'tool':
        t = tools(); name = sys.argv[2]
        args = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
        out = json.loads(call('/python', {'code': t[name], 'args': args}))
        if out.get('result') and isinstance(out['result'], dict) and 'base64' in out['result']:
            out['result']['base64'] = '<%d chars>' % len(out['result']['base64'])
        print(json.dumps(out, ensure_ascii=False, indent=1)[:6000])
    elif cmd == 'message': print(call('/message', {'name': sys.argv[2], 'payload': json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}})[:6000])
    elif cmd == 'js': print(call('/js', {'script': sys.argv[2]})[:6000])
    elif cmd in ('chat','snap'): pass
    else: print(__doc__)

if __name__ == '__main__':
    main()

def js(script):
    r = json.loads(call('/js', {'script': script}))
    v = r.get('value')
    # Eto отдаёт результат скрипта JSON-строкой, внутри — наш JSON.stringify: разворачиваем до объекта.
    for _ in range(3):
        if not isinstance(v, str): break
        try: v = json.loads(v)
        except Exception:
            try: v = json.loads(json.loads('"' + v + '"'))
            except Exception: break
    return v

SNAPSHOT = """return JSON.stringify({state: document.getElementById('app').dataset.state, hint: document.getElementById('composerHint').textContent, usage: document.getElementById('usage').textContent,
  feed: [].map.call(document.querySelectorAll('#chat > .msg, #chat > .tool, #chat > .card, #chat > .render'), function(e){
    if (e.classList.contains('tool')) return {tool: e.querySelector('.tool__name').textContent, label: e.querySelector('.tool__label').textContent, state: e.dataset.state, result: (e.querySelector('.tool__result').textContent||'').slice(0,300)};
    if (e.classList.contains('card')) return {card: e.querySelector('.card__title').textContent, text: (e.querySelector('.card__text')||{}).textContent, done: e.classList.contains('is-done')};
    return {msg: e.className.replace('msg ','').replace('msg--',''), text: e.querySelector('.msg__body').textContent.slice(0,500)};
  })})"""

def chat(text, wait=240, poll=3):
    import time
    js("document.getElementById('input').value = %s; document.getElementById('btnSend').click(); return 'sent'" % json.dumps(text))
    t0 = time.time(); last = None
    while time.time() - t0 < wait:
        time.sleep(poll)
        snap = js(SNAPSHOT)
        if snap != last:
            print('[%3ds] %s' % (time.time() - t0, snap.get('state')), snap.get('hint') or '')
            last = snap
        if snap.get('state') != 'busy' and time.time() - t0 > poll:
            break
    print(json.dumps(snap, ensure_ascii=False, indent=1))

if __name__ == '__main__' and len(sys.argv) > 1 and sys.argv[1] == 'chat':
    chat(sys.argv[2], wait=int(sys.argv[3]) if len(sys.argv) > 3 else 240)
elif __name__ == '__main__' and len(sys.argv) > 1 and sys.argv[1] == 'snap':
    print(json.dumps(js(SNAPSHOT), ensure_ascii=False, indent=1))
