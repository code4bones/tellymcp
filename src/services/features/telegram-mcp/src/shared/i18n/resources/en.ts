export const enCommon = {
  errors: {
    no_telegram_identity: "Telegram identity is unavailable for this chat.",
    no_active_session:
      "No active session is linked yet. Pair a session via /start <code>.",
    missing_telegram_context: "Telegram user or chat is missing.",
  },
  menu: {
    refreshed: "Menu refreshed.",
    gateway_unavailable: "Gateway unavailable",
    no_telegram_identity_label: "No Telegram identity",
    no_active_session_label: "No active session",
    back: "⬅ Back",
    refresh: "🔄 Refresh",
    close: "✖ Close",
    delete: "🗑 Delete",
    get: "📥 Get",
  },
} as const;

export const enMenu = {
  main: {
    buttons: {
      live: "🖥 Live",
      content: "📄 Content",
      browser: "🌐 Browser",
      local: "🏠 Local",
      collab: "👥 Collab",
      storage: "📦 Storage",
      settings: "⚙ Settings",
      back: "⬅ Back",
    },
    actions: {
      open_content: "Opening content menu.",
      open_browser: "Opening browser menu.",
      open_inbox: "Opening inbox.",
      open_storage: "Opening storage.",
      open_settings: "Opening settings.",
      back_to_sessions: "Back to sessions.",
    },
    screen: {
      title: "🎛 Session: {{sessionName}}",
      inbox_messages: "📥 Inbox messages: {{count}}",
      project: "📦 Project: <b>{{projectName}}</b>",
      partner: "🤝 Partner: <b><i>{{partnerName}}</i></b>",
      partner_hint:
        "Share API details, what's new, errors, and git changes with your teammate.",
      link_hint:
        "🔗 Link a partner session to coordinate through shared notes and files.",
      tmux_mode_direct: "🖧 TMUX mode: direct",
    },
  },
  sessions: {
    screen: {
      title: "🗂 Choose active session",
      last_worked: "🕘 Last worked: <i>{{sessionName}}</i>",
      updated: "⏱ Updated: <i>{{timestamp}}</i>",
      current_active: "📌 Current active: <b>{{sessionName}}</b>",
      no_linked_sessions: "No visible sessions found for this Telegram identity.",
    },
    labels: {
      no_linked_sessions: "🫥 No visible sessions",
      unavailable: "⚠ Sessions unavailable",
      tools: "🛠 Tools",
    },
    actions: {
      no_linked_sessions:
        "No visible sessions found for this Telegram identity.",
      unavailable: "Sessions menu is temporarily unavailable.",
      refreshed: "Sessions refreshed.",
      open_tools: "Opening tools menu.",
    },
  },
  inbox: {
    button: "📥 Inbox",
    button_count: "📥 Inbox ({{count}})",
    screen: {
      title: "📥 Inbox",
      active_session: "📌 Active session: {{sessionName}}",
      stored_messages: "📨 Stored messages: {{count}}",
      choose_message: "Choose a message below to inspect or delete it.",
      empty: "No stored unsolicited Telegram messages for this session.",
    },
    labels: {
      empty: "📭 Inbox is empty",
    },
    actions: {
      empty: "No unsolicited Telegram messages are stored.",
      refreshed: "Inbox refreshed.",
    },
  },
  buffer: {
    buttons: {
      visible: "👁 Visible",
      full: "🧾 Full",
      last_300: "📄 Last 300",
      last_1000: "📄 Last 1000",
    },
    screen: {
      title: "📄 Content",
      active_session: "📌 Active session: {{sessionName}}",
      tmux_target: "🖥 tmux target: {{tmuxTarget}}",
      export_hint:
        "Choose how much pane history to export as a Markdown file.",
      export_modes:
        "Visible is the current pane viewport. Full exports the whole available tmux history.",
    },
  },
  browser: {
    buttons: {
      screenshots: "📸 Screenshots",
      screenshots_count: "📸 Screenshots ({{count}})",
    },
    actions: {
      open_screenshots: "Opening screenshots.",
      back_to_session_menu: "Back to session menu.",
      refreshed: "Screenshots refreshed.",
      back_to_browser_menu: "Back to browser menu.",
    },
    screen: {
      title: "🌐 Browser",
      active_session: "📌 Active session: {{sessionName}}",
      stored_screenshots: "📸 Stored screenshots: {{count}}",
      choose_action: "Choose a browser-related action below.",
    },
  },
  screenshots: {
    screen: {
      title: "📸 Screenshots",
      active_session: "📌 Active session: {{sessionName}}",
      stored_screenshots: "📦 Stored screenshots: {{count}}",
      choose_screenshot:
        "Choose a screenshot below to get it in Telegram or delete it.",
      empty: "No browser screenshots are stored for this session.",
    },
    labels: {
      empty: "📭 No screenshots",
    },
    actions: {
      empty: "No screenshots are stored for this session.",
      refreshed: "Screenshots refreshed.",
      back_to_screenshots: "Back to screenshots.",
    },
  },
  storage: {
    buttons: {
      get: "📥 Get",
      delete: "🗑 Delete",
    },
    actions: {
      back_to_storage: "Back to storage.",
      refreshed: "Storage refreshed.",
      empty: "No files are stored in .mcp-xchange for this session yet.",
    },
    screen: {
      title: "📦 Storage",
      active_session: "📌 Active session: {{sessionName}}",
      stored_files: "📦 Stored files: {{count}}",
      choose_file:
        "Choose a file below to inspect it or send it to Telegram.",
      empty: "No .mcp-xchange files are stored for this session.",
    },
    labels: {
      empty: "📭 Storage is empty",
    },
  },
  settings: {
    buttons: {
      info: "ℹ Info",
      rename: "✏ Rename",
      unpair: "🗑 Unpair",
      confirm_unpair: "⚠ Confirm route removal",
    },
    actions: {
      confirm_unpair: "Confirm route removal.",
      back_to_settings: "Back to settings.",
      rename_prompt: "Send the new session title.",
      rename_body:
        "Send the next text message as the new title for the active session.\nCommands like /menu or /help cancel rename mode.",
    },
    screen: {
      title: "⚙ Settings",
      active_session: "📌 Active session: {{sessionName}}",
      hint:
        "Open console info, rename it, or remove its Telegram route.",
    },
  },
  local: {
    buttons: {
      partner: "🤝 Partner",
      link: "🔗 Link",
      unlink: "🔓 Unlink",
    },
    actions: {
      open_local: "Opening local collaboration.",
      back_to_session_menu: "Back to session menu.",
    },
    screen: {
      title: "🏠 Local",
      active_session: "📌 Active session: {{sessionName}}",
      link_status: "🤝 Link: {{linkedSessionName}}",
      link_status_none: "🤝 Link: not configured",
      hint_title: "Local collaboration inside one bot lives here:",
      hint_body: "console linking, note exchange, and file handoff without a gateway.",
      unavailable: "Local collaboration is unavailable for this chat.",
      no_active_session: "No active console is selected. Open /menu and choose one first.",
    },
  },
  link: {
    buttons: {
      link: "🔗 Link",
      unlink_with_name: "🔓 Unlink {{sessionName}}",
      unlink: "🔓 Unlink",
    },
    labels: {
      no_partner_sessions: "🫥 No partner sessions",
    },
    actions: {
      no_partner_sessions: "No other linked sessions are available.",
      back_to_session_menu: "Back to session menu.",
      unlinked: "Partner session unlinked.",
      choose_partner: "Choose a partner session.",
    },
    screen: {
      title: "🔗 Link partner",
      active_session: "📌 Active session: {{sessionName}}",
      choose_partner: "Choose another session to link as a teammate.",
      hint:
        "Use this partnership to share API summaries, what's new, errors, and relevant git changes through .mcp-xchange notes and files.",
    },
  },
  partner: {
    buttons: {
      ask: "❓ Ask",
      share: "📤 Share",
      unlink: "🔓 Unlink",
    },
    actions: {
      back_to_session_menu: "Back to session menu.",
      open_partner_menu: "Opening partner menu.",
      back_to_partner: "Back to partner.",
      cancel_note_input: "Partner note input cancelled.",
      no_pending_note_input: "No active partner note input.",
      task_sent: "Task was sent to the selected session.",
      inbox_queued: "Task was placed into the current session inbox.",
    },
    screen: {
      title: "🤝 Partner",
      active_session: "📌 Active session: {{sessionName}}",
      linked_partner: "👥 Linked partner: {{partnerName}}",
      no_partner: "No partner is linked yet.",
      use_link_first: "Use Link in the session menu first.",
      prompt_hint: "Ask for API details or share what changed.",
      prompt_format:
        "Prompt format: first line is summary. Add a blank line and then the main message body if needed.",
      default_partner: "partner",
      executor: "Executor: {{label}}",
      route_result: "Result route: {{source}} -> {{target}}",
      route_send: "Send route: {{source}} -> {{target}}",
      type: "Type: {{kind}}",
      summary: "Summary: {{summary}}",
      status: "Status: {{status}}",
      delivered: "delivered",
      queued: "queued",
      current_session_handles:
        "The current session will prepare the result and send it itself.",
    },
  },
  collab: {
    buttons: {
      tools: "🛠 Tools",
      create: "➕ Create",
      join: "🔑 Join",
      broadcast: "📣 Broadcast",
      history: "🕘 History",
      delete: "🗑 Delete",
    },
    actions: {
      gateway_only: "Projects are available only through the gateway.",
      open_tools: "Opening project tools.",
      open_collab: "Opening Collab.",
      open_delete: "Opening project deletion.",
      back_to_collab: "Back to Collab.",
      back_to_tools: "Back to tools.",
      back_to_session_menu: "Back to session menu.",
      no_projects: "No projects yet. Create one or join an existing project.",
    },
    labels: {
      no_projects: "🫥 No projects",
    },
    screen: {
      title: "👥 Collab",
      gateway_not_configured: "Gateway is not configured for this runtime.",
      use_local_instead:
        "Use Local for collaboration inside one bot.",
      unavailable: "Collab is unavailable for the current session.",
      active_session: "📌 Active session: {{sessionName}}",
      open_project: "📦 Open project: {{projectName}}",
      open_project_none: "📦 Open project: not selected",
      project_count: "🗂 Available projects: {{count}}",
      invite_hint: "Open a project, create a new one, or join by invite code.",
      tools_title: "🛠 Collab Tools",
      tools_empty: "Create a project or join an existing one first.",
      tools_project_count: "🗂 Collab projects: {{count}}",
      tools_session_count: "👥 Unique sessions: {{count}}",
      tools_broadcast:
        "Broadcast sends your next text message to every unique Collab session across bots without duplication.",
      tools_history:
        "History sends a .md file with the latest 5 Collab events for the current session.",
    },
  },
  help: {
    title: "❓ TellyMCP help",
    menu: "/menu - open the sessions list",
    help: "/help - show this help",
    how_it_works: "How it works:",
    step_choose: "- choose the active session",
    step_inbox: "- ordinary Telegram messages go to that session inbox",
    step_nudge:
      "- if a tmux target is configured, the service nudges the agent automatically",
    step_tools:
      "- the agent then reads the inbox batch through MCP tools",
  },
  live: {
    buttons: {
      fullscreen: "Fullscreen",
      expand: "Expand",
      default: "Default",
    },
    actions: {
      opening: "Opening Live View.",
      choose_mode: "Choose a launch mode:",
      opened_info: "Live view opened.",
      approval_unavailable: "This session is unavailable for approval right now.",
    },
    errors: {
      identity_unavailable: "Telegram identity is unavailable.",
      no_active_session: "No active session selected.",
      webapp_disabled: "WebApp is not enabled on the server.",
      public_url_missing: "WebApp public URL is not configured.",
    },
    screen: {
      launcher_title: "🖥 Live: {{sessionName}}",
    },
    approval: {
      request_title: "🖥 Live view request",
      request_message:
        "Session {{sourceSessionName}} requests access to the Live view of your session.",
      route: "Session: {{sourceSessionName}} -> {{targetSessionName}}",
      project: "Project: {{projectName}}",
      approve: "Approve",
      deny: "Deny",
      approved: "✅ Live access approved.",
      denied: "❌ Live access denied.",
      source_open: "Open Live",
      result_approved:
        "Live view was approved for {{sourceSessionName}} -> {{targetSessionName}}.",
      result_denied:
        "Live view was denied for {{sourceSessionName}} -> {{targetSessionName}}.",
    },
  },
  notices: {
    admin: {
      gateway_client_registered_title: "🆕 New gateway client registered",
      gateway_session_registered_title: "🆕 New gateway session registered",
      gateway_client_uuid: "Client UUID: {{value}}",
      gateway_node_id: "Node: {{value}}",
      gateway_package_version: "Package: {{value}}",
      gateway_session_count: "Sessions in hello: {{count}}",
      gateway_new_sessions: "New sessions:",
      gateway_session_item: "• {{label}} ({{localSessionId}})",
    },
    startup: {
      title: "✅ TellyMCP is running.",
      version: "Version: {{packageVersion}}",
      protocol: "Protocol: {{protocolVersion}}",
      mode: "Mode: {{mode}}",
      bot: "Bot: @{{botUsername}}",
      sessions: "Linked sessions: {{count}}",
      session_list: "Sessions: {{sessions}}",
      mcp: "MCP: {{url}}",
      webapp: "WebApp: {{url}}",
      gateway: "Gateway: {{url}}",
      gateway_ws: "Gateway WS: {{url}}",
      browser: "Browser: {{status}}",
      update_available:
        "Update available: {{currentVersion}} -> {{latestVersion}}",
      update_command:
        "Update command: npm install -g {{packageName}}@{{latestVersion}}",
      hint: "Send /menu to open the session menu.",
    },
    project: {
      member_joined: "A participant joined project “{{projectName}}”: {{memberLabel}}.",
      member_left: "A participant left project “{{projectName}}”: {{memberLabel}}.",
      deleted: "Project “{{projectName}}” was deleted. Local project bindings were cleared.",
      new_member: "New participant",
      member: "Participant",
    },
    tools: {
      changed: "Gateway TOOLS.md changed or the current session hash is unknown.",
      session: "Session: {{sessionName}}",
      action_required:
        "Action required: call refresh_tools_markdown with the current known hash. If changed=true, read and apply the returned content before continuing work.",
    },
    version: {
      reject:
        "Gateway and client are protocol-incompatible. Transport for this session is blocked.",
      warn: "Gateway and client versions differ.",
      session: "Session: {{sessionName}}",
      client: "Client: {{packageVersion}} / protocol {{protocolVersion}}",
      gateway: "Gateway: {{packageVersion}} / protocol {{protocolVersion}}",
    },
    tmux: {
      target_invalid_title:
        "⚠ Automatic tmux nudge failed for session {{sessionName}}.",
      target_invalid_target: "Saved tmux target is no longer valid: {{tmuxTarget}}",
      target_invalid_action: "Rebind the tmux target for this session.",
      unavailable_title:
        "⚠ Automatic tmux nudge was skipped for session {{sessionName}}.",
      unavailable_body: "tmux is unavailable on this machine right now.",
      unavailable_target: "tmux target: {{tmuxTarget}}",
      unavailable_reason:
        "This usually means the tmux session/server is not running or is unreachable via the current socket path.",
      unavailable_action:
        "Start tmux and the agent inside it, or update/remove the tmux target for this session.",
      prompt_detected_title:
        "🛎 The agent in session {{sessionName}} may be waiting for your input.",
      prompt_detected_score: "Detection score: {{score}}",
      prompt_detected_target: "tmux target: {{tmuxTarget}}",
      prompt_detected_hint:
        "Open Live or answer in the terminal if this prompt really needs you.",
      prompt_detected_excerpt: "Recent prompt lines:",
    },
  },
  admin: {
    auth: {
      prompt:
        "Gateway admin access is locked. Send /auth <token> to continue.",
      help:
        "This gateway bot requires admin authentication first. Send /auth <token>.",
      required_callback:
        "Authenticate first with /auth <token>.",
      invalid: "Admin token is invalid.",
      success:
        "Gateway admin authentication accepted. You can continue with commands and menus.",
      disabled: "Gateway admin authentication is not enabled.",
    },
    buttons: {
      clients: "Clients",
      tools: "Tools",
      client_env: "Client .env",
    },
    actions: {
      open_clients: "Opening clients.",
      open_client_sessions: "Opening client sessions.",
      open_client_session: "Opening session.",
      open_tools: "Opening tools.",
      back_to_admin: "Back to admin.",
      back_to_clients: "Back to clients.",
      back_to_client_sessions: "Back to client sessions.",
    },
    screen: {
      title: "🛡 Gateway Admin",
      help: "Use the admin menu to inspect gateway clients and export a client .env.",
      gateway_clients: "Known clients: {{count}}",
      gateway_clients_connected: "Connected via gateway WS: {{count}}",
      gateway_clients_registered: "Registered active sessions: {{count}}",
      gateway_clients_unavailable: "Known clients: unavailable right now.",
      hint: "Choose a section below.",
    },
    clients: {
      title: "🖥 Gateway Clients",
      empty: "The gateway does not know any clients yet.",
      unavailable: "The gateway client list is unavailable right now.",
      connected_count: "Connected via gateway WS: {{count}}",
      registered_count: "Registered active sessions: {{count}}",
      legend: "Legend: 🟢 connected right now, 🗂 has registered active sessions.",
      item: "• {{label}}",
      bot: "  Bot: {{botUsername}}",
      sessions: "  Sessions: {{count}}",
      last_seen: "  Last seen: {{value}}",
    },
    client_sessions: {
      buttons: {
        collab: "👥 Collab",
        all: "🗂 All",
      },
      title: "🧩 Client Sessions",
      client: "Client: <b>{{client}}</b>",
      total: "Sessions: {{count}}",
      choose: "Choose a session below.",
      choose_scope: "Choose which sessions to inspect.",
      scope_collab: "Scope: Collab",
      scope_all: "Scope: All known sessions",
      empty: "This client has no active sessions.",
      empty_all: "This client has no known sessions right now.",
      unavailable: "The client session list is unavailable right now.",
      updated: "  Updated: {{timestamp}}",
      project: "  Project: <b>{{projectName}}</b>",
      no_client_selected: "Choose a client first.",
      invalid_action: "Invalid client action.",
      not_found: "The selected client is no longer available.",
      back_to_scope: "⬅ Back to views",
    },
    client_session_detail: {
      title: "🖥 Client Session",
      session: "Session: <b>{{sessionName}}</b>",
      project: "Project: <b>{{projectName}}</b>",
      bind: "🔗 Link here",
      bound: "Session linked: {{sessionName}}",
      back_to_sessions: "⬅ Back to sessions",
    },
    tools: {
      title: "🛠 Admin Tools",
      client_env_help:
        "Export a ready-to-edit .env-client built from the current gateway URLs and runtime settings.",
      client_env_caption: "Generated .env-client from current gateway settings.",
      client_env_sent: "Client .env sent.",
    },
  },
  developer: {
    screen: {
      title: "🛠 Tools",
      linked_sessions: "🗂 Visible sessions: {{count}}",
      broadcast_help:
        "Broadcast writes your next text message into every linked session inbox and nudges every configured tmux target.",
      prune_help:
        "Prune all clears every Redis key under this Telegram MCP namespace.",
    },
  },
  session_info: {
    opened: "Session info opened.",
    title: "ℹ Session info",
    label: "📌 Label: {{value}}",
    session_id: "🆔 Session ID: {{value}}",
    inbox_count: "📥 Inbox count: {{count}}",
    route: "🔗 Telegram route: {{value}}",
    partner: "🤝 Partner: {{value}}",
    tmux_target: "🖥 tmux target: {{value}}",
    tmux_session: "📺 tmux session: {{value}}",
    tmux_window: "🪟 tmux window: {{value}}",
    tmux_pane: "🔹 tmux pane: {{value}}",
    yes: "yes",
    no: "no",
    not_linked: "not linked",
    not_set: "not set",
  },
  unpair: {
    title: "⚠ Confirm route removal",
    active_session: "📌 Active session: {{sessionName}}",
    body_1: "This removes the active Telegram route for the selected console.",
    body_2:
      "Session metadata and inbox records remain in Redis until you delete them separately.",
    done: "Telegram route removed: {{sessionName}}",
    shown: "Telegram route removed: {{sessionName}}",
  },
  prune: {
    title: "⚠ Confirm prune",
    linked_sessions: "🗂 Visible sessions here: {{count}}",
    body_1: "This clears every Redis key under the telegram-mcp namespace.",
    body_2:
      "Bindings, sessions, inbox, menu payloads, and pending requests will all be deleted.",
    done: "Prune complete. Deleted {{count}} Redis keys.",
  },
  history: {
    title: "# Collab History",
    session: "Session: {{sessionName}}",
    empty: "No recent Collab events were found for this session.",
    project: "Project: {{projectName}}",
    caption: "Collab history for {{sessionName}}",
  },
  broadcast: {
    begin: "Broadcast to {{count}} sessions.",
    title: "📣 Broadcast",
    body:
      "Send the next text message to broadcast it to all {{count}} visible sessions.",
    hint:
      "The message will be stored in every session inbox and the service will nudge every configured tmux target.",
    cancel_hint: "Commands like /menu or /help cancel broadcast mode.",
    collab_begin: "Broadcast to {{count}} collab sessions.",
    collab_title: "📣 Collab Broadcast",
    collab_projects: "Collab projects: {{count}}",
    collab_sessions: "Unique sessions: {{count}}",
    collab_body:
      "Send the next text message to broadcast it to all Collab sessions across bots without duplication.",
    collab_hint:
      "Local sessions receive an inbox message, remote sessions receive a gateway delivery.",
    no_linked_sessions: "No visible sessions found.",
    no_collab_targets: "No Collab sessions are available for broadcast.",
    no_projects_first: "Create a project or join an existing one first.",
    mode_not_active: "Broadcast mode is not active.",
    cancelled: "Broadcast cancelled.",
    cancelled_no_sessions:
      "Broadcast was cancelled because no visible sessions were found.",
    completed_linked: "Broadcast completed for {{count}} visible sessions.",
    completed_collab: "Broadcast completed for {{count}} Collab sessions.",
    completed_collab_local: "Local inbox: {{count}}",
    completed_collab_remote: "Remote deliveries: {{count}}",
    completed_collab_total: "Total sessions: {{count}}",
  },
  project: {
    not_found: "Project not found.",
    left_callback: "Left the project.",
    left_screen: "You left the selected project.",
    deleted_callback: "Project deleted.",
    deleted_screen:
      "Project “{{projectName}}” was deleted. Participants were unbound and project state was cleared.",
    delete_only_owner: "Only the owner can delete a project.",
    delete_menu_title: "🗑 Delete Project",
    active_session: "📌 Active session: {{sessionName}}",
    total_count: "🗂 Collab projects: {{count}}",
    owner_count: "👑 Projects where you are owner: {{count}}",
    delete_choose: "Choose a project for complete deletion.",
    delete_body:
      "Participants will be unbound, project sessions removed, and the project record deleted.",
    delete_owner_hint: "Only the owner can delete a project.",
    created: "Project created: {{projectName}}\nInvite: {{inviteToken}}",
    joined: "Joined project: {{projectName}}",
    opened: "Opened project: {{projectName}}",
    invalid_action: "Invalid project action.",
    invalid_member_action: "Invalid project member action.",
    invalid_member_payload: "Invalid project member data.",
    stale_member_payload: "Project member data is invalid or outdated.",
    invalid_live_payload: "Invalid Live View data.",
    stale_live_payload: "Live View data is invalid or outdated.",
    no_telegram_user: "Unable to determine Telegram user.",
    request_live_sent: "Live request sent for approval.",
    loading_members: "Loading members.",
    opening_members: "Opening project members.",
    opening_session: "Opening session.",
    opening_files: "Opening files.",
    create_prompt_title: "📦 Create project",
    create_prompt_body: "Send the project name in your next message.",
    join_prompt_title: "🔑 Join project",
    join_prompt_body: "Send the project invite token in your next message.",
    prompt_cancel: "Commands like /menu or /help cancel this mode.",
    start_create: "Creating project.",
    start_join: "Joining project.",
    data_missing: "Project data was not found.",
    data_stale: "Project data is outdated or invalid.",
    no_active_project: "No active project.",
    left_current: "Project left.",
    left_current_screen: "You left the current project.",
    members_title: "👥 Members of {{projectName}}",
    current_session: "Session: {{sessionName}}",
    other_sessions: "Other sessions: {{count}}",
    choose_file_target: "Choose who should receive this file.",
    choose_member_action:
      "Choose a session to ask, share with, reply to, or send a file to.",
    no_other_active: "There are no other active sessions in this project yet.",
    leave: "🚪 Leave",
    back_to_projects: "⬅ To projects",
    ask: "❓ Ask",
    share_button: "📤 Share",
    back_to_members: "⬅ To members",
    back_to_session: "⬅ To session",
    file_title: "📎 Choose file",
    file_project: "Project: {{projectName}}",
    file_recipient: "Recipient: {{label}}",
    file_choose: "Choose a file to send.",
    file_none: "There are no uploaded files in this session.",
    invalid_approval: "Invalid Live View approval.",
    invalid_approval_data: "Invalid approval data.",
    approval_stale: "The Live View request has expired.",
  },
  handoff: {
    no_pending: "No pending file handoff prompt.",
    cancelled: "File handoff cancelled.",
    delivered_agent: "File delivered to the agent.",
    queued_partner: "File was queued for delivery to the partner.",
    project: "Project: {{projectName}}",
    recipient: "Recipient: {{label}}",
    session: "Session: {{label}}",
    status: "Status: {{status}}",
    share: "Share: {{shareId}}",
    delivered: "delivered",
    queued: "queued",
    prompt_title: "🤝 Send to participant",
    route: "Session: {{sourceSessionName}} -> {{targetSessionName}}",
    file: "File: {{fileName}}",
    prompt_body:
      "Send the file description or instructions in your next message.",
    prompt_hint: "This text will be attached to the handoff.",
    choose_title: "📎 Choose file",
    choose_recipient: "Recipient: {{label}}",
    choose_local: "Choose a file to send to the local partner.",
    choose_project: "Choose a file to send.",
    no_files: "No uploaded files are available in this session.",
    cancel: "Cancel",
    uploaded_to_session: "File sent to session {{label}}.",
    uploaded_to_partner: "File sent to partner {{label}}.",
    delivered_one: "File delivered to session {{label}}.",
    delivered_many: "Files delivered to session {{label}}: {{count}}.",
  },
  system: {
    sessions_menu_unavailable:
      "Sessions menu is temporarily unavailable. Try /menu again.",
    gateway_relay_inbox_sent:
      "Message routed to session {{sessionName}} through the gateway.",
    gateway_relay_inbox_failed:
      "Failed to route the message to the selected gateway session.",
    error_prefix: "Error: {{message}}",
    tmux_recreated_hint:
      "This usually means the pane/window/session was recreated.",
  },
} as const;
