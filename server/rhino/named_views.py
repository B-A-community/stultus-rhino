# Именованные виды (Named Views) как инструмент модели: list, activate, add,
# update, delete. Только штатный API Rhino.
# Аргументы: action, name.
action = (A.get('action') or 'list').lower()
name = (A.get('name') or '').strip()
table = DOC.NamedViews


def listing():
    items = []
    for i in range(table.Count):
        vi = table[i]
        cam = vi.Viewport
        items.append({'name': vi.Name, 'eye': pt(cam.CameraLocation), 'target': pt(cam.TargetPoint),
                      'projection': 'perspective' if cam.IsPerspectiveProjection else 'parallel'})
    return items


def find(n):
    if not n:
        return -1
    i = table.FindByName(n)
    if i >= 0:
        return i
    for k in range(table.Count):
        if table[k].Name.lower() == n.lower():
            return k
    return -1


view, vp = active_viewport()
if action == 'list':
    result = {'ok': True, 'views': listing()}
elif action == 'activate':
    i = find(name)
    if i < 0:
        raise Exception('Вида «%s» нет. Есть: %s' % (name, ', '.join(v['name'] for v in listing()) or 'ни одного'))
    if not view:
        raise Exception('Нет активного вьюпорта.')
    table.Restore(i, view, False)
    view.Redraw()
    result = {'ok': True, 'activated': table[i].Name, 'camera': camera()}
elif action == 'add':
    if not name:
        raise Exception('Нужно имя вида.')
    if find(name) >= 0:
        raise Exception('Вид «%s» уже есть — используй update или другое имя.' % name)
    if not vp:
        raise Exception('Нет активного вьюпорта.')
    i = table.Add(name, vp.Id)
    if i < 0:
        raise Exception('Rhino не сохранил вид.')
    result = {'ok': True, 'added': name, 'views': listing()}
elif action == 'update':
    i = find(name)
    if i < 0:
        raise Exception('Вида «%s» нет.' % name)
    if not vp:
        raise Exception('Нет активного вьюпорта.')
    real = table[i].Name
    table.Delete(i)
    table.Add(real, vp.Id)
    result = {'ok': True, 'updated': real}
elif action == 'delete':
    i = find(name)
    if i < 0:
        raise Exception('Вида «%s» нет.' % name)
    real = table[i].Name
    table.Delete(i)
    result = {'ok': True, 'deleted': real, 'views': listing()}
else:
    raise Exception('Неизвестное действие: %s. Есть list, activate, add, update, delete.' % action)
