# План: Image → PDF с автоматической обработкой

## Контекст проекта

- **Runtime:** Cloudflare Workers (Hono) — Node.js API недоступен
- **Хранилище:** R2 (binding `MY_BUCKET`), D1 (binding `DB`)
- **Frontend:** Vue 3 (CDN), vanilla JS, без сборщика
- **Файлы:** `src/worker.js`, `public/app.js`, `public/app.html`, `public/style.css`
- **Существующие таблицы D1:** `objects`, `object_tags`, `documents`, `document_tags`, `usage_cache`
- **Существующие R2-префиксы:** `files/`, `thumbs/`

---

## Архитектурные решения

| Задача | Решение | Причина |
|---|---|---|
| Обработка изображения | `getImageData / putImageData` в браузере | Единственный способ в Workers-окружении |
| Preview фильтров | `ctx.filter` (CSS) | Только для визуального preview, не для экспорта |
| Генерация PDF | jsPDF через CDN | Pure JS, работает в браузере |
| Хранение оригинала каждой страницы | R2, префикс `originals/`, колонка `objects.original_key` | Для регенерации при добавлении/изменении страниц |
| Настройки коррекции | Новая колонка `correction_settings TEXT` в `documents` | Единые настройки на весь документ |
| Итоговый PDF | R2, префикс `pdfs/`, колонка `documents.pdf_key` | Перегенерируется из всех страниц при любом изменении |
| Загрузка PDF в R2 | Существующий `POST /api/objects/upload` с `content_type=application/pdf` | Переиспользование без дублирования |
| Загрузка оригинала в R2 | Существующий `POST /api/objects/upload` с префиксом `originals/` | Переиспользование без дублирования |

---

## Архитектурные ограничения — важно для будущего

### Многостраничный PDF и добавление страниц

Нельзя "дописать" страницу в существующий jsPDF-файл. При добавлении страницы в документ:
1. Загрузить оригинал новой страницы в `originals/`
2. Обработать все оригиналы (все страницы документа) заново
3. Перегенерировать PDF целиком из всех страниц
4. Перезаписать `pdfs/<docId>.pdf` в R2

Это значит: оригинал хранится **для каждой страницы** (в `objects.original_key`), а не только для документа.

### Схема хранения (R2)

```
originals/<timestamp>_<filename>  — оригинал каждой страницы (цветной, без обработки)
files/<timestamp>_<filename>      — обработанная grayscale-версия (для thumb и просмотра)
thumbs/<sha256>.jpg               — миниатюра страницы
pdfs/<docId>.pdf                  — итоговый PDF всего документа
```

### Схема хранения (D1)

```
objects.original_key TEXT         — ссылка на оригинал конкретной страницы
documents.pdf_key TEXT            — ссылка на итоговый PDF документа
documents.correction_settings TEXT — JSON: {brightness, contrast, sharpness} для всех страниц
```

### Рефакторинг uploadFiles / addFilesToDocument

Обе функции (~70 строк каждая) дублируют логику. При добавлении шага обработки изображения
нужно вынести общую логику в одну функцию `processAndUploadPages(files, docId?)`.

### Камера девайса

`getUserMedia()` + `<video>` элемент — отдельный модальный компонент. Источник (файл / камера)
не влияет на пайплайн обработки: изображение из камеры проходит тот же путь, что и из файловой системы.
На мобильных как fallback работает `<input capture="environment">`.

---

## Пайплайн автоматической обработки (браузер)

```
Оригинал (JPG/PNG — из файловой системы или с камеры)
    ↓
1. decode: FileReader / ImageCapture → Image → drawImage на offscreen canvas (полное разрешение)
    ↓
2. grayscale: getImageData → pixel[i] = 0.299R + 0.587G + 0.114B (luminance)
    ↓
3. auto-normalize: найти реальный min/max яркости → растянуть диапазон до 0–255
    ↓
4. auto-brightness: вычислить mean яркости; если < 120 → сдвинуть вверх, если > 180 → вниз
    ↓
5. auto-contrast: fine-tune вокруг среднего (после normalize)
    ↓
6. light unsharp mask: фиксированные параметры (radius=1, amount=0.3) — не регулируется
    ↓
7. putImageData → показать в <canvas> preview
    ↓
8. Вычислить авто-значения для слайдеров (brightness delta, contrast factor, sharpen %)
    ↓
9. Открыть модальное окно с preview и слайдерами
```

**Важно:** шаги 2–6 работают с `getImageData` (пиксельные операции), а не с `ctx.filter`.
`ctx.filter` используется только для мгновенного preview при движении слайдеров.

---

## Ручные слайдеры (после авто-обработки)

| Параметр | Диапазон | Формула применения |
|---|---|---|
| Яркость | -50 … +50 | `pixel += delta` (clamp 0–255) |
| Контраст | -50 … +50 | `pixel = 128 + (pixel - 128) * factor` |
| Резкость | 0 … 100% | сила unsharp mask |

Слайдеры инициализируются авто-вычисленными значениями. Цвет не доступен (grayscale обязателен).

---

## Авто-подбор качества JPEG (перед генерацией PDF)

```
Цель: ≤ 500KB на страницу, max 1MB

quality = 0.85 → canvas.toBlob()
  blob.size > 1MB   → quality = 0.70, повтор
  blob.size > 500KB → quality = 0.80, повтор
  blob.size ≤ 500KB → принять

Если при quality=0.70 > 1MB → показать предупреждение (очень большое изображение)
```

---

## UX-флоу

```
1. Пользователь выбирает файлы (кнопка / drag-drop / камера)
2. Для каждого файла — автоматическая обработка (grayscale + normalize + auto-brightness + sharpen)
   → индикатор прогресса "Обработка..."
3. Модальное окно (по одному изображению за раз, или общие настройки для пакета):
   ┌───────────────────────────────────────────┐
   │  [Canvas preview]   │  Яркость:  [──●───] │
   │                     │  Контраст: [───●──] │
   │                     │  Резкость: [──●───] │
   │                     │                     │
   │  Стр. 1 из 3        │  Размер PDF: ~340KB │
   │                     │                     │
   │  [Отмена]           │  [Сохранить]        │
   └───────────────────────────────────────────┘
   - Индикатор размера обновляется при изменении слайдеров
   - Слайдеры показывают авто-значения (можно двигать)
   - При нескольких файлах: настройки применяются ко всем страницам
4. "Сохранить" →
   a. Для каждой страницы: авто-подбор quality → canvas.toBlob()
   b. Загрузить оригиналы в R2: originals/<timestamp>_<filename>  (сохраняется в objects.original_key)
   c. Загрузить обработанные версии в R2: files/<timestamp>_<filename>
   d. Сгенерировать единый PDF из всех страниц (jsPDF, addPage() для каждой)
   e. Загрузить PDF в R2: pdfs/<docId>.pdf  (сохраняется в documents.pdf_key)
   f. Сохранить настройки в D1 (correction_settings JSON)
   g. Открыть окно тегов (существующий UI)
5. Готово — документ появляется в списке
```

---

## Изменения в D1 (schema)

### В таблице `documents` (добавить 2 колонки):

```sql
ALTER TABLE documents ADD COLUMN pdf_key TEXT;
ALTER TABLE documents ADD COLUMN correction_settings TEXT;
```

### В таблице `objects` (добавить 1 колонку):

```sql
ALTER TABLE objects ADD COLUMN original_key TEXT;
```

**Реализация в коде:** добавить в `ensureSchema()` в `worker.js` (аналогично существующим `ALTER TABLE`):

```javascript
// В блоке проверки колонок objects (уже есть document_id, page_number):
if (!colNames.has("original_key")) {
  await db.prepare("ALTER TABLE objects ADD COLUMN original_key TEXT").run();
}

// Новый блок для documents:
const docCols = await db.prepare("PRAGMA table_info(documents)").all();
const docColNames = new Set((docCols.results || []).map((r) => r.name));
if (!docColNames.has("pdf_key")) {
  await db.prepare("ALTER TABLE documents ADD COLUMN pdf_key TEXT").run();
}
if (!docColNames.has("correction_settings")) {
  await db.prepare("ALTER TABLE documents ADD COLUMN correction_settings TEXT").run();
}
```

---

## Новые API-эндпоинты в worker.js

### `GET /api/documents/:id/pdf-settings`
Возвращает `correction_settings`, `pdf_key` и список `original_key` всех страниц — для регенерации.

```json
{
  "pdf_key": "pdfs/doc_123.pdf",
  "correction_settings": {"brightness": 10, "contrast": 5, "sharpness": 30},
  "pages": [
    {"key": "files/...", "original_key": "originals/...", "page_number": 1},
    {"key": "files/...", "original_key": "originals/...", "page_number": 2}
  ]
}
```

### `PUT /api/documents/:id/pdf`
Body JSON: `{ pdf_key: "pdfs/...", correction_settings: {...} }`

Обновляет `documents.pdf_key` и `documents.correction_settings`. Также обновляет `objects.original_key`
для каждой страницы через отдельный массив `pages: [{key, original_key}]`.

> Загрузка файлов (оригиналов и PDF) идёт через существующий `POST /api/objects/upload`.

---

## Регенерация PDF

```
1. Кнопка "Редактировать обработку" на карточке документа
2. GET /api/documents/:id/pdf-settings → получить correction_settings + original_key всех страниц
3. Для каждой страницы: GET /api/objects/download-url?key=<original_key> → загрузить оригинал
4. Применить сохранённые настройки → открыть модальное окно
5. "Сохранить" →
   a. Обработать все страницы → единый PDF
   b. Загрузить в R2: pdfs/<docId>.pdf (перезаписать)
   c. PUT /api/documents/:id/pdf
```

---

## Список файлов для изменения

| Файл | Изменения |
|---|---|
| `src/worker.js` | 1. В `ensureSchema()`: ALTER TABLE — `original_key` в `objects`, `pdf_key` + `correction_settings` в `documents` |
| `src/worker.js` | 2. Новый эндпоинт `GET /api/documents/:id/pdf-settings` |
| `src/worker.js` | 3. Новый эндпоинт `PUT /api/documents/:id/pdf` |
| `src/worker.js` | 4. Обновить `POST /api/documents/:id/pages` — принимать и сохранять `original_key` для каждой страницы |
| `public/app.html` | 5. Добавить jsPDF через CDN (рядом с pdf.js) |
| `public/app.html` | 6. Разметка модального окна image-to-pdf (canvas + 3 слайдера + индикатор размера) |
| `public/app.html` | 7. Кнопка камеры + `<video>` элемент для `getUserMedia` |
| `public/app.js` | 8. Рефакторинг: объединить `uploadFiles` и `addFilesToDocument` в `processAndUploadPages(files, docId?)` |
| `public/app.js` | 9. Функция `autoProcessImage(imageData)`: grayscale → normalize → auto-brightness → sharpen |
| `public/app.js` | 10. Логика слайдеров: применение дельт поверх авто-результата + preview через `ctx.filter` |
| `public/app.js` | 11. Авто-подбор quality + генерация единого PDF из всех страниц (jsPDF + addPage) |
| `public/app.js` | 12. Загрузка: оригиналы → `originals/`, обработанные → `files/`, PDF → `pdfs/`, сохранение в D1 |
| `public/app.js` | 13. Кнопка и логика регенерации на карточке документа |
| `public/app.js` | 14. Модальный компонент камеры (`getUserMedia` + `<video>` + capture) |
| `public/style.css` | 15. Стили модального окна image-to-pdf и компонента камеры |

---

## Порядок выполнения

- [x] **Шаг 1:** `worker.js` — добавить ALTER TABLE в `ensureSchema()` (3 колонки)
- [x] **Шаг 2:** `worker.js` — добавить `GET /api/documents/:id/pdf-settings`
- [x] **Шаг 3:** `worker.js` — добавить `PUT /api/documents/:id/pdf`
- [x] **Шаг 4:** `worker.js` — обновить `POST /api/documents/:id/pages` для `original_key`; добавить `pdf_key` в `GET /api/documents`
- [x] **Шаг 5:** `app.js` — рефакторинг: `uploadFiles` + `addFilesToDocument` → `processAndUploadPages`
- [x] **Шаг 6:** `app.js` — `autoProcessImageData`: grayscale → normalize → auto-brightness; `applySliderDeltas`: brightness/contrast/unsharp mask
- [x] **Шаг 7:** `app.html` + `app.js` — модальное окно image-to-pdf (canvas + 3 слайдера + индикатор размера)
- [x] **Шаг 8:** `app.js` — `autoPickQuality` (0.85→0.80→0.72→0.60, цель ≤500KB); `renderPdfBlob` (jsPDF + addPage)
- [x] **Шаг 9:** `app.js` — полная загрузка: оригиналы → `originals/`, обработанные → `files/`, PDF → `pdfs/`; регистрация в D1
- [x] **Шаг 10:** `app.js` + `app.html` — кнопка «Re-process PDF» в меню карточки (только если `pdf_key` есть); функция `regeneratePdf`
- [ ] **Шаг 11:** `app.js` + `app.html` + `style.css` — модальный компонент камеры *(отложено)*
- [x] **Шаг 12:** `style.css` — стили модального окна и адаптив

---

## Ограничения и заметки

- `ctx.filter` не применяется в `toBlob()` — для экспорта использовать только `putImageData`
- Максимальный размер PDF на страницу: цель 500KB, допустимо до 1MB
- jsPDF CDN: `https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js`
- Оригинал хранится в `originals/`, обработанная версия в `files/`, PDF в `pdfs/`
- Добавление страницы = перегенерация PDF целиком (нельзя дописать в существующий jsPDF)
- `getUserMedia` требует HTTPS — в Cloudflare Workers всегда HTTPS, проблем нет
- На мобильных без поддержки `getUserMedia`: fallback на `<input capture="environment">`
- Grayscale — обязательный первый шаг, не регулируется пользователем
