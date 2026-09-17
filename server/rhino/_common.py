# -*- coding: utf-8 -*-
# Общая часть всех скриптов инструментов Stultus Rhino. Gateway приклеивает
# этот файл в начало каждого tools/*.py перед отправкой в окно; хост в Rhino
# исполняет получившийся скрипт как один Python 3 (CPython) на главном потоке.
#
# Договор с хостом:
#   * __stultus_args__ — dict с аргументами вызова (хост подставляет);
#   * скрипт кладёт ответ в переменную result (dict, JSON-сериализуемый);
#   * исключение = ответ ok:false с трассировкой; print() уходит в output.
import json
import base64
import os
import math
import time
import traceback

import System
import Rhino
import scriptcontext as sc
import rhinoscriptsyntax as rs
from Rhino.DocObjects import ObjectType

try:
    import clr
    clr.AddReference("System.Drawing.Common")
except Exception:
    pass
import System.Drawing
import System.IO

try:
    __stultus_args__
except NameError:
    __stultus_args__ = {}
A = __stultus_args__ if isinstance(__stultus_args__, dict) else {}

DOC = sc.doc
# Ограничения: объектов верхнего уровня в снимке сцены; символов результата.
SCENE_OBJECT_LIMIT = 200

UNIT_NAMES = {
    Rhino.UnitSystem.Millimeters: 'mm', Rhino.UnitSystem.Centimeters: 'cm', Rhino.UnitSystem.Meters: 'm',
    Rhino.UnitSystem.Inches: 'inch', Rhino.UnitSystem.Feet: 'feet', Rhino.UnitSystem.Kilometers: 'km',
    Rhino.UnitSystem.Microns: 'micron', Rhino.UnitSystem.Yards: 'yard', Rhino.UnitSystem.Miles: 'mile',
}

# Русские названия типов для строки выделения: (один, два-четыре, много).
TYPE_WORDS = {
    'Brep': ('полисурфейс', 'полисурфейса', 'полисурфейсов'),
    'Surface': ('поверхность', 'поверхности', 'поверхностей'),
    'Extrusion': ('экструзия', 'экструзии', 'экструзий'),
    'Curve': ('кривая', 'кривые', 'кривых'),
    'Mesh': ('меш', 'меша', 'мешей'),
    'SubD': ('SubD', 'SubD', 'SubD'),
    'Point': ('точка', 'точки', 'точек'),
    'PointCloud': ('облако точек', 'облака точек', 'облаков точек'),
    'Light': ('источник света', 'источника света', 'источников света'),
    'Annotation': ('аннотация', 'аннотации', 'аннотаций'),
    'Hatch': ('штриховка', 'штриховки', 'штриховок'),
    'TextDot': ('текстовая точка', 'текстовые точки', 'текстовых точек'),
    'Object': ('объект', 'объекта', 'объектов'),
}


def units():
    u = DOC.ModelUnitSystem
    return {'length': UNIT_NAMES.get(u, str(u)), 'tolerance': DOC.ModelAbsoluteTolerance,
            'angle_tolerance_deg': round(math.degrees(DOC.ModelAngleToleranceRadians), 3)}


def plural(n, forms):
    m10, m100 = n % 10, n % 100
    if m10 == 1 and m100 != 11:
        w = forms[0]
    elif 2 <= m10 <= 4 and not 12 <= m100 <= 14:
        w = forms[1]
    else:
        w = forms[2]
    return '%d %s' % (n, w)


def r3(v):
    return round(float(v), 3)


def pt(p):
    return [r3(p.X), r3(p.Y), r3(p.Z)]


def type_of(obj):
    """Тип объекта коротким английским словом, как в RhinoCommon."""
    t = obj.ObjectType
    if t == ObjectType.Brep:
        g = obj.Geometry
        try:
            if g.Faces.Count == 1 and not g.IsSolid:
                return 'Surface'
        except Exception:
            pass
        return 'Brep'
    if t == ObjectType.Extrusion:
        return 'Extrusion'
    if t == ObjectType.Curve:
        return 'Curve'
    if t == ObjectType.Mesh:
        return 'Mesh'
    if t == ObjectType.SubD:
        return 'SubD'
    if t == ObjectType.Point:
        return 'Point'
    if t == ObjectType.PointSet:
        return 'PointCloud'
    if t == ObjectType.InstanceReference:
        return 'InstanceReference'
    if t == ObjectType.Light:
        return 'Light'
    if t == ObjectType.Annotation:
        return 'Annotation'
    if t == ObjectType.Hatch:
        return 'Hatch'
    if t == ObjectType.TextDot:
        return 'TextDot'
    return str(t)


def layer_path(obj):
    try:
        return DOC.Layers[obj.Attributes.LayerIndex].FullPath
    except Exception:
        return None


def material_name(obj):
    try:
        a = obj.Attributes
        if a.MaterialSource == Rhino.DocObjects.ObjectMaterialSource.MaterialFromObject and a.MaterialIndex >= 0:
            m = DOC.Materials[a.MaterialIndex]
            return m.Name or None
        rm = obj.RenderMaterial
        return rm.Name if rm else None
    except Exception:
        return None


def bbox(obj):
    try:
        b = obj.Geometry.GetBoundingBox(True)
        if not b.IsValid:
            return None
        return {'min': pt(b.Min), 'max': pt(b.Max),
                'size': [r3(b.Max.X - b.Min.X), r3(b.Max.Y - b.Min.Y), r3(b.Max.Z - b.Min.Z)]}
    except Exception:
        return None


def groups_of(obj):
    try:
        ids = list(obj.Attributes.GetGroupList() or [])
    except Exception:
        return []
    names = []
    for i in ids:
        try:
            g = DOC.Groups.FindIndex(i)
            names.append(g.Name if g and g.Name else 'group%d' % i)
        except Exception:
            names.append('group%d' % i)
    return names


def describe(obj, detailed=False):
    t = type_of(obj)
    h = {'id': str(obj.Id), 'type': t}
    name = obj.Name
    if name:
        h['name'] = name
    lp = layer_path(obj)
    if lp:
        h['layer'] = lp
    mat = material_name(obj)
    if mat:
        h['material'] = mat
    if obj.IsHidden:
        h['hidden'] = True
    if obj.IsLocked:
        h['locked'] = True
    g = groups_of(obj)
    if g:
        h['groups'] = g
    geo = obj.Geometry
    try:
        if t == 'InstanceReference':
            d = obj.InstanceDefinition
            h['block'] = d.Name
            h['instances_total'] = len(d.GetReferences(1))
        elif t in ('Brep', 'Surface'):
            h['closed'] = bool(geo.IsSolid)
            h['faces'] = geo.Faces.Count
            if detailed:
                try:
                    h['volume'] = r3(geo.GetVolume()) if geo.IsSolid else None
                    h['area'] = r3(geo.GetArea())
                except Exception:
                    pass
        elif t == 'Extrusion':
            h['closed'] = bool(geo.IsSolid)
        elif t == 'Curve':
            h['closed'] = bool(geo.IsClosed)
            h['degree'] = geo.Degree
            h['length'] = r3(geo.GetLength())
            if detailed:
                h['start'] = pt(geo.PointAtStart)
                h['end'] = pt(geo.PointAtEnd)
                h['planar'] = bool(geo.IsPlanar())
        elif t == 'Mesh':
            h['vertices'] = geo.Vertices.Count
            h['faces'] = geo.Faces.Count
            h['closed'] = bool(geo.IsClosed)
        elif t == 'Point':
            h['point'] = pt(geo.Location)
        elif t == 'Light':
            h['light'] = str(geo.LightStyle)
        elif t == 'Annotation':
            try:
                h['text'] = (geo.PlainText or '')[:200]
            except Exception:
                pass
    except Exception:
        pass
    b = bbox(obj)
    if b and t not in ('Point',):
        h['bbox'] = b
    return h


def selected_objects():
    return list(DOC.Objects.GetSelectedObjects(False, False))


def selection_summary(objs=None):
    if objs is None:
        objs = selected_objects()
    by_type = {}
    for o in objs:
        t = type_of(o)
        by_type[t] = by_type.get(t, 0) + 1
    definitions = {}
    for o in objs:
        if type_of(o) == 'InstanceReference':
            d = o.InstanceDefinition
            e = definitions.setdefault(d.Name, {'name': d.Name, 'selected': 0, 'total': len(d.GetReferences(1))})
            e['selected'] += 1
    return {'count': len(objs), 'text': selection_text(objs, by_type, definitions),
            'by_type': by_type, 'definitions': list(definitions.values())}


def selection_text(objs, by_type, definitions):
    if not objs:
        return 'ничего не выделено'
    parts = []
    for name, d in definitions.items():
        s = plural(d['selected'], ('экземпляр', 'экземпляра', 'экземпляров')) + ' блока «%s»' % name
        if d['total'] > d['selected']:
            s += ' из %d' % d['total']
        parts.append(s)
    for t, n in by_type.items():
        if t == 'InstanceReference':
            continue
        words = TYPE_WORDS.get(t, TYPE_WORDS['Object'])
        s = plural(n, words)
        names = []
        for o in objs:
            if type_of(o) == t and o.Name and o.Name not in names:
                names.append(o.Name)
            if len(names) >= 3:
                break
        if names:
            s += ': ' + ', '.join(names)
            if n > len(names):
                s += '…'
        parts.append(s)
    return ', '.join(parts)


def find_object(id_text):
    try:
        g = System.Guid(str(id_text))
    except Exception:
        return None
    return DOC.Objects.FindId(g)


def active_viewport():
    v = DOC.Views.ActiveView
    return v, (v.ActiveViewport if v else None)


def camera():
    v, vp = active_viewport()
    if not vp:
        return None
    try:
        size = v.ClientRectangle
        w, h = size.Width, size.Height
    except Exception:
        w = h = None
    return {
        'view': vp.Name,
        'eye': pt(vp.CameraLocation), 'target': pt(vp.CameraTarget),
        'up': [r3(vp.CameraUp.X), r3(vp.CameraUp.Y), r3(vp.CameraUp.Z)],
        'projection': 'perspective' if vp.IsPerspectiveProjection else ('parallel' if vp.IsParallelProjection else 'two-point'),
        'lens_mm': r3(vp.Camera35mmLensLength),
        'display_mode': vp.DisplayMode.EnglishName if vp.DisplayMode else None,
        'size_px': [w, h],
    }


def png_base64(bitmap):
    ms = System.IO.MemoryStream()
    bitmap.Save(ms, System.Drawing.Imaging.ImageFormat.Png)
    data = ms.ToArray()
    ms.Dispose()
    return System.Convert.ToBase64String(data), len(data)


def app_data_dir(*parts):
    base = os.environ.get('LOCALAPPDATA') or os.path.expanduser('~')
    path = os.path.join(base, 'StultusRhino', *parts)
    if not os.path.isdir(path):
        os.makedirs(path)
    return path


def doc_content_dir():
    """Папка вложений: «<файл>-content» рядом с .3dm; у несохранённого — временная."""
    path = DOC.Path
    if path:
        base = os.path.join(os.path.dirname(path), os.path.splitext(os.path.basename(path))[0] + '-content')
    else:
        base = app_data_dir('content', 'unsaved')
    if not os.path.isdir(base):
        os.makedirs(base)
    return base


result = None
