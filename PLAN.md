# План: Многостраничные документы при загрузке

## Суть задачи

Одновременная загрузка нескольких файлов должна создавать один **многостраничный документ**. Все файлы — страницы одного документа. Отображение в списке — одна карточка со специальной иконкой. Клик → список страниц → клик по странице → полноэкранный просмотр со стрелками влево/вправо.

## Текущее состояние

- Загрузка: последовательная, по одному файлу в цикле `for` (`app.js:322-380`)
- Каждый файл регистрируется отдельно в D1 через `POST /api/objects/register`
- Превью генерируется для каждого файла
- Теги запрашиваются один раз на партию (уже работает)
- Ошибка на любом файле прерывает цикл, но уже загруженные в R2 файлы не удаляются
- БД: таблицы `objects` и `object_tags`, схема создаётся в `ensureSchema` (`worker.js:83-112`)
- Файлы в R2: ключи вида `files/{timestamp}_{filename}`, превью — `thumbs/{hash}.{ext}`

## Архитектурное решение

### Концепция: Document → Pages

Всё становится документом. Одиночный файл — документ с 1 страницей. Пакет файлов — документ с N страницами.

### Схема БД (изменения в `ensureSchema`)

**Новая таблица `documents`:**
```sql
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,           -- "doc_{timestamp}_{random}"
  title TEXT NOT NULL,            -- имя первого файла или общее название
  page_count INTEGER NOT NULL DEFAULT 1,
  uploaded_at INTEGER NOT NULL,
  thumb_key TEXT                  -- ключ превью в R2 (от первого по алфавиту файла)
);
```

**Новая таблица `document_tags`:**
```sql
CREATE TABLE IF NOT EXISTS document_tags (
  document_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (document_id, tag)
);
```

**Добавить колонки в `objects`:**
```sql
ALTER TABLE objects ADD COLUMN document_id TEXT;
ALTER TABLE objects ADD COLUMN page_number INTEGER;
```

> D1 (Cloudflare) поддерживает `ALTER TABLE ADD COLUMN`. Выполняется в `ensureSchema` с проверкой через `PRAGMA table_info`.

**Обратная совместимость:** существующие записи в `objects` без `document_id` обрабатываются на лету — для них создаётся виртуальный document_id = key, page_number = 1. Миграция данных не требуется.

**Индексы:**
```sql
CREATE INDEX IF NOT EXISTS idx_objects_document ON objects(document_id);
CREATE INDEX IF NOT EXISTS idx_documents_uploaded ON documents(uploaded_at);
CREATE INDEX IF NOT EXISTS idx_document_tags_tag ON document_tags(tag);
CREATE INDEX IF NOT EXISTS idx_document_tags_doc ON document_tags(document_id);
```

### Backend (`worker.js`)

#### Новые эндпоинты

1. **`POST /api/documents/register`** — создать документ и зарегистрировать все страницы
   - Тело: `{ id, title, pages: [{ key, filename, content_type, size, page_number }], tags, thumb_key }`
   - В одной D1 batch-операции: INSERT в `documents`, INSERT всех `objects`, INSERT тегов
   - Ответ: `{ success: true, document_id }`

2. **`GET /api/documents`** — список документов (замена `GET /api/objects` для главного списка)
   - Параметр `?tag=` для фильтрации по тегам
   - JOIN с `document_tags`, GROUP_CONCAT тегов
   - Ответ: `{ documents: [{ id, title, page_count, uploaded_at, thumb_key, tags }] }`

3. **`GET /api/documents/:id/pages`** — список страниц документа
   - SELECT из `objects WHERE document_id=? ORDER BY page_number`
   - Ответ: `{ pages: [{ key, filename, content_type, size, page_number, thumb_key }] }`

4. **`DELETE /api/documents/:id`** — удалить документ целиком
   - Удалить все файлы страниц из R2
   - Удалить превью из R2
   - Удалить записи из `objects`, `document_tags`, `documents`

5. **`PUT /api/documents/:id/tags`** — обновить теги документа
   - DELETE + INSERT в `document_tags`

#### Модификация существующих

- **`GET /api/objects`** — оставить для внутреннего использования (получение страниц), но главный список переключить на `GET /api/documents`
- **`POST /api/objects/register`** — оставить без изменений (используется для одиночных операций)
- **`DELETE /api/objects/:key`** — при удалении объекта проверить, является ли он частью документа; если да и это единственная страница — удалить документ
- **Теговые эндпоинты** (`/api/tags/top`, `/api/tags/all`, `/api/tags/related`) — переключить на `document_tags` вместо `object_tags`

### Frontend (`app.js`)

#### Загрузка — новая логика `uploadFiles`

```
1. Получить список файлов, отфильтровать File
2. Сортировать по имени файла (алфавитный порядок)
3. Запросить теги (один раз) — уже работает
4. uploading = true, uploadProgress = 0
5. Загрузить все файлы в R2 последовательно:
   for each file:
     POST /api/objects/upload → получить key
     сохранить key в массив uploadedKeys
     uploadProgress = (i+1) / total
6. Если ошибка на любом файле →
     удалить все уже загруженные файлы из R2 (DELETE /api/objects/:key)
     показать сообщение об ошибке
     uploading = false
     return
7. Сгенерировать превью только для первого по алфавиту файла
8. Загрузить превью в R2 (POST /api/objects/thumb-upload)
9. Создать документ:
     POST /api/documents/register {
       id: "doc_{timestamp}_{random}",
       title: firstFileName,
       pages: [{ key, filename, content_type, size, page_number }],
       tags,
       thumb_key
     }
10. Если ошибка →
      удалить все файлы из R2
      удалить превью из R2
      показать ошибку
11. refreshAll()
12. uploading = false
```

**Откат (rollback):** массив `uploadedKeys` накапливается по мере загрузки. При ошибке — все загруженные ключи удаляются через `DELETE /api/objects/:key`.

**Опциональная параллельность:** вместо последовательного `for` можно использовать `Promise.all` с ограничением конкурентности (например, 3 одновременных запроса). Это ускорит загрузку больших пакетов. Реализуется через простой пул:

```js
const uploadWithConcurrency = async (files, concurrency = 3) => {
  const results = [];
  let index = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (index < files.length) {
      const i = index++;
      results[i] = await uploadOne(files[i]);
    }
  });
  await Promise.all(workers);
  return results;
};
```

Решение: начать с последовательной загрузки (надёжность), добавить параллельность как оптимизацию если потребуется.

**Отображение ошибки:** новый ref `uploadError` (string), показывается в `.upload-section` красным цветом. Сбрасывается при начале новой загрузки.

#### Список файлов — отображение документов

- `fetchFiles` → `fetchDocuments` (запрос к `GET /api/documents`)
- Каждая карточка в grid — документ
- **Специальная иконка для multi-page:** бейдж с количеством страниц в углу карточки (например "3 pages" или "📄×3")
- Для single-page документов — обычное отображение (без бейджа)
- Превью документа — `thumb_key` первого по алфавиту файла

#### Клик по документу — список страниц

Новый режим отображения: `documentView` (modal или overlay)

- При клике на карточку документа:
  - Если page_count === 1 → сразу открыть viewer
  - Если page_count > 1 → открыть overlay со списком страниц
- Overlay: сетка миниатюр страниц (как files-grid, но в модале)
- Каждая страница — карточка с номером страницы и превью/иконкой
- Клик по странице → открыть viewer с навигацией

#### Viewer с навигацией по страницам

Модификация `openViewer`:

- Новые refs: `viewerPages` (массив URL страниц), `viewerPageIndex` (текущий индекс)
- `openViewer(urls, name, startIndex)` — принимает массив URL
- Стрелки влево/вправо:
  - Кнопки на экране (← →)
  - Клавиатура: ArrowLeft / ArrowRight
  - Свайп (мобильные) — можно добавить позже
- Индикатор: "Page 2 of 5"
- При смене страницы: `viewerUrl = viewerPages[viewerPageIndex]`, сброс transform

#### HTML изменения (`app.html`)

1. **Карточка документа** — бейдж количества страниц:
```html
<div v-if="doc.page_count > 1" class="file-card-pages-badge">{{ doc.page_count }} pages</div>
```

2. **Overlay списка страниц** (новый блок):
```html
<div v-if="pagesViewOpen" class="modal-overlay" @click.self="closePagesView">
  <div class="pages-view">
    <div class="pages-view-header">
      <span>{{ pagesViewTitle }}</span>
      <button @click="closePagesView">Close</button>
    </div>
    <div class="pages-grid">
      <div v-for="(page, i) in pagesViewList" :key="page.key"
        class="page-card" @click="openViewerFromPages(i)">
        <span class="page-number">{{ i + 1 }}</span>
        <!-- thumbnail or ext icon -->
      </div>
    </div>
  </div>
</div>
```

3. **Viewer со стрелками** (модификация существующего):
```html
<button v-if="viewerPages.length > 1 && viewerPageIndex > 0"
  @click="viewerPrev" class="viewer-nav-btn viewer-nav-prev">←</button>
<button v-if="viewerPages.length > 1 && viewerPageIndex < viewerPages.length - 1"
  @click="viewerNext" class="viewer-nav-btn viewer-nav-next">→</button>
<span v-if="viewerPages.length > 1" class="viewer-page-indicator">
  Page {{ viewerPageIndex + 1 }} of {{ viewerPages.length }}
</span>
```

4. **Ошибка загрузки** (новый блок):
```html
<div v-if="uploadError" class="upload-error">{{ uploadError }}</div>
```

#### CSS изменения (`style.css`)

- `.file-card-pages-badge` — бейдж в углу карточки
- `.pages-view` — модальное окно списка страниц
- `.pages-grid` — сетка страниц
- `.page-card` — карточка страницы с номером
- `.viewer-nav-btn` — кнопки навигации в viewer
- `.viewer-page-indicator` — индикатор "Page X of Y"
- `.upload-error` — красное сообщение об ошибке

### Удаление документа

- `deleteFile` → `deleteDocument`
- `DELETE /api/documents/:id` — удаляет все страницы из R2 + превью + записи в БД
- Confirm dialog: "Delete document with N pages?"

### Редактирование тегов

- `editTags` — работает с `PUT /api/documents/:id/tags` вместо `PUT /api/objects/tags`

## Порядок реализации

### Этап 1: Backend — схема и эндпоинты
1. Модифицировать `ensureSchema`: добавить таблицы `documents`, `document_tags`, колонки в `objects`, индексы
2. Реализовать `POST /api/documents/register`
3. Реализовать `GET /api/documents` (с фильтром по тегам)
4. Реализовать `GET /api/documents/:id/pages`
5. Реализовать `DELETE /api/documents/:id`
6. Реализовать `PUT /api/documents/:id/tags`
7. Переключить теговые эндпоинты на `document_tags`

### Этап 2: Frontend — загрузка
1. Переписать `uploadFiles`: сортировка, загрузка всех файлов в R2, откат при ошибке
2. Превью только для первого по алфавиту файла
3. Регистрация документа через `POST /api/documents/register`
4. Отображение ошибки загрузки в UI
5. Прогресс "i из N"

### Этап 3: Frontend — отображение
1. `fetchDocuments` вместо `fetchFiles`
2. Карточки документов с бейджем количества страниц
3. Overlay списка страниц при клике на multi-page документ
4. Viewer с навигацией (стрелки, клавиатура, индикатор)

### Этап 4: Frontend — действия
1. `deleteDocument` вместо `deleteFile`
2. `editTags` для документов
3. `downloadFile` — скачивание отдельной страницы или всего документа

### Этап 5: Обратная совместимость
1. В `GET /api/documents` — для объектов без `document_id` создавать виртуальные документы на лету
2. В `ensureSchema` — не мигрировать данные, обрабатывать на уровне запросов

## Файлы для изменения

| Файл | Изменения |
|------|-----------|
| `src/worker.js` | Схема, новые эндпоинты, модификация существующих |
| `public/app.js` | Логика загрузки, отображение, viewer, действия |
| `public/app.html` | Новые блоки UI, модификация существующих |
| `public/style.css` | Стили для новых элементов |

## Риски и компромиссы

- **R2 + D1 не поддерживают транзакции** — откат реализован на уровне приложения (удаление загруженных файлов при ошибке). Маловероятный сценарий: R2 загрузка успешна, D1 регистрация неудачна, удаление из R2 тоже неудачно → orphaned files. Принимаем как допустимый риск.
- **Размер пакета** — при загрузке 50+ файлов последовательная загрузка может быть медленной. Параллельность с ограничением конкурентности — опциональная оптимизация.
- **Обратная совместимость** — виртуальные документы для старых данных добавляют сложность в SQL-запросы. Альтернатива: одноразовая миграция данных (но пользователь запретил миграции).
