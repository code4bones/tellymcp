export const ruCommon = {
  errors: {
    no_telegram_identity: "Для этого чата недоступна Telegram-идентичность.",
    no_active_session:
      "Активная сессия ещё не привязана. Привяжи её через /start <code>.",
    missing_telegram_context: "Не удалось определить Telegram-пользователя или чат.",
  },
  menu: {
    refreshed: "Меню обновлено.",
    gateway_unavailable: "Gateway недоступен",
    no_telegram_identity_label: "Нет Telegram identity",
    no_active_session_label: "Нет активной сессии",
    back: "⬅ Назад",
    refresh: "🔄 Обновить",
    close: "✖ Закрыть",
    delete: "🗑 Удалить",
    get: "📥 Получить",
  },
} as const;

export const ruMenu = {
  main: {
    buttons: {
      live: "🖥 Live",
      content: "📄 Content",
      browser: "🌐 Browser",
      local: "🏠 Local",
      collab: "👥 Collab",
      storage: "📦 Storage",
      settings: "⚙ Settings",
      back: "⬅ Назад",
    },
    actions: {
      open_content: "Открываю меню content.",
      open_browser: "Открываю browser.",
      open_inbox: "Открываю inbox.",
      open_storage: "Открываю storage.",
      open_settings: "Открываю настройки.",
      back_to_sessions: "Назад к сессиям.",
    },
    screen: {
      title: "🎛 Сессия: {{sessionName}}",
      inbox_messages: "📥 Сообщений в inbox: {{count}}",
      project: "📦 Проект: <b>{{projectName}}</b>",
      partner: "🤝 Напарник: <b><i>{{partnerName}}</i></b>",
      partner_hint:
        "Делись с напарником деталями API, изменениями, ошибками и git-контекстом.",
      link_hint:
        "🔗 Свяжи напарника, чтобы координироваться через общие заметки и файлы.",
      tmux_mode_direct: "🖧 Режим TMUX: direct",
    },
  },
  sessions: {
    screen: {
      title: "🗂 Выбери активную сессию",
      last_worked: "🕘 Последняя работа: <i>{{sessionName}}</i>",
      updated: "⏱ Обновлено: <i>{{timestamp}}</i>",
      current_active: "📌 Текущая активная: <b>{{sessionName}}</b>",
      no_linked_sessions:
        "Для этой Telegram identity не найдено привязанных сессий.",
    },
    labels: {
      no_linked_sessions: "🫥 Нет привязанных сессий",
      unavailable: "⚠ Сессии недоступны",
      tools: "🛠 Tools",
    },
    actions: {
      no_linked_sessions:
        "Для этой Telegram identity не найдено привязанных сессий.",
      unavailable: "Меню сессий временно недоступно.",
      refreshed: "Список сессий обновлён.",
      open_tools: "Открываю инструменты.",
    },
  },
  inbox: {
    button: "📥 Inbox",
    button_count: "📥 Inbox ({{count}})",
    screen: {
      title: "📥 Inbox",
      active_session: "📌 Активная сессия: {{sessionName}}",
      stored_messages: "📨 Сохранённых сообщений: {{count}}",
      choose_message:
        "Выбери сообщение ниже, чтобы просмотреть или удалить его.",
      empty: "Для этой сессии нет сохранённых внеочередных Telegram-сообщений.",
    },
    labels: {
      empty: "📭 Inbox пуст",
    },
    actions: {
      empty: "Нет сохранённых внеочередных Telegram-сообщений.",
      refreshed: "Inbox обновлён.",
    },
  },
  buffer: {
    buttons: {
      visible: "👁 Видимое",
      full: "🧾 Полное",
      last_300: "📄 Последние 300",
      last_1000: "📄 Последние 1000",
    },
    screen: {
      title: "📄 Content",
      active_session: "📌 Активная сессия: {{sessionName}}",
      tmux_target: "🖥 tmux target: {{tmuxTarget}}",
      export_hint:
        "Выбери, сколько истории pane экспортировать в Markdown-файл.",
      export_modes:
        "Visible отдаёт текущий viewport pane. Full экспортирует всю доступную tmux-историю.",
    },
  },
  browser: {
    buttons: {
      screenshots: "📸 Скриншоты",
      screenshots_count: "📸 Скриншоты ({{count}})",
    },
    actions: {
      open_screenshots: "Открываю скриншоты.",
      back_to_session_menu: "Назад к меню сессии.",
      refreshed: "Скриншоты обновлены.",
      back_to_browser_menu: "Назад к browser.",
    },
    screen: {
      title: "🌐 Browser",
      active_session: "📌 Активная сессия: {{sessionName}}",
      stored_screenshots: "📸 Сохранённых скриншотов: {{count}}",
      choose_action: "Выбери действие, связанное с browser, ниже.",
    },
  },
  screenshots: {
    screen: {
      title: "📸 Скриншоты",
      active_session: "📌 Активная сессия: {{sessionName}}",
      stored_screenshots: "📦 Сохранённых скриншотов: {{count}}",
      choose_screenshot:
        "Выбери скриншот ниже, чтобы получить его в Telegram или удалить.",
      empty: "Для этой сессии нет сохранённых browser-скриншотов.",
    },
    labels: {
      empty: "📭 Нет скриншотов",
    },
    actions: {
      empty: "Для этой сессии нет сохранённых скриншотов.",
      refreshed: "Скриншоты обновлены.",
      back_to_screenshots: "Назад к скриншотам.",
    },
  },
  storage: {
    buttons: {
      get: "📥 Получить",
      delete: "🗑 Удалить",
    },
    actions: {
      back_to_storage: "Назад к storage.",
      refreshed: "Storage обновлён.",
      empty: "В .mcp-xchange для этой сессии пока нет файлов.",
    },
    screen: {
      title: "📦 Storage",
      active_session: "📌 Активная сессия: {{sessionName}}",
      stored_files: "📦 Сохранённых файлов: {{count}}",
      choose_file:
        "Выбери файл ниже, чтобы просмотреть его или отправить в Telegram.",
      empty: "Для этой сессии нет сохранённых .mcp-xchange файлов.",
    },
    labels: {
      empty: "📭 Storage пуст",
    },
  },
  settings: {
    buttons: {
      info: "ℹ Info",
      rename: "✏ Rename",
      unpair: "🗑 Unpair",
      confirm_unpair: "⚠ Подтвердить отвязку",
    },
    actions: {
      confirm_unpair: "Подтверди отвязку.",
      back_to_settings: "Назад к настройкам.",
      rename_prompt: "Отправь новое название сессии.",
      rename_body:
        "Отправь следующим текстовым сообщением новое название активной сессии.\nКоманды вроде /menu или /help отменят режим переименования.",
    },
    screen: {
      title: "⚙ Settings",
      active_session: "📌 Активная сессия: {{sessionName}}",
      hint:
        "Открой информацию о сессии, переименуй её или отвяжи от Telegram.",
    },
  },
  local: {
    buttons: {
      partner: "🤝 Напарник",
      link: "🔗 Связать",
      unlink: "🔓 Разорвать",
    },
    actions: {
      open_local: "Открываю локальное взаимодействие.",
      back_to_session_menu: "Назад к меню сессии.",
    },
    screen: {
      title: "🏠 Local",
      active_session: "📌 Активная сессия: {{sessionName}}",
      link_status: "🤝 Связь: {{linkedSessionName}}",
      link_status_none: "🤝 Связь: не настроена",
      hint_title: "Здесь живёт локальная работа в одном боте:",
      hint_body:
        "связка сессий, обмен note и файлами без gateway.",
      unavailable: "Локальное взаимодействие недоступно для этого чата.",
      no_active_session:
        "Активная сессия не выбрана. Сначала привяжи её через /start.",
    },
  },
  link: {
    buttons: {
      link: "🔗 Связать",
      unlink_with_name: "🔓 Разорвать {{sessionName}}",
      unlink: "🔓 Разорвать",
    },
    labels: {
      no_partner_sessions: "🫥 Нет сессий напарника",
    },
    actions: {
      no_partner_sessions: "Нет других привязанных сессий.",
      back_to_session_menu: "Назад к меню сессии.",
      unlinked: "Связь с напарником снята.",
      choose_partner: "Выбери сессию напарника.",
    },
    screen: {
      title: "🔗 Связать напарника",
      active_session: "📌 Активная сессия: {{sessionName}}",
      choose_partner: "Выбери другую сессию, чтобы связать её как напарника.",
      hint:
        "Используй эту связку, чтобы делиться API summary, изменениями, ошибками и важным git-контекстом через .mcp-xchange заметки и файлы.",
    },
  },
  partner: {
    buttons: {
      ask: "❓ Ask",
      share: "📤 Share",
      unlink: "🔓 Unlink",
    },
    actions: {
      back_to_session_menu: "Назад к меню сессии.",
      open_partner_menu: "Открываю меню напарника.",
      back_to_partner: "Назад к напарнику.",
      cancel_note_input: "Отправка note напарнику отменена.",
      no_pending_note_input: "Нет активного ввода для note напарнику.",
      task_sent: "Задача отправлена выбранной сессии.",
      inbox_queued: "Задача поставлена в inbox текущей сессии.",
    },
    screen: {
      title: "🤝 Напарник",
      active_session: "📌 Активная сессия: {{sessionName}}",
      linked_partner: "👥 Связанный напарник: {{partnerName}}",
      no_partner: "Напарник пока не связан.",
      use_link_first:
        "Сначала используй Link в меню сессии.",
      prompt_hint: "Задай вопрос по API или поделись изменениями.",
      prompt_format:
        "Формат prompt: первая строка — summary. При необходимости добавь пустую строку и основной текст ниже.",
      default_partner: "напарник",
      executor: "Исполнитель: {{label}}",
      route_result: "Маршрут результата: {{source}} -> {{target}}",
      route_send: "Маршрут отправки: {{source}} -> {{target}}",
      type: "Тип: {{kind}}",
      summary: "Кратко: {{summary}}",
      status: "Статус: {{status}}",
      delivered: "доставлено",
      queued: "в очереди",
      current_session_handles:
        "Текущая сессия подготовит результат и отправит его сама.",
    },
  },
  collab: {
    buttons: {
      tools: "🛠 Tools",
      create: "➕ Создать",
      join: "🔑 Войти",
      broadcast: "📣 Broadcast",
      history: "🕘 History",
      delete: "🗑 Delete",
    },
    actions: {
      gateway_only: "Проекты доступны только через gateway.",
      open_tools: "Открываю инструменты проекта.",
      open_collab: "Открываю Collab.",
      open_delete: "Открываю удаление проектов.",
      back_to_collab: "Назад к Collab.",
      back_to_tools: "Назад к инструментам.",
      back_to_session_menu: "Назад к меню сессии.",
      no_projects: "Проектов пока нет. Создай или войди в существующий.",
    },
    labels: {
      no_projects: "🫥 Нет проектов",
    },
    screen: {
      title: "👥 Collab",
      gateway_not_configured: "Gateway не настроен для этого запуска.",
      use_local_instead:
        "Для локальной работы в одном боте используй раздел Local.",
      unavailable: "Collab недоступен для текущей сессии.",
      active_session: "📌 Активная сессия: {{sessionName}}",
      open_project: "📦 Открытый проект: {{projectName}}",
      open_project_none: "📦 Открытый проект: не выбран",
      project_count: "🗂 Доступно проектов: {{count}}",
      invite_hint: "Открой проект, создай новый или войди по invite-коду.",
      tools_title: "🛠 Collab Tools",
      tools_empty: "Сначала создай проект или войди в существующий.",
      tools_project_count: "🗂 Проектов в Collab: {{count}}",
      tools_session_count: "👥 Уникальных сессий: {{count}}",
      tools_broadcast:
        "Broadcast отправит следующее текстовое сообщение всем уникальным Collab-сессиям на ботах без дублирования.",
      tools_history:
        "History отправит .md с последними 5 Collab-событиями текущей сессии.",
    },
  },
  help: {
    title: "❓ Справка TellyMCP",
    menu: "/menu - открыть список сессий",
    help: "/help - показать эту справку",
    how_it_works: "Как это работает:",
    step_choose: "- выбери активную сессию",
    step_inbox: "- обычные Telegram-сообщения попадают в inbox этой сессии",
    step_nudge:
      "- если настроен tmux target, сервис автоматически будит агента",
    step_tools:
      "- затем агент читает batch inbox через MCP tools",
  },
  live: {
    buttons: {
      fullscreen: "Fullscreen",
      expand: "Expand",
      default: "Default",
    },
    actions: {
      opening: "Открываю Live View.",
      choose_mode: "Выбери режим открытия:",
      opened_info: "Live view открыт.",
      approval_unavailable: "Эта сессия сейчас недоступна для подтверждения.",
    },
    errors: {
      identity_unavailable: "Telegram identity недоступна.",
      no_active_session: "Активная сессия не выбрана.",
      webapp_disabled: "WebApp не включён на сервере.",
      public_url_missing: "Публичный URL WebApp не настроен.",
    },
    screen: {
      launcher_title: "🖥 Live: {{sessionName}}",
    },
    approval: {
      request_title: "🖥 Запрос Live view",
      request_message:
        "Сессия {{sourceSessionName}} запрашивает доступ к Live view вашей сессии.",
      route: "Сессия: {{sourceSessionName}} -> {{targetSessionName}}",
      project: "Проект: {{projectName}}",
      approve: "Разрешить",
      deny: "Отклонить",
      approved: "✅ Доступ к Live разрешён.",
      denied: "❌ Доступ к Live отклонён.",
      source_open: "Открыть Live",
      result_approved:
        "Live view разрешён для {{sourceSessionName}} -> {{targetSessionName}}.",
      result_denied:
        "Live view отклонён для {{sourceSessionName}} -> {{targetSessionName}}.",
    },
  },
  notices: {
    startup: {
      title: "✅ TellyMCP запущен.",
      version: "Версия: {{packageVersion}}",
      protocol: "Протокол: {{protocolVersion}}",
      mode: "Режим: {{mode}}",
      bot: "Бот: @{{botUsername}}",
      sessions: "Привязанных сессий: {{count}}",
      session_list: "Сессии: {{sessions}}",
      mcp: "MCP: {{url}}",
      webapp: "WebApp: {{url}}",
      gateway: "Gateway: {{url}}",
      gateway_ws: "Gateway WS: {{url}}",
      browser: "Browser: {{status}}",
      hint: "Напиши /menu, чтобы открыть меню сессий.",
    },
    project: {
      member_joined: "В проект «{{projectName}}» вошёл участник: {{memberLabel}}.",
      member_left: "Из проекта «{{projectName}}» вышел участник: {{memberLabel}}.",
      deleted: "Проект «{{projectName}}» удалён. Локальные project bindings очищены.",
      new_member: "Новый участник",
      member: "Участник",
    },
    tools: {
      changed: "TOOLS.md обновлён на шлюзе или отсутствует локально.",
      session: "Сессия: {{sessionName}}",
      action_required:
        "Действие обязательно: вызови refresh_tools_markdown, затем перечитай локальный TOOLS.md и применяй его перед продолжением работы.",
    },
    version: {
      reject:
        "Шлюз и клиент несовместимы по протоколу. Транспорт этой сессии заблокирован.",
      warn: "Версии шлюза и клиента различаются.",
      session: "Сессия: {{sessionName}}",
      client: "Клиент: {{packageVersion}} / protocol {{protocolVersion}}",
      gateway: "Шлюз: {{packageVersion}} / protocol {{protocolVersion}}",
    },
    tmux: {
      target_invalid_title:
        "⚠ Автоматический tmux nudge для сессии {{sessionName}} не сработал.",
      target_invalid_target:
        "Сохранённый tmux target больше недействителен: {{tmuxTarget}}",
      target_invalid_action: "Перепривяжи tmux target для этой сессии.",
      unavailable_title:
        "⚠ Автоматический tmux nudge для сессии {{sessionName}} пропущен.",
      unavailable_body: "tmux сейчас недоступен на этой машине.",
      unavailable_target: "tmux target: {{tmuxTarget}}",
      unavailable_reason:
        "Обычно это значит, что tmux session/server не запущен или недоступен по текущему socket path.",
      unavailable_action:
        "Запусти tmux и агента внутри него, либо обнови/сними tmux target для этой сессии.",
    },
  },
  developer: {
    screen: {
      title: "🛠 Tools",
      linked_sessions: "🔗 Привязанных сессий: {{count}}",
      broadcast_help:
        "Broadcast записывает твоё следующее текстовое сообщение в inbox каждой привязанной сессии и будит все настроенные tmux target.",
      prune_help:
        "Prune all очищает каждый Redis key в этом namespace telegram-mcp.",
    },
  },
  session_info: {
    opened: "Информация о сессии открыта.",
    title: "ℹ Информация о сессии",
    label: "📌 Label: {{value}}",
    session_id: "🆔 Session ID: {{value}}",
    inbox_count: "📥 Сообщений в inbox: {{count}}",
    paired: "🔗 Привязана: {{value}}",
    partner: "🤝 Напарник: {{value}}",
    tmux_target: "🖥 tmux target: {{value}}",
    tmux_session: "📺 tmux session: {{value}}",
    tmux_window: "🪟 tmux window: {{value}}",
    tmux_pane: "🔹 tmux pane: {{value}}",
    yes: "да",
    no: "нет",
    not_linked: "не связан",
    not_set: "не задан",
  },
  unpair: {
    title: "⚠ Подтверди отвязку",
    active_session: "📌 Активная сессия: {{sessionName}}",
    body_1: "Это удалит Telegram binding для активной сессии.",
    body_2:
      "Метаданные сессии и записи inbox останутся в Redis, пока ты не удалишь их отдельно.",
    done: "Отвязано: {{sessionName}}",
    shown: "Сессия отвязана: {{sessionName}}",
  },
  prune: {
    title: "⚠ Подтверди prune",
    linked_sessions: "🔗 Видимых здесь привязанных сессий: {{count}}",
    body_1: "Это очистит каждый Redis key внутри namespace telegram-mcp.",
    body_2:
      "Будут удалены pair codes, bindings, sessions, inbox, menu payloads и pending requests.",
    done: "Prune завершён. Удалено Redis keys: {{count}}.",
  },
  history: {
    title: "# Collab History",
    session: "Сессия: {{sessionName}}",
    empty: "Для этой сессии не найдено недавних Collab-событий.",
    project: "Проект: {{projectName}}",
    caption: "Collab history для {{sessionName}}",
  },
  broadcast: {
    begin: "Broadcast в {{count}} сессий.",
    title: "📣 Broadcast",
    body:
      "Отправь следующее текстовое сообщение, чтобы разослать его всем {{count}} привязанным сессиям.",
    hint:
      "Сообщение будет сохранено в inbox каждой сессии, а сервис разбудит все настроенные tmux target.",
    cancel_hint: "Команды вроде /menu или /help отменят режим broadcast.",
    collab_begin: "Broadcast в {{count}} Collab-сессий.",
    collab_title: "📣 Collab Broadcast",
    collab_projects: "Collab проектов: {{count}}",
    collab_sessions: "Уникальных сессий: {{count}}",
    collab_body:
      "Отправь следующее текстовое сообщение, чтобы разослать его всем Collab-сессиям на ботах без дублирования.",
    collab_hint:
      "Локальные сессии получат inbox message, удалённые — gateway delivery.",
    no_linked_sessions: "Привязанных сессий не найдено.",
    no_collab_targets: "Нет доступных Collab-сессий для broadcast.",
    no_projects_first: "Сначала создай проект или войди в существующий.",
    mode_not_active: "Режим broadcast не активен.",
    cancelled: "Broadcast отменён.",
    cancelled_no_sessions:
      "Broadcast отменён, потому что привязанных сессий не найдено.",
    completed_linked: "Broadcast завершён для {{count}} привязанных сессий.",
    completed_collab: "Broadcast завершён для {{count}} Collab-сессий.",
    completed_collab_local: "Локальных inbox: {{count}}",
    completed_collab_remote: "Удалённых deliveries: {{count}}",
    completed_collab_total: "Всего сессий: {{count}}",
  },
  project: {
    not_found: "Проект не найден.",
    left_callback: "Выход из проекта выполнен.",
    left_screen: "Вы вышли из выбранного проекта.",
    deleted_callback: "Проект удалён.",
    deleted_screen:
      "Проект «{{projectName}}» удалён. Участники отвязаны, project state очищен.",
    delete_only_owner: "Удалять проект может только owner.",
    delete_menu_title: "🗑 Delete Project",
    active_session: "📌 Активная сессия: {{sessionName}}",
    total_count: "🗂 Проектов в Collab: {{count}}",
    owner_count: "👑 Проектов, где ты owner: {{count}}",
    delete_choose: "Выбери проект для полного удаления.",
    delete_body:
      "Будут отвязаны участники, удалены project sessions и сама запись проекта.",
    delete_owner_hint: "Удалять проект может только owner.",
    created: "Проект создан: {{projectName}}\nInvite: {{inviteToken}}",
    joined: "Вход в проект выполнен: {{projectName}}",
    opened: "Открыт проект: {{projectName}}",
    invalid_action: "Некорректное действие проекта.",
    invalid_member_action: "Некорректное действие для участника проекта.",
    invalid_member_payload: "Некорректные данные участника проекта.",
    stale_member_payload: "Данные участника проекта некорректны или устарели.",
    invalid_live_payload: "Некорректные данные Live View.",
    stale_live_payload: "Данные Live View некорректны или устарели.",
    no_telegram_user: "Не удалось определить Telegram пользователя.",
    request_live_sent: "Запрос на Live отправлен на подтверждение.",
    loading_members: "Загружаю участников.",
    opening_members: "Открываю участников проекта.",
    opening_session: "Открываю сессию.",
    opening_files: "Открываю файлы.",
    create_prompt_title: "📦 Создать проект",
    create_prompt_body: "Отправь следующим сообщением имя проекта.",
    join_prompt_title: "🔑 Вступить в проект",
    join_prompt_body: "Отправь следующим сообщением invite token проекта.",
    prompt_cancel: "Команды вроде /menu или /help отменят этот режим.",
    start_create: "Создание проекта.",
    start_join: "Вход в проект.",
    data_missing: "Данные проекта не найдены.",
    data_stale: "Данные проекта устарели или некорректны.",
    no_active_project: "Нет активного проекта.",
    left_current: "Выход из проекта выполнен.",
    left_current_screen: "Вы вышли из текущего проекта.",
    members_title: "👥 Участники {{projectName}}",
    current_session: "Сессия: {{sessionName}}",
    other_sessions: "Других сессий: {{count}}",
    choose_file_target: "Выбери, кому передать этот файл.",
    choose_member_action:
      "Выбери сессию, чтобы спросить, поделиться, ответить или передать.",
    no_other_active: "В этом проекте пока нет других активных сессий.",
    leave: "🚪 Выйти",
    back_to_projects: "⬅ К проектам",
    ask: "❓ Спросить",
    share_button: "📤 Поделиться",
    back_to_members: "⬅ К участникам",
    back_to_session: "⬅ К сессии",
    file_title: "📎 Выбор файла",
    file_project: "Проект: {{projectName}}",
    file_recipient: "Получатель: {{label}}",
    file_choose: "Выбери файл для отправки.",
    file_none: "В этой сессии нет загруженных файлов.",
    invalid_approval: "Некорректное подтверждение Live View.",
    invalid_approval_data: "Некорректные данные подтверждения.",
    approval_stale: "Запрос Live View устарел.",
  },
  handoff: {
    no_pending: "Нет ожидающего prompt передачи файла.",
    cancelled: "Передача файла отменена.",
    delivered_agent: "Файл передан агенту.",
    queued_partner: "Файл поставлен в очередь доставки напарнику.",
    project: "Проект: {{projectName}}",
    recipient: "Получатель: {{label}}",
    session: "Сессия: {{label}}",
    status: "Статус: {{status}}",
    share: "Share: {{shareId}}",
    delivered: "доставлено",
    queued: "в очереди",
    prompt_title: "🤝 Передать участнику",
    route: "Сессия: {{sourceSessionName}} -> {{targetSessionName}}",
    file: "Файл: {{fileName}}",
    prompt_body:
      "Отправь следующим сообщением описание или инструкции для этого файла.",
    prompt_hint: "Этот текст будет приложен к handoff.",
    choose_title: "📎 Выбор файла",
    choose_recipient: "Получатель: {{label}}",
    choose_local: "Выбери файл для отправки локальному напарнику.",
    choose_project: "Выбери файл для отправки.",
    no_files: "В этой сессии нет загруженных файлов.",
    cancel: "Отмена",
    uploaded_to_session: "Файл отправлен в сессию {{label}}.",
    uploaded_to_partner: "Файл отправлен напарнику {{label}}.",
    delivered_one: "Файл доставлен в сессию {{label}}.",
    delivered_many: "Файлы доставлены в сессию {{label}}: {{count}}.",
  },
  system: {
    sessions_menu_unavailable:
      "Меню сессий временно недоступно. Попробуй /menu ещё раз.",
    error_prefix: "Ошибка: {{message}}",
    tmux_recreated_hint:
      "Обычно это значит, что pane/window/session был пересоздан.",
  },
} as const;
