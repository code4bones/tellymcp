import fs from "node:fs";
import path from "node:path";

const graphqlIndexPath = path.resolve(__dirname, "../../../public/graphql/index.html");

const escapeInlineScriptJson = (value: string) =>
	value.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");

const renderMissingSandbox = () => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>GraphQL Sandbox Unavailable</title>
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
      <h1>Local GraphQL sandbox bundle was not built</h1>
      <p>Run <code>yarn --cwd back build:graphql</code> so the standalone app from <code>./package-dev/graphiql</code> is copied into <code>back/public/graphql</code>.</p>
    </section>
  </body>
</html>`;

const renderGraphiQL = ({ endpoint, subscriptionEndpoint, settings }: any) => {
	if (!fs.existsSync(graphqlIndexPath)) {
		return renderMissingSandbox();
	}

	const assetBase = endpoint.replace(/\/graphql\/?$/, "/graphql-assets/");
	const configJson = escapeInlineScriptJson(
		JSON.stringify({
			endpoint,
			subscriptionEndpoint,
			theme: settings?.["editor.theme"] === "light" ? "light" : "dark",
		}),
	);
	const template = fs.readFileSync(graphqlIndexPath, "utf8");
	const configScript = `<script>window.__GRAPHQL_SANDBOX_CONFIG__=${configJson};</script>`;
	const rewrittenTemplate = template
		.replaceAll('src="./assets/', `src="${assetBase}assets/`)
		.replaceAll('href="./assets/', `href="${assetBase}assets/`)
		.replaceAll("src=\"assets/", `src="${assetBase}assets/`)
		.replaceAll("href=\"assets/", `href="${assetBase}assets/`);

	return rewrittenTemplate.includes("</head>")
		? rewrittenTemplate.replace("</head>", `${configScript}</head>`)
		: `${configScript}${rewrittenTemplate}`;
};

export { renderGraphiQL };
