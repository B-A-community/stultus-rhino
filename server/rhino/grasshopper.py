# Grasshopper (GH1) как инструмент модели: канвас, компоненты, слайдеры,
# провода, Python-компоненты, решение, чтение выходов, сохранение .gh.
# Только штатный SDK Grasshopper из CPython (pythonnet).
#
# Аргументы: action и поля по действию (см. ACTIONS ниже). Идентификаторы
# объектов канваса — InstanceGuid (строка), параметры — по имени/nickname.
import Grasshopper
import System
from System.Drawing import PointF
from Grasshopper.Kernel import GH_Document, GH_ParameterSide, GH_ParamAccess, GH_RuntimeMessageLevel
from Grasshopper.Kernel.Special import GH_NumberSlider, GH_Panel, GH_BooleanToggle
from Grasshopper.GUI.Base import GH_SliderAccuracy

PYTHON3_GUID = System.Guid('719467e6-7cf5-4848-99b0-c5dd57e5442c')
ACTIONS = ('status', 'open', 'new', 'clear', 'list', 'find', 'add', 'slider', 'set', 'script', 'wire', 'unwire',
           'delete', 'solve', 'read', 'save', 'load', 'zoom')

action = (A.get('action') or 'status').lower()


def dec(v):
    """System.Decimal слайдера → float (pythonnet не приводит Decimal сам)."""
    try:
        return float(System.Convert.ToDouble(v))
    except Exception:
        return float(str(v))


def impl(o):
    """pythonnet отдаёт объекты канваса через интерфейс — берём реализацию."""
    return o.__implementation__ if hasattr(o, '__implementation__') else o


def canvas():
    return Grasshopper.Instances.ActiveCanvas


def ensure_open():
    if canvas() is None:
        # Диалог «Grasshopper Loading Errors» (сторонние плагины) блокирует
        # команду; закрываем его таймером, пока команда ждёт.
        _auto_close_errors()
        Rhino.RhinoApp.RunScript('_Grasshopper', False)
    c = canvas()
    if c is None:
        raise Exception('Grasshopper не запустился (команда _Grasshopper).')
    if c.Document is None:
        c.Document = GH_Document()
    return c.Document


def _auto_close_errors():
    try:
        import System.Windows.Forms as WF
        t = WF.Timer(); t.Interval = 700
        state = {'n': 0}

        def tick(sender, e):
            state['n'] += 1
            # Окна первого запуска: «Grasshopper Loading Errors» (сторонние
            # плагины) и «Getting started with Grasshopper» — оба модальные.
            for f in list(WF.Application.OpenForms):
                txt = f.Text or ''
                if 'Loading Errors' in txt or txt.startswith('Getting started'):
                    f.Close()
            if state['n'] > 90:
                t.Stop(); t.Dispose()
        t.Tick += tick
        t.Start()
    except Exception:
        pass


def doc_required():
    c = canvas()
    if c is None or c.Document is None:
        raise Exception('Канвас Grasshopper не открыт: сначала action "open".')
    return c.Document


def find_object(d, id_or_nick):
    if not id_or_nick:
        return None
    try:
        g = System.Guid(str(id_or_nick))
        o = d.FindObject(g, True)
        if o is not None:
            return impl(o)
    except Exception:
        pass
    for o in d.Objects:
        if (o.NickName or '') == id_or_nick or (o.Name or '') == id_or_nick:
            return impl(o)
    return None


def find_param(obj, side, name):
    """Параметр компонента по имени/nickname/индексу; для параметров-объектов — сам объект."""
    params = None
    if hasattr(obj, 'Params'):
        params = obj.Params.Input if side == 'input' else obj.Params.Output
    else:
        return obj  # слайдер, панель — сами параметры
    if name is None or name == '':
        return params[0] if params.Count else None
    if isinstance(name, int) or (isinstance(name, str) and name.isdigit()):
        i = int(name)
        return params[i] if 0 <= i < params.Count else None
    for p in params:
        if (p.NickName or '') == name or (p.Name or '') == name:
            return p
    for p in params:
        if (p.NickName or '').lower() == str(name).lower() or (p.Name or '').lower() == str(name).lower():
            return p
    return None


def messages(o):
    out = []
    try:
        for lvl in (GH_RuntimeMessageLevel.Error, GH_RuntimeMessageLevel.Warning):
            for m in o.RuntimeMessages(lvl):
                out.append({'level': str(lvl), 'text': str(m)})
    except Exception:
        pass
    return out


def data_summary(param, sample=3):
    try:
        vd = param.VolatileData
        items = []
        for x in list(vd.AllData(True))[:sample]:
            v = x.Value if hasattr(x, 'Value') else x
            items.append(str(v)[:80] if not hasattr(v, 'GetBoundingBox') else type(v).__name__)
        return {'count': vd.DataCount, 'branches': vd.PathCount, 'sample': items}
    except Exception:
        return None


def describe(o, data=False):
    o = impl(o)
    h = {'id': str(o.InstanceGuid), 'nick': o.NickName, 'name': o.Name, 'type': o.GetType().Name,
         'pos': [int(o.Attributes.Pivot.X), int(o.Attributes.Pivot.Y)] if o.Attributes else None}
    if isinstance(o, GH_NumberSlider):
        h['slider'] = {'min': dec(o.Slider.Minimum), 'max': dec(o.Slider.Maximum), 'value': dec(o.Slider.Value),
                       'type': str(o.Slider.Type)}
    elif hasattr(o, 'Params'):
        h['inputs'] = [{'nick': p.NickName, 'name': p.Name, 'sources': [str(s.InstanceGuid) for s in p.Sources],
                        'data': data_summary(p) if data else None} for p in o.Params.Input]
        h['outputs'] = [{'nick': p.NickName, 'name': p.Name, 'recipients': len(list(p.Recipients)),
                         'data': data_summary(p) if data else None} for p in o.Params.Output]
    elif isinstance(o, GH_Panel):
        h['text'] = (o.UserText or '')[:200]
    m = messages(o)
    if m:
        h['messages'] = m
    return h


def solve(d, redraw=True):
    d.NewSolution(False)
    if redraw:
        Grasshopper.Instances.RedrawCanvas()
        DOC.Views.Redraw()
    bad = []
    for o in d.ActiveObjects():
        m = messages(o)
        if m:
            bad.append({'nick': o.NickName, 'messages': m})
    return bad


def place(o, x, y, nick=None):
    o.CreateAttributes()
    o.Attributes.Pivot = PointF(float(x or 100), float(y or 100))
    if nick:
        o.NickName = nick
    return o


if action == 'status':
    c = canvas()
    d = c.Document if c else None
    result = {'ok': True, 'open': c is not None, 'document': d is not None,
              'objects': d.ObjectCount if d else 0, 'file': d.FilePath if d else None,
              'names': [o.NickName for o in list(d.Objects)[:50]] if d else []}

elif action == 'open':
    d = ensure_open()
    result = {'ok': True, 'objects': d.ObjectCount, 'file': d.FilePath}

elif action == 'new':
    c = canvas() or (ensure_open() and canvas())
    d = GH_Document()
    Grasshopper.Instances.DocumentServer.AddDocument(d)
    c.Document = d
    result = {'ok': True, 'objects': 0}

elif action == 'clear':
    d = doc_required()
    d.RemoveObjects([o for o in list(d.Objects)], False)
    Grasshopper.Instances.RedrawCanvas()
    result = {'ok': True, 'objects': d.ObjectCount}

elif action == 'list':
    d = doc_required()
    result = {'ok': True, 'objects': [describe(o, data=bool(A.get('data'))) for o in list(d.Objects)[:200]],
              'total': d.ObjectCount, 'file': d.FilePath}

elif action == 'find':
    # Поиск компонента в библиотеке по имени (для add по guid).
    q = (A.get('query') or '').lower()
    hits = []
    for p in Grasshopper.Instances.ComponentServer.ObjectProxies:
        if p.Obsolete:
            continue
        d = p.Desc
        text = ' '.join([d.Name or '', d.NickName or '', d.Category or '', d.SubCategory or '']).lower()
        if q in text:
            exact = (d.Name or '').lower() == q or (d.NickName or '').lower() == q
            hits.append((0 if exact else 1, len(d.Name or ''), {'guid': str(p.Guid), 'name': d.Name, 'nick': d.NickName, 'category': d.Category,
                         'sub': d.SubCategory, 'description': (d.Description or '')[:120]}))
    hits.sort(key=lambda h: (h[0], h[1]))
    result = {'ok': True, 'hits': [h[2] for h in hits[:40]], 'total': len(hits)}

elif action == 'add':
    # Компонент по guid или точному имени.
    d = ensure_open()
    guid = A.get('guid')
    proxy = None
    if guid:
        proxy = Grasshopper.Instances.ComponentServer.EmitObjectProxy(System.Guid(str(guid)))
    else:
        name = (A.get('name') or '').lower()
        for p in Grasshopper.Instances.ComponentServer.ObjectProxies:
            if not p.Obsolete and ((p.Desc.Name or '').lower() == name or (p.Desc.NickName or '').lower() == name):
                proxy = p
                break
    if proxy is None:
        raise Exception('Компонент не найден: %s' % (guid or A.get('name')))
    o = impl(proxy.CreateInstance())
    place(o, A.get('x'), A.get('y'), A.get('nick'))
    d.AddObject(o, False)
    result = {'ok': True, 'object': describe(o)}

elif action == 'slider':
    d = ensure_open()
    s = GH_NumberSlider()
    place(s, A.get('x'), A.get('y'), A.get('nick') or A.get('name'))
    lo, hi, val = float(A.get('min', 0)), float(A.get('max', 10)), float(A.get('value', 0))
    s.Slider.Type = GH_SliderAccuracy.Integer if A.get('integer', True) else GH_SliderAccuracy.Float
    s.Slider.Minimum = System.Decimal(lo); s.Slider.Maximum = System.Decimal(hi); s.Slider.Value = System.Decimal(val)
    d.AddObject(s, False)
    result = {'ok': True, 'object': describe(s)}

elif action == 'set':
    # Значение слайдера / текст панели / переключателя; пересчёт.
    d = doc_required()
    o = find_object(d, A.get('id'))
    if o is None:
        raise Exception('Объект не найден: %s' % A.get('id'))
    if isinstance(o, GH_NumberSlider):
        v = float(A.get('value'))
        if 'min' in A: o.Slider.Minimum = System.Decimal(float(A['min']))
        if 'max' in A: o.Slider.Maximum = System.Decimal(float(A['max']))
        o.Slider.Value = System.Decimal(v)
    elif isinstance(o, GH_Panel):
        o.UserText = str(A.get('value', ''))
    elif isinstance(o, GH_BooleanToggle):
        o.Value = bool(A.get('value'))
    else:
        raise Exception('Значение можно задать слайдеру, панели или переключателю, а это %s' % o.GetType().Name)
    o.ExpireSolution(True)
    bad = solve(d)
    result = {'ok': True, 'object': describe(o), 'problems': bad}

elif action == 'script':
    # Python 3 компонент: создать (или обновить по id), задать входы/выходы и код.
    # inputs: [{name, access: item|list|tree}], outputs: [name], code: str.
    d = ensure_open()
    o = find_object(d, A.get('id')) if A.get('id') else None
    created = o is None
    if created:
        o = impl(Grasshopper.Instances.ComponentServer.EmitObjectProxy(PYTHON3_GUID).CreateInstance())
        place(o, A.get('x'), A.get('y'), A.get('nick') or 'Script')
        d.AddObject(o, False)
    elif A.get('nick'):
        o.NickName = A['nick']
    inputs = A.get('inputs')
    outputs = A.get('outputs')
    def shrink(side, keep):
        # Лишние параметры убираем; компонент может отказать (CanRemoveParameter) —
        # тогда останавливаемся, иначе цикл повис бы на главном потоке.
        params = o.Params.Input if side == GH_ParameterSide.Input else o.Params.Output
        while params.Count > keep:
            n = params.Count
            if not o.CanRemoveParameter(side, n - 1):
                break
            o.DestroyParameter(side, n - 1)
            if params.Count == n:
                break
    if inputs is not None:
        shrink(GH_ParameterSide.Input, 0)
        for i, spec in enumerate(inputs):
            if isinstance(spec, str):
                spec = {'name': spec}
            p = o.Params.Input[i] if i < o.Params.Input.Count else o.CreateParameter(GH_ParameterSide.Input, i)
            p.Name = spec['name']; p.NickName = spec['name']
            acc = (spec.get('access') or 'item').lower()
            p.Access = GH_ParamAccess.list if acc == 'list' else GH_ParamAccess.tree if acc == 'tree' else GH_ParamAccess.item
            p.Optional = bool(spec.get('optional', True))
            if spec.get('description'):
                p.Description = spec['description']
    if outputs is not None:
        # Первый выход «out» (stdout) оставляем, остальные пересоздаём.
        shrink(GH_ParameterSide.Output, 1)
        for i, name in enumerate(outputs):
            p = o.Params.Output[i + 1] if i + 1 < o.Params.Output.Count else o.CreateParameter(GH_ParameterSide.Output, i + 1)
            p.Name = name; p.NickName = name
    o.Params.OnParametersChanged()
    if A.get('code') is not None:
        o.SetSource(A['code'])
    # Списки Python на выходах — в ветки данных GH, а не одним объектом-списком
    # (по умолчанию у компонента, созданного из кода, маршалинг выключен).
    o.MarshInputs = True
    o.MarshOutputs = True
    o.ExpireSolution(True)
    bad = solve(d) if A.get('solve', True) else []
    result = {'ok': True, 'created': created, 'object': describe(o, data=True), 'problems': bad}

elif action == 'wire':
    # Соединить выход одного объекта со входом другого (или слайдер → вход).
    d = doc_required()
    src = find_object(d, A.get('from'))
    dst = find_object(d, A.get('to'))
    if src is None or dst is None:
        raise Exception('Не найден объект: %s' % (A.get('from') if src is None else A.get('to')))
    sp = find_param(src, 'output', A.get('from_param'))
    dp = find_param(dst, 'input', A.get('to_param'))
    if sp is None or dp is None:
        raise Exception('Не найден параметр: %s' % (A.get('from_param') if sp is None else A.get('to_param')))
    if A.get('replace', True):
        dp.RemoveAllSources()
    dp.AddSource(sp)
    dp.ExpireSolution(True)
    bad = solve(d) if A.get('solve', True) else []
    result = {'ok': True, 'from': str(src.InstanceGuid), 'to': str(dst.InstanceGuid), 'input': dp.NickName, 'problems': bad}

elif action == 'unwire':
    d = doc_required()
    dst = find_object(d, A.get('to'))
    dp = find_param(dst, 'input', A.get('to_param')) if dst else None
    if dp is None:
        raise Exception('Не найден вход')
    dp.RemoveAllSources(); dp.ExpireSolution(True); solve(d)
    result = {'ok': True}

elif action == 'delete':
    d = doc_required()
    ids = A.get('ids') or ([A.get('id')] if A.get('id') else [])
    objs = [find_object(d, i) for i in ids]
    objs = [o for o in objs if o is not None]
    d.RemoveObjects(objs, False)
    Grasshopper.Instances.RedrawCanvas()
    result = {'ok': True, 'deleted': len(objs), 'objects': d.ObjectCount}

elif action == 'solve':
    d = doc_required()
    bad = solve(d)
    result = {'ok': True, 'objects': d.ObjectCount, 'problems': bad}

elif action == 'read':
    # Данные выхода компонента (или значения параметра-объекта).
    d = doc_required()
    o = find_object(d, A.get('id'))
    if o is None:
        raise Exception('Объект не найден: %s' % A.get('id'))
    p = find_param(o, 'output', A.get('param'))
    vd = p.VolatileData
    limit = int(A.get('limit', 20))
    items = []
    for x in list(vd.AllData(True))[:limit]:
        v = x.Value if hasattr(x, 'Value') else x
        b = None
        try:
            if hasattr(v, 'GetBoundingBox'):
                b = v.GetBoundingBox(True)
            elif hasattr(v, 'BoundingBox'):
                b = v.BoundingBox
        except Exception:
            b = None
        if b is not None and b.IsValid:
            items.append({'type': type(v).__name__, 'bbox': {'min': pt(b.Min), 'max': pt(b.Max)}})
        else:
            items.append(str(v)[:200])
    result = {'ok': True, 'param': p.NickName, 'count': vd.DataCount, 'branches': vd.PathCount, 'items': items, 'messages': messages(o)}

elif action == 'save':
    d = doc_required()
    path = A.get('path')
    if not path:
        raise Exception('Нужен path (.gh)')
    if not path.lower().endswith('.gh'):
        path += '.gh'
    folder = os.path.dirname(path)
    if folder and not os.path.isdir(folder):
        os.makedirs(folder)
    io = Grasshopper.Kernel.GH_DocumentIO(d)
    ok = io.SaveQuiet(path)
    result = {'ok': bool(ok), 'path': path, 'error': None if ok else 'SaveQuiet вернул false'}

elif action == 'load':
    ensure_open()
    path = A.get('path')
    if not path or not os.path.isfile(path):
        raise Exception('Файл не найден: %s' % path)
    io = Grasshopper.Kernel.GH_DocumentIO()
    if not io.Open(path):
        raise Exception('Не удалось открыть %s' % path)
    d = io.Document
    Grasshopper.Instances.DocumentServer.AddDocument(d)
    canvas().Document = d
    bad = solve(d)
    result = {'ok': True, 'objects': d.ObjectCount, 'file': d.FilePath, 'problems': bad}

elif action == 'zoom':
    d = doc_required()
    attrs = [o.Attributes for o in d.Objects if o.Attributes is not None]
    if attrs:
        canvas().Viewport.Focus(attrs)
    Grasshopper.Instances.RedrawCanvas()
    result = {'ok': True}

else:
    raise Exception('Неизвестное действие: %s. Есть: %s' % (action, ', '.join(ACTIONS)))
