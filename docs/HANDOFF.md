# HANDOFF

## Gateway0.0.52 deployed (2026-11-09)

User explicitly authorized production deployment after the debt-closing step.
Release commit13a6e3a, annotated tag v0.0.52 pushed to GitLab and GitHub.
Pipeline7564 passed build13603 and deploy13604:
https://gitlab.undoo.ru/c4b/mcp/telegram_mcp/-/pipelines/7564
CI:517 passed/15 skipped, including all7 real PostgreSQL tests. Skips are13 browser
checks (Chromium absent in build image) and2 opt-in Codex smoke tests; browser
coverage had passed in the earlier local full run.

Production on savant now runs tellymcp-gateway:0.0.52-13a6e3a88970. Actual installed
package version inside the running container is0.0.52. All5 services are healthy;
PostgreSQL, Redis, RabbitMQ and Nginx retained their container IDs. Gateway was
recreated; prior image/config remains available. Config snapshot:
/opt/tellymcp/releases/20261108T210935Z-13604

Post-deploy verification:
- External /api/healthz is OK. Authorized MCP initialize/listTools succeeds;
  send_partner_note/send_partner_file expose request_id, browser_dom batch/pinned
  target fields and all5 inspector tools with Marks are present.
- PostgreSQL16 has mcp.gateway_messages.request_key and the source/request unique
  index. Queue/messages were empty before deployment and remain empty.
- User env fingerprint is unchanged after excluding TELLYMCP_IMAGE. Database/cache
  services and volumes were not recreated. No credentials or admin grants changed.
- Telegram read-only API succeeds; getWebhookInfo confirms no webhook and0 pending
  updates; /menu,/auth,/admin commands are registered. Deployment remains polling.
  INFO startup/polling logs are unavailable at existing LOG_LEVEL=warn; no polling
  crash or queue retry/dispatch errors were logged. No synthetic human update,
  Telegram message or browser action was sent during verification.
- A console reconnected after gateway restart (live registry connected_at). No
  local or remote owner process was restarted by this deployment.
- Copyable Live menu/link behavior, token-link HTML, locally hosted Telegram SDK
  digest/cache headers, three-layer public root and browser toolbar scope passed
  the deployed-package probe. Probe uses fixtures for Telegram menu rendering.

Ignored evidence: artifacts/release052/deploy-preflight.json, deploy-state.json,
deploy-mcp-verification.jsonl, deploy-telegram-verification.json, deploy-presence.json.
The local CLI0.0.52, signed Firefox0.0.15 and Chrome0.0.15 from the previous step
remain valid; release-only changes were CHANGELOG/VERSION metadata. Existing
recipient owners must be restarted separately to load their0.0.52 materializer
fixes. The active conversation owner was intentionally kept alive. No npm registry
publication or extension-store publication was performed.

## Technical debt fixes:0.0.52 candidate (2026-11-08)

User authorized finishing confirmed debts T001–004 and repeated Firefox Inject
(T058), milestone "Закрыть технический долг TellyMCP". Region remains screenshot-only.
No running owner, production gateway or credentials were changed.

Implemented:
- SQLite connections reused per canonical workspace path, WAL/busy timeout,
  one schema setup per cached handle; existing runtime shutdown closes the cache.
- Xchange root must remain within the workspace. Writes/deletes reject symlink
  roots/parents/leaves, including dangling links. Writers verify the open regular
  file before truncating; unique allocation uses exclusive creation. These are
  application-level checks, not a native OS sandbox for concurrent directory swaps.
- Project enqueue is one transaction for message/artifacts/delivery. Optional
  source-scoped request_id uses an advisory lock, fingerprint and unique index;
  repeated keys replay the original receipt, changed payloads fail, calls without
  a key remain independent. The key is supported only on queued project routes;
  direct/local routes reject it. Additive schema migration handles existing tables.
- Queue polling uses FOR UPDATE OF d/SKIP LOCKED and a60s lease in available_at.
  Push and periodic5s retry drain use the same claim path, scoped to advertised
  owner sessions. Local and remote owners sharing a client UUID are merged.
  Missing targets fail retryably without ACK; late errors cannot overwrite an ACK.
- Recipient coalesces concurrent delivery RPCs, persists notifying/complete tags,
  preserves already-read records and never blindly repeats an uncertain terminal
  notification after a crash. Such an outcome is reported as failed for inspection;
  this is not a transactionally exactly-once PTY-input guarantee. Completion updates
  only tags so an agent reading during notification stays read.
- Firefox Inject helpers are block-scoped, repeated exports refresh and a custom
  namespace no longer overwrites the default namespace. Firefox0.0.15; Chrome
  remains0.0.15. No Picker behavior changes.

Validation: build + lint passed. Full suite529 passed/2 skipped, including7 real
PostgreSQL tests; subsequent queue/socket regressions38 passed after guarding late
failure and merging owner routes. Integration tests use a random isolated schema,
real ensuredb migration and a temporary PostgreSQL17 container, never production.
Package-build CI now creates its own isolated PostgreSQL/network and cleans both
by container/network ID. docs/tellymcp.gw.conf is a generic HTTP/TLS-termination
example with the same limiter policy as nginx/tellymcp.gw.conf; nginx -t passed.
CLI/Russian MCP routing docs and D-029 write/delete guarantees updated.

Implementation commit b86419f is pushed to GitLab and GitHub main. Pipeline7561
(build:gateway/job13602) passed the complete Docker package/image-build flow:
517 tests passed/15 skipped (13 browser tests: Chromium absent in build image;
2 opt-in Codex smoke tests). All7 real PostgreSQL tests and all11 detached CLI
scenarios passed. Local full run included the browser tests,529 passed/2 skipped;
the subsequent38 queue/socket checks cover the last added owner-route regression.
Pipeline: https://gitlab.undoo.ru/c4b/mcp/telegram_mcp/-/pipelines/7561
No deploy job runs for main.

Prepared and installed local CLI0.0.52. All271 installed runtime/extension files
match the npm archive. Firefox0.0.15 was signed by Mozilla in channel unlisted;
code/assets match dist/npm and the ZIP, parsed manifest objects match, embedded
CMS signature verifies (no independent certificate-chain validation). Chrome15
ZIP/CRX were retained unchanged and their payloads checked against dist/npm.

Artifacts (ignored, checksums and sizes in artifacts/release052/artifacts.json):
- artifacts/release052/deadragdoll-tellymcp-0.0.52.tgz
  SHA2562f138eee0e86514d1dd12e0b60fc62287737a2b05f3a6e3dc8b07b5cea57fefb
- packages/firefox-attach-extension/web-ext-artifacts/6e2c53eb034d4975995e-0.0.15.xpi
  SHA2569d03aeb6c33f623046d33801fee06b60fb28cdd632128e5fead21a821f4813d6
- packages/firefox-attach-extension/web-ext-artifacts/tellymcp-firefox-attach-0.0.15.zip
  SHA256aee1db6e0892d6dde680688aca0af52c242674957567336245fe4134a3b8bdfd
Chrome15 hashes/identity remain as recorded in the previous signed-artifact section.
Session marker, user .env and Chrome key hashes match local-preflight.json.
Temporary PostgreSQL container tellymcp-debt-postgres-test was stopped/removed.
No running owner was restarted; production gateway remains0.0.48. Both gateway
and recipient owners need0.0.52 to activate the queue fixes. No release tag/deploy
or npm publication was performed.

Marrow reconciliation: T037 /admin is done (existing implementation and user
confirmation); T030 is done and project.lastVersion=0.0.52, verified by project.get.
T006 PTY and T036 Nginx moved from stale todo to review with precise remaining
acceptance notes. T001–004 and T058 are done, with implementation/test notes and
CI evidence. Other open roadmap/review tasks were not declared done.

## Public README refreshed for Git (2026-11-08)

README.md now presents current0.0.51 features, gateway/client quick start, Live
Link/Attach menu, local terminal sessions, Picker mode/Send/Snapshot tables, MCP
routing and extension export/pack/unlisted-sign commands. Region is explicitly
screenshot-only, with Snapshot off by default. Source versions are distinguished
from the npm registry badge; no unpublished package/download links are promised.

Fixed wizard env filenames in run examples, optional scope-token wording and the
normal gateway MCP route. Interactive run does not open a local MCP HTTP listener
(foregroundRuntime standaloneHttp=false and ENVIRONMENT.md); old CLI MCP help
still contains legacy local-endpoint wording and was not changed in this docs task.
Removed the link to untracked/missing screenshots/README.md and condensed internal
operational history into public setup/usage guidance. README-ru.md was not rewritten.

Validation: Prettier and git diff checks pass; all tracked relative links/heading
fragments and18 shell blocks checked. Source versions and referenced build scripts
match the checkout. Actual compiled CLI help/config helper ran successfully for
the example gateway MCP URL. Runtime source, package versions, built/signed
artifacts and owners unchanged; no new package, test-suite run or deploy needed.

## Old local build artifacts cleaned (2026-11-08)

At the user's request, removed25 ignored files (~4.99MiB): client0.0.41–43,
Picker candidate builds, releases0.0.46/47/49/50 and Chrome CRX0.0.8. Historical
artifact paths below may no longer exist. Retained current runtime0.0.51 and
Chrome0.0.15/Firefox0.0.14 packages, plus deployed gateway0.0.48 for recovery.
Current artifacts and Chrome signing key hashes unchanged. Session artifacts in
.mcp-xchange were not touched. Cleanup inventory: artifacts/release051/cleanup.json.

## Extension packages signed and checked (2026-11-08)

User requested current package builds, including Firefox's existing sign flow.
Versions preserved: Chrome0.0.15 / Firefox0.0.14 / runtime0.0.51. Run scripts
separately: aggregate release:extensions synchronizes versions and was not used.
Chrome pack reused packages/chrome-attach-extension/key.pem (existing CRX identity
`oihpjdgijjpgnckbjpcabcgomceanokm`); ZIP/CRX3 payloads match dist and runtime tgz.

Firefox sign used existing AMO environment with no credential output and channel
unlisted. Upload passed validation (0 errors,1 warning). Mozilla approved version
6681638 at2026-11-08T19:31:09Z, file.status=public, channel=unlisted (not a public
listing). Signed XPI downloaded successfully; all code/assets match dist/tgz.
Mozilla reformatted manifest.json, but parsed manifest objects are identical.
META-INF signature files present; detached CMS signature verifies with the
embedded certificate (this local check does not independently validate its chain).
Firefox add-on GUID matches the previous signed0.0.8 package.

Ready artifacts:
- packages/chrome-attach-extension/webstore-artifacts/tellymcp-chrome-attach-0.0.15.zip
  SHA2562af7b14b1d10017c1bea838f17be540679b8105f43481311f5ba8202b7419ea0
- packages/chrome-attach-extension/crx-artifacts/tellymcp-chrome-attach-0.0.15.crx
  SHA25630792d7827e06a68d9c6b778a63c0e34218edb358ba245b7d94ccb6c13c4c4c4
- packages/firefox-attach-extension/web-ext-artifacts/6e2c53eb034d4975995e-0.0.14.xpi
  SHA256da5d34c83a8232ed3fe39061c06294997b1ec465733ca198f2f4f7386f315c7b
- artifacts/release051/deadragdoll-tellymcp-0.0.51.tgz unchanged; SHA below.

Checksums/sizes saved in ignored artifacts/release051/extensions.json and
SHA256SUMS. No source behavior changes; no broad test rerun needed after the
previous503-pass suite. No deploy, owner restart, update-server/store publish.

User explicitly clarified **Region is screenshot-only; do not add DOM collection**.
The briefly proposed Region DOM change was cancelled before any code edit.
User accepted current Picker behavior; actual signed Firefox installation remains
for the user to perform. Keep T056 review until installed acceptance is clear.

## Local0.0.51: Ctrl selection, optional reply, frozen Snapshot toggle (2026-11-08)

User changes bundled into this local update:
- Element/Marks use Ctrl+click; normal clicks/typing reach the page so users can
  open a popup before selecting it. Ctrl is latched for the complete gesture,
  including compatibility mouse events/release-before-click. Region keeps normal
  dragging. Ctrl+click inside a mark removes its entire marked container.
- Send requests an answer only in the agent console. Ctrl+Send additionally asks
  for a browser reply, with green hover while Ctrl is held. The flag is
  `context.replyInBrowser`; new artifacts include `replyRequired`, and only
  requested browser replies include `response.arguments`. Terminal prompt,
  xchange tools/requires_reply/expected_reply and read-after-answer instructions
  follow the flag. Console-only: answer in conversation, then mark read; browser
  reply: answer here, respond successfully, then mark read. Old contexts without
  a flag keep their old artifact shape/reply workflow to preserve retry identity.
- Element/Region start a local cropped screenshot at selection time; one frame
  hides the overlay before capture. Snapshot is an initially-off inclusion toggle:
  preview/attach or remove the cached image without recapture. A removed original
  node does not invalidate a completed cached image. Busy/failed capture does not
  discard the saved DOM. Image data stays local unless Snapshot is enabled.
- User explicitly requested speed over image masking: the new screenshot path
  does not scan DOM or generate masks. DOM/question sanitization remains.
  Legacy background callers can still supply their old masks; the new controller
  sends none. Existing source-tab/URL/image-size/expiry guards remain.

Final validation: full suite **503 passed,2 skipped** (78 passed files,1 skipped);
28 focused tests passed before the final full run. Build/typechecked extension
builds/lint pass. Browser regressions cover popup opening/page typing, modifier
release, Ctrl hover/Send flags, Marks review, modal focus, image toggle after node
replacement, zero recapture, no mask payload and original red canvas image despite
later blue pixels. Chrome/Firefox API semantics are exercised in Chromium fixtures;
actual installed Chrome/Firefox user acceptance is still pending (T056 review).

Local0.0.51 installed globally; Chrome0.0.15 / Firefox0.0.14 ZIPs match final dist
and bundled package bytes. Artifact:
`artifacts/release051/deadragdoll-tellymcp-0.0.51.tgz`, SHA256
`83b2667a84435cbfa03a9f5d7b398185884e231c22acffcc843db5acebe5b4ca`.
An early Ctrl-only0.0.51 draft was installed during this turn before the user
expanded scope; it was superseded by the final package and reinstalled. Draft
archives were moved outside the repository; do not use those /tmp artifacts.
Local profile/workspace marker fingerprints are preserved. No running owner was
stopped or restarted. **Optional replies require restarting the source owner on
0.0.51**, then reloading extensions and target pages when the current selection
is finished. Capability `picker_optional_reply` prevents an older owner from
misinterpreting the new explicit flag. Installing alone does not update running
owners. Gateway stays deployed0.0.48; no gateway deploy/tag/registry/store publish.
Artifact delivery and browser responses do not need a gateway deployment for this
change. Direct get_selection against an old remote catalog may still reject the
new optional context field; use the artifact instructions for the agent workflow.

## Local0.0.50 built: frozen Element snapshot and single Send (2026-11-08)

User explicitly requested that ordinary Element selection not fail with
"Selection is stale. Select again." when its content updates but its role stays
the same. User clarified the snapshot must be captured immediately on selection.
Final behavior: choose captures sanitized DOM once; Send uses that saved snapshot
without rereading/ comparing live contents. Content updates or original-node
removal do not block sending or replies. Highlight/new image capture require the
original connected node; navigation/page geometry, expiry and correlated IDs
retain their guards. Marks stays separate and reads live DOM by selector.
Explain/Ask buttons are replaced by one Ant Design Send icon that sends the text
field's question; no default Explain action remains.

Chrome/Firefox API regression failed before fix (selection stayed pending after
text update), passes after fix, verifies original text delivered despite updates
before Send, and responses accepted after further updates or node replacement.
Highlight rejects a removed node while saved-text response still succeeds.21 focused
browser/inspector/delivery tests passed on final source, build/typechecked extension
builds/lint pass. Local package0.0.50 built and installed globally; Chrome0.0.14 /
Firefox0.0.13 ZIPs match dist and tgz byte-for-byte. Package:
`artifacts/release050/deadragdoll-tellymcp-0.0.50.tgz`, SHA256
`93918320d4fcd76829d498e8c15750744271ffe2d9b29de69e9f718af9d4af56`.
Shared local profile and workspace marker unchanged; owners were not stopped.
Gateway remains0.0.48; no gateway deployment, release tag or registry/store
publication. Load the new extension and reload the target page after finishing
current work; T055 is in review for installed acceptance. Earlier uninstalled
draft package was moved outside the repo and replaced with the final frozen-snapshot
build; do not ship a reread-on-Send variant.

## Local0.0.49 extension fix: Picker question vs Drawer focus trap (2026-11-08)

**T-TELLYMCP-054:** user could hover/click Picker buttons but could not focus/type
the question when Marrow's Ant Design Drawer was open. Inspection of the attached
Chrome tab1974259195 showed the Picker above the drawer; local installed
@rc-component/util/Dom/focus uses a window-bubble focusin listener to force focus
back into the Drawer. This was focus capture, not a stacking-order problem.

Permanent shared-controller fix stops focusin/focusout propagation inside the
closed Shadow Root without preventDefault; listener cleanup uses Picker's existing
AbortController. Real click/typing/Ask browser regression fails before fix (empty
question) and passes after for Chrome/Firefox API fixtures; after Picker closes,
the page focus trap still works. Existing browser regression4/4 passed.

A temporary host-scoped window-capture guard was injected through Telly into the
already open Marrow Picker (no reload or content reset). User confirmed typing
now works. Guard removes itself when that host disappears or after five minutes.
Persistent source must still be loaded by updating extensions/reloading target
page once the user finishes this live selection.

Local package0.0.49 built and global CLI installed; Chrome0.0.13 / Firefox0.0.12
ZIPs match dist and bundled package byte-for-byte. Artifact:
`artifacts/release049/deadragdoll-tellymcp-0.0.49.tgz`, SHA256
`597dd599f5ed36038d37e692dececb4ac4eeb9909f25139965bbbaf1fa94dd36`.
Full suite496 passed,2 skipped; after final JSON removal, browser regression4/4,
build/typechecked extension builds/lint passed again. Local profile/marker hashes
unchanged. Gateway remains production0.0.48; no gateway/owner restart or new release
tag was created for this extension-only change. No npm/store publication. T054
is in review for loading the permanent extension builds; temporary live fix was
user-accepted. Preserve current selection, then reload extension and target page.
User also requested removing the raw JSON block from every Picker preview;
renderPreview no longer creates it. Keep question, status/actions, optional image,
Copy context and later agent response blocks. Artifact/protocol contents unchanged.

## Production0.0.48 deployed: local Telegram SDK and starfield (2026-11-08)

Current release commit **`eee972a07b4492804644ea4d158b934713bb4838`**, tag
**`v0.0.48`**, image **`tellymcp-gateway:0.0.48-eee972a07b44`** on savant.
Pipeline **[7552](https://gitlab.undoo.ru/c4b/mcp/telegram_mcp/-/pipelines/7552)**
succeeded: build13600, deploy13601. CI487 passed,9 skipped; local494 passed,2
skipped; build/lint/package/native PTY pass. All five services healthy. Actual
HTTP MCP/menu schema probes pass. Both internal and direct public HTTPS checks
confirm root HTML with three canvases and SDK JavaScript MIME/cache/exact SHA.
Served Live HTML uses the local SDK URL and includes browser-only toolbar hiding.
Telegram API is reachable, webhook remains disabled and pending updates0 after
deploy. This does not establish the cause/fix of the earlier bot-menu stall.

Config except image, env0600, Redis admin principal, data container IDs/volumes
and local shared profile are preserved. Workspace marker matched immediately
after installation; a concurrent update was observed at14:42:42 UTC and retained,
without overwriting it with preflight data. No owner was stopped by this agent.
Local global CLI0.0.48 installed; artifact
`artifacts/release048/deadragdoll-tellymcp-0.0.48.tgz`, SHA256
`71f2b8bdb4a6621e6f7d319dfeded8297f03cecf8727514c4619684da75856c6`.
Extensions unchanged Chrome0.0.12/Firefox0.0.11; these presentation changes need
only a gateway update/page reload. Previous app/config:
`/opt/tellymcp/releases/20261108T144054Z-13601` (not a DB rollback).
No npm/store publication or real Telegram messages generated by verification.
User confirmed Mini App now works inside Telegram, the starfield works, and the
browser Live toolbar is hidden as requested;
**T053 is done**. This supersedes the pending acceptance note below.
Open Live anew from the bot after restart to refresh in-memory launch grants/tokens.

**T-TELLYMCP-053** bundles the official unchanged SDK from
`https://telegram.org/js/telegram-web-app.js?64` under vendor/telegram-web-app,
including source/date/SHA metadata. Snapshot119731 bytes, SHA256
`124bdff7ba3fe86c8ba5143467afec21e020405e74abdb92cfdda6c0ee3b5908`.
The gateway serves `/api/webapp/vendor/telegram-web-app.124bdff7ba3fe86c.js`
(configured WebApp base path respected), GET only, JavaScript MIME and immutable
one-year cache. Filename derives from bytes; no build/startup download. npm files
includes the vendor directory; ESLint excludes upstream source. Mini App loader
uses this same-origin URL; browser direct token path still skips SDK entirely.

User added a predeploy request for the public domain root: black, three dark star
layers drifting slowly, cursor motion adds acceleration and depth parallax.
Root GET/HEAD now serves a self-contained canvas page with no network dependencies;
other paths retain their handlers. It respects reduced motion and pauses when
hidden. Real Chromium checks: all3 layers move at idle and react to pointer,
no page errors/external requests, desktop/mobile preview reviewed. SDK browser
fixtures now use the actual vendored SDK with a simulated native bridge and
telegram.org blocked; all Mini App modes/bootstrap and SDK-free browser paths pass.

Runtime0.0.48 is packaged, installed and deployed as recorded above. Build,
lint,23 focused checks and full suite494 passed,2 skipped (79 files) pass.

## Local follow-up: browser Live toolbar hidden (2026-11-08)

User requested `div.toolbar { display:none }` only for browser Live. Current
source adds body.browser-live before startup when a direct token exists in query
or hash, and scopes the hiding rule to that class. Telegram retains its toolbar;
both keep the statusbar. Build and21 focused WebApp checks pass; a real Chromium
layout probe confirms zero toolbar height and terminal/statusbar adjacency for
both token forms, and visible toolbar for Mini App mode. Focused lint passes.
This is included in the0.0.48 preparation above. At initial implementation no
deployment/owner restart occurred; production/global CLI was0.0.47.

## Historical production0.0.47: browser Live and Picker auto-attachment (2026-11-08)

**Installed acceptance update:** user confirmed Live ultimately opened in both
Chrome and Firefox and Attach worked. Browser Live acceptance is now confirmed;
do not repeat the earlier blocked-on-SDK diagnosis as a current failure. The
report does not distinguish Live terminal Attach from Picker auto-attachment,
and does not establish the complete Picker artifact → agent → overlay response
roundtrip. Keep T052 in review for the remaining Picker acceptance; do not close
T049/T050 based solely on this report. The Telegram menu stall below remains a
separate recovered incident with unconfirmed root cause.

**Postdeploy Telegram incident (14:04 UTC):** user reported startup/client-online
notifications arriving but both /menu and callbacks unresponsive. Gateway HTTP,
all services and proxied Bot API getMe were healthy; webhook disabled and
getWebhookInfo showed3 pending updates. Restarted only the gateway container,
without dropping updates or stopping owners/data services. User confirmed menus
recovered; pending updates now0, health OK, all production fingerprints and service
IDs unchanged. Original env restored byte-for-byte (private backup in
`/opt/tellymcp/backups/env-before-menu-diagnostic-20261108T140408Z`). Three polling
middleware `fetch failed` errors appeared during restart warm-up. Original hang's
root cause is **unconfirmed**; do not claim an application fix. Transport starts
before gateway HTTP setup in bootstrap, so warm-up errors merit separate review
if repeated. Standard HTTP health does not prove bot update handling is healthy.
Get a fresh Live→Link after this additional restart.

Release commit at that rollout **`124c7a591520314fc48b95747300599e9263c43b`**, tag
**`v0.0.47`**, image **`tellymcp-gateway:0.0.47-124c7a591520`** on savant.
Pipeline **[7546](https://gitlab.undoo.ru/c4b/mcp/telegram_mcp/-/pipelines/7546)**
succeeded: build13598, deploy13599. CI485 passed,9 skipped (browser fixtures are
unavailable in CI); local492 passed,2 skipped. User confirmed the gateway is up.
All five services healthy; public health OK; actual HTTP MCP schemas/menu checks
pass. Public Live HTML has no blocking Telegram script; compiled owner includes
the acknowledged auto-attach protocol. No real Telegram/browser actions were
generated by postdeploy probes. Environment except image, env0600, polling,
Redis admin principal, data container IDs/volumes and local profile/marker hashes
are preserved. Previous app/config:
`/opt/tellymcp/releases/20261108T135759Z-13599` (not a DB rollback).

Global local CLI0.0.47 is installed; active owner preserved and **not restarted**.
Package: `artifacts/release047/deadragdoll-tellymcp-0.0.47.tgz`, SHA256
`626b81f6c5c80132aec5667a08b9965062aabc1f08bc33087ec8d709048727ba`.
Chrome0.0.12/Firefox0.0.11 ZIPs match rebuilt dist and packed extension contents.
No npm/store publication. T052 is in review for remaining installed Picker
acceptance; Live in Chrome/Firefox and Attach were confirmed above. Reload
extensions, restart the owner when ready, get a fresh Live→Link
(gateway tokens/launch grants are in memory and old links expire across restart).

**T-TELLYMCP-052** follows the user's Chrome/Firefox diagnosis and request to
remove manual tab attachment. Source/runtime0.0.47, Chrome0.0.12, Firefox0.0.11.
Direct Live tokens in query or hash skip Telegram SDK initialization entirely;
Mini App startup loads the SDK asynchronously before authorization/launch mode,
with an explicit ten-second failure instead of an indefinite parser stall.
The old page had a synchronous head script on telegram.org: public gateway health
was200 directly, Telegram SDK timed out directly and returned200 via the configured
proxy. This explains Firefox-with-proxy vs Chrome-without-proxy behavior.

Picker Ask/Explain in all three modes validates sender/context, requests automatic
attachment using the existing attach_tab_selected event with a unique request ID,
and waits for attach_tab_selected_result after owner persistence. Only then does
it set local attachment, cache context and submit for artifact delivery. New
picker_auto_attach capability prevents optimistic use against old owners. Failed
attachment, changed source or disconnect cannot continue delivery. Agent artifacts
retain exact browser instance/tab IDs. Auto-attachment selects that browser target
for the console and may invalidate another tab's previous live Picker.

Validation: local full suite492 passed,2 skipped (78 files); build/typecheck/lint
pass. Real Chromium fixtures prove browser bootstrap/WS without telegram.org and
all three Mini App launch modes. Real owner socket checks ACK-after-persistence;
tests cover all Picker modes, attachment failure/disconnect and old-owner gating.
Packaging/rollout and postchecks completed as recorded above. Preserve the active
Test Attach owner; installing the package does not reload it.

## Historical production0.0.46 deployment (2026-11-08)

State at that rollout; superseded by0.0.47 above. Release commit
**`fba3fe2c92682c41a303762f6022bb4307d0bc36`**, tag **`v0.0.46`**, image
**`tellymcp-gateway:0.0.46-fba3fe2c9268`** is running on savant.
GitLab pipeline **[7543](https://gitlab.undoo.ru/c4b/mcp/telegram_mcp/-/pipelines/7543)**
succeeded: build13596, deploy13597. CI475 passed,4 skipped; local477 passed,2
skipped. Build/lint/package/native PTY passed. Initial pipeline7542 stopped before
deploy on the unchanged remote resize test's timeout; focused10/10 and the full
same-tag rerun passed without source changes or skipped checks.

Postdeploy: all five services healthy, public health endpoint OK. Actual HTTP MCP
initialize/list/close confirms all five inspector tools, marks mode and DOM batch/
pinned-target fields. Deployed compiled Live handlers pass the RU3/2/1 layout and
private copyable Link checks using local fakes; no real Telegram message/browser
action was generated. Environment settings except image, env0600, Redis admin
principal, all data container IDs and named volumes are preserved. Polling stays
enabled. Previous app/config: `/opt/tellymcp/releases/20261108T133329Z-13597`;
rollback restores app/config, not DB. Local global CLI is0.0.46; shared profile
and session marker hashes match preflight. No user owner sessions were stopped.

Chrome0.0.11 and Firefox0.0.10 ZIPs are rebuilt at their usual package artifact
paths. Reload/update installed extensions and use an owner running0.0.46 before
acceptance. T049 automatic delivery and T050 Marks remain in review pending real
installed-browser acceptance; T048 remaining region/image/privacy/Firefox response
checks are also separate. No npm or browser store publication was performed.

### Authorized menu and release scope

User explicitly authorized the update after requesting the Live menu follow-up.
**T-TELLYMCP-051**: first row Fullscreen | Expand | Default, second Link | Attach,
third Back. Link is a callback, not a URL button: it creates a browser session
token only on demand, sends a private HTML code-block address with previews
disabled, validates original user/button/active launch grant, and never logs the
address. Back routes to the selected console's main menu; approval chooser also
gets Back. Existing owners and profiles must remain intact during installation.

Release versions: runtime **0.0.46**, Chrome **0.0.11**, Firefox **0.0.10**.
Includes T049 artifact/terminal notification and T050 toggle Marks/new MCP DOM
schema, plus this session's accepted icon/compact UI. Local menu regression7
tests pass; gateway0.0.45 baseline is healthy, polling on, env0600/admin principal
and PostgreSQL/Redis/RabbitMQ IDs/volumes recorded in private fingerprint-only
`artifacts/release046/preflight.json`. Local marker/profile fingerprints recorded.
No local or gateway consoles were online during preflight; none were stopped.
Build/lint and full suite477 passed,2 skipped. Local0.0.46 package and private
verification fingerprints/probes are under `artifacts/release046/`. Tagged GitLab
rollout and postdeploy checks completed as recorded above.

## Current continuation: toggle DOM marking groups (2026-11-08)

**T-TELLYMCP-050** adds popup **Mark elements** mode on top of T049 delivery.
User clarified: clicking anywhere inside an already marked container removes the
entire container mark; never select a nested child or activate the site button.
The mode supports up to50 non-nested elements with a shared UUID in
`data-ai-picker` and individual `data-ai-picker-item` IDs. Selecting a parent
coalesces selected descendants. The compact circle shows count; its expanded
list supports removal/clear, Enter/review opens question preview, Select again
edits the group. Marked areas remain protected from site clicks during preview.
Esc/close/TTL/navigation/disconnect remove marks and restore pre-existing values.

Marks requests/artifacts contain only selector/group/item metadata and question,
never selected text/HTML/image. `selection.json.read.arguments` tells the agent to
call `browser_dom(all=true)` with pinned original session/instance/tab; a changed
tab binding is rejected. DOM data is read live at analysis time, bounded by50
matches/shared max_chars budget with total/truncated flags. Agent must check
item IDs and report missing/changed marks. Top-frame light DOM only; no automatic
marker recreation after rerender; Canvas content still requires Region/image.

**Unlike T049 alone, full Marks agent use requires an updated gateway/catalog**:
`browser_dom` schema now includes all/limit/max_chars/instance_id/tab_id and batch
output; `inspector_start.mode` also accepts marks. Old owner consoles without
`picker_marks` capability get an update/restart message on Ask. No gateway rollout
or owner restart has been performed for this source work. Preserve the running
user session. Original production stays tagged0.0.45; current source is local and
uncommitted at the same package/extension version numbers.

Validation: **474 passed,2 skipped**, build/typechecked extension builds/lint pass.
Chromium fixtures exercise both Chrome/Firefox API styles, ancestor/child toggle,
parent coalescing, list removal, metadata-only Ask, live batch read/limits and
answer, restored site clicks, prior attributes, disconnect and five-minute TTL
cleanup. Node tests cover no-DOM artifact/read instructions and pinned MCP reads.
Actual installed Marks acceptance remains pending. Latest candidate package is
under `artifacts/picker-marks-candidate/`; the earlier T049 candidate below and
the original released root tarball remain separate and preserved.
Marks candidate tgz SHA256:
`f0b4e34870b0578ded7ecda025258b00573782348ccf0178c653c2abed69c4e4`.
Both extension ZIPs rebuilt at their usual paths; packed batch helper/schema and
Marks bundles verified. Final focused4 suites15 passed, including a click inside
a marked container during preview; both built popup API styles route all four
icons correctly. No installed owner/client/gateway changes accompanied packaging.

## Current continuation: Picker artifact delivery (2026-11-08)

The user resumed work, accepted installed Chrome and Firefox selection/UI, and
accepted a real Chrome DOM selection -> agent -> plain-text overlay answer.
These supersede the old deferral below. UI follow-ups are in the current working
tree: 44px compact circle during picking, Select again at the same upper-right
position, Ant Design SVG-only controls in preview and popup, removed privacy hint.

**T-TELLYMCP-049** implements the user's next requested behavior: explicit
Ask/Explain -> existing local WS -> owner validates/pulls context -> saves
`.mcp-xchange/{date}/picker/{artifact_id}/selection.json`, optional `selection.png`
and `README.txt` -> structured `local_handoff` / kind `browser_picker` -> existing
`TerminalInputService` sends an ID/path notification to the same agent console.
The agent must answer in its conversation and via `inspector_response`, then mark
the xchange record read. `selection.json.response.arguments` preserves exact
request/selection IDs and the canonical gateway session ID for client consoles.
Artifact IDs deduplicate a session/instance/tab/request tuple; changed content
requires a new request ID. No page/question contents are pasted into the terminal.
ACK distinguishes saved/notified from failed/uncertain delivery. A persisted
unfinished notification is not automatically replayed after an owner crash.

Validation: full suite **472 passed,2 skipped**; build/lint and real WS + real PTY
artifact-before-notification checks pass. Browser fixtures exercise both extension
API styles and acknowledged submission. See `docs/AI_PICKER_EXTENSION.md` and
`docs/AGENTS.md` for delivery and agent instructions. Installed automatic delivery
still needs acceptance after loading this new owner code and extension builds;
T049 remains separate from the earlier manual pull/response acceptance.

This is local unreleased source at package0.0.45 / Chrome0.0.10 / Firefox0.0.9.
Candidate packaging is under `artifacts/picker-candidate/`; preserve the original
released root0.0.45 tarball and its earlier recorded SHA. Gateway remains the
already deployed0.0.45; the new submission protocol is local console/extension
only and does not require a gateway rollout. Old owners lack `picker_delivery`
capability: extensions show an update/restart message for automatic delivery.
Installing a package does not reload live owners. Do not stop the running user's
session to force this update. No registry/store publication or production deploy.
T048 remains review for remaining installed region/image/privacy/Firefox roundtrip
acceptance; T046 real ChatGPT OAuth retry remains separate and unconfirmed.

Candidate tarball SHA256:
`cac5a8c9b76739ee758ca977311c2ef94d0a185e5ef781c6d0b34723ce5f8628`.
It contains the compiled delivery module and both updated extension bridges;
compiled CLI/module load passed using existing workspace dependencies (not a
fresh dependency install). Both extension ZIPs are rebuilt at their usual paths.
Post-final-routing focused tests:4 suites19 passed; lint and diff checks passed.

## Historical deferral: Picker acceptance left for the next session

The user ended today's work and explicitly left Picker testing for tomorrow/the
next session. **Do not continue feature work or create reminders now.** Resume
with **T-TELLYMCP-048** and Marrow handoff **I-TELLYMCP-070**.

- Native local/remote terminals, writable Live and shared dimensions were accepted
  on0.0.45; **T047 is done** (I069). Last attach/resize wins, including Live;
  disconnect never resizes. Keep this policy.
- Gateway0.0.45 is deployed and its five `inspector_*` tools were verified over
  actual HTTP MCP (I068). User installed0.0.45 clients. No additional rollout is
  needed just to resume manual Picker testing.
- Next: load/verify Chrome0.0.10 and Firefox0.0.9, bind the target tab to the
  intended console, test Element/Region → preview/optional crop → Explain/Ask →
  `inspector_get_selection` → `inspector_response`, including Esc/cleanup and
  privacy checks. See implementation map in `docs/AI_PICKER_EXTENSION.md` and I066.
  Restart an old source owner only when the user is ready; preserve live sessions.
- T048 remains in review until real installed-browser acceptance. Site adapters
  and annotations are later phases. T046's real ChatGPT OAuth login retry is also
  still unconfirmed and separate from the completed terminal acceptance.

## Production gateway0.0.45 deployed (2026-11-08)

The user reported0.0.45 installed everywhere and requested the gateway update.
Release commit **`9e9169812cc690674e4e97489f46e2f5ef11eda0`**, tag **`v0.0.45`**,
image **`tellymcp-gateway:0.0.45-9e9169812cc6`** is running on savant.
GitLab pipeline **[7537](https://gitlab.undoo.ru/c4b/mcp/telegram_mcp/-/pipelines/7537)**
succeeded: build13592, deploy13593. CI:466 passed,4 skipped (Chromium fixtures are
unavailable in the build container; local browser-inclusive suite468 passed,2
skipped). Build/lint/package/native PTY checks passed. Previous configuration:
`/opt/tellymcp/releases/20261108T000735Z-13593` (rollback app/config, not DB).

Post-deploy: all five services healthy and public `/api/healthz` OK. Verified
**all five `inspector_*` tools through the running HTTP MCP endpoint**, with the
configured operator bearer kept inside the container. Only initialize/list/close
were used, no tool execution or browser/user actions. The compiled full service
also advertises OAuth security metadata for these tools. Telegram JWKS returns
HTTP200/four keys through the configured proxy. Polling remains enabled; env hash
excluding the intended image change,0600 permissions, Redis admin principal and
PostgreSQL/Redis/RabbitMQ IDs/volumes all match the preflight baseline.

Main/tag were pushed to GitLab and GitHub. User session owners were not stopped.
A gateway restart disconnects remote viewers; reconnect with a fresh code. Load
the new extensions and a0.0.45 source owner for real Picker acceptance. **T047 is
done:** the user accepted all native terminals and Live working simultaneously
with correct shared sizes, recorded in **I-TELLYMCP-069**. All266 compiled files in
the deployed image match the installed candidate, so no package reinstall is needed.
T048 stays in review pending installed-browser Picker acceptance; T046
still needs the user's real ChatGPT OAuth retry. No registry/store publication.

## Implementation and local verification record (2026-11-08)

- User confirmed real remote terminal access from savant: **I-TELLYMCP-064**.
  Missing g++ prevented node-pty installation there; g++ was installed, exact CI
  0.0.44 package installed under NVM Node24.16.0, real PTY smoke passed. Original
  workstation CLI was then updated from0.0.43 to the same0.0.44 artifact under
  NVM Node24.13.0; shared profile and marker hashes were unchanged. User restarted
  the source owner and confirmed the actual Telegram-code/public-WSS attach.
- User subsequently requested **several simultaneous writable native terminals**
  (T047), superseding the old exclusive-native policy and the intermediate idea
  of a busy-confirmation takeover prompt. **Latest attach or resize wins**, also
  from Live; the user explicitly rejected choosing the smallest window. Detach
  never resizes. One shell/PID/agent/runtime remains shared.
- Repository version is now **0.0.45**. T047 source has independent
  snapshot/ACK/UTF8/output queues, per-client expiry/backpressure, ordered
  authoritative viewport resnapshots and a VT projection for differing physical
  sizes (small windows clip). Local protocol2 retains safe protocol1 owner
  discovery/attach/stop compatibility. Restart source owners and update viewers
  for simultaneous attach; installing a package does not reload active owners.
- T048 implements `docs/AI_PICKER_EXTENSION.md` Phase0–2 in shared TypeScript,
  Chrome0.0.10/Firefox0.0.9 and existing tab RPC/MCP route. See the implementation
  map at the end of that spec. Five inspector tools support selection pull,
  highlight, plain-text response and cleanup. Explicit receiver, preview before
  send, optional masked/cropped image, bounded memory queue with five-minute TTL;
  no provider invocation, trade actions or separate backend. Real Firefox/store
  publication acceptance remains separate from Chromium fixture tests.
- Candidate archives are built locally: `deadragdoll-tellymcp-0.0.45.tgz`,
  `packages/chrome-attach-extension/webstore-artifacts/tellymcp-chrome-attach-0.0.10.zip`,
  `packages/firefox-attach-extension/web-ext-artifacts/tellymcp-firefox-attach-0.0.9.zip`.
  The user subsequently installed0.0.45 on both native sides. Production gateway
  was0.0.44 before the release recorded above. Picker's tools require the updated
  gateway/console, while the0.0.44 gateway already relays new native protocol
  bytes. Preserve the current running user sessions during updates.
- Final full suite: **468 passed,2 skipped** (76 files). Build, typechecked
  extension builds and lint passed. After final UTF8 byte-budget/error-message
  refinement, Picker's four focused suites20 passed. Standalone0.0.45 package
  installed with `--omit=dev` under `/tmp/tellymcp-045-candidate.k5lCA8`; three
  compiled CLI scenarios passed: concurrent native PID/I/O/idempotence, shared
  picker, and SIGTERM/SIGKILL/TTY controls. Test harness accepts explicit
  `TELLYMCP_TEST_CLI_ENTRY` and disables source runtime for these installed tests.
  The final pack only additionally includes the linked Picker spec; code files
  are compared to the tested installation. No registry/store publication.
- Next review/test: restart a source owner when the user is ready to load new
  native and Picker code; after gateway release, load the new browser extensions
  and verify the inspector roundtrip. Do not stop user sessions to force
  the new owner code in. Record actual multi-terminal and real Firefox/Chrome
  acceptance before marking T048 done. T047 was accepted by the user after this
  deployment and is done; see I069. T048 remains in review.
  Source test notes: I065/I066; candidate/install smoke: **I067**. Final tgz SHA256:
  `550a3d8d9ebf50c316dde096ff3e79ab24691f4d458fb38770577cbb0383e2eb`.

## Historical0.0.44 gateway update (2026-11-08)

The user authorized the T046 gateway update. **0.0.44** is deployed on savant:
release commit **`2a993c001ad213cd3ceef47693f466b815d477ac`**, tag `v0.0.44`,
image `tellymcp-gateway:0.0.44-2a993c001ad2`. GitLab pipeline
**[7534](https://gitlab.undoo.ru/c4b/mcp/telegram_mcp/-/pipelines/7534)** passed
build/lint/tests/package/image and deploy jobs. Previous configuration is saved at
`/opt/tellymcp/releases/20261107T225336Z-13591`; rollback restores app/config, not DB.

Post-deploy checks: all five services healthy, public `/api/healthz` OK. The exact
deployed OAuth transport fetched Telegram JWKS: HTTP200, four keys, 310ms. Token
exchange with an intentionally invalid probe code reached Telegram in80ms and
received its expected `invalid_grant` JSON (Telegram uses HTTP200 for this error).
Bot `getMe` and `getWebhookInfo` passed; polling remains enabled, webhook URL empty,
pending updates0. No bot message or account authorization was generated by probes.
Before/after hashes match for all env settings except the intended image change;
env stays0600 and the Redis admin principal is unchanged. PostgreSQL/Redis/RabbitMQ
container IDs and named data volumes are unchanged. Browser extension versions
are independent and unchanged.

Real-account ChatGPT -> Telegram -> bot approval -> connector acceptance still
needs the user's retry; T046 stays in review. Remote attach source is now released
on the gateway, but separate-host/real Telegram acceptance remains pending.
Global local client is still the earlier custom 0.0.43 build with local attach/stop
menus; install 0.0.44 and restart an owner to load its remote bridge before testing
the new Attach button. No local client installation accompanied this deployment.
Deployment evidence and remaining acceptance: **I-TELLYMCP-063** in Marrow.

## Current continuation: local detach/attach integration (2026-11-08)

This section supersedes the historical snapshot below. The user selected
detach/attach as the next feature. Single-binary packaging is off the active
plan: `T-TELLYMCP-033` is cancelled and research decision `D-TELLYMCP-038`
is archived in Marrow. Retain the research; resume only on a new request.

### Repository and installed client

- Repository package version is **0.0.45**. The user authorized a local package install
  on 2026-11-08; the global command now includes detach/attach and the stop-menu
  follow-up. Current `main` includes released Linux local detach/attach, merged
  as **`f377ea7`** from `feature/detached-sessions` at **`968698e`**. Source
  integration and the local installation are separate from gateway deployment.
- `feature/detached-sessions` was updated from latest `main` (`13a14e0`) by
  merge **`b34bb74`**, preserving runtime baseline **0.0.43**. Stage-1 prototype
  is committed as **`9e2d636`**, accepted after the user's manual check; T040 is
  done. Stage-2 owner implementation is committed as **`9f67959`**. Stage-3 public
  CLI/frontend commit **`968698e`** includes the session picker, formatted listing and scoped
  SQLite warning suppression. The user accepted local terminal/buffer restoration,
  switching between two sessions and the picker, then requested integration into
  `main` on 2026-11-08; merge **`f377ea7`** completed without conflicts and retains
  the tested feature tree. Continue new development from `main`.
  Post-merge follow-up: stop without a handle now uses a
  repeating picker instead of workspace-marker selection. It is included in the
  local global installation and release commit `2a993c0` on both remotes.
  The earlier design-only commit `5ef06a2` remains on both remotes.
- Read `docs/DETACHED_SESSIONS_DESIGN.md`, especially **Stage 1 prototype** and
  **Stage 2 implementation** and **Stage 3 implementation**,
  for the confirmed restoration/query contract, bounds, evidence and limits.
  The design's original **0.0.38** baseline is historical.
- `autotests`, `gateway`, `onebot` and `ws` are already ancestors of `main`;
  they contain no unmerged commits. Branch audit found no stash or other worktree.
- Canonical shared client profile: `~/.tellymcp/.env`, mode `0600`, directory
  `0700`. `~/.env-client` is a compatibility symlink. All 45 active settings
  were preserved during migration. Never print credentials or replace user edits.
- Config precedence: explicit `--env`, saved `.mcpsession.json` profile,
  workspace `.env`, then the shared home profile. Workspace identity stays local.
  Preserve each workspace's current marker and stable gateway client UUID.
- **0.0.41:** use `TELLYMCP_HTTP_PROXY` / `TELLYMCP_NO_PROXY`; preserve the
  standard proxy environment inherited by the shell and agent.
- **0.0.42:** `run --ws 9999` enables the extension bridge on that port for
  this launch. **Without `--ws`, use env settings**, including enabled/port.
  `init client` without a directory creates the shared home profile.
- **0.0.43:** normal Unix PTY `read EIO` is quiet, including before `onExit`;
  other fd errors and the actual shell exit status are preserved.
- Local updates use `npm pack` (builds runtime and extensions), then
  `npm install -g ./deadragdoll-tellymcp-<version>.tgz`, then a client restart.
  Current install belongs to NVM Node **24.13.0**. No npm registry publication
  or automatic local updater was added. Codex plugin and Playwright browsers
  have separate CLI install commands.

### Current T043/T044 source work (2026-11-08)

- User selected Telegram authorization: **Attach** beside **Open in browser** in
  the same Live keyboard row, eight-digit one-use code valid for five minutes,
  then `tellymcp attach --code <code> [--gateway <url>] [--env <file>]`.
- **Policy correction:** Live View remains mirrored and writable alongside native
  attach. Only native local/remote attachments share exclusive control. Do not
  implement the old proposed read-only-Live restriction. Marrow T043/T044 scope
  and acceptance were updated to the user's selected contract.
- Source implements private in-process Telegram issuance, original-user button
  binding, gateway DB ownership checks at issuance/redemption, hash-only Redis
  grants with 300s TTL and atomic GETDEL, bounded issuance/attempt limits, exact
  owner-instance binding and denial of stop/admin protocol operations. The code
  travels in the initial websocket message, never a URL; WSS is required outside
  loopback. A code permits one redemption, not repeated reconnects.
- Gateway viewer endpoint is `<GATEWAY_WS_PATH>/attach`. The existing owner WSS
  connection carries scoped terminal envelopes into the same private owner socket;
  no new console/services/marker on the viewing machine. Local and remote reuse
  one raw renderer and snapshot/sequence protocol. Viewer ping/pong and owner-side
  keepalive expiry release native control without killing the shell. Reconnect
  needs a fresh Telegram code; uncertain input is never replayed automatically.
- Latest build/lint/full suite: **449 passed, 2 skipped**. Four Telegram tests
  verify the same keyboard row, identity binding/private delivery, callback expiry
  and omission of URL credentials. Ten real-WS/PTY cases verify one-use/expiry,
  ownership/instance changes, limits/scope, raw I/O/resize, same PID/screen across
  detach, native busy, writable mirror input, network loss, lease expiry and exit7.
- A private real Redis probe passed NX allocation, 300s TTL, atomic GETDEL across
  eight concurrent redemptions, expiry and counter windows. A separate compiled
  smoke used real `gateway-socket.service`, embedded owner/client and CLI with
  private Redis and stubbed gateway identity/database methods: one registration,
  same shell PID **1989565**, detach/fresh-code reattach, final output/exit7 and
  no viewer marker/runtime. Temporary owner and Redis were cleaned up.
- Remote-attach source was released in0.0.44 (`2a993c0`); the user accepted actual
  Telegram/account/public-WSS/separate-host access in I064. Installed clients and
  gateway are now0.0.45. Simultaneous native attach and installed-browser Picker
  acceptance are tracked separately in T047/T048 and remain pending.
  Implementation/review records: **I-TELLYMCP-060** (authorization and policy),
  **I-TELLYMCP-061** (remote transport); T043/T044 are in review.

### Current T046: ChatGPT Telegram login diagnosis and fix

- User reported Telegram account confirmation followed by missing bot approval
  and eventual expiration after the domain/polling migration. Diagnosis below was
  performed against gateway0.0.40; the authorized0.0.44 deployment is recorded above.
- Read-only evidence: three `Telegram OIDC login verification failed` warnings
  with `reason: fetch failed` at 2026-11-07 22:04:18, 22:05:49 and 22:09:43 UTC.
  Code fails before sending the separate gateway-admin approval request.
- Inside that exact container, direct Telegram OAuth JWKS GET timed out at
  6003ms; the same GET through the configured HTTP proxy returned200 in307ms.
  The bot's proxy was configured but token exchange used raw global fetch and
  jose's JWKS loader also used its default direct transport.
- Host/container env-file fingerprints match. Public/issuer/audience/callback,
  gateway and WebApp URLs all use `tellymcp.deadragdoll.net`; actual running OAuth
  discovery also reports that issuer. Polling is enabled, and the Redis v3 admin
  principal exists. No credentials or raw OAuth codes were printed or changed.
- Source fix: inject `createTelegramFetch(config, logger)` into both OIDC token
  exchange and jose custom JWKS fetch. Cache keysets per fetch transport; use
  15s token/10s JWKS timeouts. After approval, start the outer authorization-code
  TTL at issuance, and refer missing-admin users to `/admin`, not `/auth`.
- Build/lint and full suite passed: **454 tests passed, 2 skipped**. Four new
  signed-JWT/transport cases cover proxy routing for both backchannel steps,
  cached-key isolation, audience/signature checks and redacted failures; a facade
  regression covers delayed approval and fresh code TTL. T046 is in review;
  production diagnosis and source verification are recorded in I-TELLYMCP-062.
- Production now has the transport/TTL fix; real-account ChatGPT -> Telegram ->
  bot approval -> connector acceptance remains pending. Preserve polling and the
  existing env, admin identity and data volumes.

### Production deployment — keep distinct from the client version

- Gateway is **0.0.48**, image `tellymcp-gateway:0.0.48-eee972a07b44` on
  **savant**, not fr-vpn. All five Compose services are healthy after deployment.
  Previous image0.0.47 remains available for rollback. Local client0.0.41–0.0.43
  updates had no corresponding gateway releases.
- `/opt/tellymcp`: `docker-compose.yml`, secret `.env-gateway` (`0600`),
  `nginx/default.conf`, `state/`, `backups/`, `releases/`. PostgreSQL 16, Redis 7
  and RabbitMQ 3 are dedicated private containers with persistent volumes.
- HTTPS domain `tellymcp.deadragdoll.net` -> existing Nginx Proxy Manager ->
  `192.168.1.68:18088` -> container nginx -> private gateway `8080`.
  HTTP client endpoint: `https://tellymcp.deadragdoll.net/api/gateway`;
  WSS: `wss://tellymcp.deadragdoll.net/api/gateway/ws`.
- GitLab CI uses shell runner tag **`telly_savant`**. Main/MR builds produce
  npm `.tgz` artifacts and gateway images. A matching **`vX.Y.Z` tag** deploys
  production after main-ancestry/version checks. A main push alone does not
  deploy. Latest production release: `v0.0.48`, pipeline **7552**.
- Telegram uses **polling**, `TELEGRAM_WEBHOOK_ENABLED=false`: inbound webhook
  traffic cannot reach this network. User confirmed messages, menu and Live work.
  Keep polling during future deploys and rollbacks; older snapshots have webhook
  enabled. Telegram egress still uses the existing HTTP proxy on fr-vpn:33128.
- Old fr-vpn PM2 gateway, source infrastructure and temporary legacy URL proxy
  are stopped; data/backups remain. The fr-vpn host/HTTP egress proxy still matters.
  Do not use `dev2.sh` or PM2 to deploy the gateway again.
- Manual recovery: `cd /opt/tellymcp`, then
  `docker compose --env-file .env-gateway up -d`. Never print the full env or
  interpolated Compose config. Deployment rollback restores app/config, not DB.
- Detailed recovery paths, volume names and migration incidents:
  Marrow **`I-TELLYMCP-039`**. Client handoffs: **042**, **043**, **044**.

### T-TELLYMCP-040/041/042 implementation and next steps

1. Read this section, T041 implementation note **I-TELLYMCP-048** (review), T040 result **I-TELLYMCP-046**
   and user acceptance **I-TELLYMCP-047**, plus the design's two implementation
   sections and T042 review result **I-TELLYMCP-049**. Refresh Git status and
   preserve the stage-3 work. User acceptance and UI follow-ups are recorded in
   I-TELLYMCP-050 through I-TELLYMCP-054.
2. Stage 1 now has `TerminalRestorationPrototype`, a snapshot adapter and VT
   query framing under `features/detached-terminal/model/`, plus replay and real
   PTY integration tests. `@xterm/addon-serialize` **0.13.0** works with xterm
   **5.5.0**, with tested corrections for omitted state and alternate SGR bleed.
   One headless owner answers supported queries in both attached/detached
   states; the display stream removes queries to avoid duplicate replies.
   Ordered snapshot/live frames, input ACK, resize, Unicode, queue limits,
   stale-controller rejection and draining final output before exit are tested.
   The standalone manual harness is
   `yarn tsx tools/prototype-terminal-restoration.ts`: Ctrl+] detaches, a attaches,
   q while detached stops. It owns one clean Bash and no broker/identity/services.
   That harness is still foreground; it intentionally waits for a/q after detach.
3. Stage 2 adds internal owner/launcher, Unix framing/connection, private registry
   and readiness/discovery. The hidden same-package `__session-owner` entrypoint
   owns the real embedded broker and the existing PTY/screen in `ptyRegistry`.
   The stream now shares that registry screen; no second parser is retained.
   One startup claim covers canonical console identity and real workspace/session;
   a short built-in SQLite transaction serializes claim mutations (mutex only,
   no application data). Recovery checks boot/start identity and socket reachability
   before rechecking under the lock. The child has independent stdio, ignores
   SIGHUP, and bounded private logs/queues. Startup failure/cancellation and shell
   exit/explicit stop clean up only their owner's resources. See design for protocol.
   T041 implementation is ready for review, but actual SSH disconnect acceptance
   remains unverified: localhost sshd host key was checked using its local public
   key; login for the current account was denied. Do not claim cgroup/login survival.
   Stage 3 now routes client-mode `run` through that owner and a thin native
   attachment. `run --detach` returns after ready without a TTY; `sessions [--json]`,
   `attach [handle]`, and `stop [handle]` are public. Without a handle, attach opens
   a Clack session picker (arrows/Enter, Esc/Ctrl+C to cancel); the available current
   workspace owner is initially selected and busy/unavailable owners are disabled.
   Stop without a handle opens a repeating picker, including attached sessions;
   after each stop it refreshes until empty or Esc/Ctrl+C. Errors return to the
   menu. An explicit handle stops one owner. Neither needs a profile/gateway.
   Ctrl+], then d exits the
   frontend to the outer shell; doubled Ctrl+] forwards the literal prefix.
   Bracketed paste is protected, input stays raw, output is sequenced/reassembled,
   exact outer termios is saved/restored with Linux stty, and own mode-query replies
   are consumed locally, including late replies. Concurrent first launch serializes
   marker UUID creation; repeated run checks a private startup fingerprint and
   explicit provider/bridge choices without launching a second runtime.
   Nested run inside its own Telly console is rejected; an old foreground process
   cannot transfer its live PTY into an owner. Busy native controllers are rejected.
   T043/T044 source implementation is described above. Next: **045** real account,
   separate-host/provider/SSH acceptance, docs and an explicitly authorized release.
4. Keep one package, one PTY/agent/console identity and the existing raw terminal
   experience. No tmux dependency or client Redis. Attach starts no duplicate
   shell, agent, broker or browser bridge. Preserve the shared profile, scoped
   proxies, `--ws` semantics and workspace marker.
5. Local detach/reattach comes first. Remote attach must authenticate ownership
   of the target account; the shared gateway bearer alone is insufficient.
   Disconnecting an attachment must leave the owner and PTY alive; actual shell
   exit or explicit stop must shut down owned services with the real exit status.
6. Stage 1 remains a standalone fidelity harness; stage 2 provides the daemon
   and stage 3 switches Linux client-mode run to owner + frontend. Gateway/both
   runner behavior stays separate. Public CLI testing uses `yarn build`, then
   `node /absolute/path/to/telegram_mcp/dist/cli.js run` from an outer console.
   The globally installed client is now a local 0.0.43 build with detach/attach,
   including the repeating stop picker. The package version was not bumped.
   Its fixed palette and unsupported terminal extensions are documented in the
   design. Keep the shared `ptyRegistry` screen/query owner during CLI integration.
   Do not create a
   release tag or deploy the experimental branch as part of this prototype.

Latest source checks including the prototype: build/lint passed;
**454 tests passed, 2 skipped** (18 stage-1, 12 stage-2, 24 stage-3, 14 remote/code, 5 OAuth-repair and 3 SQLite-warning cases).
Follow-up: both registry and xchange SQLite imports use the shared
`shared/lib/sqlite.ts` loader. It suppresses only the exact startup SQLite
ExperimentalWarning during synchronous module loading and restores the warning
handler in finally. Other warnings and load errors are retained; no global
NODE_OPTIONS/NODE_NO_WARNINGS changes. Compiled sessions/plain JSON stdout and
empty stderr verified on Node24.13.0.
The sessions display now pads columns before applying picocolors, preserves full
handles, and uses a compact per-session layout when the terminal is too narrow.
Long paths are shortened only in the terminal display; JSON remains complete and
uncolored. This display follow-up passed build/lint and manual 160/100/80-column,
color/plain alignment, and actual two-session JSON checks (no new test cases).
Attach without a handle now uses lazy-loaded `@clack/prompts` **1.8.1**. The
picker keeps full owner handles as values, works outside a workspace, defaults
to the available workspace owner, and disables busy/unavailable/exited entries.
Esc/Ctrl+C cancel; catchable signals abort with their exit status. Exact termios
is restored before attach or cancellation. Four new real-PTY cases cover another
owner selection, busy skipping/all-busy rejection, non-TTY rejection, Esc/Ctrl+C
termios restoration, and SIGTERM cancellation; existing attach tests confirm the
menu-to-attachment transition. Build/lint and the full suite passed. Compiled-menu
smoke listed the user's two actual owners and cancelled via Esc without attaching;
both remained detached with their original shell PIDs. See I-TELLYMCP-054.
Pre-merge packaging check also passed: `npm pack` rebuilt runtime and both browser
extensions. Extracted tarball contains the owner/frontend, picker, formatter and
SQLite loader; help, attach help and isolated sessions JSON work using the existing
workspace dependencies. The package is a temporary verification artifact, not a
release or global install. Remote main refs were checked at `13a14e0` before merge.
T041/T042 remain in review because their documented SSH/provider/authenticated
integration acceptance is still open; merging the accepted local CLI scope does
not complete remote attach or the entire detach/attach milestone.
Stop-menu follow-up: the shared picker accepts attach/stop actions. Stop allows
attached owners and stale/unavailable entries so the existing safe-stop/recovery
path can handle them. Each selection waits for stop, probes a fresh list and
reopens the menu; errors are printed and retain exit status 1, while selection
continues. Empty list ends the menu; Esc/Ctrl+C leaves remaining sessions alive.
An explicit handle still stops one owner without a TTY. Four new PTY cases verify
two-owner iteration (including an attached frontend), Esc/Ctrl+C exact termios,
and error-to-menu recovery without signalling an unverified process. Build/lint
and the full suite passed; actual compiled stop/help also verified with the user's
now-empty registry. The user reported stopping both of their prior sessions.

Local package installation (explicitly authorized 2026-11-08): `npm pack` rebuilt
runtime and both browser extensions, then `npm install --global --omit=dev` installed
the archive into NVM Node24.13.0. Global binary:
`~/.nvm/versions/node/v24.13.0/bin/tellymcp`; package under its `lib/node_modules`.
Artifact: `/tmp/tellymcp-local-install.vNBBQW/deadragdoll-tellymcp-0.0.43.tgz`,
SHA256 `189cee7a7e0a1b4ba508099efca3b925da13b1a61bb7d9b37fdca90ce118cb7e`.
Installed CLI/picker/formatter/frontend/SQLite modules match the compiled source.
Installed-package smoke used its own production dependencies and an isolated local
HTTP registration fixture: run --detach, sessions JSON, raw attach/detach, picker
reattach to the same shell PID1854198, stop picker and empty-list cleanup all passed,
with one registration. Global attach/stop help and actual empty sessions JSON passed.
Profile/legacy symlink target/workspace-marker content fingerprints were unchanged.
Version stays 0.0.43; no release tag, registry publication or production deployment.
Real PTY tests preserved shell/interactive-child PIDs, detached progress, raw
Unicode input and one reply per query through attach/detach, final output and
exit 7. The manual harness reported Bash PID `1411199` both before and after
detach/reattach, delivered `FINAL_OUTPUT`, and propagated exit 7.
Stage-2 tests additionally cover separate launcher exit with its controlling PTY,
owner stdio `/dev/null`, concurrent launches creating one runtime, broken frontend/
SIGHUP, private discovery, stale PID/start identity, input/output framing and
bounds, startup cancellation/failure, isolated stop, bounded logs and early runtime
readiness rejection. That last regression could previously crash before embedded
broker startup returned; it now propagates through cleanup and private logging.
Actual compiled internal CLI + embedded broker smoke used a disposable local
HTTP gateway and temporary profile: owner PID `1490425`, shell PID `1490435`.
After gateway drop and frontend disconnect, local reattach reached the same shell,
received final output and exit9, cleaned discovery and preserved the temporary
marker. The fixture supplied HTTP registration and rejected WebSocket upgrades;
this was not authenticated real WSS reconnect evidence.
No real gateway/shared profile/workspace marker was used or changed.
Stage-3 public source-CLI tests verify first concurrent launches => one registration,
profile/provider/bridge conflicts without extra runtime or marker mutation,
normal run, ready/attach/resize/busy, profile-free reattach, final output/exit7,
exact termios in an outer Bash, active-controller stop, SIGTERM/SIGKILL survival,
Ctrl+C/Z/D, and browser bridge TCP continuity until owner exit. Stream tests cover
byte splits, bracketed paste, prefix escaping, late mode-query replies and output
sequence validation. A regression covers shell exit before snapshot ACK.
Manual compiled CLI run --detach and repeat returned one handle; owner1555986,
shell1556062. Split Ctrl+] then d exited frontend0; reattach reached shell1556062,
delivered CLI_FINAL and returned shell exit7. Its temporary registry was cleaned.
This is tool-PTY evidence; two physical emulator and real provider checks remain
pending. This earlier smoke preceded the separately authorized local install above;
no release or production mutation occurred.
Installed client auto-discovery, authenticated gateway HTTPS/WSS and foreground
shell exit were verified in the previous client work. Optional Playwright Chromium
binaries are missing in the local installation. Actual SSH disconnect survival,
two physical emulators, managed Codex/Claude terminal fidelity, authenticated
Telegram/MCP/Live continuity, real WSS reconnect and remote attach remain future
acceptance checks. Current busy enforcement covers local native attachments;
shared native local/remote lease enforcement is now implemented in source, while
Live remains mirrored and writable by the user's explicit decision.

## Historical snapshot (2026-08-07)

The material below is retained for history. Its versions, deployment assumptions
and backlog statuses are not current; use the continuation section above and Marrow.

Operational snapshot for the next session.

Last updated: `2026-08-07`

Note on this file's own history: the `2026-07-14` snapshot below was never fully
retired — a `2026-07-15` commit touched only the "Current State" bullets (added the
Redis-gateway-only line) without bumping this header or updating "What Was Just
Finished"/"Known Remaining Follow-Ups", and several commits after `2026-07-14` were
never reflected here at all until this pass. Treat any single bullet list in this file
as current only as of the date next to it, not as of the header date, until this file
is next fully reconciled against `git log`.

## Current State

- branch: `main`
- runtime model: gateway-first
- terminal model: built-in PTY only
- workspace marker: `.mcpsession.json` only
- persistence split: Redis is gateway-only; clients use process-local transient
  state and keep their stable gateway client UUID in `.mcpsession.json`
- browser attach: Firefox + Chrome local extensions are implemented and exported through CLI
- browser recording: structured bundles under `.mcp-xchange/web/<tab-title>-<timestamp>/`

## What Was Just Finished

- ChatGPT/Claude OAuth connector support was implemented around the existing
  Streamable HTTP MCP endpoint
- the connector was validated in production with ChatGPT on
  `https://your-gateway-domain.example/api/mcp`; reconnect and tool refresh succeeded
- OAuth discovery, PKCE authorization-code exchange, RS256 JWT bearer auth,
  exact redirect allowlisting, confidential-client auth, JWKS, dual MCP auth,
  Nginx routes, signing-key CLI support, and safe diagnostics are present
- the production incident was caused by entering the OAuth base `/api` in the
  ChatGPT `Connection` field; the required endpoint is `/api/mcp`
- detailed continuation notes are in `docs/HANDOFF_CHAT_CONNECTOR_OAUTH.md`
- browser-attach connectivity fixes landed:
  - Firefox global recorder injection removed
  - Firefox/Chrome fetch wrapper no longer blocks page `fetch()` on body capture
  - Chrome MV3 keepalive/reconnect backstop now uses `alarms`
- browser-attach server-side fixes landed:
  - reconnect close-race fixed
  - `startRecording()` now checks `tabId`
  - `stopRecording()` works against persisted state after restart and finalizes bundles when session cwd exists
- browser attached-tab output schemas were relaxed from strict URL validation to plain strings where needed
- browser-attach review/plan docs were updated to reflect fixed vs still-open items
- `DECISIONS.md` was created as the living source of truth for accepted project decisions
- browser-attach WS inputs now have Origin checks, strict bounded schemas, rate limiting,
  stale-heartbeat reaping, contained handler failures, and deterministic duplicate replacement
- Chrome attach extension `0.0.2` uses a Manifest V3-compatible static executor for DOM/click/press
  and returns correlated action errors instead of remote WS timeouts

## What Landed After The 2026-07-14 Snapshot (added 2026-08-07)

The block above stopped being updated after `2026-07-14` even though development
continued. Confirmed from `git log` and `CHANGELOG.md` (not independently re-tested in
this pass beyond the source-audit described below):

- webapp live console made WS-only: the Mini App terminal now reconnects `/api/live/ws`
  with backoff instead of permanently downgrading to polling after one drop; polling
  was removed entirely. See `docs/CODE_REVIEW_webapp-live-console.md` for the
  before/after (commits `defc4b3`, `c1ed83a`).
- `get_file` / `get_file_list` MCP tools were added for chat-client file retrieval, with
  `url`/`image`/`text`/`base64` modes and symlink-safe read confinement (commit
  `25b07e9`; see `docs/DECISIONS.md` D-029). Read confinement is verified via
  `realpath()`; the equivalent write/delete paths in the same storage layer are not —
  see the H-06 update in `docs/CODE_REVIEW_2026-07-13.md`.
- Redis was made gateway/`both`-only; client runtimes no longer connect to Redis or
  require `REDIS_*`, and keep only the stable gateway client UUID in
  `.mcpsession.json` (see `docs/DECISIONS.md` D-031). This shipped alongside a local
  web configurator (`tellymcp configure`) and the `get_runtime_diagnostics` MCP tool.
- `tellymcp run`/`doctor`/postinstall now genuinely probe whether the native
  `node-pty` addon loads, instead of assuming successful compilation, with
  platform-aware remediation instructions (commit `9f093da`).
- `tellymcp doctor`'s WebSocket probe no longer strips error listeners before closing,
  fixing an unhandled-rejection crash on HTTP reject/timeout/early close (commit
  `c11319e`).
- The ChatGPT/Claude OAuth connector work described below shipped to production; see
  `docs/HANDOFF_CHAT_CONNECTOR_OAUTH.md` (unchanged, still current as its own file).

## Files To Read First

1. `DECISIONS.md`
2. `docs/CODE_REVIEW_2026-07-13.md` — the current-state review with per-finding
   `Status:` lines; the most reliable single source for "what reliability/security
   issues are actually still open right now" (added to this list on `2026-08-07`; it
   existed before but was never linked from here)
3. `docs/HANDOFF_CHAT_CONNECTOR_OAUTH.md` when continuing connector work
4. `docs/CHAT_CONNECTOR.md`
5. `docs/DEVELOPMENT.md`
6. `docs/IMPLEMENTATION_PLAN.md`
7. `TOOLS.md`
8. `docs/CODE_REVIEW_browser-attach.md`
9. `docs/CODE_REVIEW_browser-attach_FIXES.md`

## Verified Commands

These passed in this workspace as of `2026-07-14`, during the OAuth connector work
(full suite reached `150` passing tests; build/lint passed before the final
request/response diagnostic logging change, which was not re-validated per explicit
user instruction at the time):

```bash
yarn build
yarn build:extensions
yarn lint
yarn test
```

Not re-run since. At least `9` commits have landed after `2026-07-14` (see "What
Landed After The 2026-07-14 Snapshot" above), so do not describe the current working
tree as validated by this section — re-run these commands before relying on them.

## Known Accepted Invariants

- do not reintroduce pairing-first, inbox-first, or tmux-first flows
- do not add hidden routing/session fallbacks
- gateway-side prompt scanning is event-driven and should not depend on manual `/menu`
- blocker actions stay limited to digits `1..N`, `Enter`, `Esc`
- attached browser control state is backend-owned, not popup-owned

## Known Remaining Follow-Ups

These are known backlog items, not regressions from the last pass. Items 1-3 were
re-verified against current source on `2026-08-07`; items 5-10 were added on that date
because they were confirmed still open but had never been listed in this file before
(they were only tracked in `docs/CODE_REVIEW_2026-07-13.md`, and a reader who trusted
this "read first" file's follow-up list alone would have missed them entirely).

1. browser-attach naming debt still exists, with concrete counts as of `2026-08-07`:
   - shared infra is still named `firefox*` (`FirefoxAttachRegistry`, `FirefoxAttachServer`)
   - persisted `backend` literal is still `"firefox-attached"` in 8 files / 14
     occurrences; `"chrome-attached"` is never used, so Chrome-originated sessions are
     currently persisted under the wrong label
2. attached-browser injected export semantics still differ across Chrome/Firefox for some bare `window.foo = ...` cases
3. `activeTab` in attach registry can still become stale after tab close
4. DB-level functions/views/triggers for some gateway logic are still only a deferred idea, not an accepted direction
5. **gateway message enqueue is not transactional** (`H-04`): `sendPartnerNoteRecord()`
   in `gateway.service.ts:1862-2128` inserts message/artifacts/delivery as separate
   unwrapped statements; a retry after partial failure cannot dedupe. See
   `docs/CODE_REVIEW_2026-07-13.md` H-04.
6. **delivery consumption can duplicate or silently drop work** (`H-05`):
   `pollDeliveriesRecord()` claims no rows atomically, and the `delivery_event` WS
   handler at `gateway-socket.service.ts:2782-2814` acks unconditionally even when the
   target session is missing (one of its two call sites has a partial guard, the other
   does not). See `docs/CODE_REVIEW_2026-07-13.md` H-05.
7. **workspace symlink confinement covers reads only** (`H-06`): `get_file` and other
   read paths resolve `realpath()` before serving a file, but
   `resolvePathInsideRoot`/`writeXchangeRelativeFile`/`deleteXchangeFile` in
   `terminal/client.ts` — used for browser-recording writes, partner-artifact writes,
   and xchange-file deletion — remain lexical-only. Do not read `docs/DECISIONS.md`
   D-029's symlink-resolution language as covering these write/delete paths; it does
   not. See `docs/CODE_REVIEW_2026-07-13.md` H-06.
8. **browser recording events are unsynchronized and write-amplified** (`M-01`): no
   per-recording lock/queue; `session.json` is rewritten and Redis is `SET` on every
   single event with no throttling. See `docs/CODE_REVIEW_2026-07-13.md` M-01.
9. **xchange SQLite reopens and reapplies schema on every call** (`M-02`):
   `sqliteRecordStore.ts`'s `withDatabase` opens a fresh synchronous `DatabaseSync`,
   runs full DDL, and closes it on every list/get/upsert/mark-read. See
   `docs/CODE_REVIEW_2026-07-13.md` M-02.
10. **PTY records leak on failure and never get removed on stop** (`M-03`): a
    synchronous `spawn()` failure orphans a temp directory (no `try`/`catch` around
    prepare+spawn), and `stopPtyTarget` never deletes the record from the global
    `sessions` map, so `hasPtyTarget()` reports stopped targets as present
    indefinitely — an unbounded accumulation on long-lived processes. See
    `docs/CODE_REVIEW_2026-07-13.md` M-03.

## If Continuing Browser-Attach Work

Primary files:

- `src/services/features/telegram-mcp/src/features/browser/model/browserService.ts`
- `src/services/features/telegram-mcp/src/features/browser-attach/model/firefoxAttachServer.ts`
- `src/services/features/telegram-mcp/src/features/browser-attach/model/firefoxAttachRegistry.ts`
- `src/services/features/telegram-mcp/src/features/browser-attach/model/browserRecordingBundle.ts`
- `packages/firefox-attach-extension/src/*`
- `packages/chrome-attach-extension/src/*`

## If Continuing Docs Work

Keep these aligned together:

- `README.md`
- `README-ru.md`
- `TOOLS.md`
- `docs/DEVELOPMENT.md`
- `docs/IMPLEMENTATION_PLAN.md`
- `DECISIONS.md`

## Working Tree Note (historical — 2026-07-14, superseded)

At the time of writing, the connector work was uncommitted and spanned source,
tests, env templates, Nginx, and documentation. The primary new files were:

- `src/services/features/telegram-mcp/src/app/oauthFacade.ts`
- `tests/oauthFacade.test.ts`
- `docs/CHAT_CONNECTOR.md`
- `docs/HANDOFF_CHAT_CONNECTOR_OAUTH.md`

The user supplied `docs/CHAT_CONNECTOR_OAUTH_GUIDE.md` and
`nginx/tellymcp.gw.conf`; these were preserved. The Nginx file was intentionally
edited in place as part of the connector work.

Update (`2026-08-07`): this work was committed (`ed94aa1`, "ChatGPT Connector") and
several more commits have landed on top of it since. As of this pass, `git status` on
`main` is clean — there is no uncommitted connector work outstanding. This section is
kept only as history of what that working tree once contained; do not use it to infer
the current working-tree state.
