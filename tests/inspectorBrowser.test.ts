import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { inspectorBundle } from "../packages/attach-extension-shared/build.mjs";
import { validateInspectorResult } from "../src/services/features/telegram-mcp/src/features/browser/model/inspectorProtocol";
import { readDomBatch } from "../src/services/features/telegram-mcp/src/shared/lib/browserDomBatch";

const fixture = `<!doctype html><html><head><title>Inspector fixture</title><style>body{margin:0;min-height:1800px}#card{position:absolute;left:40px;top:60px;width:280px;height:150px;background:#eee}#trade{margin:20px;width:120px;height:40px}canvas{position:absolute;left:40px;top:300px}iframe{position:absolute;left:40px;top:450px;width:200px;height:80px}</style></head><body><section id="card"><button id="trade">Liquidity 42</button><input type="password" value="super-private-value"><span hidden>hidden-value</span></section><canvas width="200" height="100"></canvas><iframe src="https://frame.test/"></iframe><script>globalThis.trades=0;document.querySelector('#trade').onclick=()=>trades++;const ctx=document.querySelector('canvas').getContext('2d');ctx.fillStyle='#ff0000';ctx.fillRect(0,0,200,100);</script></body></html>`;

describe.skipIf(!existsSync(chromium.executablePath()))(
  "Picker question focus inside a modal page",
  () => {
    it.each(["chrome", "firefox"])(
      "accepts a typed question with an open Drawer (%s API)",
      async (browserName) => {
        const browser = await chromium.launch({ headless: true });
        try {
          const page = await browser.newPage({
            viewport: { width: 1100, height: 800 },
          });
          await page.route("https://focus.test/**", (route) =>
            route.fulfill({
              contentType: "text/html",
              body: `<button id="outside">Outside</button><aside role="dialog" aria-modal="true" style="position:fixed;inset:0 0 0 500px;z-index:1000;background:#ddd"><button id="drawer-focus">Drawer action</button><div id="marked" style="margin-top:100px;width:200px;height:90px;background:#aaa">Selected content</div></aside>`,
            }),
          );
          await page.goto("https://focus.test/");
          await page.addScriptTag({
            content: `
        globalThis.focusReturns=0;globalThis.deliveries=[];
        const drawer=document.querySelector('[role=dialog]');
        window.addEventListener('focusin',()=>{
          if(!drawer.contains(document.activeElement)){
            focusReturns++;document.querySelector('#drawer-focus').focus();
          }
        });
        document.querySelector('#drawer-focus').focus();
        const original=Element.prototype.attachShadow;
        Element.prototype.attachShadow=function(init){const root=original.call(this,init);globalThis.fixtureShadow=root;return root;};
        const runtime={id:'fixture-extension',onMessage:{addListener:fn=>globalThis.command=fn},sendMessage:(message,callback)=>{
          if(message.type==='picker_submit')deliveries.push(message.context);
          const result={ok:true,saved:true,notified:true};
          if(callback){callback(result);return;}return Promise.resolve(result);
        }};
        globalThis.${browserName === "firefox" ? "browser" : "chrome"}={runtime};
      `,
          });
          await page.addScriptTag({ content: inspectorBundle("controller") });
          await page.evaluate(
            `command({type:'picker_control',action:'start',mode:'marks'}, {id:'fixture-extension'}, ()=>{});`,
          );
          await page.mouse.click(600, 150);
          await page.keyboard.press("Enter");
          const box = await page.evaluate(
            `(()=>{const r=fixtureShadow.querySelector('textarea').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
          );
          await page.mouse.click(box.x, box.y);
          await page.keyboard.type("Compare these marked elements");
          expect(
            await page.evaluate(
              "fixtureShadow.querySelector('textarea').value",
            ),
          ).toBe("Compare these marked elements");
          expect(
            await page.evaluate(
              "fixtureShadow.activeElement===fixtureShadow.querySelector('textarea')",
            ),
          ).toBe(true);
          const ask = await page.evaluate(
            `(()=>{const r=fixtureShadow.querySelector('[aria-label=Ask]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
          );
          await page.mouse.click(ask.x, ask.y);
          await expect
            .poll(() => page.evaluate("deliveries[0]?.question"))
            .toBe("Compare these marked elements");
          await page.keyboard.press("Escape");
          await page.locator("#outside").focus();
          expect(await page.evaluate("document.activeElement.id")).toBe(
            "drawer-focus",
          );
        } finally {
          await browser.close();
        }
      },
    );
  },
);

describe.skipIf(!existsSync(chromium.executablePath()))(
  "AI Picker browser interaction",
  () => {
    it.each(["chrome", "firefox"])(
      "selects, reviews, crops and answers with %s API semantics",
      async (browserName) => {
        const browser = await chromium.launch({ headless: true });
        try {
          const page = await browser.newPage({
            viewport: { width: 900, height: 700 },
            deviceScaleFactor: 1.5,
          });
          page.setDefaultTimeout(3000);
          page.setDefaultNavigationTimeout(5000);
          page.on("pageerror", (error) =>
            console.error("Picker fixture error:", error.message),
          );
          await page.route("https://fixture.test/**", (route) =>
            route.fulfill({ contentType: "text/html", body: fixture }),
          );
          await page.route("https://frame.test/**", (route) =>
            route.fulfill({
              contentType: "text/html",
              body: "<p>Cross-origin frame</p>",
            }),
          );
          await page.goto("https://fixture.test/page?token=private#fragment");
          await page.exposeFunction(
            "fixtureCapture",
            async () =>
              "data:image/png;base64," +
              (await page.screenshot({ type: "png" })).toString("base64"),
          );
          // Keep the production closed root; retain a reference only in this fixture to locate UI coordinates.
          await page.addScriptTag({
            content: `const originalShadow=Element.prototype.attachShadow;Element.prototype.attachShadow=function(init){const root=originalShadow.call(this,init);globalThis.fixtureShadow=root;return root};`,
          });
          await page.addScriptTag({ content: inspectorBundle("background") });
          await page.addScriptTag({
            content: `
        globalThis.fixtureMessages=[];
        globalThis.fixtureDeliveries=[];
        const listeners=[];
        globalThis.fixtureBridge=tellyInspector.createBridge({
          tab:async id=>({id,windowId:1,url:location.href,active:true}),
          active:async()=>({id:7,windowId:1,url:location.href,active:true}),
          selected:()=>7,inject:async()=>{},capture:()=>fixtureCapture(),
          submit:async(id,context)=>{fixtureDeliveries.push(structuredClone(context));return {ok:true,saved:true,notified:true,artifact_id:'fixture-artifact'}},
          message:async(id,message)=>new Promise(resolve=>listeners[0](message,{id:'fixture-extension'},resolve))
        });
        fixtureBridge.bind('session','connection','Fixture console');
        const runtime={id:'fixture-extension',onMessage:{addListener:fn=>listeners.push(fn)},sendMessage:(message,callback)=>{
          fixtureMessages.push(message);
          const result=fixtureBridge.runtime(message,{tab:{id:7},frameId:0});
          if(callback){result.then(callback);return;}return result;
        }};
        globalThis.${browserName === "firefox" ? "browser" : "chrome"}={runtime};
      `,
          });
          await page.addScriptTag({ content: inspectorBundle("controller") });
          const command = (operation: string, payload = {}) =>
            page.evaluate(
              `Promise.race([fixtureBridge.action(7,${JSON.stringify("inspector_" + operation)},${JSON.stringify({ session_id: "session", ...payload })}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Inspector command timeout: '+${JSON.stringify(operation)})),3000))])`,
            );
          const panel = page.locator("#telly-inspector-overlay");
          const clickButton = async (label: string) => {
            const box = await page.evaluate(
              `(()=>{const button=[...fixtureShadow.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)});if(!button)throw new Error('Missing picker button');button.scrollIntoView({block:'nearest'});const r=button.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
            );
            await page.mouse.click(box.x, box.y);
          };
          await command("start", {
            mode: "element",
            request_id: "agent-request",
          });
          const panelSize = () =>
            page.evaluate(
              "(()=>{const r=fixtureShadow.querySelector('.panel').getBoundingClientRect();return {width:r.width,height:r.height}})()",
            );
          expect(await panelSize()).toEqual({ width: 44, height: 44 });
          const pickerCorner = await page.evaluate(
            "fixtureShadow.querySelector('.panel').getBoundingClientRect().toJSON()",
          );
          await clickButton("Show picker controls");
          expect((await panelSize()).width).toBe(340);
          expect(await page.evaluate("fixtureShadow.textContent")).toContain(
            "Receiver: Fixture console",
          );
          await clickButton("Collapse");
          expect(await panelSize()).toEqual({ width: 44, height: 44 });
          await page.mouse.move(100, 100);
          await page.waitForTimeout(40);
          await page.keyboard.press("Alt+ArrowUp");
          await page.keyboard.press("Alt+ArrowDown");
          await page.mouse.click(100, 100);
          expect((await panelSize()).width).toBe(340);
          expect(await page.evaluate("trades")).toBe(0);
          expect(
            await page.evaluate(
              "fixtureMessages.filter(m=>m.type==='picker_submit').length",
            ),
          ).toBe(0);
          expect(await page.evaluate("fixtureDeliveries.length")).toBe(0);
          await clickButton("Explain");
          await expect
            .poll(async () => (await command("get_selection"))?.result?.status)
            .toBe("selected");
          let selected = (await command("get_selection")).result.context;
          expect(await page.evaluate("fixtureDeliveries[0].question")).toBe(
            "Explain this selection using only observed content.",
          );
          expect(await page.evaluate("fixtureShadow.textContent")).toContain(
            "Saved and sent to the bound agent",
          );
          validateInspectorResult(
            { status: "selected", context: selected },
            { sessionId: "session", instanceId: "connection", tabId: 7 },
          );
          expect(selected.requestId).toBe("agent-request");
          expect(selected.selection.element.tagName).toBe("button");
          expect(selected.selection.element.text).toBe("Liquidity 42");
          expect(JSON.stringify(selected)).not.toContain("super-private-value");
          expect(JSON.stringify(selected)).not.toContain("hidden-value");
          expect(selected.page.url).toBe("https://fixture.test/page");
          await command("response", {
            selection_id: selected.selectionId,
            request_id: selected.requestId,
            explanation: "<script>trades=999</script> Observed liquidity: 42",
          });
          expect(await page.evaluate("fixtureShadow.textContent")).toContain(
            "<script>trades=999</script> Observed liquidity: 42",
          );
          expect(await page.evaluate("trades")).toBe(0);
          // The old expanded panel covered this corner; selection must now reach the page.
          await page.evaluate(
            "(()=>{const corner=document.createElement('button');corner.textContent='Previously covered';corner.style.cssText='position:fixed;right:100px;top:70px;width:160px;height:50px';corner.onclick=()=>trades++;document.body.append(corner)})()",
          );
          await command("start", { mode: "element" });
          await page.mouse.move(700, 90);
          await page.waitForTimeout(40);
          await page.mouse.click(700, 90);
          await page.evaluate(
            `Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { globalThis.fixtureCopiedContext = value; } } });`,
          );
          await clickButton("Copy context");
          expect(await page.evaluate("fixtureCopiedContext")).toContain(
            "Previously covered",
          );
          expect((await panelSize()).width).toBe(340);
          expect(await page.evaluate("trades")).toBe(0);
          expect(
            await page.evaluate(
              "fixtureShadow.querySelector('[aria-label=\"Select again\"]').getBoundingClientRect().toJSON()",
            ),
          ).toEqual(pickerCorner);
          await clickButton("Select again");
          expect(await panelSize()).toEqual({ width: 44, height: 44 });
          await command("start", {
            mode: "element",
            request_id: "parent-request",
          });
          await page.mouse.move(100, 100);
          await page.waitForTimeout(40);
          await page.keyboard.press("Alt+ArrowUp");
          await page.keyboard.press("Enter");
          await clickButton("Explain");
          await expect
            .poll(
              async () =>
                (
                  await command("get_selection", {
                    request_id: "parent-request",
                  })
                ).result?.status,
            )
            .toBe("selected");
          selected = (
            await command("get_selection", { request_id: "parent-request" })
          ).result.context;
          expect(selected.selection.element.tagName).toBe("section");
          expect(JSON.stringify(selected)).not.toContain("super-private-value");
          expect(JSON.stringify(selected)).not.toContain("hidden-value");
          validateInspectorResult(
            { status: "selected", context: selected },
            { sessionId: "session", instanceId: "connection", tabId: 7 },
          );
          await page.evaluate(
            "document.querySelector('#trade').outerHTML='<button id=trade>Replaced</button>'",
          );
          await expect(
            command("highlight", {
              selection_id: selected.selectionId,
              request_id: selected.requestId,
            }),
          ).rejects.toThrow();
          await page.keyboard.press("Escape");
          expect(await panel.count()).toBe(0);
          await page.evaluate(
            "for(let i=0;i<60;i++){const e=document.createElement('div');e.setAttribute('data-batch-test','yes');e.textContent='Batch item '+i;document.body.append(e)}",
          );
          const boundedBatch = await page.evaluate(readDomBatch, {
            selector: "[data-batch-test]",
          });
          expect(boundedBatch.total).toBe(60);
          expect(boundedBatch.elements).toHaveLength(50);
          expect(boundedBatch.truncated).toBe(true);
          expect(
            await page.evaluate(readDomBatch, {
              selector: "[data-no-such-mark]",
            }),
          ).toMatchObject({ found: false, total: 0, elements: [] });
          await page.waitForTimeout(20);
          expect((await command("get_selection")).result.status).toBe(
            "pending",
          );

          await command("start", { mode: "region" });
          expect(await panelSize()).toEqual({ width: 44, height: 44 });
          await page.mouse.move(40, 300);
          await page.mouse.down();
          await page.mouse.move(240, 400);
          await page.mouse.up();
          expect((await panelSize()).width).toBe(340);
          await clickButton("Capture preview");
          await expect
            .poll(
              () =>
                page.evaluate(
                  "({images:fixtureShadow.querySelectorAll('img').length,status:[...fixtureShadow.querySelectorAll('p')].at(-1)?.textContent,visibility:document.querySelector('#telly-inspector-overlay').style.visibility})",
                ),
              { timeout: 5000 },
            )
            .toMatchObject({ images: 1 });
          expect(
            await page.evaluate(
              "fixtureMessages.filter(m=>m.type==='picker_submit').length",
            ),
          ).toBe(2);
          await clickButton("Explain");
          await expect
            .poll(
              async () =>
                (await command("get_selection", { include_image: true })).result
                  ?.image?.width,
            )
            .toBe(300);
          const region = (
            await command("get_selection", { include_image: true })
          ).result;
          validateInspectorResult(region, {
            sessionId: "session",
            instanceId: "connection",
            tabId: 7,
          });
          expect(region.image.height).toBe(150);
          expect(region.context.selection.mode).toBe("region");
          expect(region.context.selection.element).toBeUndefined();
          const pixel = await page.evaluate(
            `(async()=>{const img=await createImageBitmap(await(await fetch('data:image/png;base64,${region.image.png_base64}')).blob());const c=new OffscreenCanvas(img.width,img.height);const ctx=c.getContext('2d');ctx.drawImage(img,0,0);return [...ctx.getImageData(100,50,1,1).data]})()`,
          );
          expect(pixel).toEqual([255, 0, 0, 255]);
          await page.evaluate("window.scrollTo(0,100)");
          await expect(
            command("response", {
              selection_id: region.context.selectionId,
              request_id: region.context.requestId,
              explanation: "Stale response",
            }),
          ).rejects.toThrow();
          await page.keyboard.press("Escape");
          expect(await panel.count()).toBe(0);
          // Page interaction works again after all picker handlers were removed.
          await page.evaluate(
            "globalThis.afterEscape=0;document.querySelector('#trade').onclick=()=>afterEscape++",
          );
          await page.evaluate("window.scrollTo(0,0)");
          await page.locator("#trade").click();
          expect(await page.evaluate("afterEscape")).toBe(1);

          // Marks toggle whole containers, never trigger their child buttons, and send selectors only.
          await page.evaluate(
            "globalThis.trades=0;document.querySelector('#trade').onclick=()=>trades++;document.querySelector('canvas').setAttribute('data-ai-picker','site-owned');document.querySelector('canvas').setAttribute('data-ai-picker-item','legacy')",
          );
          await command("start", { mode: "marks" });
          await page.mouse.click(290, 180);
          const groupId = await page
            .locator("#card")
            .getAttribute("data-ai-picker");
          expect(groupId).toMatch(/^[a-f0-9-]{36}$/);
          await page.mouse.click(100, 100);
          expect(
            await page.locator("#card").getAttribute("data-ai-picker"),
          ).toBeNull();
          expect(
            await page.locator("#trade").getAttribute("data-ai-picker"),
          ).toBeNull();
          expect(await page.evaluate("trades")).toBe(0);
          await page.mouse.click(100, 100);
          await page.mouse.click(100, 350);
          expect(
            await page.locator("#trade").getAttribute("data-ai-picker"),
          ).toBe(groupId);
          expect(
            await page.locator("canvas").getAttribute("data-ai-picker"),
          ).toBe(groupId);
          await page.mouse.click(290, 180);
          expect(
            await page.locator("#trade").getAttribute("data-ai-picker"),
          ).toBeNull();
          expect(
            await page.locator("#card").getAttribute("data-ai-picker"),
          ).toBe(groupId);
          expect(
            await page.locator(`[data-ai-picker="${groupId}"]`).count(),
          ).toBe(2);
          await clickButton("Show picker controls");
          const item = await page
            .locator("#card")
            .getAttribute("data-ai-picker-item");
          await clickButton(`Remove marked element ${item}`);
          expect(
            await page.locator("#card").getAttribute("data-ai-picker"),
          ).toBeNull();
          await clickButton("Collapse");
          await page.mouse.click(290, 180);
          await page.keyboard.press("Enter");
          expect(
            await page.evaluate(
              "[...fixtureShadow.querySelectorAll('button')].some(b=>b.getAttribute('aria-label')==='Capture preview')",
            ),
          ).toBe(false);
          await page.evaluate(
            "fixtureShadow.querySelector('textarea').value='Compare the marked blocks'",
          );
          await clickButton("Ask");
          await expect
            .poll(
              async () =>
                (await command("get_selection")).result?.context?.selection
                  ?.mode,
            )
            .toBe("marks");
          const marked = (await command("get_selection")).result;
          validateInspectorResult(marked, {
            sessionId: "session",
            instanceId: "connection",
            tabId: 7,
          });
          expect(marked.context.question).toBe("Compare the marked blocks");
          expect(marked.context.selection.marks).toMatchObject({
            groupId,
            selector: `[data-ai-picker="${groupId}"]`,
          });
          expect(marked.context.selection.marks.itemIds).toHaveLength(2);
          expect(marked.context.selection.element).toBeUndefined();
          expect(marked.context.screenshot).toBeUndefined();
          expect(marked.image).toBeUndefined();
          expect(JSON.stringify(marked)).not.toContain("super-private-value");
          expect(JSON.stringify(marked)).not.toContain("Replaced");
          const batch = await page.evaluate(readDomBatch, {
            selector: marked.context.selection.marks.selector,
          });
          expect(batch.total).toBe(2);
          expect(batch.elements).toHaveLength(2);
          expect(
            batch.elements.some((e) => e.text_content?.includes("Replaced")),
          ).toBe(true);
          const limited = await page.evaluate(readDomBatch, {
            selector: marked.context.selection.marks.selector,
            limit: 1,
            max_chars: 256,
          });
          expect(limited.total).toBe(2);
          expect(limited.elements).toHaveLength(1);
          expect(limited.truncated).toBe(true);
          await command("response", {
            request_id: marked.context.requestId,
            selection_id: marked.context.selectionId,
            explanation: "Both marked blocks were read live.",
          });
          expect(await page.evaluate("fixtureShadow.textContent")).toContain(
            "Both marked blocks were read live.",
          );
          await page.waitForTimeout(510);
          await page.mouse.click(100, 100);
          expect(
            await page.locator("#card").getAttribute("data-ai-picker"),
          ).toBeNull();
          expect(
            await page.locator("canvas").getAttribute("data-ai-picker"),
          ).toBe(groupId);
          expect(await page.evaluate("trades")).toBe(0);
          expect(await panelSize()).toEqual({ width: 44, height: 44 });
          await page.keyboard.press("Escape");
          expect(
            await page.locator(`[data-ai-picker="${groupId}"]`).count(),
          ).toBe(0);
          expect(
            await page.locator("canvas").getAttribute("data-ai-picker"),
          ).toBe("site-owned");
          expect(
            await page.locator("canvas").getAttribute("data-ai-picker-item"),
          ).toBe("legacy");
          await page.locator("#trade").click();
          expect(await page.evaluate("trades")).toBe(1);
          await command("start", { mode: "marks" });
          await page.mouse.click(290, 180);
          await page.evaluate("fixtureBridge.disconnect()");
          expect(
            await page.locator("#card").getAttribute("data-ai-picker"),
          ).toBeNull();
          expect(await panel.count()).toBe(0);
          await page.evaluate(
            "fixtureBridge.bind('session','connection','Fixture console')",
          );
          await page.clock.install();
          await command("start", { mode: "marks" });
          await page.mouse.click(290, 180);
          expect(
            await page.locator("#card").getAttribute("data-ai-picker"),
          ).not.toBeNull();
          await page.clock.fastForward(300001);
          expect(
            await page.locator("#card").getAttribute("data-ai-picker"),
          ).toBeNull();
          expect(await panel.count()).toBe(0);
        } finally {
          await browser.close();
        }
      },
      30000,
    );
  },
);
