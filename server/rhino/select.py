# Инструмент модели: выделить объекты по id.
# Аргументы: ids (list[str GUID]), mode: replace | add | clear, zoom (bool).
ids = A.get('ids') or []
mode = (A.get('mode') or 'replace')
zoom = bool(A.get('zoom'))

if mode == 'clear':
    DOC.Objects.UnselectAll()
    DOC.Views.Redraw()
    result = {'ok': True, 'selected': 0, 'text': 'ничего не выделено'}
else:
    if mode != 'add':
        DOC.Objects.UnselectAll()
    found, missing, skipped = [], [], []
    for i in ids:
        o = find_object(i)
        if o is None:
            missing.append(str(i))
        elif o.IsHidden or o.IsLocked:
            skipped.append(str(i))
        else:
            o.Select(True)
            found.append(o)
    if zoom:
        v, vp = active_viewport()
        if vp and found:
            vp.ZoomExtentsSelected()
    DOC.Views.Redraw()
    sel = selected_objects()
    r = {'ok': True, 'selected': len(sel), 'text': selection_summary(sel)['text']}
    if missing:
        r['missing_ids'] = missing
    if skipped:
        r['hidden_or_locked_ids'] = skipped
    result = r
