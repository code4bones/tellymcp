const GITHUB_URL = "https://github.com/code4bones/tellymcp";
const NPM_URL = "https://www.npmjs.com/package/@deadragdoll/tellymcp";

const PAGE_STYLES = `
  :root {
    color-scheme: dark;
    --bg: #0b0f14;
    --panel: #111823;
    --border: #1f2a37;
    --text: #e6edf3;
    --muted: #8b96a5;
    --accent: #4aa3ff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 16px/1.6 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .wrap { max-width: 760px; margin: 0 auto; padding: 48px 24px 80px; }
  header.hero { margin-bottom: 40px; }
  header.hero h1 { font-size: 2.2rem; margin: 0 0 6px; }
  header.hero p.tagline { color: var(--muted); font-size: 1.1rem; margin: 0; }
  nav.top { display: flex; gap: 18px; margin-bottom: 32px; font-size: 0.95rem; }
  nav.top a { color: var(--muted); text-decoration: none; }
  nav.top a:hover { color: var(--accent); }
  h2 { font-size: 1.3rem; margin: 36px 0 12px; }
  p { margin: 0 0 14px; }
  ul { padding-left: 22px; margin: 0 0 14px; }
  li { margin-bottom: 6px; }
  a { color: var(--accent); }
  .cta { display: flex; gap: 12px; flex-wrap: wrap; margin: 28px 0; }
  .btn {
    display: inline-block;
    padding: 10px 18px;
    border-radius: 8px;
    border: 1px solid var(--border);
    color: var(--text);
    text-decoration: none;
    font-weight: 600;
  }
  .btn.primary { background: var(--accent); color: #06111c; border-color: var(--accent); }
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 20px 24px;
    margin-bottom: 16px;
  }
  footer { margin-top: 56px; padding-top: 20px; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.9rem; }
  footer a { color: var(--muted); }
  footer a:hover { color: var(--accent); }
  .meta { color: var(--muted); font-size: 0.9rem; }
`;

function renderPage(input: {
  title: string;
  description: string;
  bodyHtml: string;
  basePath: string;
}): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${input.title}</title>
    <meta name="description" content="${input.description}" />
    <style>${PAGE_STYLES}</style>
  </head>
  <body>
    <div class="wrap">
      <nav class="top">
        <a href="${input.basePath}">TellyMCP</a>
        <a href="${input.basePath}/policy">Privacy Policy</a>
        <a href="${input.basePath}/terms">Terms of Service</a>
        <a href="${GITHUB_URL}">GitHub</a>
      </nav>
      ${input.bodyHtml}
      <footer>
        <p>TellyMCP is open-source software (MIT License). This page describes the project;
        it is not an invitation to connect to any specific hosted instance.</p>
        <p><a href="${GITHUB_URL}">Source on GitHub</a> ·
        <a href="${NPM_URL}">Package on npm</a></p>
      </footer>
    </div>
  </body>
</html>`;
}

export function renderLandingHtml(basePath: string): string {
  const bodyHtml = `
      <header class="hero">
        <h1>TellyMCP</h1>
        <p class="tagline">A Telegram control plane for MCP-connected coding agents.</p>
      </header>

      <p>
        TellyMCP lets you supervise, message, and hand off work to coding agents
        (Codex, Claude, and other MCP-connected tools) from Telegram. A single
        gateway process owns the Telegram bot, a web mini-app, project state, and
        a live console registry; one or more agent processes connect to it as
        routable targets.
      </p>

      <div class="cta">
        <a class="btn primary" href="${GITHUB_URL}">View on GitHub</a>
        <a class="btn" href="${basePath}/terms">Terms of Service</a>
        <a class="btn" href="${basePath}/policy">Privacy Policy</a>
      </div>

      <h2>What it does</h2>
      <div class="card">
        <ul>
          <li>Exposes MCP tools for human-in-the-loop interaction over Telegram</li>
          <li>Lets one agent ask another agent to do work and return files or notes</li>
          <li>Lets MCP chat clients pull project text, images, and artifacts from a selected console</li>
          <li>Supports browser automation with Playwright, plus attaching to an already-running Firefox or Chrome tab via bundled local extensions</li>
          <li>Records browser sessions into structured bundles with HTML, network, and console artifacts</li>
          <li>Serves a Telegram Mini App / Live View directly from the gateway</li>
          <li>Runs the Telegram bot in polling or webhook mode</li>
        </ul>
      </div>

      <h2>Why it exists</h2>
      <p>
        Coding agents increasingly run unattended for long stretches. TellyMCP gives
        you a lightweight way to check in on them, approve or redirect work, and
        collaborate across multiple agents from a phone, without exposing agent
        consoles directly to the internet.
      </p>

      <h2>Self-hosting</h2>
      <p>
        TellyMCP is self-hosted: you run your own gateway, your own Telegram bot,
        and connect your own agents to it. This page does not grant access to, and
        does not publish connection details for, any particular running instance —
        see the <a href="${GITHUB_URL}">GitHub repository</a> for setup instructions.
      </p>
  `;

  return renderPage({
    title: "TellyMCP — Telegram control plane for MCP-connected coding agents",
    description:
      "TellyMCP is an open-source Telegram control plane for MCP-connected coding agents: supervise, message, and collaborate with coding agents from Telegram.",
    bodyHtml,
    basePath,
  });
}

export function renderPrivacyPolicyHtml(basePath: string): string {
  const bodyHtml = `
      <header class="hero">
        <h1>Privacy Policy</h1>
        <p class="tagline">TellyMCP project — gateway, web app, and browser attach extensions</p>
      </header>
      <p class="meta">Last updated: 2026-10-18</p>

      <p>
        This policy covers the TellyMCP gateway/web app and the TellyMCP browser
        attach extensions (<strong>TellyMCP Chrome Attach</strong> and
        <strong>TellyMCP Attach</strong> for Firefox), published by the TellyMCP
        project.
      </p>

      <h2>What this software does</h2>
      <p>
        TellyMCP is self-hosted software. A user (or organization) runs their own
        gateway instance and connects it to their own Telegram bot and their own
        coding-agent processes. The browser attach extensions let that same user
        connect their own local TellyMCP gateway to a specific browser tab they
        explicitly select ("attach"), so the local gateway can read page content,
        console messages, network activity, and cookies, and perform actions
        (click, fill, navigate, screenshot, inject debug scripts) on that one tab —
        strictly for local software development, testing, and browser-automation
        workflows.
      </p>

      <h2>What data is accessed, and where it goes</h2>
      <ul>
        <li>Data is only read from the single tab the user has explicitly <strong>attached</strong> or explicitly <strong>started recording</strong> — never passively from other open tabs.</li>
        <li>All data (DOM content, console output, network requests/responses, cookies, screenshots) is sent exclusively to the TellyMCP gateway that same user runs themselves, over a connection to an endpoint the user configures (commonly a local address such as <code>127.0.0.1</code>, or a gateway the user operates and controls).</li>
        <li>No data is ever sent to any server operated by the TellyMCP project's maintainer, nor to any third party. The maintainer does not collect, receive, or store any of this data.</li>
        <li>No data is sold, shared with advertisers, or used for purposes unrelated to the development session the user is actively running.</li>
      </ul>

      <h2>Remote / dynamically supplied code</h2>
      <p>
        The browser extensions' "inject script" feature executes a script that the
        user's own TellyMCP gateway supplies at the moment the user explicitly
        triggers that action, on the tab the user has attached. This code
        originates from the user's own process, not from any third-party or
        maintainer-controlled server, and is never executed automatically or in
        the background.
      </p>

      <h2>Permissions</h2>
      <p>
        Each browser permission the extensions request is used only for the
        specific local-development behavior described above (listing/attaching
        tabs, capturing console/network/cookies on an attached tab, keeping the
        background connection to the user's gateway alive, and running
        page-interaction commands on the attached tab). Host access
        (<code>&lt;all_urls&gt;</code>) is required only because the user may want
        to attach to any site they are currently developing against; it is not
        used to act on tabs the user has not explicitly attached.
      </p>

      <h2>Data retention</h2>
      <p>
        The extensions themselves retain only small, local browser-storage state
        needed for their own operation (the configured gateway address, which tab
        is currently attached, connection status) and short in-memory buffers of
        recent console/network events for the currently attached tab, cleared when
        that tab is detached, closed, or the browser restarts. The extensions do
        not maintain any server-side storage of their own. The gateway itself is
        operated by the user, under the user's own retention choices.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about this policy can be raised via the project's repository:
        <a href="${GITHUB_URL}">${GITHUB_URL}</a>.
      </p>
  `;

  return renderPage({
    title: "TellyMCP — Privacy Policy",
    description: "Privacy policy for the TellyMCP gateway and browser attach extensions.",
    bodyHtml,
    basePath,
  });
}

export function renderTermsOfServiceHtml(basePath: string): string {
  const bodyHtml = `
      <header class="hero">
        <h1>Terms of Service</h1>
        <p class="tagline">TellyMCP project — gateway, web app, and browser attach extensions</p>
      </header>
      <p class="meta">Last updated: 2026-10-18</p>

      <h2>Open-source, self-hosted software</h2>
      <p>
        TellyMCP is open-source software distributed under the
        <a href="${GITHUB_URL}/blob/main/LICENSE">MIT License</a>. You download,
        install, configure, and operate your own gateway instance, your own
        Telegram bot, and your own browser attach extensions against that
        instance. The TellyMCP maintainer does not operate a public multi-tenant
        service on your behalf, and this site does not grant access to any
        specific hosted instance.
      </p>

      <h2>Your responsibility</h2>
      <ul>
        <li>You are responsible for the Telegram bot token, credentials, and any agent processes you connect to your own TellyMCP gateway.</li>
        <li>You are responsible for complying with Telegram's own Terms of Service, and with the terms of any coding-agent or MCP tooling you connect, when operating your instance.</li>
        <li>You are responsible for how you use the browser attach extensions — only attach tabs you are authorized to inspect and automate, and only inject scripts you trust.</li>
      </ul>

      <h2>No warranty</h2>
      <p>
        As stated in the MIT License, TellyMCP is provided "as is", without
        warranty of any kind, express or implied. The maintainer is not liable
        for any damages arising from use of this software, to the extent
        permitted by law.
      </p>

      <h2>Browser extensions</h2>
      <p>
        The TellyMCP browser attach extensions act only on tabs the user
        explicitly attaches, and only relay data to the gateway the user
        themselves configured and operates — see the
        <a href="${basePath}/policy">Privacy Policy</a> for details. Installing
        an extension does not create any account or relationship with the
        maintainer beyond the software license.
      </p>

      <h2>Changes</h2>
      <p>
        These terms may be updated from time to time as the project evolves. The
        current version always lives at this URL and in the project's
        <a href="${GITHUB_URL}">GitHub repository</a>.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about these terms can be raised via the project's repository:
        <a href="${GITHUB_URL}">${GITHUB_URL}</a>.
      </p>
  `;

  return renderPage({
    title: "TellyMCP — Terms of Service",
    description: "Terms of Service for the TellyMCP gateway and browser attach extensions.",
    bodyHtml,
    basePath,
  });
}
