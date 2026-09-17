# Кадры постпродакшна на диске этого компьютера (не в файле модели).
#
# Аргументы: action:
#   store   — id, image (base64 PNG), source (base64 PNG), preview (bool)
#   chunk   — id, index, total, data (кусок полного большого кадра)
#   read    — id → image, source (base64)
#   export_to — id, path (без диалога; файл .png или папка)
#   export  — id: диалог «Сохранить как»
import re
import shutil

MAX_BYTES = 24 * 1024 * 1024
MAX_FULL_BYTES = 400 * 1024 * 1024
PNG_HEAD = b'\x89PNG\r\n\x1a\n'

action = A.get('action') or 'read'
rid = str(A.get('id') or '')
if not re.match(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', rid):
    raise Exception('Некорректный идентификатор кадра')

root = app_data_dir('renders')
target = os.path.join(root, rid + '.png')
original = os.path.join(root, rid + '-source.png')
preview = os.path.join(root, rid + '-preview.png')


def decode(value):
    if len(value or '') > MAX_BYTES * 4 // 3 + 4:
        raise Exception('Изображение слишком большое')
    data = base64.b64decode(value or '')
    if not data.startswith(PNG_HEAD) or len(data) < 24:
        raise Exception('Некорректное изображение PNG')
    return data


def stamp():
    return time.strftime('%Y%m%d_%H%M%S')


if action == 'store':
    rendered, source = decode(A.get('image')), decode(A.get('source'))
    with open(preview if A.get('preview') else target, 'wb') as f:
        f.write(rendered)
    with open(original, 'wb') as f:
        f.write(source)
    result = {'ok': True, 'id': rid}

elif action == 'chunk':
    index, total = int(A.get('index') or 0), int(A.get('total') or 0)
    part = target + '.part'
    try:
        if index < 0 or total <= 0 or index >= total:
            raise Exception('Некорректный кусок')
        data = base64.b64decode(A.get('data') or '')
        if index == 0 and os.path.exists(part):
            os.remove(part)
        if os.path.exists(part) and os.path.getsize(part) + len(data) > MAX_FULL_BYTES:
            raise Exception('Файл слишком большой')
        with open(part, 'ab') as f:
            f.write(data)
        if index != total - 1:
            result = {'ok': True, 'done': False, 'received': index + 1}
        else:
            with open(part, 'rb') as f:
                head = f.read(8)
            if head != PNG_HEAD:
                raise Exception('Собранный файл не PNG')
            if os.path.exists(target):
                os.remove(target)
            os.rename(part, target)
            result = {'ok': True, 'done': True, 'bytes': os.path.getsize(target), 'path': target}
    except Exception as e:
        if os.path.exists(part):
            os.remove(part)
        result = {'ok': False, 'error': str(e)}

elif action == 'read':
    shown = preview if os.path.isfile(preview) else target
    if not (os.path.isfile(shown) and os.path.isfile(original)):
        result = {'ok': False, 'error': 'Кадр не найден на этом компьютере.'}
    elif os.path.getsize(shown) > MAX_BYTES or os.path.getsize(original) > MAX_BYTES:
        raise Exception('Изображение слишком большое')
    else:
        with open(shown, 'rb') as f:
            img = f.read()
        with open(original, 'rb') as f:
            src = f.read()
        result = {'ok': True, 'image': base64.b64encode(img).decode('ascii'), 'source': base64.b64encode(src).decode('ascii')}

elif action == 'export_to':
    raw = (A.get('path') or '').strip()
    if not os.path.isfile(target):
        result = {'ok': False, 'error': 'Кадр не найден на этом компьютере.'}
    elif not raw:
        result = {'ok': False, 'error': 'Путь не задан.'}
    else:
        dest = os.path.abspath(os.path.expanduser(raw.replace('\\', '/')))
        if os.path.isdir(dest) or raw.endswith(('/', '\\')) or not os.path.splitext(dest)[1]:
            if not os.path.isdir(dest):
                os.makedirs(dest)
            dest = os.path.join(dest, 'stultus_%s.png' % stamp())
        else:
            d = os.path.dirname(dest)
            if d and not os.path.isdir(d):
                os.makedirs(d)
            if os.path.splitext(dest)[1].lower() != '.png':
                dest += '.png'
        shutil.copyfile(target, dest)
        result = {'ok': True, 'path': dest, 'bytes': os.path.getsize(dest)}

elif action == 'export':
    if not os.path.isfile(target):
        result = {'ok': False, 'error': 'Кадр не найден на этом компьютере.'}
    else:
        dlg = Rhino.UI.SaveFileDialog()
        dlg.Title = 'Сохранить визуализацию'
        dlg.Filter = 'PNG (*.png)|*.png'
        dlg.DefaultExt = 'png'
        dlg.FileName = 'stultus-%s.png' % rid[:8]
        if not dlg.ShowSaveDialog():
            result = {'ok': True, 'cancelled': True}
        else:
            filename = dlg.FileName
            if os.path.splitext(filename)[1].lower() != '.png':
                filename += '.png'
            if os.path.abspath(filename) != os.path.abspath(target):
                shutil.copyfile(target, filename)
            result = {'ok': True, 'path': filename}
else:
    raise Exception('Неизвестное действие: %s' % action)
