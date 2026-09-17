# Вложения пользователя (картинки к сообщению).
#
# Оригинал сохраняется как есть — без пережатия — в папку рядом с файлом
# модели: «<имя проекта>-content» (для «Дом.3dm» → «Дом-content»). У
# несохранённого документа папка во временном месте пользователя. Модели
# уходит именно оригинал; миниатюра только для ленты в окне.
#
# Аргументы: action: save | read; name, base64 (save); path (read).
import re

action = A.get('action') or 'save'

if action == 'save':
    data = base64.b64decode(A.get('base64') or '')
    if not data:
        raise Exception('Пустой файл')
    safe = re.sub(r'[\\/:*?"<>|]+', '_', os.path.basename(A.get('name') or ''))
    if not safe or safe == '_':
        safe = 'image_%s.png' % time.strftime('%Y%m%d_%H%M%S')
    d = doc_content_dir()
    path = os.path.join(d, safe)
    if os.path.exists(path):
        root, ext = os.path.splitext(safe)
        path = os.path.join(d, '%s_%s%s' % (root, time.strftime('%H%M%S'), ext))
    with open(path, 'wb') as f:
        f.write(data)
    result = {'ok': True, 'path': path, 'dir': d, 'bytes': len(data)}
elif action == 'read':
    path = A.get('path') or ''
    if not os.path.isfile(path):
        raise Exception('Файл не найден')
    with open(path, 'rb') as f:
        data = f.read()
    result = {'ok': True, 'base64': base64.b64encode(data).decode('ascii'), 'bytes': len(data)}
else:
    raise Exception('Неизвестное действие: %s' % action)
