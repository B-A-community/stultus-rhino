# -*- coding: utf-8 -*-
"""Собирает параметрическую станцию KAFD (Заха Хадид) в Grasshopper через тот же
инструмент grasshopper, которым пользуется модель: слайдеры → Python-компонент
из station.py → провода → проверка синхронизации с этажностью → снимки →
сохранение .gh и .3dm.

  python examples/kafd/build.py            # через мост разработки (127.0.0.1:8799) и gateway (8792)
"""
import os, sys, json, time, base64
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, 'tests'))
import dev

BUILD = os.path.join(ROOT, 'build', 'kafd')
os.makedirs(BUILD, exist_ok=True)
TOOLS = dev.tools()


def tool(name, args):
    r = json.loads(dev.call('/python', {'code': TOOLS[name], 'args': dict({'host_version': 'kafd'}, **args)}, timeout=900))
    if not r.get('ok'):
        raise SystemExit('%s %s: %s\n%s' % (name, args.get('action'), r.get('error'), r.get('traceback') or ''))
    v = r['result']
    if isinstance(v, dict) and v.get('ok') is False:
        raise SystemExit('%s: %s' % (name, v.get('error')))
    return v


def gh(**args):
    return tool('grasshopper', args)


def py(code, args=None):
    r = json.loads(dev.call('/python', {'code': code, 'args': args or {}}, timeout=900))
    if not r.get('ok'):
        raise SystemExit(r.get('error') + '\n' + (r.get('traceback') or ''))
    return r.get('result')


def shot(name, view='perspective', mode='Shaded', w=1600, h=1000):
    r = tool('screenshot', {'view': view, 'zoom_extents': True, 'display_mode': mode, 'width': w, 'height': h})
    path = os.path.join(BUILD, name)
    open(path, 'wb').write(base64.b64decode(r['base64']))
    return path


code = open(os.path.join(HERE, 'station.py'), encoding='utf-8').read()

# Документ Rhino в метрах: станция — 130 м длиной.
py("import scriptcontext as sc, Rhino\nsc.doc.AdjustModelUnitSystem(Rhino.UnitSystem.Meters, False)\nsc.doc.ModelAbsoluteTolerance = 0.01\nresult = str(sc.doc.ModelUnitSystem)")

print('== канвас')
gh(action='open')
gh(action='new')

print('== слайдеры')
X = 60
sliders = [
    ('этажи', 1, 10, 6, True, 'floors'),
    ('высота_этажа_м', 3, 9, 6.0, False, 'floor_h'),
    ('длина_м', 60, 240, 130, False, 'length'),
    ('ширина_м', 30, 120, 70, False, 'width'),
    ('крыша_м', 0, 20, 6, False, 'roof'),
    ('решётка_вдоль', 8, 60, 26, True, 'lattice_n'),
    ('решётка_поперёк', 3, 20, 9, True, 'lattice_m'),
    ('прут_м', 0.1, 1.5, 0.45, False, 'rod'),
]
y = 40
for nick, lo, hi, val, integer, _ in sliders:
    gh(action='slider', nick=nick, min=lo, max=hi, value=val, integer=integer, x=X, y=y)
    y += 46
# Переключатель запекания — обычный Boolean Toggle из библиотеки.
hit = [h for h in gh(action='find', query='Boolean Toggle')['hits'] if h['name'] == 'Boolean Toggle'][0]
gh(action='add', guid=hit['guid'], nick='запечь', x=X, y=y)

print('== Python-компонент')
inputs = [{'name': s[5]} for s in sliders] + [{'name': 'bake'}]
comp = gh(action='script', nick='KAFD', x=460, y=120, inputs=inputs,
          outputs=['shell', 'lattice', 'slabs', 'cores', 'columns', 'info'], code=code, solve=False)
for nick, *_, name in sliders:
    gh(action='wire', **{'from': nick, 'to': 'KAFD', 'to_param': name, 'solve': False})
gh(action='wire', **{'from': 'запечь', 'to': 'KAFD', 'to_param': 'bake', 'solve': False})
r = gh(action='solve')
if r['problems']:
    print('ПРОБЛЕМЫ:', json.dumps(r['problems'], ensure_ascii=False))
info = gh(action='read', id='KAFD', param='info', limit=1)
print('  ', info['items'][0])

def counts():
    return {p: gh(action='read', id='KAFD', param=p, limit=1)['count'] for p in ('shell', 'lattice', 'slabs', 'cores', 'columns')}

print('== синхронизация с этажностью')
base = counts(); print('  этажи=6:', base)
assert base['slabs'] == 6, base
gh(action='set', id='этажи', value=9)
c9 = counts(); print('  этажи=9:', c9)
assert c9['slabs'] == 9, c9
gh(action='set', id='этажи', value=3)
c3 = counts(); print('  этажи=3:', c3)
assert c3['slabs'] == 3, c3
h3 = gh(action='read', id='KAFD', param='shell', limit=1)['items'][0]['bbox']['max'][2]
gh(action='set', id='этажи', value=6)
h6 = gh(action='read', id='KAFD', param='shell', limit=1)['items'][0]['bbox']['max'][2]
print('  высота оболочки: 3 этажа → %.1f м, 6 этажей → %.1f м' % (h3, h6))
assert h6 > h3

print('== запекание и снимки')
gh(action='set', id='запечь', value=True)
n = py("import rhinoscriptsyntax as rs\nresult = {l: len(rs.ObjectsByLayer(l) or []) for l in rs.LayerNames() if l.startswith('KAFD::')}")
print('  объектов в документе по слоям:', n)
gh(action='set', id='запечь', value=False)
gh(action='zoom')
gh(action='preview', mode='off')   # снимки — запечённой геометрии по слоям, без красного превью GH
for name, view in (('kafd_persp.png', 'perspective'), ('kafd_top.png', 'top'), ('kafd_front.png', 'front'), ('kafd_right.png', 'right')):
    print('  ', shot(name, view))
# Ещё раз с другой этажностью — на снимке видно, что геометрия следует слайдеру.
gh(action='set', id='этажи', value=9)
gh(action='set', id='запечь', value=True); gh(action='set', id='запечь', value=False)
print('  ', shot('kafd_persp_9floors.png'))
gh(action='set', id='этажи', value=6)
gh(action='set', id='запечь', value=True); gh(action='set', id='запечь', value=False)
gh(action='preview', mode='shaded')

print('== сохранение')
ghp = os.path.join(BUILD, 'kafd-metro-station.gh')
print('  ', gh(action='save', path=ghp))
dm = os.path.join(BUILD, 'kafd-metro-station.3dm')
print('  ', py("import scriptcontext as sc\nresult = sc.doc.SaveAs(__stultus_args__['p'])", {'p': dm}), dm)
print('готово')
