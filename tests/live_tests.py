# -*- coding: utf-8 -*-
"""Живой прогон Stultus Rhino: хост, скрипты инструментов, приёмы моделирования,
Grasshopper и ходы модели через окно.

Нужно: тестовый Rhino 8 с хостом и STULTUS_RHINO_DEV=1 (мост 127.0.0.1:8799),
gateway с tools.js (по умолчанию 127.0.0.1:8792) и, для ходов модели, окно,
подключённое к gateway с настроенными провайдерами (по умолчанию тот же адрес,
что в настройках хоста).

  python tests/live_tests.py            # всё
  python tests/live_tests.py tools gh   # группы: host tools techniques gh chat
Отчёт: build/live_tests_report.md
"""
import json, os, sys, time, base64, re
sys.path.insert(0, os.path.dirname(__file__))
import dev

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, 'build')
os.makedirs(BUILD, exist_ok=True)
PNG1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1kAAAAASUVORK5CYII='

results = []
TOOLS = None


def tools():
    global TOOLS
    if TOOLS is None:
        TOOLS = dev.tools()
    return TOOLS


def py(code, args=None):
    return json.loads(dev.call('/python', {'code': code, 'args': args or {}}))


def tool(name, args=None):
    r = json.loads(dev.call('/python', {'code': tools()[name], 'args': dict({'host_version': 'test'}, **(args or {}))}))
    if not r.get('ok'):
        raise AssertionError('%s: %s\n%s' % (name, r.get('error'), r.get('traceback') or ''))
    v = r.get('result')
    if isinstance(v, dict) and v.get('ok') is False:
        raise AssertionError('%s: %s' % (name, v.get('error')))
    return v


def msg(name, payload=None):
    r = json.loads(dev.call('/message', {'name': name, 'payload': payload or {}}))
    if r.get('ok') is False:
        raise AssertionError('%s: %s' % (name, r.get('error')))
    return r


def case(group, name):
    def deco(fn):
        fn._case = (group, name)
        return fn
    return deco


def run_case(fn):
    group, name = fn._case
    t0 = time.time()
    try:
        note = fn() or ''
        results.append((group, name, 'ok', note, time.time() - t0))
        print('  ok   %-60s %s' % (name, note[:80]))
    except Exception as e:
        results.append((group, name, 'FAIL', str(e)[:400], time.time() - t0))
        print('  FAIL %-60s %s' % (name, str(e)[:300]))


def reset_doc():
    py("import rhinoscriptsyntax as rs\nrs.EnableRedraw(False)\nobjs = rs.AllObjects(select=False, include_lights=True, include_grips=False) or []\nif objs: rs.DeleteObjects(objs)\nfor n in rs.LayerNames() or []:\n    if n != 'Default':\n        try: rs.PurgeLayer(n)\n        except Exception: pass\nrs.EnableRedraw(True)\nresult = len(rs.AllObjects() or [])")


# ---------------------------------------------------------------- хост
@case('host', 'health: хост отвечает, документ и версия')
def t_health():
    h = json.loads(dev.call('/health'))
    assert h['ok'] and h['instance']['app'] == 'rhino', h
    return 'Rhino %s, хост %s' % (h['instance']['app_version'], h['version'])


@case('host', 'python: аргументы с кириллицей туда и обратно, stdout, result')
def t_py_roundtrip():
    r = py("print('привет', __stultus_args__['n'])\nresult = {'echo': __stultus_args__, 'sum': sum(range(10))}", {'n': 7, 'имя': 'Стол'})
    assert r['ok'] and r['result']['echo']['имя'] == 'Стол' and r['result']['sum'] == 45, r
    assert 'привет 7' in r['output'], r['output']
    return 'за %.2f с' % r['seconds']


@case('host', 'python: ошибка → ok:false, трассировка с верным номером строки')
def t_py_error():
    r = py("x = 1\ny = 2\nraise ValueError('проверка')")
    assert not r['ok'] and 'проверка' in r['error'], r
    assert 'line 3' in (r['traceback'] or ''), r['traceback']
    assert 'file:///' not in (r['traceback'] or '')
    return 'line 3 в трассировке'


@case('host', 'python: несериализуемый result → строка')
def t_py_repr():
    r = py("import Rhino\nresult = Rhino.Geometry.Point3d(1,2,3)")
    assert r['ok'] and r['result'] == '1,2,3', r
    return r['result']


@case('host', 'execute_python: запись Undo на ход, ошибка удаляет созданные объекты')
def t_exec_undo():
    reset_doc()
    ok = msg('execute_python', {'code': "import rhinoscriptsyntax as rs\nrs.AddSphere((0,0,0), 5)\nresult='a'", 'turn': 101, 'turn_label': 'Stultus: тест'})
    assert ok['ok'] and ok['result'] == 'a', ok
    bad = json.loads(dev.call('/message', {'name': 'execute_python', 'payload': {'code': "import rhinoscriptsyntax as rs\nrs.AddSphere((20,0,0), 5)\nraise RuntimeError('упал после создания')", 'turn': 101, 'turn_label': 'Stultus: тест'}}))
    assert bad['ok'] is False and bad.get('removed') == 1, bad
    n = py("import rhinoscriptsyntax as rs\nresult = len(rs.AllObjects() or [])")['result']
    assert n == 1, n
    msg('turn_end', {'turn': 101})
    py("import Rhino\nRhino.RhinoApp.RunScript('_-Undo', False)")
    n2 = py("import rhinoscriptsyntax as rs\nresult = len(rs.AllObjects() or [])")['result']
    assert n2 == 0, 'после одного Undo осталось %s' % n2
    return 'упавший вызов удалил 1 объект; один Undo убрал весь ход'


@case('host', 'переписка: save/clear(архив)/restore в документе, сессии')
def t_history():
    saved = msg('save_history', {'messages': [{'role': 'user', 'text': 'привет'}, {'role': 'assistant', 'text': 'здравствуйте'}]})
    assert saved['saved'] == 2, saved
    msg('save_sessions', {'sessions': {'claude': 'abc'}})
    r = msg('ready')
    assert len(r['history']) == 2 and r['sessions']['claude'] == 'abc', r
    c = msg('clear_history')
    assert c['archived'] == 2 and c['archive']['count'] == 2, c
    assert msg('ready')['history'] == []
    rs_ = msg('restore_history')
    assert rs_['restored'] == 2 and len(rs_['messages']) == 2 and rs_['sessions']['claude'] == 'abc', rs_
    stored = py("import scriptcontext as sc\nresult = sc.doc.Strings.GetValue('BACommunity_StultusRhino', 'history')")['result']
    assert 'здравствуйте' in stored
    msg('clear_history')
    return 'в doc.Strings, архив и восстановление работают'


@case('host', 'настройки: чужие ключи игнорируются, булевы')
def t_settings():
    before = msg('ready')['settings']
    r = msg('save_settings', {'settings': {'theme': 'light', 'attach_scene': False, 'evil': 'x'}})
    s = r['settings']
    assert s['theme'] == 'light' and s['attach_scene'] is False and 'evil' not in s, s
    msg('save_settings', {'settings': {'theme': before['theme'], 'attach_scene': before['attach_scene']}})
    return 'ok'


# ---------------------------------------------------------------- скрипты инструментов
@case('tools', 'scene_state: объекты, слои, блоки, группы, выделение по-русски')
def t_scene():
    reset_doc()
    py("""import rhinoscriptsyntax as rs
a = rs.AddBox([(0,0,0),(1000,0,0),(1000,500,0),(0,500,0),(0,0,300),(1000,0,300),(1000,500,300),(0,500,300)]); rs.ObjectName(a, 'Стол')
rs.AddLayer('Мебель'); rs.ObjectLayer(a, 'Мебель')
c = rs.AddCircle((2000,0,0), 250); b = rs.AddBlock([c], (2000,0,0), 'Кружок', True)
i1 = rs.InsertBlock('Кружок', (3000,0,0)); i2 = rs.InsertBlock('Кружок', (4000,0,0))
g = rs.AddGroup('Пара'); rs.AddObjectsToGroup([i1, i2], g)
rs.SelectObjects([a, i1])""")
    s = tool('scene_state', {'full': True})
    assert s['units']['length'] == 'mm'
    assert s['selection_summary']['count'] == 2 and 'полисурфейс: Стол' in s['selection_summary']['text'] and 'из 2' in s['selection_summary']['text'], s['selection_summary']
    assert 'Мебель' in s['layers'] and s['blocks'][0]['instances'] == 2 and 'Пара' in s['groups'], (s['layers'], s['blocks'], s['groups'])
    brep = [o for o in s['objects'] if o.get('name') == 'Стол'][0]
    assert brep['closed'] and brep['bbox']['size'] == [1000.0, 500.0, 300.0], brep
    assert 'grasshopper' in s
    return s['selection_summary']['text']


@case('tools', 'select: replace/add/clear, zoom, чужой id')
def t_select():
    ids = py("import rhinoscriptsyntax as rs\nresult = [str(o) for o in rs.AllObjects()]")['result']
    r = tool('select', {'ids': ids[:1], 'mode': 'replace', 'zoom': True})
    assert r['selected'] == 1
    r = tool('select', {'ids': ids[1:2] + ['00000000-0000-0000-0000-000000000001'], 'mode': 'add'})
    assert r['selected'] == 2 and r['missing_ids'] == ['00000000-0000-0000-0000-000000000001'], r
    r = tool('select', {'mode': 'clear'})
    assert r['selected'] == 0
    return 'ok'


@case('tools', 'screenshot: стандартный вид + режим, камера и имя вьюпорта возвращаются')
def t_screenshot():
    before = py("import scriptcontext as sc\nvp = sc.doc.Views.ActiveView.ActiveViewport\nresult = [vp.Name, vp.IsPerspectiveProjection, vp.DisplayMode.EnglishName]")['result']
    r = tool('screenshot', {'view': 'top', 'zoom_extents': True, 'display_mode': 'Shaded', 'width': 640, 'height': 400})
    assert r['width'] == 640 and r['bytes'] > 2000 and r['camera']['projection'] == 'parallel', r['camera']
    open(os.path.join(BUILD, 'test_shot_top.png'), 'wb').write(base64.b64decode(r['base64']))
    after = py("import scriptcontext as sc\nvp = sc.doc.Views.ActiveView.ActiveViewport\nresult = [vp.Name, vp.IsPerspectiveProjection, vp.DisplayMode.EnglishName]")['result']
    assert after == before, (before, after)
    v = tool('screenshot', {'framing': 'viewport'})
    assert v['framing'] == 'viewport' and v['width'] > 100
    return '%dx%d, камера %s восстановлена' % (r['width'], r['height'], before[0])


@case('tools', 'named_views: add/list/activate/update/delete')
def t_views():
    n = tool('named_views', {'action': 'add', 'name': 'Тест вид'})
    assert 'Тест вид' in [v['name'] for v in n['views']]
    a = tool('named_views', {'action': 'activate', 'name': 'тест вид'})
    assert a['activated'] == 'Тест вид'
    tool('named_views', {'action': 'update', 'name': 'Тест вид'})
    d = tool('named_views', {'action': 'delete', 'name': 'Тест вид'})
    assert 'Тест вид' not in [v['name'] for v in d['views']]
    return 'ok'


@case('tools', 'attachments: save/read рядом с моделью')
def t_attach():
    s = tool('attachments', {'action': 'save', 'name': 'ref.png', 'base64': PNG1})
    r = tool('attachments', {'action': 'read', 'path': s['path']})
    assert r['base64'] == PNG1 and s['bytes'] == 68, (s, r)
    return s['dir']


@case('tools', 'render_assets: store/chunk/read/export_to')
def t_render_assets():
    rid = '12345678-1234-1234-1234-1234567890ab'
    tool('render_assets', {'action': 'store', 'id': rid, 'image': PNG1, 'source': PNG1, 'preview': True})
    data = base64.b64decode(PNG1)
    half = len(data) // 2
    c1 = tool('render_assets', {'action': 'chunk', 'id': rid, 'index': 0, 'total': 2, 'data': base64.b64encode(data[:half]).decode()})
    c2 = tool('render_assets', {'action': 'chunk', 'id': rid, 'index': 1, 'total': 2, 'data': base64.b64encode(data[half:]).decode()})
    assert not c1['done'] and c2['done'] and c2['bytes'] == 68, (c1, c2)
    r = tool('render_assets', {'action': 'read', 'id': rid})
    assert r['image'] == PNG1
    e = tool('render_assets', {'action': 'export_to', 'id': rid, 'path': os.path.join(BUILD, 'test_export')})
    assert os.path.isfile(e['path'])
    return e['path']


# ---------------------------------------------------------------- приёмы моделирования (execute_python)
def exec_turn(code, turn=200):
    r = msg('execute_python', {'code': code, 'turn': turn, 'turn_label': 'Stultus: приём'})
    if not r.get('ok'):
        raise AssertionError(r.get('error') + '\n' + (r.get('traceback') or ''))
    return r


@case('techniques', 'стена с проёмом: коробка + булево вычитание, замкнутый полисурфейс')
def t_wall():
    reset_doc()
    r = exec_turn("""import rhinoscriptsyntax as rs
wall = rs.AddBox([(0,0,0),(6000,0,0),(6000,200,0),(0,200,0),(0,0,3000),(6000,0,3000),(6000,200,3000),(0,200,3000)])
hole = rs.AddBox([(2000,-100,900),(3200,-100,900),(3200,300,900),(2000,300,900),(2000,-100,2100),(3200,-100,2100),(3200,300,2100),(2000,300,2100)])
res = rs.BooleanDifference([wall], [hole], True)
rs.ObjectName(res[0], 'Стена с окном'); rs.AddLayer('Стены'); rs.ObjectLayer(res[0], 'Стены')
result = {'closed': rs.IsPolysurfaceClosed(res[0]), 'faces': rs.PolysurfaceCount(res[0]) if hasattr(rs,'PolysurfaceCount') else None, 'vol': rs.SurfaceVolume(res[0])[0]}""")
    v = r['result']
    assert v['closed'] and abs(v['vol'] - (6000 * 200 * 3000 - 1200 * 200 * 1200)) < 1, v
    return 'объём %.0f' % v['vol']


@case('techniques', 'выдавливание контура с крышками: плита нестандартной формы')
def t_extrude():
    r = exec_turn("""import rhinoscriptsyntax as rs
pts = [(0,0,0),(8000,0,0),(9000,3000,0),(6000,6000,0),(1000,5000,0),(0,0,0)]
crv = rs.AddPolyline(pts)
srf = rs.ExtrudeCurveStraight(crv, (0,0,0), (0,0,300))
rs.CapPlanarHoles(srf); rs.DeleteObject(crv)
rs.ObjectName(srf, 'Плита')
result = {'closed': rs.IsPolysurfaceClosed(srf), 'bbox': [list(p) for p in rs.BoundingBox(srf)][6]}""")
    assert r['result']['closed'] and r['result']['bbox'][2] == 300, r['result']
    return 'плита замкнута'


@case('techniques', 'колонны циклом: цилиндры по сетке, слой, имена')
def t_columns():
    r = exec_turn("""import rhinoscriptsyntax as rs
rs.AddLayer('Колонны'); ids = []
for i in range(4):
    for j in range(3):
        c = rs.AddCylinder((i*3000, j*3000, 0), 3000, 200)
        rs.ObjectName(c, 'Колонна %d-%d' % (i+1, j+1)); rs.ObjectLayer(c, 'Колонны'); ids.append(c)
result = {'n': len(ids), 'all_closed': all(rs.IsPolysurfaceClosed(i) for i in ids)}""")
    assert r['result']['n'] == 12 and r['result']['all_closed']
    return '12 колонн'


@case('techniques', 'блок и экземпляры: окно как определение, вставки с шагом')
def t_block():
    r = exec_turn("""import rhinoscriptsyntax as rs
frame = rs.AddBox([(0,0,0),(1200,0,0),(1200,60,0),(0,60,0),(0,0,1500),(1200,0,1500),(1200,60,1500),(0,60,1500)])
blk = rs.AddBlock([frame], (0,0,0), 'Окно 1200', True)
inst = [rs.InsertBlock('Окно 1200', (i*2000, 0, 900)) for i in range(5)]
result = {'instances': rs.BlockInstanceCount('Окно 1200'), 'names': rs.BlockNames()}""")
    assert r['result']['instances'] == 5 and 'Окно 1200' in r['result']['names'], r['result']
    return '5 экземпляров'


@case('techniques', 'лестница: ступени циклом по подъёму и проступи')
def t_stairs():
    r = exec_turn("""import rhinoscriptsyntax as rs
H, W, rise, tread = 3000.0, 1000.0, 150.0, 300.0
n = int(round(H / rise)); ids = []
for i in range(n):
    z0 = i * rise; y0 = i * tread
    ids.append(rs.AddBox([(0,y0,0),(W,y0,0),(W,y0+tread,0),(0,y0+tread,0),(0,y0,z0+rise),(W,y0,z0+rise),(W,y0+tread,z0+rise),(0,y0+tread,z0+rise)]))
g = rs.AddGroup('Лестница'); rs.AddObjectsToGroup(ids, g)
top = max(rs.BoundingBox(i)[6][2] for i in ids)
result = {'steps': n, 'top': top}""")
    assert r['result']['steps'] == 20 and r['result']['top'] == 3000, r['result']
    return '20 ступеней до +3000'


@case('techniques', 'лофт по сечениям и сдвиг/поворот копий (rg + rs)')
def t_loft():
    r = exec_turn("""import rhinoscriptsyntax as rs, Rhino.Geometry as rg, scriptcontext as sc
c1 = rs.AddCircle((0,0,0), 2000); c2 = rs.AddCircle((0,0,4000), 1200); c3 = rs.AddCircle((0,0,8000), 1800)
loft = rs.AddLoftSrf([c1, c2, c3])
rs.DeleteObjects([c1,c2,c3])
copies = [rs.RotateObject(rs.CopyObject(loft[0], (6000,0,0)), (6000,0,0), 30*k) for k in range(1,4)]
result = {'lofts': 1 + len(copies), 'area': rs.SurfaceArea(loft[0])[0] > 0}""")
    assert r['result']['lofts'] == 4 and r['result']['area']
    msg('turn_end', {'turn': 200})
    return '4 лофта'


@case('techniques', 'один Undo откатывает все приёмы хода')
def t_undo_all():
    n = py("import rhinoscriptsyntax as rs\nresult = len(rs.AllObjects() or [])")['result']
    py("import Rhino\nRhino.RhinoApp.RunScript('_-Undo', False)")
    n2 = py("import rhinoscriptsyntax as rs\nresult = len(rs.AllObjects() or [])")['result']
    assert n > 20 and n2 == 0, (n, n2)
    return 'было %d объектов, после Undo %d' % (n, n2)


# ---------------------------------------------------------------- Grasshopper
@case('gh', 'open + new: канвас открыт, новый документ')
def t_gh_open():
    r = tool('grasshopper', {'action': 'open'})
    tool('grasshopper', {'action': 'new'})
    s = tool('grasshopper', {'action': 'status'})
    assert s['open'] and s['document'] and s['objects'] == 0, s
    return 'ok'


@case('gh', 'slider + script(Python 3) + wire + read: брепы по слайдеру')
def t_gh_chain():
    tool('grasshopper', {'action': 'slider', 'nick': 'floors', 'min': 1, 'max': 20, 'value': 5, 'integer': True, 'x': 50, 'y': 50})
    tool('grasshopper', {'action': 'slider', 'nick': 'h', 'min': 2.5, 'max': 6, 'value': 3.5, 'integer': False, 'x': 50, 'y': 110})
    sc = tool('grasshopper', {'action': 'script', 'nick': 'Floors', 'x': 320, 'y': 60, 'inputs': ['n', 'h'], 'outputs': ['slabs'],
                              'code': "import Rhino.Geometry as rg\nn = int(n or 1); h = float(h or 3)\nslabs = [rg.Box(rg.Plane(rg.Point3d(0,0,i*h), rg.Vector3d.ZAxis), rg.Interval(0,12), rg.Interval(0,8), rg.Interval(0,0.3)).ToBrep() for i in range(n)]"})
    assert sc['created'] and not sc['problems'], sc
    tool('grasshopper', {'action': 'wire', 'from': 'floors', 'to': 'Floors', 'to_param': 'n'})
    tool('grasshopper', {'action': 'wire', 'from': 'h', 'to': 'Floors', 'to_param': 'h'})
    r = tool('grasshopper', {'action': 'read', 'id': 'Floors', 'param': 'slabs', 'limit': 5})
    assert r['count'] == 5 and r['items'][0]['type'] == 'Brep' and r['items'][1]['bbox']['min'][2] == 3.5, r
    return '5 плит, вторая на z=3.5'


@case('gh', 'set: изменение слайдера пересчитывает геометрию (синхронизация)')
def t_gh_sync():
    tool('grasshopper', {'action': 'set', 'id': 'floors', 'value': 12})
    r = tool('grasshopper', {'action': 'read', 'id': 'Floors', 'param': 'slabs', 'limit': 20})
    assert r['count'] == 12, r['count']
    tool('grasshopper', {'action': 'set', 'id': 'h', 'value': 4})
    r = tool('grasshopper', {'action': 'read', 'id': 'Floors', 'param': 'slabs', 'limit': 20})
    assert r['items'][1]['bbox']['min'][2] == 4.0, r['items'][1]
    return '12 этажей, шаг 4'


@case('gh', 'find + add native component + wire: окружность радиусом со слайдера')
def t_gh_native():
    f = tool('grasshopper', {'action': 'find', 'query': 'circle'})
    hit = [h for h in f['hits'] if h['name'] == 'Circle'][0]
    a = tool('grasshopper', {'action': 'add', 'guid': hit['guid'], 'nick': 'Круг', 'x': 320, 'y': 300})
    tool('grasshopper', {'action': 'wire', 'from': 'h', 'to': 'Круг', 'to_param': 'Radius'})
    r = tool('grasshopper', {'action': 'read', 'id': 'Круг', 'param': 'Circle'})
    assert r['count'] == 1 and r['items'][0]['bbox']['max'][0] == 4.0, r
    return 'Circle R=4 из слайдера h'


@case('gh', 'list: провода и данные видны; script update по id')
def t_gh_list():
    l = tool('grasshopper', {'action': 'list', 'data': True})
    comp = [o for o in l['objects'] if o['nick'] == 'Floors'][0]
    assert comp['inputs'][0]['sources'] and comp['outputs'][1]['data']['count'] == 12, comp
    u = tool('grasshopper', {'action': 'script', 'id': 'Floors', 'code': "import Rhino.Geometry as rg\nn = int(n or 1); h = float(h or 3)\nslabs = [rg.Box(rg.Plane(rg.Point3d(0,0,i*h), rg.Vector3d.ZAxis), rg.Interval(0,20), rg.Interval(0,8), rg.Interval(0,0.3)).ToBrep() for i in range(n)]"})
    assert not u['created'] and not u['problems']
    r = tool('grasshopper', {'action': 'read', 'id': 'Floors', 'param': 'slabs', 'limit': 1})
    assert r['items'][0]['bbox']['max'][0] == 20.0
    return 'обновление кода компонента без пересоздания'


@case('gh', 'ошибка в компоненте видна в problems')
def t_gh_problem():
    u = tool('grasshopper', {'action': 'script', 'nick': 'Bad', 'x': 320, 'y': 500, 'inputs': ['x'], 'outputs': ['y'], 'code': "y = 1/0"})
    assert any('Bad' == p['nick'] for p in u['problems']), u['problems']
    tool('grasshopper', {'action': 'delete', 'ids': ['Bad']})
    return 'ZeroDivision в problems'


@case('gh', 'save .gh → new → load: определение восстанавливается и считает')
def t_gh_save_load():
    path = os.path.join(BUILD, 'test_definition.gh')
    s = tool('grasshopper', {'action': 'save', 'path': path})
    assert s['ok'] and os.path.isfile(path), s
    tool('grasshopper', {'action': 'new'})
    l = tool('grasshopper', {'action': 'load', 'path': path})
    assert l['objects'] >= 4 and not l['problems'], l
    r = tool('grasshopper', {'action': 'read', 'id': 'Floors', 'param': 'slabs', 'limit': 1})
    assert r['count'] == 12, r['count']
    tool('grasshopper', {'action': 'clear'})
    return '%d объектов после load' % l['objects']


@case('gh', 'scene_state видит канвас Grasshopper')
def t_gh_scene():
    tool('grasshopper', {'action': 'slider', 'nick': 'n', 'min': 0, 'max': 10, 'value': 3})
    s = tool('scene_state', {'full': True})
    g = s['grasshopper']
    assert g['open'] and any(i['nick'] == 'n' and i.get('value') == 3 for i in g['items']), g
    tool('grasshopper', {'action': 'clear'})
    return 'ok'


# ---------------------------------------------------------------- ходы модели через окно
def window_ready():
    dev.call('/open', {})
    for _ in range(30):
        time.sleep(1)
        try:
            st = dev.js("return JSON.stringify({state: document.getElementById('app').dataset.state, url: location.origin})")
            if isinstance(st, dict) and st.get('state') in ('connected', 'busy'):
                return st
        except Exception:
            pass
    raise AssertionError('окно не подключилось к gateway')


def set_provider(provider, model=None):
    return dev.js("var p=document.getElementById('providerSelect'); p.value=%s; p.dispatchEvent(new Event('change'));%s return document.getElementById('modelSelect').value" % (
        json.dumps(provider), (" var m=document.getElementById('modelSelect'); m.value=%s; m.dispatchEvent(new Event('change'));" % json.dumps(model)) if model else ''))


def chat(text, wait=300):
    dev.js("document.getElementById('input').value = %s; document.getElementById('btnSend').click(); return 'sent'" % json.dumps(text))
    t0 = time.time()
    snap = None
    while time.time() - t0 < wait:
        time.sleep(3)
        snap = dev.js(dev.SNAPSHOT)
        if snap.get('state') != 'busy':
            break
    return snap


def feed_tail(snap, n=6):
    return json.dumps(snap['feed'][-n:], ensure_ascii=False)[:1500]


def answer_card():
    """Карточка вопросов: выбрать первый вариант в каждом вопросе (или написать «как считаешь лучше»), ответить."""
    return dev.js("""var card = [].slice.call(document.querySelectorAll('.card--questions:not(.is-done)')).pop(); if (!card) return 'no card';
      card.querySelectorAll('.ask__q').forEach(function (q) { var b = q.querySelector('.ask__opt'); if (b) b.click(); else { var i = q.querySelector('.ask__custom'); i.value = 'как считаешь лучше'; i.dispatchEvent(new Event('input')); } });
      var s = card.querySelector('.card__options .btn--primary'); s.click(); return 'answered ' + card.querySelectorAll('.ask__q').length;""")


def chat_provider_tests(provider, model):
    @case('chat', '%s: ход «построй куб» → execute_python/get_scene, проверка результата' % provider)
    def t_build():
        reset_doc()
        set_provider(provider, model)
        snap = chat('Построй куб 500 мм у начала координат, назови его «Куб-тест», положи на слой «Тест» и проверь габарит по снимку сцены.')
        tools_used = [f['tool'] for f in snap['feed'] if 'tool' in f]
        assert 'execute_python' in tools_used, feed_tail(snap)
        n = py("import rhinoscriptsyntax as rs\nobjs=rs.ObjectsByName('Куб-тест') or []\nresult={'n':len(objs),'layer':rs.ObjectLayer(objs[0]) if objs else None,'size':[round(b,1) for b in rs.BoundingBox(objs[0])[6]] if objs else None}")['result']
        assert n['n'] == 1 and n['layer'] == 'Тест' and n['size'] == [500.0, 500.0, 500.0], n
        return 'инструменты: %s' % ', '.join(tools_used)

    @case('chat', '%s: неполное задание → карточка вопросов → ответ → построено' % provider)
    def t_ask():
        set_provider(provider, model)
        snap = chat('Сделай лестницу.')
        cards = [f for f in snap['feed'] if 'card' in f]
        assert cards, 'карточки вопросов нет: ' + feed_tail(snap)
        a = answer_card()
        assert a.startswith('answered'), a
        t0 = time.time()
        while time.time() - t0 < 400:
            time.sleep(4)
            snap = dev.js(dev.SNAPSHOT)
            if snap.get('state') != 'busy':
                break
        n = py("import rhinoscriptsyntax as rs\nresult = len(rs.AllObjects() or [])")['result']
        assert n > 1, 'после ответов ничего не построено: ' + feed_tail(snap)
        return '%s; объектов в модели: %d' % (a, n)

    @case('chat', '%s: просьба снимка → карточка → разрешить → модель описала вид' % provider)
    def t_shot():
        set_provider(provider, model)
        snap = chat('Попроси у меня снимок вьюпорта в перспективе с показом всей модели в режиме Shaded и коротко опиши, что на нём. Ничего не строй.', wait=120)
        r = dev.js("var b=document.querySelector('.card--shot:not(.is-done) [data-act=allow]'); if(!b) return 'no card'; b.click(); return 'clicked'")
        assert r == 'clicked', r + ' ' + feed_tail(snap)
        t0 = time.time()
        while time.time() - t0 < 300:
            time.sleep(4)
            snap = dev.js(dev.SNAPSHOT)
            if snap.get('state') != 'busy':
                break
        last = [f for f in snap['feed'] if f.get('msg') == 'assistant'][-1]['text']
        assert len(last) > 20, feed_tail(snap)
        return last[:90]

    @case('chat', '%s: Grasshopper через чат — слайдер этажности и Python-компонент' % provider)
    def t_gh_chat():
        set_provider(provider, model)
        tool('grasshopper', {'action': 'open'})
        tool('grasshopper', {'action': 'new'})
        snap = chat('В Grasshopper сделай параметрическую башню: слайдер «этажи» от 1 до 30 (сейчас 6) и Python-компонент, который строит плиты 10×10 м толщиной 0.3 с шагом 3.5 м по числу этажей. Проверь read, что плит столько, сколько на слайдере.', wait=400)
        s = tool('grasshopper', {'action': 'status'})
        assert s['objects'] >= 2, (s, feed_tail(snap))
        l = tool('grasshopper', {'action': 'list', 'data': True})
        scripts = [o for o in l['objects'] if o['type'] == 'Python3Component']
        sliders = [o for o in l['objects'] if o['type'] == 'GH_NumberSlider']
        assert scripts and sliders, l['objects']
        outs = [o for o in scripts[0]['outputs'][1:] if o['data'] and o['data']['count']]
        assert outs, scripts[0]
        return 'слайдер %s, выход %s: %d' % (sliders[0]['nick'], outs[0]['nick'], outs[0]['data']['count'])

    return [t_build, t_ask, t_shot, t_gh_chat]


GROUPS = {
    'host': [t_health, t_py_roundtrip, t_py_error, t_py_repr, t_exec_undo, t_history, t_settings],
    'tools': [t_scene, t_select, t_screenshot, t_views, t_attach, t_render_assets],
    'techniques': [t_wall, t_extrude, t_columns, t_block, t_stairs, t_loft, t_undo_all],
    'gh': [t_gh_open, t_gh_chain, t_gh_sync, t_gh_native, t_gh_list, t_gh_problem, t_gh_save_load, t_gh_scene],
}


def main():
    groups = [a for a in sys.argv[1:] if not a.startswith('--')] or ['host', 'tools', 'techniques', 'gh', 'chat']
    providers = [('claude', 'claude-sonnet-5'), ('codex', 'gpt-6-astra')]
    for a in sys.argv[1:]:
        if a.startswith('--providers='):
            providers = [tuple(x.split(':')) for x in a.split('=', 1)[1].split(',')]
    started = time.time()
    for g in groups:
        print('== %s' % g)
        if g == 'chat':
            st = window_ready()
            print('  окно: %s' % st)
            for provider, model in providers:
                for fn in chat_provider_tests(provider, model):
                    run_case(fn)
        else:
            for fn in GROUPS[g]:
                run_case(fn)
    passed = sum(1 for r in results if r[2] == 'ok')
    lines = ['# Живой прогон Stultus Rhino — %s' % time.strftime('%Y-%m-%d %H:%M'), '',
             'Пройдено %d из %d, %.0f с.' % (passed, len(results), time.time() - started), '',
             '| Группа | Проверка | Итог | Заметка | с |', '|---|---|---|---|---|']
    for g, name, st, note, sec in results:
        lines.append('| %s | %s | %s | %s | %.1f |' % (g, name, st, note.replace('|', '/').replace('\n', ' ')[:200], sec))
    path = os.path.join(BUILD, 'live_tests_report.md')
    open(path, 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
    print('\nПройдено %d из %d. Отчёт: %s' % (passed, len(results), path))
    sys.exit(0 if passed == len(results) else 1)


if __name__ == '__main__':
    main()
