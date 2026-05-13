import fs from "node:fs";
import path from "node:path";

const workbenchIndexPath = path.resolve(__dirname, "../../../public/workbench/index.html");

const renderMissingWorkbench = () => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Workbench Unavailable</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      html, body {
        margin: 0;
        min-height: 100%;
        background: #0f172a;
        color: #e2e8f0;
      }
      body {
        display: grid;
        place-items: center;
        padding: 2rem;
      }
      .card {
        width: min(42rem, 100%);
        padding: 1.25rem 1.5rem;
        border: 1px solid #334155;
        border-radius: 1rem;
        background: #111827;
      }
      code {
        display: inline-block;
        padding: 0.1rem 0.35rem;
        border-radius: 0.35rem;
        background: #1e293b;
      }
    </style>
  </head>
  <body>
    <section class="card">
      <h1>Workbench bundle was not built</h1>
      <p>Run <code>yarn --cwd front build</code> so the standalone app is copied into <code>back/public/workbench</code>.</p>
    </section>
  </body>
</html>`;

const renderWorkbench = () => {
	if (!fs.existsSync(workbenchIndexPath)) {
		return renderMissingWorkbench();
	}

	return fs.readFileSync(workbenchIndexPath, "utf8");
};

export { renderWorkbench };
