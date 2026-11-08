# AI Picker Extension — архитектура и спецификация для TellyMCP

**Статус:** проектное решение / спецификация для реализации  
**Целевой проект:** TellyMCP (существующее браузерное расширение, транспорт, gateway и MCP-коннекторы)  
**Назначение:** интерактивный выбор элемента или области веб-страницы с передачей структурированного контекста агенту и возможностью показать объяснение непосредственно на странице.

## 1. Цель и принципы

Реализовать в **существующем расширении TellyMCP** универсальный **AI Picker / Interactive DOM Inspector**: пользователь выбирает элемент, DOM-контейнер, таблицу, график или произвольную область страницы в стиле DevTools, после чего агент получает релевантный контекст для объяснения или анализа. Первые сценарии — GMGN, Whitebird, TradingView и Cryxxle, но функциональность **не должна зависеть от конкретного сайта или AI-провайдера**.

Ключевые принципы:

1. **Reuse first:** использовать существующие pairing/auth, идентификаторы вкладок и сессий, WebSocket-транспорт, gateway, MCP-клиентов и логирование TellyMCP. Не создавать параллельный backend, отдельную авторизацию или второй транспорт.
2. **Hybrid context:** передавать **структурированный DOM + снимок выбранной области + метаданные страницы**, когда они доступны и нужны. Для Canvas критично изображение; для HTML-таблиц — данные таблицы.
3. **Capture ≠ explain:** Picker только выбирает, собирает и доставляет контекст. Объяснение выполняет отдельный агент/сервис; специфичная логика Cryxxle не внедряется в базовый модуль.
4. **Opt-in, read-only:** активируется по явному действию пользователя либо подтверждённому запросу агентной сессии; не выполняет действий на сайте и не отправляет данные бесконтрольно.
5. **Progressive enhancement:** общая реализация для любых сайтов; отдельные адаптеры для TradingView/GMGN/Whitebird можно подключать позднее.
6. **No invented data:** агент обязан различать наблюдаемые значения, извлечённые метаданные и интерпретацию графика по изображению. Не выдавать предположения за текущие биржевые данные.

### Что не входит в MVP

- Автоторговля, нажатие кнопок Buy/Sell, отправка транзакций, исполнение ордеров.
- Скрытая запись всего пользовательского трафика или постоянное прослушивание страницы.
- Универсальное декодирование Canvas, WebGL и внутренних данных TradingView.
- Автоматический доступ к закрытым/cross-origin iframe без нужных разрешений.
- Полноценная система аннотаций, многоагентной аналитики, долговременная база знаний (это следующие итерации).

## 2. Пользовательские сценарии

**A. Browser → Agent.** Пользователь включает Picker в меню расширения или горячей клавишей, наводит на `Liquidity`, переключается на родительскую карточку, выбирает её, нажимает «Объяснить» либо вводит вопрос. Контекст передаётся через существующий TellyMCP gateway к **явно выбранной/привязанной активной агентной сессии**. Ответ показывается в overlay, side panel или существующем UI TellyMCP. Если получатель не подключён, выбор можно оставить локально и предложить привязать сессию; не отправлять «всем агентам».

**B. Agent → Browser.** Codex вызывает MCP tool `inspector_start` для известной вкладки. Расширение активирует Picker, пользователь выбирает элемент; MCP tool `inspector_get_selection` получает результат. При необходимости агент запрашивает highlight или повторное выделение.

**C. Выбор области.** Пользователь выделяет прямоугольник над Canvas-графиком. Расширение получает screenshot видимой вкладки и обрезает нужную область; DOM внутри Canvas не выдумывает.

**D. Сравнение.** Пользователь последовательно выбирает блоки Order Book в разных вкладках, сохраняет локальный контекст диалога и задаёт сравнительный вопрос. В MVP достаточно нескольких SelectionContext в рамках одной сессии; сложная корреляция — после MVP.

## 3. Компоненты и границы

```text
Browser Tab (GMGN / Whitebird / any page)
    │
    ├── Content Script: picker controller
    │      ├── hit testing / navigation / overlay
    │      ├── DOM context extractor & sanitizer
    │      ├── region selection
    │      └── local explanation UI (optional)
    │
    ├── Extension Background / Service Worker
    │      ├── captureVisibleTab + crop orchestration
    │      ├── permission & tab/frame routing
    │      ├── payload size / redaction gate
    │      └── existing TellyMCP transport client
    │
    ▼
Existing TellyMCP WebSocket transport
    ▼
Existing TellyMCP Gateway
    ├── auth / session binding / ACL
    ├── request/response events, TTL, audit metadata
    ├── existing MCP server / tool bridge
    └── agent session / connector routing (browser → agent path)
             │
             ▼
       Codex / LLM / other agent
             │
             └── explanation / optional annotations → gateway → browser
```

**Важно:** MCP tools удобны для **Agent → Browser**, но сами по себе не создают механизма произвольного входящего запроса **Browser → Agent**. Требуется переиспользовать существующую сессионную маршрутизацию TellyMCP либо явно добавить маршрутизатор событий/очередь запросов и интеграцию с агентным клиентом. Не предполагать, что MCP сервер может самостоятельно «позвать Codex» и получить ответ без работающей агентной сессии.

Распределение ответственности:

| Компонент | Ответственность |
|---|---|
| Content script | Наведение, выбор, подсветка, DOM extraction, выбор прямоугольника, отображение ответа |
| Background | API расширения, снимок вкладки, permission checks, маршрутизация фреймов, WS |
| Gateway | Авторизация, привязка вкладки к сессии, журнал запросов, маршрутизация ответа, лимиты |
| MCP bridge | Запуск/получение выбора, безопасные read-only операции инспектора |
| Agent | Объяснение, анализ, запрос дополнительного контекста, генерация аннотаций |

## 4. Picker UI и взаимодействия

### 4.1 Element Picker

- Включение из popup/контекстного меню/команды расширения или через `inspector_start`.
- В активном режиме `pointermove` (с throttling через `requestAnimationFrame`) определяет DOM-элемент из точки указателя: `document.elementFromPoint(clientX, clientY)`. Для обработки событий полезны `event.composedPath()` и точечная поддержка открытых Shadow Roots.
- Поверх элемента рисуется **отдельная визуальная рамка** (`position: fixed`, `pointer-events: none`, isolated shadow root, высокий `z-index`), не изменяя CSS выбранного сайта.
- `getBoundingClientRect()` задаёт положение рамки. Пересчёт при scroll, resize и смене масштаба; при сложных трансформациях это приближение.
- Клик фиксирует текущий выбор. Клик **не должен** доходить до торгового интерфейса как действие. Перехватывать по необходимости `pointerdown`, `pointerup`, `click`, `dblclick` в capture phase. Не создавать ложных гарантий: не все способы активации можно безопасно подавить во всех страницах; при сомнениях использовать явную кнопку подтверждения выбора поверх страницы и отменять дальнейшее взаимодействие.
- `Alt+↑` — подъём к родительскому элементу; `Alt+↓` — возврат по сохранённому пути дочерних элементов. `Enter` — выбрать/подтвердить; `Esc` — немедленно выключить Picker. Комбинации должны быть конфигурируемыми и не конфликтовать со штатными shortcut браузера/сайта.
- Дополнительно можно показывать tag, role, dimensions, краткий текст, цепочку предков (breadcrumb).

### 4.2 Region Picker

- Drag-to-select прямоугольную область viewport; выбранная зона может содержать Canvas/SVG/HTML.
- Снимок делается **только после действия пользователя**, с разрешениями, достаточными для конкретного API браузера. Для Firefox/Chrome необходимо проверить ограничения `tabs.captureVisibleTab`, `activeTab`, host permissions и особые страницы.
- Screenshot захватывает видимую область вкладки, не произвольную область длинной страницы; cropping — отдельная операция.
- **Координаты:** DOM rect в CSS px; screenshot может использовать device pixels и масштаб. Перед обрезкой пересчитать координаты через фактические размеры bitmap относительно viewport (не слепо умножать на `devicePixelRatio`), учитывать scroll/zoom и ограничения браузера.
- Перед снимком скрыть overlay, tooltip и курсорный UI Picker, дождаться кадра и восстановить состояние; при неудаче не оставлять страницу в режиме блокировки кликов.

### 4.3 Контекстное меню после выбора

`Объяснить` · `Проанализировать` · `Показать связи` · `Спросить` · `Копировать контекст` · `Отмена`.

В MVP достаточно «Объяснить», «Спросить» и «Копировать». Анализ и связи — промпт/режим агента, не отдельный механизм захвата.

### 4.4 Интерактивный ответ

- MVP: ответ в компактной панели, привязанной к selection или в существующем интерфейсе TellyMCP; поддержка follow-up в пределах одной сессии.
- V2+: агент возвращает **структурированные аннотации**, подсвечивающие участки DOM/области на изображении. Перед визуализацией валидировать targets и привязывать их к актуальному DOM; при изменившейся странице не подсвечивать случайные элементы.

## 5. Формат контекста (версионированный контракт)

Ниже **логическая модель**; привести её к фактическому стилю протокола TellyMCP, не вводя вторую несовместимую схему.

```typescript
type PickerMode = 'element' | 'region';

type SelectionContextV1 = {
  schemaVersion: 1;
  selectionId: string;
  requestId: string;
  timestamp: string;                   // ISO 8601
  source: {
    connectionId: string;             // existing TellyMCP identity
    tabId: string;                    // existing logical tab identifier
    frameId?: string;
    sessionId?: string;               // explicitly bound receiver
  };
  page: {
    url: string;                      // sanitized: strip sensitive query/fragment
    title: string;
    origin: string;
    viewport: { width: number; height: number; deviceScaleFactor?: number };
  };
  selection: {
    mode: PickerMode;
    rect: { x: number; y: number; width: number; height: number }; // CSS px viewport
    element?: {
      tagName: string;
      role?: string;
      selectorHint?: string;          // not guaranteed stable
      text?: string;                  // bounded, sanitized
      html?: string;                  // bounded, sanitized
      ancestors?: Array<{ tagName: string; role?: string; label?: string }>;
      nearbyLabels?: string[];
      table?: { headers: string[]; rows: string[][] }; // bounded
      attributes?: Record<string, string>;             // allowlisted only
      styles?: Record<string, string>;                 // selected properties only
    };
  };
  screenshot?: {
    mimeType: 'image/png' | 'image/webp';
    width: number;
    height: number;
    attachmentId: string;             // prefer binary attachment, not base64 in JSON
  };
  question?: string;
  redaction: { applied: boolean; warnings?: string[] };
};
```

Использовать attachment upload или бинарный канал TellyMCP, если он существует, иначе аккуратно реализовать передачу chunked binary с лимитами. **Не внедрять base64 картинку в каждое WS-сообщение без необходимости.**

Извлечение:

- Для HTML: видимый текст, теги, подписи, ARIA, необходимые атрибуты, ближайший смысловой контейнер, ограниченная цепочка ancestors и скриншот.
- Для таблиц: заголовки и видимые строки с ограничением объёма; если таблица виртуализована, указывать, что выгружена только видимая часть.
- Для SVG: метаданные, подписи, доступная структура + изображение.
- Для Canvas/WebGL: изображение + метаданные окружающего контейнера; **нет DOM-узлов для отдельных свечей/объектов внутри рисунка**.
- Для сайта со специализированным адаптером: разрешённые структурированные данные текущего UI, с признаком происхождения и актуальности.

Рекомендуемые пределы MVP: ограниченные HTML/text (настраиваемые, например 16–64 KiB), снимок WebP/PNG с ресайзом и максимальным размером, общий cap запроса. При превышении показывать пользователю предупреждение и деградировать до текстового контекста или уменьшенного изображения.

## 6. Безопасность и приватность

Это **обязательная часть реализации**, особенно для финансовых интерфейсов.

1. **User activation:** снимки и извлечение только после явного действия пользователя или подтверждённого inspector-запроса агента. Не включать постоянный мониторинг мыши/DOM при выключенном Picker.
2. **Explicit receiver:** отправка только в выбранную подключённую агентную сессию; запрет broadcast и отправки в посторонние workspaces.
3. **Redaction before transport:** никогда не отправлять cookies, localStorage, sessionStorage, Authorization headers, приватные ключи/seed-фразы, значения `input[type=password]`, скрытых полей, секретные токены, платёжные реквизиты. Очистить URL query/fragment, event handler attributes и потенциально опасные inline data. Сам UI или screenshot тоже могут содержать чувствительные данные: предоставить preview/подтверждение перед отправкой и возможность скрыть области.
4. **Sanitize HTML:** HTML — недоверенные данные. Не исполнять скрипты, не рендерить сырой HTML в privileged UI. Собирать allowlisted атрибуты, удалять script/style/формы/секреты. **DOM и текст страницы — недоверенный ввод для LLM; игнорировать содержащиеся в нём инструкции как prompt injection.**
5. **Read-only:** Picker/MCP inspector не может торговать, переводить деньги, нажимать кнопки сайта или подтверждать формы. Overlay должен предотвращать случайное взаимодействие при выделении.
6. **Access control:** вкладка, соединение, пользователь, агентная сессия и разрешения проверяются gateway; server-side ACL, TTL, request IDs; защита от replay и устаревших tab IDs.
7. **Minimal retention:** не логировать screenshot и полный HTML в обычные JSONL-логи. Хранить metadata и диагностические коды; контент держать недолго, с удалением по TTL и возможностью «забыть выделение».
8. **Permission minimization:** host permissions и screenshot privileges — по необходимости, избегать расширения прав без явного основания. Не собирать контекст на внутренних браузерных/защищённых страницах, где браузер запрещает API.
9. **Safe recovery:** `Esc`, закрытие вкладки, отрыв соединения, смена навигации и timeout должны корректно уничтожать overlay и обработчики, не оставляя сайт заблокированным.

## 7. Протокол и MCP (предлагаемые имена)

**Перед реализацией:** агенту изучить существующие команды/события TellyMCP и адаптировать naming conventions. Ниже — контракт по смыслу, а не требование переписать протокол.

### 7.1 Gateway events

| Event | Направление | Назначение |
|---|---|---|
| `inspector.start` | agent/gateway → extension | Включить picker в целевой вкладке/фрейме |
| `inspector.started` | extension → gateway | Подтвердить запуск / вернуть ограничения |
| `inspector.selection` | extension → gateway | Передать `SelectionContextV1`/attachment IDs |
| `inspector.selection_ack` | gateway → extension | Подтверждение доставки или ошибка |
| `inspector.response` | agent/gateway → extension | Объяснение и возможные аннотации |
| `inspector.highlight` | agent/gateway → extension | Подсветить выбранный/ранее известный элемент |
| `inspector.stop` | agent/gateway → extension | Завершить сессию Picker |
| `inspector.error` | any → requester | Типизированная ошибка |

Обязательные поля envelope: `requestId`, `selectionId?`, `connectionId`, `tabId`, `sessionId?`, `schemaVersion`, `timestamp`, `payload`. Использовать существующий envelope TellyMCP, если он есть.

### 7.2 MCP Tools

| Tool | Семантика |
|---|---|
| `inspector_start` | Запустить picker во вкладке; ответ: состояние/идентификатор запроса |
| `inspector_get_selection` | Получить последнюю или указанную selection привязанной сессии; ожидание/таймаут по фактическим паттернам TellyMCP |
| `inspector_highlight` | Подсветить известную selection, без кликов |
| `inspector_stop` | Остановить picker и очистить UI |

`inspector_explain` **не является обязательным MCP tool**: объяснение лучше выполняет подключённый агент, который видит SelectionContext. Допустим gateway-side shortcut в конкретный LLM-провайдер, но он должен быть отдельным адаптером, а не частью базового Picker.

Для Browser → Agent предусмотреть `selection request` в существующей системе агентных сессий, асинхронную доставку, явную привязку адресата и корректное поведение, если сессия неактивна. Нельзя предполагать, что сам факт регистрации MCP сервера даёт возможность агенту автоматически принимать произвольные сообщения из браузера.

### 7.3 Пример обработки

```text
User → Toggle picker → Hover → Select → Ask: "Что такое Funding Rate?"
  → Extension builds sanitized SelectionContextV1
  → Existing WS / TellyMCP Gateway
  → Route to bound agent session OR store pending until agent pulls
  → Agent explains; cites visible inputs and distinguishes assumptions
  → Gateway response(requestId, selectionId)
  → Extension renders explanation overlay
```

## 8. DOM, Shadow DOM, iframe: особенности

- **`elementFromPoint()`** определяет верхний элемент в *данном документе*; CSS-перекрытия и overlay влияют на hit testing. Свою рамку делать `pointer-events: none`. Для вложенной структуры можно использовать `elementsFromPoint()`.
- **Shadow DOM:** доступны открытые roots; закрытые roots не раскрываются обычному content script. Выбор внутреннего элемента через composed event path возможен не во всех случаях; fallback — host element.
- **iframe:** верхний документ видит iframe как элемент. Для содержимого cross-origin iframe необходим запуск content script в соответствующем frame при наличии host permissions/`all_frames` и маршрут frameId; для недоступного iframe — снимок и сообщение об ограничении.
- **SPA:** DOM пересоздаётся. Selection хранить через временный handle/слабую ссылку, плюс selector hint и контекст. При re-render не использовать старый CSS selector без повторной проверки.
- **Canvas/TradingView:** отдельные графические объекты не видны в DOM. Screenshot-first с контекстом из DOM; адаптеры могут в будущем предоставлять OHLC/таймфрейм/тикер, если эти данные легитимно доступны.
- **Capture privileges:** у Firefox и Chrome различия в APIs и разрешениях. Реализовать capability detection, не обещать захват любой вкладки и защищённых страниц.

## 9. План реализации и критерии приёмки

### Phase 0 — Discovery

Прочитать текущую архитектуру TellyMCP: расширение, manifest, background/content scripts, табы, connection IDs, WS envelopes, gateway, MCP tools, session routing, текущие screenshot/DOM capabilities. **Сначала переиспользовать существующее**, затем внести минимальные изменения. Зафиксировать карту интеграций в документации проекта.

### Phase 1 — Picker без AI (MVP core)

- On-demand toggle + Esc cleanup.
- Element Picker: hover, outline, click-select, ancestor navigation, breadcrumbs.
- Region Picker: drag, screenshot, crop (с учётом масштабирования).
- Sanitized bounded DOM/Text + screenshot attachment.
- Отправка выбора через текущий transport; получение через MCP tool.
- Предпросмотр и копирование контекста; базовые ошибки/таймауты.

**Acceptance:** на произвольной HTML-странице можно выбрать вложенный элемент и его родителя; для Canvas — получить корректный crop; агент получает payload с tabId и provenance; клики в торговом UI не исполняются; Esc полностью отключает режим.

### Phase 2 — Agent round trip

- Привязка вкладки к активной агентной сессии.
- Browser → Agent запрос с вопросом и selection.
- Вывод объяснения в overlay, корректная корреляция request/response.
- Follow-up по тому же selectionId; отмена и timeout.

**Acceptance:** пользователь в браузере выбирает блок и получает ответ в этой вкладке; при отсутствии активного агента сообщение не теряется незаметно и не отправляется случайному получателю.

### Phase 3 — Domain-aware extraction

- Generic table/SVG extractors.
- Site adapters: GMGN, Whitebird, TradingView по потребности Cryxxle.
- Метаданные графика, пользовательские индикаторы и market context при доступности.
- Сравнение нескольких selections и cross-tab context.

### Phase 4 — Annotated explanations

- Структурированный ответ `{ explanation, annotations[] }`.
- Привязка целей к текущему DOM/regions, автоматическое исчезновение при потере актуальности.
- UX подсветки терминов, bid/ask/spread, свечей, индикаторов, без выполнения действий на странице.

## 10. Технические требования к качеству

- Модульность: picker controller, DOM extractor, region capture, sanitization, protocol DTO, UI overlay и gateway/MCP adapters — отдельно, без одного огромного content script.
- TypeScript и единый стиль проекта; явные DTO, валидаторы payload, типизированные ошибки, schema versioning.
- Производительность: никакого DOM serialization на каждом `pointermove`; hit testing и rect update через `requestAnimationFrame`; тяжёлое извлечение — **после выбора**.
- Не мешать сайтам: никаких постоянных global hooks; удалять event listeners/overlay; тестировать на SPA и страницах с высокочастотным перерисовыванием.
- Тесты: unit для redaction/DTO/coordinate conversion, integration для WS routing и MCP, browser E2E для HTML, canvas, iframe, SPA, scroll/zoom, быстрых кликов и Esc.
- Логирование: requestId, mode, tabId, длительности, размер payload, код результата; без чувствительного контента.
- Совместимость с существующими механизмами TellyMCP session attach/detach и remote gateway.

## 11. Примеры использования

**Cryxxle / GMGN:** выбрать `Liquidity` или `Market Cap`; агент объясняет метрику. Выделить Order Book; агент объясняет Bid/Ask, spread и ликвидность. Выделить Canvas-график; агент интерпретирует **видимую часть**, не утверждая, что имеет полный исторический ряд.

**Whitebird:** выбрать Funding Rate, плечо, PnL или блок лимитного ордера; агент объясняет термины и риски, **не размещая ордер**.

**Markestral:** выбрать карточку товара, ценовой блок или таблицу характеристик; агент разбирает DOM и сопоставляет поля.

**TellyMCP general:** выбрать проблемный элемент в произвольном приложении, передать агенту DOM/screenshot/URL для объяснения или отладки.

## 12. Итоговое архитектурное решение

Реализовать **AI Picker как универсальный read-only модуль существующего браузерного расширения TellyMCP** с двумя режимами выделения (**Element / Region**) и гибридной передачей контекста (**DOM + screenshot + metadata**). Транспорт, авторизация, gateway, MCP и жизненный цикл сессий остаются внутри TellyMCP. Агент независим от расширения; объяснение и интерактивные аннотации — надстройка. Для запуска из браузера нужен явный маршрут к агентной сессии; для запуска агентом — MCP-инструменты инспектора.

**Основной результат:** «Выдели элемент или область на любом сайте → передай проверяемый контекст агенту → получи объяснение непосредственно на странице», без торговых действий и без дублирования инфраструктуры TellyMCP.

## 13. Карта реализации MVP (2026-11-08)

Реализуются Phase 0–2; адаптеры сайтов и структурированные аннотации остаются
следующими этапами. Marrow: **T-TELLYMCP-048**. Версии расширений: Chrome
**0.0.10**, Firefox **0.0.9**. Изменения исходников не означают публикацию в магазинах
или обновление production gateway.

| Участок | Реализация |
|---|---|
| Общие DTO, очистка DOM/URL, таблицы, координаты | `packages/attach-extension-shared/src/context.ts` |
| Element/Region UI, preview, Esc, ответы | `packages/attach-extension-shared/src/controller.ts` |
| Привязка, очередь, TTL, screenshot/crop | `packages/attach-extension-shared/src/background.ts` |
| Сборка общего TypeScript в статические browser scripts | `packages/attach-extension-shared/build.mjs` |
| Интеграция браузеров | Существующие `background.js`, popup и build scripts обоих расширений |
| MCP DTO и проверка источника | `features/browser/model/inspectorProtocol.ts` |
| Запуск и получение/ответ/cleanup | `BrowserService.inspector`, `inspectorRemote`, `InspectorTools` |

Маршрут: существующее локальное расширение → loopback BrowserAttachServer →
владеющая консоль → существующий authenticated gateway action route → MCP.
`tab_action`/`tab_action_result` получают операции `inspector_*`; второй WS,
провайдер AI и отдельная авторизация не добавляются. На gateway используется
канонический адрес консоли; у локального browser bridge — её local session ID.
Источник результата проверяется по session ID, instance ID и tab ID.

Пользователь запускает **Element / Region** из popup или **Alt+Shift+P**
(комбинация запуска меняется штатными настройками команд браузера). Наведение
не сериализует DOM; клик/Enter фиксирует выбор, Alt+↑/↓ выбирают предка/потомка.
После preview кнопки **Explain / Ask** кладут контекст в очередь только для
сессии и вкладки, выбранной в существующем Control Panel. Без привязки остаётся
локальный preview; отправка показывает причину отказа. Агент читает
`inspector_get_selection` и отвечает через `inspector_response` с обоими ID.
Самостоятельного запуска агента нет. `inspector_start`, `inspector_highlight`,
`inspector_stop` работают с уже attached вкладкой текущей сессии.

Очередь хранится только в памяти расширения: до пяти выделений на вкладку,
до восьми открытых picker, TTL пять минут. Закрытие, навигация, отключение моста,
Esc/Forget и остановка инспектора очищают состояние. После перезапуска service
worker очередь не восстанавливается. Повторный вопрос получает новый request ID;
устаревший ответ не подменяет новый. Изменение выбранного DOM, scroll, resize
или масштаба требует повторного выбора.

Снимок необязателен: **Capture preview** → просмотр → явная отправка либо
**Text only**. Используется `captureVisibleTab` активной HTTP(S) вкладки;
background проверяет tab/URL до и после захвата. CSS-координаты пересчитываются
по фактическим размерам bitmap. Максимум 1600px по большей стороне и 256KiB PNG;
при превышении нужно выбрать меньшую область или отправить текст. Pinch zoom
отклоняется, обычный масштаб браузера учитывается отношением bitmap/viewport.
Это соответствует ограничениям [Chrome Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)
и [Firefox captureVisibleTab](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/captureVisibleTab).
Новых host permissions нет.

Изображение передаётся один раз в ответ на явный MCP pull через уже существующий
bounded screenshot RPC (base64 в `tab_action_result`, как у `browser_screenshot`).
Оно не включается в события наведения/обычные JSON metadata; MCP получает отдельный
image content block и attachment metadata. `include_image=false` читает только DOM
и metadata. Отдельного бинарного attachment канала у browser bridge сейчас нет;
chunked upload не вводится ради ограниченного снимка в существующем RPC.

URL query/fragment/credentials, формы, input/textarea/select/contenteditable,
скрытые элементы, script/style и обработчики не включаются в DOM. HTML строится
из разрешённых тегов без атрибутов; ARIA/title/alt собираются отдельным allowlist.
Текст и HTML ограничены 16KiB каждый, таблица дополнительно ограничена 8KiB,
весь context — 64KiB. Известные форматы секретов очищаются. В изображении маскируются
поля, помеченные приватные области, iframe и недоступные custom element roots.
Автоматическая очистка не распознаёт произвольные секреты в изображении: preview,
выбор меньшей области и отказ от картинки остаются обязательными возможностями UI.
Ответ агента выводится только через `textContent`, без HTML/Markdown исполнения.

MVP работает в top frame; открытый Shadow DOM доступен для hit testing.
Содержимое iframe и закрытых shadow roots не извлекается; ограничения явно указаны
в контексте. Полного подавления ранее зарегистрированных глобальных обработчиков
недоверенной страницы браузер не гарантирует. Overlay-перехват и capture handlers
защищают обычные указательные/клавиатурные действия; торговые команды не добавлены.

Проверки: redaction/координаты/DTO, сессионная очередь и TTL, корреляция ответов,
MCP image blocks, реальный WS RPC с поддельным ответом другого instance. Chromium
fixtures проверяют оба стиля extension API, настоящий closed shadow overlay,
клик без действия страницы, выбор предка, DOM replacement, Esc, scroll, crop Canvas
при device scale1.5, preview до отправки и plain-text ответ. Это не заменяет ручную
приёмку в установленном Firefox и Chrome на пользовательских сайтах.
