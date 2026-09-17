# Снимок состояния документа для модели.
#
# Компактный JSON: единицы, выделение (подробно), объекты верхнего уровня с
# габаритами, слои, материалы, блоки, именованные виды, камера. Всё, что
# позволяет модели понять, с чем она работает, не запрашивая геометрию
# целиком. Глубже — через execute_python.
#
# Аргументы: full (bool) — полный снимок; иначе только единицы и выделение.
full = A.get('full', True)

sel = selected_objects()
snap = {
    'title': os.path.basename(DOC.Path) if DOC.Path else (DOC.Name or 'Без имени'),
    'path': DOC.Path or None,
    'units': units(),
    'selection_summary': selection_summary(sel),
    'selection': [describe(o, True) for o in sel[:SCENE_OBJECT_LIMIT]],
    'plugin': A.get('host_version'),
}

if full:
    settings = Rhino.DocObjects.ObjectEnumeratorSettings()
    settings.ActiveObjects = True
    settings.HiddenObjects = True
    settings.LockedObjects = True
    settings.DeletedObjects = False
    settings.IncludeLights = True
    settings.IncludeGrips = False
    objects = list(DOC.Objects.GetObjectList(settings))
    counts = {}
    for o in objects:
        t = type_of(o)
        counts[t] = counts.get(t, 0) + 1
    # Скрытые не показываем в списке (о них говорит counts), выделенные уже описаны.
    visible = [o for o in objects if not o.IsHidden]
    snap['counts'] = counts
    snap['objects'] = [describe(o) for o in visible[:SCENE_OBJECT_LIMIT]]
    snap['objects_total'] = len(visible)
    snap['truncated'] = len(visible) > SCENE_OBJECT_LIMIT

    layers = []
    for L in DOC.Layers:
        if L.IsDeleted:
            continue
        item = L.FullPath
        if not L.IsVisible:
            item += ' (скрыт)'
        if L.IsLocked:
            item += ' (заблокирован)'
        layers.append(item)
    snap['layers'] = layers[:100]
    snap['current_layer'] = DOC.Layers.CurrentLayer.FullPath

    mats = []
    for m in DOC.Materials:
        if not m.IsDeleted and m.Name:
            mats.append(m.Name)
    snap['materials'] = mats[:100]

    blocks = []
    for d in DOC.InstanceDefinitions:
        if d.IsDeleted:
            continue
        blocks.append({'name': d.Name, 'instances': len(d.GetReferences(1))})
    snap['blocks'] = blocks[:100]

    groups = []
    for g in DOC.Groups:
        if not g.IsDeleted:
            groups.append(g.Name or 'group%d' % g.Index)
    snap['groups'] = groups[:100]

    views = []
    for i in range(DOC.NamedViews.Count):
        views.append(DOC.NamedViews[i].Name)
    snap['named_views'] = views[:100]

    snap['camera'] = camera()

    try:
        b = Rhino.Geometry.BoundingBox.Empty
        for o in visible:
            bb = o.Geometry.GetBoundingBox(True)
            if bb.IsValid:
                b.Union(bb)
        snap['model_bbox'] = {'min': pt(b.Min), 'max': pt(b.Max)} if b.IsValid else None
    except Exception:
        pass

result = snap
