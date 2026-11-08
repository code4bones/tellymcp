import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { inspectorBundle } from "../packages/attach-extension-shared/build.mjs";
import { validateInspectorResult } from "../src/services/features/telegram-mcp/src/features/browser/model/inspectorProtocol";

const fixture = `<!doctype html><html><head><title>Inspector fixture</title><style>body{margin:0;min-height:1800px}#card{position:absolute;left:40px;top:60px;width:280px;height:150px;background:#eee}#trade{margin:20px;width:120px;height:40px}canvas{position:absolute;left:40px;top:300px}iframe{position:absolute;left:40px;top:450px;width:200px;height:80px}</style></head><body><section id="card"><button id="trade">Liquidity 42</button><input type="password" value="super-private-value"><span hidden>hidden-value</span></section><canvas width="200" height="100"></canvas><iframe src="https://frame.test/"></iframe><script>globalThis.trades=0;document.querySelector('#trade').onclick=()=>trades++;const ctx=document.querySelector('canvas').getContext('2d');ctx.fillStyle='#ff0000';ctx.fillRect(0,0,200,100);</script></body></html>`;

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
        const listeners=[];
        globalThis.fixtureBridge=tellyInspector.createBridge({
          tab:async id=>({id,windowId:1,url:location.href,active:true}),
          active:async()=>({id:7,windowId:1,url:location.href,active:true}),
          selected:()=>7,inject:async()=>{},capture:()=>fixtureCapture(),
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
              `(()=>{const button=[...fixtureShadow.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(label)});if(!button)throw new Error('Missing picker button');button.scrollIntoView({block:'nearest'});const r=button.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
            );
            await page.mouse.click(box.x, box.y);
          };
          await command("start", {
            mode: "element",
            request_id: "agent-request",
          });
          await page.mouse.move(100, 100);
          await page.waitForTimeout(40);
          await page.keyboard.press("Alt+ArrowUp");
          await page.keyboard.press("Alt+ArrowDown");
          await page.mouse.click(100, 100);
          expect(await page.evaluate("trades")).toBe(0);
          expect(
            await page.evaluate(
              "fixtureMessages.filter(m=>m.type==='picker_submit').length",
            ),
          ).toBe(0);
          await clickButton("Explain");
          await expect
            .poll(async () => (await command("get_selection"))?.result?.status)
            .toBe("selected");
          let selected = (await command("get_selection")).result.context;
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
          await page.waitForTimeout(20);
          expect((await command("get_selection")).result.status).toBe(
            "pending",
          );

          await command("start", { mode: "region" });
          await page.mouse.move(40, 300);
          await page.mouse.down();
          await page.mouse.move(240, 400);
          await page.mouse.up();
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
        } finally {
          await browser.close();
        }
      },
      30000,
    );
  },
);
