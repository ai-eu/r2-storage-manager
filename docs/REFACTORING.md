# Аудит `public/app.js` и план рефакторинга

## 1. Текущее состояние

`public/app.js` — **1639 строк, ~72 КБ**, загружается одним синхронным
`<script src="/app.js?v=5">` в `public/app.html` после Vue 3 (global build),
pdf.js и jsPDF. Сборки нет: проект — Cloudflare Worker, отдающий статику.

Структура файла:

| Диапазон     | Что находится                                            | Объём     |
|--------------|----------------------------------------------------------|-----------|
| 1–48         | Глобальные утилиты (теги, расширения, иконки, pdf.js)    | ~48 строк |
| 50–256       | Обработка изображений и генерация превью                 | ~207      |
| 258–1768     | Один `createApp({ setup() {...} })` — **всё остальное**  | ~1510     |

Внутри `setup()` сосредоточено ~10 логических областей, перемешанных в одной
функции с общим замыканием:

1. **Состояние и computeds** (260–291) — refs, `workersPct`, `storagePct`, форматтеры.
2. **Меню документа** (294–344) — `getMenuItems`, `handleMenuAction`.
3. **Usage widget** (345–350) — `fetchUsage`.
4. **Pages view** (353–356, 1343–1547) — список страниц документа, операции.
5. **PDF-модал обработки** (368–523) — слайдеры, zoom, drag, рендер страницы.
6. **Tags modal** (525–540) — модалка ввода тегов.
7. **Image viewer** (542–690) — pan/zoom/pinch, навигация, клавиатура.
8. **PDF viewer** (691–865) — pan/zoom/pinch, рендер страниц pdf.js.
9. **API-слой** (866–934) — `apiFetch`, `logout`, `fetchTopTags/All/Related`, `fetchDocuments`, `refreshAll`.
10. **Генерация PDF** (936–996, 998–1216) — `renderPageBlob`, `addJpegBlobToPdf`, `renderPdfBlob`, `processAndUploadPages`.
11. **Upload / drag&drop** (1217–1342) — `uploadFiles`, `handleFileUpload`, `triggerAddPages`, dnd.
12. **Операции над документом** (1357–1723) — `rebuildPdfForDoc`, `deletePage`, `movePageUp/Down`, `openPagesView`, `viewDocument`, `editTags`, `regeneratePdf`, `downloadBlob/Page`, `deleteDocument`.
13. `onMounted` + большой `return` (1725–1768), экспортирующий ~60 имён в шаблон.

## 2. Проблемы

- **Гигантский `setup()`** (~1510 строк). Любое изменение требует скроллинга и
  удержания в голове общего замыкания, в котором ~150 локальных имён.
- **Дублирование логики pan/zoom/pinch** между image viewer (599–635) и
  PDF viewer (816–865) — почти идентичный код `dist`/`mid`/pointer capture.
- **Смешение уровней**: чистые функции (обработка пикселей, нормализация тегов)
  живут рядом с сетевыми вызовами и DOM-манипуляциями в одном замыкании.
- **`processAndUploadPages`** — ~220 строк в одной функции, смешивает загрузку
  оригиналов, рендер, загрузку превью, сборку PDF, ребилд при `addDocId`.
- **Невозможность юнит-тестирования**: чистые хелперы (`autoProcessImageData`,
  `applySliderDeltas`, `normalizeTags`, `hashTag`) не импортируются отдельно.
- **Диффы и ревью**: правка в viewer-е и в upload-логике оказываются в одном
  файле, конфликты при параллельной работе вероятны.
- **`return` из `setup()`** на 30 строк — индикатор того, что компонент
  перегружен: шаблон (`app.html`, 340 строк) тоже монолитный.

## 3. Аргументация «за» рефакторинг

| Выгода                       | Обоснование                                                                              |
|------------------------------|------------------------------------------------------------------------------------------|
| Навигация                    | Файлы по 100–300 строк открываются быстрее в голове, IDE-переходы по символам точнее.    |
| Изоляция изменений           | Правка zoom-логики не требует перечитывания upload-цепочки.                              |
| Переиспользование            | Общий `usePanZoom()` устранит ~120 строк дублирования между двумя viewer-ами.            |
| Тестируемость                | Чистые хелперы (image processing, tags, PDF-сборка) можно покрыть юнит-тестами.          |
| Параллельная разработка      | Разные модули → меньше merge-конфликтов.                                                 |
| Поиск багов                  | Меньше скрытых зависимостей через общее замыкание, явные импорты.                        |
| Подготовка к SFC/TypeScript  | Если позже появится Vite, модули уже будут на месте — миграция механическая.             |

## 4. Аргументация «против» / риски

| Риск                                        | Митигация                                                                                |
|---------------------------------------------|------------------------------------------------------------------------------------------|
| Нет сборщика → ES-модули = доп. HTTP-запросы | Проект внутренний, ~6–8 модулей, всё кешируется (Cache-Control). Запросы параллельные.   |
| Vue global build + `setup()` возвращает всё  | Используем **composables** (`useXxx()`), возвращающие refs/функции — идиома Composition API. |
| Скрытые связи через замыкание               | Передавать зависимости явно в composable-функции; избегать общих мутабельных синглтонов. |
| Регрессии в рабочем коде                    | Поэтапный перенос, после каждого этапа — ручной чек-лист сценариев (см. §7).             |
| Больше файлов                               | Незначительно по сравнению с выигрышем в читаемости.                                     |
| Шаблон `app.html` тоже монолитный           | Не трогаем в рамках этого рефакторинга; имена в `return` сохраняем.                      |

## 5. Вывод

**Рефакторинг стоит делать**, но **поэтапно и без введения сборщика**.
Цель — не «разрезать ради красоты», а:

1. Вынести чистые функции в импортируемые модули (тестируемость + переиспользование).
2. Вынести две viewer-логики в общий composable (устранение дублирования).
3. Разбить `setup()` на composables по доменным областям (читаемость).
4. Сохранить `app.html` и публичные имена в шаблоне без изменений.

Сборщик (Vite/esbuild) **не добавляется** — это отдельное решение, которое
изменит dev/deploy-флоу и выходит за рамки текущего рефакторинга.

## 6. Предлагаемая структура модулей

```
public/
  app.html              # без изменений (имена в шаблоне сохраняются)
  app.js                # точка входа: import + createApp + монтаж, ~80–120 строк
  style.css             # без изменений
  modules/
    utils/
      tags.js           # normalizeTag, normalizeTags, parseTagsInput, hashTag, tagToColors
      files.js          # getExt, getExtIcon, isImage, isPdf
      format.js         # formatNum, formatBytes
    image/
      process.js        # autoProcessImageData, applySliderDeltas, autoPickQuality
      thumb.js          # decodeImageFile, generateImageThumbBlob, generatePdfThumbBlob
    pdf/
      build.js          # renderPageBlob, addJpegBlobToPdf, renderPdfBlob
    api/
      client.js         # apiFetch, logout (общий fetch-обёртка с cookie-авторизацией)
      documents.js      # fetchDocuments, deleteDocument, editTags, fetchTopTags/All/Related
      usage.js          # fetchUsage
    composables/
      usePanZoom.js     # общий хук pan/zoom/pinch + clamp (замена дублирования viewer-ов)
      useImageViewer.js # состояние + действия image viewer
      usePdfViewer.js   # состояние + действия PDF viewer
      usePdfModal.js    # модалка обработки (слайдеры, zoom, drag)
      useTagsModal.js   # модалка ввода тегов
      usePagesView.js   # список страниц документа + операции
      useUpload.js      # uploadFiles, handleFileUpload, drag&drop, processAndUploadPages
      useDocuments.js   # refreshAll, setActiveTag, viewDocument, regeneratePdf, rebuildPdfForDoc
```

### Уровни зависимости (от нижних к верхним)

```
utils/*          ← чистые, без зависимостей
image/*, pdf/*   ← зависят от utils, pdf.js/jsPDF (глобалы)
api/*            ← зависят от utils
composables/*    ← зависят от utils, image, pdf, api
app.js           ← собирает composables в один setup()
```

### Способ загрузки

`app.html`:

```html
<script type="module" src="/app.js?v=6"></script>
```

`app.js`:

```js
import { createApp, ref, computed, onMounted, nextTick } from "https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js";
import { useDocuments } from "./modules/composables/useDocuments.js";
// ...
createApp({ setup() { /* spread composables, return */ } }).mount("#app");
```

> Vue global build (`vue.global.prod.js`) не экспортирует ESM-члены — нужен
> `vue.esm-browser.prod.js` (тот же CDN, тот же размер). pdf.js и jsPDF
> остаются как UMD-глобалы через отдельные `<script>` теги.

## 7. Поэтапный план работ

Каждый этап = отдельный коммит + ручная проверка сценариев. После каждого
этапа: открыть приложение, залогиниться, прогнать чек-лист ниже.

### Чек-лист регрессии (после каждого этапа)

- [ ] Логин через `/` → редирект на `/app.html`.
- [ ] Список документов загружается, теги подгружаются.
- [ ] Загрузка файла drag&drop и через input.
- [ ] Открытие изображения в viewer (pan, zoom, pinch, ←/→, download, close).
- [ ] Открытие PDF в viewer (zoom, scroll, download, close).
- [ ] Модалка обработки изображения (слайдеры, zoom, превью, confirm).
- [ ] Add pages / Edit pages / Re-process PDF / Delete из меню документа.
- [ ] Перемещение страниц вверх/вниз, удаление страницы.
- [ ] Редактирование тегов, фильтр по тегу.
- [ ] Usage widget показывает Workers и R2 storage.

### Этап 0 — подготовка (без изменения поведения)

- Создать `public/modules/` структуру каталогов.
- Переключить `app.html` на `<script type="module" src="/app.js?v=6">`
  и на `vue.esm-browser.prod.js`.
- Оставить весь код в `app.js`, убедиться что ничего не сломалось
  (проверка: ESM-режим + Vue ESM-билд работают).
- **Коммит:** `refactor: switch app entry to ES module + Vue ESM build`.

### Этап 1 — чистые утилиты (низший риск)

- Перенести `utils/tags.js`, `utils/files.js`, `utils/format.js`.
- В `app.js` — `import` вместо локальных определений.
- **Коммит:** `refactor: extract pure utils (tags, files, format) into modules`.

### Этап 2 — обработка изображений и превью

- Перенести `image/process.js`, `image/thumb.js`.
- Сохранить использование глобалов `pdfjsLib`.
- **Коммит:** `refactor: extract image processing and thumbnail generators`.

### Этап 3 — сборка PDF

- Перенести `pdf/build.js` (`renderPageBlob`, `addJpegBlobToPdf`, `renderPdfBlob`).
- Использует `window.jspdf` и `image/process.js`.
- **Коммит:** `refactor: extract PDF build helpers`.

### Этап 4 — API-слой

- Перенести `api/client.js` (`apiFetch`, `logout`), `api/documents.js`,
  `api/usage.js`.
- `apiFetch` сейчас определён внутри `setup()` — вынести в модуль, принимает
  опции как параметр (без зависимости от reactive state).
- **Коммит:** `refactor: extract API client and resource modules`.

### Этап 5 — общий `usePanZoom` (устранение дублирования)

- Создать `composables/usePanZoom.js` с обобщённой логикой pointer/pinch.
- **Пока не подключать** к viewer-ам — только завести и покрыть сценарий
  вручную в изоляции (временный тестовый вызов из `app.js`).
- **Коммит:** `refactor: add shared usePanZoom composable`.

### Этап 6 — `useImageViewer` + `usePdfViewer`

- Перенести image viewer в `useImageViewer.js`, используя `usePanZoom`.
- Перенести PDF viewer в `usePdfViewer.js`, используя `usePanZoom`.
- В `setup()` — `const imageViewer = useImageViewer({ apiFetch });` и
  spread в `return`.
- **Коммит:** `refactor: extract image and PDF viewers into composables`.

### Этап 7 — модалки (`usePdfModal`, `useTagsModal`)

- Перенести модалку обработки и модалку тегов.
- **Коммит:** `refactor: extract pdf processing modal and tags modal`.

### Этап 8 — `usePagesView`

- Перенести состояние и операции списка страниц
  (`refreshPagesView`, `rebuildPdfForDoc`, `deletePage`, `movePageUp/Down`,
  `openPagesView`, `closePagesView`, `openViewerFromPages`).
- **Коммит:** `refactor: extract pages view composable`.

### Этап 9 — `useUpload`

- Перенести `uploadFiles`, `handleFileUpload`, `triggerAddPages`,
  `handleAddPagesInput`, drag&drop, `processAndUploadPages`.
- `processAndUploadPages` при этом **разбить** на 3–4 функции:
  `uploadOriginals`, `renderAndUploadProcessed`, `generatePdfAndThumbs`,
  `registerPagesAndRebuildPdf`.
- **Коммит:** `refactor: extract upload pipeline, split processAndUploadPages`.

### Этап 10 — `useDocuments` (оркестрация верхнего уровня)

- Перенести `refreshAll`, `setActiveTag`, `clearActiveTag`, `viewDocument`,
  `regeneratePdf`, `editTags`, `deleteDocument`, `downloadBlob/Page`.
- **Коммит:** `refactor: extract documents orchestration composable`.

### Этап 11 — финальная сборка

- `app.js` сокращается до: импорты, `createApp({ setup() { ... } }).mount`.
- `setup()` — только композиция composables и `return` для шаблона.
- Целевой размер `app.js`: **~80–120 строк**.
- **Коммит:** `refactor: finalize app.js as composition root`.

## 8. Что НЕ делается в рамках этого рефакторинга

- Не вводим Vite/esbuild/TypeScript — отдельное решение.
- Не трогаем `app.html` (шаблон) и `style.css`.
- Не меняем `src/worker.js` и `schema.sql`.
- Не переименовываем публичные имена, видимые из шаблона.
- Не добавляем юнит-тесты в этом цикле — только готовим почву (чистые
  функции теперь импортируемые; тесты можно добавить позже).

## 9. Метрики успеха

| Метрика                              | До           | Цель          |
|--------------------------------------|--------------|---------------|
| Размер `app.js`                      | 1639 строк   | 80–120 строк  |
| Размер `setup()`                     | ~1510 строк  | ~40–60 строк  |
| Дублирование pan/zoom/pinch          | 2 копии      | 1 (`usePanZoom`) |
| Импортируемых чистых модулей         | 0            | 6+            |
| Юнит-тестируемых функций             | 0            | все чистые    |
| HTTP-запросов при первой загрузке    | 1 (app.js)   | ~10 (кешируется) |
