# -*- coding: utf-8 -*-
# Станция метро KAFD (King Abdullah Financial District), Эр-Рияд, Заха Хадид —
# параметрическая модель для Python 3 компонента Grasshopper.
#
# Входы (слайдеры): floors (этажность), floor_h (высота этажа, м), length,
# width (габарит в плане, м), roof (запас высоты над верхним этажом, м),
# lattice_n (ячеек решётки вдоль), lattice_m (поперёк), rod (радиус прута, м),
# bake (переключатель: запечь геометрию в документ Rhino на слои KAFD::*).
# Выходы: shell (оболочка, Brep), lattice (решётка, Mesh), slabs (плиты этажей,
# Brep), cores (ядра, Brep), columns (колонны, Brep), info (текст).
#
# Всё считается от этажности: высота здания H = floors*floor_h + roof, плиты —
# сечения оболочки на каждой отметке, ядра и колонны — до верхней плиты.
# Единицы — метры (документ в метрах).
import math
import Rhino
import Rhino.Geometry as rg
import scriptcontext as sc

TOL = 0.01

def val(x, d):
    try:
        return float(x) if x is not None else d
    except Exception:
        return d

floors = max(1, int(val(floors, 6)))
floor_h = max(2.5, val(floor_h, 6.0))
length = max(30.0, val(length, 130.0))
width = max(20.0, val(width, 70.0))
roof = max(0.0, val(roof, 6.0))
lattice_n = max(6, int(val(lattice_n, 26)))
lattice_m = max(3, int(val(lattice_m, 9)))
rod = max(0.05, val(rod, 0.45))
bake = bool(bake) if 'bake' in dir() else False

H = floors * floor_h + roof

# ---- оболочка: лофт по сечениям вдоль X ---------------------------------
# Профиль сечения — «дюна»: у земли широкий, к гребню сужается; гребень
# смещён к одному концу (асимметрия KAFD), концы заострены.
def profile(t):
    """t в [0,1] вдоль длины. Возвращает (полуширина, высота) сечения."""
    # Огибающая плана — суперэллипс с заострёнными концами.
    e = 1.0 - abs(2 * t - 1) ** 2.6
    half_w = 0.5 * width * max(0.06, e ** 0.75)
    # Гребень: максимум на t≈0.6, плавно к концам.
    crest = math.exp(-((t - 0.6) / 0.42) ** 2)
    h = H * max(0.12, 0.28 + 0.72 * crest) * max(0.15, e ** 0.35)
    return half_w, h

def section(t):
    x = (t - 0.5) * length
    hw, h = profile(t)
    # Сечение в плоскости YZ: наклонные стены, скруглённая макушка, выпуклость наружу.
    pts = []
    n = 24
    for i in range(n + 1):
        a = -math.pi / 2 + math.pi * i / n          # от -90° до +90°
        # Суперэллипс в сечении: |y/hw|^p + |z/h|^p = 1, p=2.3 — «пухлые» стены.
        p = 2.3
        cy = math.copysign(abs(math.cos(a)) ** (2.0 / p), math.cos(a))
        cz = abs(math.sin(a)) ** (2.0 / p)
        y = hw * cy
        z = h * cz
        # Лёгкий наклон стен внутрь у гребня и волна по длине.
        y *= 1.0 - 0.18 * (z / max(h, 1e-6)) ** 2
        pts.append(rg.Point3d(x, y, z))
    return rg.Curve.CreateInterpolatedCurve(pts, 3)

N_SEC = 15
sections = [section(0.02 + 0.96 * i / (N_SEC - 1)) for i in range(N_SEC)]
loft = rg.Brep.CreateFromLoft(sections, rg.Point3d.Unset, rg.Point3d.Unset, rg.LoftType.Normal, False)
shell = None
if loft and len(loft) > 0:
    shell = loft[0]
    # Закрыть торцы плоскими крышками и низ — оболочка становится телом.
    capped = shell.CapPlanarHoles(TOL)
    if capped is not None:
        shell = capped

# ---- решётка: диагрид по поверхности оболочки -----------------------------
lattice = []
srf = None
if shell is not None:
    # Первая грань лофта — сама оболочка (крышки добавлены позже).
    face = shell.Faces[0]
    srf = face.ToNurbsSurface()
    du, dv = srf.Domain(0), srf.Domain(1)

    def sp(u, v):
        return srf.PointAt(du.ParameterAt(u), dv.ParameterAt(v))

    def polyline_on_surface(uv_pts, steps=6):
        pts = []
        for k in range(len(uv_pts) - 1):
            (u0, v0), (u1, v1) = uv_pts[k], uv_pts[k + 1]
            for s in range(steps):
                f = s / float(steps)
                pts.append(sp(u0 + (u1 - u0) * f, v0 + (v1 - v0) * f))
        pts.append(sp(*uv_pts[-1]))
        return rg.Polyline(pts).ToNurbsCurve()

    rails = []
    # Диагонали в двух направлениях (ромбическая сетка), как ажур KAFD.
    for i in range(-lattice_m, lattice_n + 1):
        uv1 = []
        uv2 = []
        for j in range(lattice_m + 1):
            u = (i + j) / float(lattice_n)
            v = j / float(lattice_m)
            if 0.0 <= u <= 1.0:
                uv1.append((u, v))
            u2 = (i + lattice_m - j) / float(lattice_n)
            if 0.0 <= u2 <= 1.0:
                uv2.append((u2, v))
        if len(uv1) > 1:
            rails.append(polyline_on_surface(uv1))
        if len(uv2) > 1:
            rails.append(polyline_on_surface(uv2))
    # Кольца по высоте — на отметках этажей (структура читает этажность).
    for f_i in range(1, floors + 1):
        v = min(0.98, f_i * floor_h / H)
        rails.append(polyline_on_surface([(u / 40.0, v) for u in range(41)], steps=2))
    for c in rails:
        m = rg.Mesh.CreateFromCurvePipe(c, rod, 8, 12, rg.MeshPipeCapStyle.Flat, False)
        if m is not None:
            lattice.append(m)

# ---- плиты этажей: горизонтальные сечения оболочки, с отступом ------------
slabs = []
slab_t = 0.4
inset = 1.2
if shell is not None:
    for i in range(floors):
        z = i * floor_h
        plane = rg.Plane(rg.Point3d(0, 0, z + slab_t), rg.Vector3d.ZAxis)
        contours = rg.Brep.CreateContourCurves(shell, plane) if z > 0 else [rg.Curve.JoinCurves([sections[0]])[0]] if False else rg.Brep.CreateContourCurves(shell, plane)
        crvs = [c for c in (contours or []) if c.IsClosed]
        if not crvs:
            continue
        outer = max(crvs, key=lambda c: rg.AreaMassProperties.Compute(c).Area)
        off = outer.Offset(plane, -inset, TOL, rg.CurveOffsetCornerStyle.Round)
        outline = off[0] if off and len(off) == 1 else outer
        planar = rg.Brep.CreatePlanarBreps([outline], TOL)
        if not planar:
            continue
        slab = planar[0]
        # Толщина плиты — выдавливание вниз.
        ext = rg.Extrusion.Create(outline, -slab_t, True)
        if ext is not None:
            b = ext.ToBrep()
            if b is not None:
                slab = b
        # Атриум: центральный вырез на верхних плитах (кроме первой).
        if i > 0:
            hole_w = min(width, length) * 0.16
            hole = rg.Circle(rg.Plane(rg.Point3d(length * 0.05, 0, z + slab_t + 1), rg.Vector3d.ZAxis), hole_w)
            cyl = rg.Cylinder(rg.Circle(rg.Plane(rg.Point3d(length * 0.05, 0, z - 1), rg.Vector3d.ZAxis), hole_w), slab_t + 3).ToBrep(True, True)
            diff = rg.Brep.CreateBooleanDifference(slab, cyl, TOL)
            if diff and len(diff) == 1:
                slab = diff[0]
        slabs.append(slab)

# ---- ядра и колонны: до верхней плиты (высота от этажности) -----------------
top_z = (floors - 1) * floor_h + slab_t
cores = []
for cx in (-length * 0.22, length * 0.3):
    core_pl = rg.Plane(rg.Point3d(cx, 0, 0), rg.Vector3d.ZAxis)
    r = rg.Rectangle3d(core_pl, rg.Interval(-5, 5), rg.Interval(-7, 7)).ToNurbsCurve()
    ext = rg.Extrusion.Create(r, top_z + floor_h * 0.5, True)
    if ext is not None:
        cores.append(ext.ToBrep())

columns = []
col_r = 0.6
nx = max(2, int(length / 12.0))
ny = max(1, int(width / 14.0))
for ix in range(nx + 1):
    for iy in range(ny + 1):
        x = -length * 0.42 + length * 0.84 * ix / nx
        y = -width * 0.3 + width * 0.6 * iy / ny
        # Колонна только внутри плана первого этажа.
        t = (x / length) + 0.5
        hw, _ = profile(min(0.98, max(0.02, t)))
        if abs(y) > hw * 0.75:
            continue
        cyl = rg.Cylinder(rg.Circle(rg.Plane(rg.Point3d(x, y, 0), rg.Vector3d.ZAxis), col_r), top_z)
        columns.append(cyl.ToBrep(True, True))

info = 'KAFD: этажей %d × %.1f м + крыша %.1f = %.1f м; план %.0f × %.0f м; плит %d, прутьев %d, колонн %d' % (
    floors, floor_h, roof, H, length, width, len(slabs), len(lattice), len(columns))

# ---- запечь в документ Rhino (по переключателю) ------------------------------
if bake:
    doc = Rhino.RhinoDoc.ActiveDoc
    sc.doc = doc
    layers = {'KAFD::Оболочка': ([shell] if shell else [], (150, 190, 220)),
              'KAFD::Решётка': (lattice, (245, 245, 240)),
              'KAFD::Плиты': (slabs, (200, 200, 200)),
              'KAFD::Ядра': (cores, (160, 160, 160)),
              'KAFD::Колонны': (columns, (170, 170, 170))}
    import System.Drawing as SD
    parent = doc.Layers.FindByFullPath('KAFD', -1)
    if parent < 0:
        parent = doc.Layers.Add('KAFD', SD.Color.Black)
    parent_id = doc.Layers[parent].Id
    for full, (geos, col) in layers.items():
        idx = doc.Layers.FindByFullPath(full, -1)
        if idx < 0:
            lay = Rhino.DocObjects.Layer()
            lay.Name = full.split('::')[1]
            lay.ParentLayerId = parent_id
            lay.Color = SD.Color.FromArgb(*col)
            idx = doc.Layers.Add(lay)
        # Старая выпечка — прочь.
        for o in list(doc.Objects.FindByLayer(doc.Layers[idx])) or []:
            doc.Objects.Delete(o, True)
        attr = Rhino.DocObjects.ObjectAttributes()
        attr.LayerIndex = idx
        attr.Name = full.split('::')[1]
        for g in geos:
            if g is None:
                continue
            if isinstance(g, rg.Mesh):
                doc.Objects.AddMesh(g, attr)
            else:
                doc.Objects.AddBrep(g, attr)
    doc.Views.Redraw()
    sc.doc = ghdoc if 'ghdoc' in dir() else sc.doc
