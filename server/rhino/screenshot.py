# Снимок активного вьюпорта.
#
# Снимается только после согласия пользователя — кнопка в окне чата. Модель
# может попросить стандартный вид (perspective/top/front/right/back/left/bottom),
# «показать всё» и режим отображения: тогда камера и режим переставляются
# ПЕРЕД снимком, а после — возвращаются, чтобы не сбивать человеку ракурс.
#
# Аргументы: view, zoom_extents, display_mode, width, height,
#   framing == 'viewport' — точный кадр вьюпорта (постпродакшн): пропорции и
#   кадрирование как на экране; width задаёт ширину офскрин-снимка (большой кадр).
from Rhino.Display import DefinedViewportProjection, DisplayModeDescription

VIEWS = {
    'perspective': DefinedViewportProjection.Perspective, 'top': DefinedViewportProjection.Top,
    'bottom': DefinedViewportProjection.Bottom, 'front': DefinedViewportProjection.Front,
    'back': DefinedViewportProjection.Back, 'left': DefinedViewportProjection.Left,
    'right': DefinedViewportProjection.Right,
}
MAX_WIDTH = 7680

view, vp = active_viewport()
if not vp:
    raise Exception('Нет активного вьюпорта.')

framing = A.get('framing')
view_name = (A.get('view') or '').lower()
zoom_extents = bool(A.get('zoom_extents'))
mode_name = A.get('display_mode')

saved = Rhino.DocObjects.ViewportInfo(vp)
saved_mode = vp.DisplayMode
saved_name = vp.Name
changed = False
try:
    if view_name in VIEWS:
        vp.SetProjection(VIEWS[view_name], None, True)
        vp.ZoomExtents()
        changed = True
    elif zoom_extents:
        vp.ZoomExtents()
        changed = True
    if mode_name:
        dm = None
        for d in DisplayModeDescription.GetDisplayModes():
            if d.EnglishName.lower() == str(mode_name).lower() or (d.LocalName or '').lower() == str(mode_name).lower():
                dm = d
                break
        if dm is None:
            raise Exception('Нет режима отображения «%s». Есть: %s' % (mode_name, ', '.join(d.EnglishName for d in DisplayModeDescription.GetDisplayModes())))
        vp.DisplayMode = dm
        changed = True
    if changed:
        view.Redraw()

    rect = view.ClientRectangle
    vw, vh = max(1, rect.Width), max(1, rect.Height)
    if framing == 'viewport':
        w = int(A.get('width') or 0)
        if w > 0:
            w = max(320, min(MAX_WIDTH, w))
            h = int(round(w * vh / float(vw)))
        else:
            w, h = vw, vh
    else:
        w = int(A.get('width') or 1280)
        h = int(A.get('height') or 800)
    bmp = view.CaptureToBitmap(System.Drawing.Size(w, h))
    if bmp is None:
        raise Exception('CaptureToBitmap не вернул изображение.')
    b64, size = png_base64(bmp)
    bmp.Dispose()
    result = {'ok': True, 'mime': 'image/png', 'base64': b64, 'width': w, 'height': h, 'bytes': size,
              'framing': 'viewport' if framing == 'viewport' else 'custom', 'camera': camera()}
finally:
    if changed:
        try:
            vp.SetViewProjection(saved, True)
            # SetProjection переименовывает вьюпорт (Top, Front…) — возвращаем имя.
            if vp.Name != saved_name:
                vp.Name = saved_name
            if mode_name and saved_mode:
                vp.DisplayMode = saved_mode
            view.Redraw()
        except Exception:
            pass
