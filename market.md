Да. По README и беглому осмотру репы: **идея не уникальная**, но **комбинация механик у TellyMCP уже не выглядит просто “ещё один Telegram bot для агента”**.

Моя оценка: **вторичность ядра — 7/10**, **вторичность продукта как связки — 4/10**.

То есть: “агент спрашивает человека через Telegram” — уже довольно избитая механика. А вот “MCP + Telegram + tmux Live View + session pairing + multi-agent/local/remote collaboration + `.mcp-xchange` + browser tools + gateway mode” — это уже более самобытный комбайн.

## Где TellyMCP явно пересекается с существующими штуками

### 1. Telegram как human-in-the-loop канал

Это самая вторичная часть. У TellyMCP есть `ask_user_telegram`, inbox, уведомления, pairing flow, Telegram bot token, ожидание ответа от человека и т.п. README прямо позиционирует проект как “Telegram Human-in-the-Loop MCP server for coding agents” и перечисляет механику: спрашивать человека, получать незапрошенные сообщения, связывать сессии, обмениваться файлами/скриншотами. ([GitHub][1])

Аналоги уже есть:

**Anthropic official Telegram plugin для Claude Code** — очень близко по базовой идее: Telegram bot подключается к Claude Code через MCP, входящие сообщения пересылаются в Claude Code session, бот умеет reply/react/edit, поддерживает pairing и allowlist. ([GitHub][2])

**mcp-kilo-telegram** — прямой простой аналог по ядру: MCP server, который позволяет AI assistants задавать вопросы в Telegram, ждать ответа, делать HITL approval/input flow. ([GitHub][3])

**Agent Reachout** — тоже MCP/Claude Code + Telegram HITL: уведомления, решения, blockers, продолжение работы после human input. ([MCP Market][4])

Вывод: **если описывать TellyMCP только как “агент задаёт вопросы в Telegram” — продукт будет выглядеть вторично.** Это уже рынок/паттерн, не новая категория.

---

### 2. Удалённый контроль coding agent с телефона

Тут тоже есть пересечения. Сейчас это прям мини-тренд: “Claude/Codex/Gemini из Telegram/мобилки, пока агент работает в tmux”.

Например:

**Claude Code Telegram** позиционируется как “Control Claude Code AI directly from Telegram” и обещает писать код, ревьюить, управлять проектами, approving HITL actions и деплоить без компьютера. ([GitHub][5])

**TerminalBot** — Telegram bot для удалённого контроля tmux sessions, мониторинга long-running tasks и CLI tools с телефона. ([GitHub][6])

**CCBot** — Telegram ↔ tmux bridge для Claude Code: monitor, interact, manage AI coding sessions running in tmux. ([GitHub][7])

**ccgram** — свежий пример Telegram ↔ tmux bridge уже не только для Claude Code, но и для Codex CLI/Gemini CLI: monitor output, respond to prompts, manage parallel sessions. ([GitHub][8])

То есть сама связка **Telegram ↔ tmux ↔ coding agent** тоже не уникальна.

Но у TellyMCP есть отличие: он не просто “шлёт команды в tmux”, а строит вокруг этого **MCP-сессионность**, `.mcp-xchange`, pairing, inbox, local/collab routing, gateway-relayed live view и browser tools. README прямо говорит, что tmux нужен для Live View, tmux nudges и direct tmux control из Telegram Mini App. ([GitHub][1])

---

### 3. Mobile-first agent control уже становится платформенной функцией

Тут самая опасная зона. OpenAI уже двигает Codex в ChatGPT mobile app: работа с активными threads, approvals, plugins, screenshots, terminal output, diffs, test results, real-time updates с машин, где запущен Codex. ([OpenAI][9])

Это значит, что если TellyMCP позиционировать как “Codex/агент с телефона”, то сверху его будет придавливать официальный UX: меньше настройки, нативная мобилка, доверенный relay, аккаунтная синхронизация.

Но это не убивает TellyMCP, потому что у него другая ниша: **self-hosted, Telegram-native, MCP-generic, tmux-centric, hackable, multi-agent/local-first**. Официальные штуки обычно красивее, но менее “я сам всё прокинул как хочу”.

---

## Где TellyMCP выглядит менее вторично

Вот тут, на мой взгляд, сильная часть.

### 1. Session pairing как first-class модель

README описывает явный pairing flow: агент создаёт short code, пользователь делает `/start <code>` или `/link <code>`, после этого появляется `/menu` и сессия становится управляемой из Telegram. ([GitHub][1])

У многих аналогов pairing тоже есть, но у TellyMCP это завязано не просто на доступ к боту, а на **конкретную agent session**, tmux target, cwd/workspace, `.mcp-xchange`, inbox и session context. Это уже ближе к “операционной панели для множества агентов”, а не к “чатик с одним Claude”.

### 2. `.mcp-xchange` как файловая шина между человеком, агентом и агентами

Это хорошая механика. README говорит, что Telegram uploads, screenshots и exchange files пишутся в `.mcp-xchange`; partner notes живут в `.mcp-xchange/shares/`, есть `SHARED_INDEX.md` и `LOCAL_INDEX.md`, а заметки имеют типы `share`, `question`, `reply`, `request`, `handoff`. ([GitHub][1])

Это уже не просто “отправь файл боту”. Это похоже на **локальный протокол handoff’ов** между агентами и человеком. Вот это стоит вытащить в позиционирование сильнее.

### 3. Local + Collab модель

README описывает `Local` link между сессиями для backend/frontend или подобных agent collaborations, а также `Collab` как project-based multi-machine/multi-bot flow с выбором project/member и действиями `Ask`, `Share`, `Live`. ([GitHub][1])

Это уже сильно отличается от простых Telegram мостов. Большинство аналогов решают “я ↔ один агент”. TellyMCP пытается решать “я ↔ несколько сессий ↔ напарники ↔ удалённые машины”.

### 4. Gateway mode

У TellyMCP есть client/gateway/both режимы, gateway HTTP surface, Postgres persistence, optional RabbitMQ fanout, WebSocket control-plane, gateway-relayed Live View и remote project messaging через gateway DB/ws. ([GitHub][1])

Это добавляет продукту “инфраструктурность”. С одной стороны, это усложняет install. С другой — это уже не игрушечный бот, а заготовка под self-hosted control plane.

### 5. Browser tools внутри того же MCP

У TellyMCP есть `browser_open`, `browser_click`, `browser_fill`, `browser_screenshot`, `browser_console`, `browser_errors`, `browser_network_failures`, `browser_dom`, `browser_computed_style` и изоляция browser context/page per MCP session. ([GitHub][1])

Это не уникально как идея — browser automation у агентов есть давно. Но в связке с Telegram handoff и screenshots в `.mcp-xchange` получается полезный workflow: агент проверяет SPA, делает скрин, человек смотрит в Telegram, правит курс.

---

## Самый близкий “продуктовый архетип”

Я бы сказал, TellyMCP сейчас находится между четырьмя категориями:

| Категория                                               |            Насколько TellyMCP похож |
| ------------------------------------------------------- | ----------------------------------: |
| Telegram HITL MCP server                                |                         Очень похож |
| Telegram/tmux remote control для Claude/Codex           |                         Очень похож |
| Self-hosted Codex/Claude mobile control plane           |                 Похож, но более DIY |
| Multi-agent collaboration bus через MCP/workspace files | Вот тут интереснее и менее заезжено |

Главное: **не продавать его как Telegram HITL.** Это самая слабая и самая вторичная формулировка.

Лучше продавать как:

> **Self-hosted mobile control plane for local coding agents: Telegram UI, tmux live view, MCP tools, session pairing, file handoffs, and multi-agent collaboration.**

Или по-русски:

> **Самохостящаяся Telegram-панель управления локальными coding agents: сессии, tmux live view, MCP-инструменты, файловые handoff’ы и коллаборация между агентами.**

Вот это звучит менее вторично.

---

## Что сейчас в README делает продукт более “вторичным”, чем он есть

README начинается с “Telegram Human-in-the-Loop MCP server for coding agents”. Это честно, но слишком generic. Под это описание уже подходят mcp-kilo-telegram, Agent Reachout, официальный Claude Telegram plugin и куча маленьких мостов. ([GitHub][3])

Я бы поменял первый экран README примерно так:

> TellyMCP is a self-hosted Telegram control plane for local and remote coding agents.
> It pairs each agent session with Telegram, exposes tmux live view/control, routes human input through MCP, exchanges files via `.mcp-xchange`, and lets multiple agent sessions collaborate locally or through a gateway.

То есть первым предложением — не HITL, а **control plane**.

---

## Итоговая оценка

**Не уникально:**

* Telegram HITL.
* Ask/notify/wait-for-human-response.
* Telegram bot для Claude/Codex.
* tmux remote control с телефона.
* file upload/download через Telegram.
* mobile approvals/steering — уже становится официальной платформенной фичей у Claude/Codex. ([Claude][10])

**Относительно самобытно:**

* MCP-native session pairing.
* tmux Live View через Telegram Mini App.
* `.mcp-xchange` как workspace-level handoff шина.
* local linked sessions для агент-агент коммуникации.
* gateway/collab для remote multi-machine/multi-bot workflows.
* browser automation + screenshots + Telegram/storage flow в одном контуре.

Мой честный вердикт: **как “Telegram HITL MCP” — вторично. Как “самохостящийся control plane для нескольких coding agents с tmux/live/session/file/collab механиками” — уже есть характер и шанс занять нишу.**

Главная продуктовая правка: **сдвинуть позиционирование с “бот спрашивает человека” на “операционная панель для живых agent sessions”.** Это сразу убирает ощущение клона и подсвечивает то, что реально отличает TellyMCP.

[1]: https://github.com/code4bones/tellymcp/blob/main/README.md "tellymcp/README.md at main · code4bones/tellymcp · GitHub"
[2]: https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram "claude-plugins-official/external_plugins/telegram at main · anthropics/claude-plugins-official · GitHub"
[3]: https://github.com/StoyPenny/mcp-kilo-telegram "GitHub - StoyPenny/mcp-kilo-telegram: A Model Context Protocol (MCP) server that enables AI assistants to ask questions via Telegram, creating a human-in-the-loop workflow for decisions, approvals, and input during long-running tasks. · GitHub"
[4]: https://mcpmarket.com/server/agent-reachout "Agent Reachout: Claude AI Notifications for Human-in-the-Loop"
[5]: https://github.com/Angusstone7/claude-code-telegram "GitHub - Angusstone7/claude-code-telegram: Control Claude Code AI assistant through Telegram. Full coding capabilities via chat. · GitHub"
[6]: https://github.com/liuxsh9/TerminalBot?utm_source=chatgpt.com "liuxsh9/TerminalBot: Control tmux terminal sessions ..."
[7]: https://github.com/six-ddc/ccbot?utm_source=chatgpt.com "CCBot - Telegram ↔ tmux bridge for Claude Code"
[8]: https://github.com/alexei-led/ccgram?utm_source=chatgpt.com "alexei-led/ccgram - Control AI Coding Agents from Telegram"
[9]: https://openai.com/index/work-with-codex-from-anywhere/ "Work with Codex from anywhere | OpenAI"
[10]: https://code.claude.com/docs/en/channels-reference "Channels reference - Claude Code Docs"
