const { test } = require("node:test");
const assert = require("node:assert/strict");
const { chromium } = require("playwright-core");
const { readFileSync } = require("node:fs");
const http = require("node:http");
const mock = `
window.calls=[];window.tables={workspaces:[],workspace_members:[],workspace_homes:[],user_preferences:[]};
let callback;let current=null;
const session=email=>({user:{id:email==='a@example.com'?'user-a':'user-b',email}});
window.supabaseClient={auth:{
 onAuthStateChange(fn){callback=fn;setTimeout(()=>fn('INITIAL_SESSION',current),0)},
 async getSession(){return {data:{session:current}}},
 async signInWithPassword(v){calls.push(['signin',v.email]);current=session(v.email);callback('SIGNED_IN',current);return {data:{session:current}}},
 async signUp(v){calls.push(['signup',v.email]);return {data:{session:null}}},
 async resetPasswordForEmail(email){calls.push(['reset',email]);return {}},
 async updateUser(v){calls.push(['password',v.password]);return {}},
 async signOut(){current=null;callback('SIGNED_OUT',null);return {}},
 },
 async rpc(name,args){calls.push([name,args]);const id='w'+(tables.workspaces.length+1);tables.workspaces.push({id,name:args.workspace_name,business:{email:'',phone:'',address:''},enabled_apps:['documents','customers']});tables.workspace_members.push({workspace_id:id,user_id:current.user.id,role:'owner'});return {data:id}},
 from(table){let op='select',payload,filters=[];const q={select(){return q},eq(k,v){filters.push([k,v]);return q},maybeSingle(){return q},single(){return q},update(v){op='update';payload=v;return q},upsert(v){op='upsert';payload=v;return q},insert(v){op='insert';payload=v;return q},delete(){op='delete';return q},then(resolve){calls.push([table,op]);if(window.failWrite&&op!=='select'){window.failWrite=false;return Promise.resolve({error:{message:'Write denied'}}).then(resolve)}
 const uid=current.user.id;const rows=tables[table];const allowed=rows.filter(r=>table==='user_preferences'||table==='workspace_homes'?r.user_id===uid:table==='workspaces'?tables.workspace_members.some(m=>m.workspace_id===r.id&&m.user_id===uid):tables.workspace_members.some(m=>m.workspace_id===r.workspace_id&&m.user_id===uid));let data=allowed.filter(r=>filters.every(([k,v])=>r[k]===v));
 if(op==='update'){data.forEach(r=>Object.assign(r,payload));data=data[0]||null}
 if(op==='upsert'){let r=rows.find(r=>r.user_id===payload.user_id&&r.workspace_id===payload.workspace_id);if(r)Object.assign(r,payload);else rows.push(payload);data=payload}
 if(op==='insert'){rows.push(payload);data=payload}if(table==='user_preferences'&&op==='select')data=data[0]||null;
 return Promise.resolve({data:structuredClone(data)}).then(resolve)}};return q}
};window.recover=()=>{current=session('a@example.com');callback('PASSWORD_RECOVERY',current)};
`;
test("auth, workspace UI, private settings, local data preservation and failed writes", async () => {
  const server = http.createServer((req, res) => {
    res.setHeader(
      "Content-Type",
      req.url.endsWith(".js") ? "application/javascript" : "text/html",
    );
    res.end(
      req.url === "/client.js"
        ? mock
        : req.url === "/hotel-tax.js"
          ? readFileSync("dist/hotel-tax.js")
          : req.url === "/app.js"
            ? readFileSync("dist/app.js")
            : readFileSync("dist/index.html"),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      localStorage.setItem("backendos.workspaces.v1", "preserved");
      localStorage.setItem("backendos.preferences.v1", "preserved appearance");
    });
    await page.goto("http://127.0.0.1:" + server.address().port);
    await page.locator('[data-auth-mode="signup"]').click();
    await page.locator("#auth-email").fill("a@example.com");
    await page.locator("#auth-password").fill("password123");
    await page.locator("#auth-form button").click();
    await page
      .getByText("Check your email to confirm", { exact: false })
      .waitFor();
    await page.locator("#auth-email").fill("a@example.com");
    await page.locator("#auth-password").fill("password123");
    await page.locator("#auth-form button").click();
    await page.getByText("Your first workspace", { exact: true }).waitFor();
    await page.locator("[data-new-workspace]").click();
    await page.locator("#workspace-name").fill("Business A");
    await page.locator("#create-workspace-form button").click();
    await page.getByRole("heading", { name: "Welcome home." }).waitFor();
    await page.locator('.dock [data-route="appearance"]').click();
    await page.locator('[data-pref="theme"][data-value="dark"]').click();
    await page.waitForFunction(
      () => tables.user_preferences[0]?.appearance.theme === "dark",
    );
    await page.locator('.dock [data-route="home"]').click();
    await page.locator('[data-route="edit"]').click();
    await page.locator('[data-remove="documents"]').click();
    await page.locator("[data-done]").click();
    await page.waitForFunction(
      () =>
        tables.workspace_homes[0] &&
        !tables.workspace_homes[0].shortcuts.includes("documents"),
    );
    await page.locator('.dock [data-route="appearance"]').click();
    await page.evaluate(() => (window.failWrite = true));
    await page.locator('[data-pref="theme"][data-value="light"]').click();
    await page.getByText("Write denied", { exact: true }).waitFor();
    assert.equal(await page.locator("body").getAttribute("data-dark"), "true");
    await page.locator('.settings-nav [data-route="account"]').click();
    await page.locator("#sign-out").click();
    await page.locator("#auth-email").waitFor();
    assert.equal(await page.locator(".dock").isVisible(), false);
    await page.locator("#auth-email").fill("b@example.com");
    await page.locator("#auth-password").fill("password123");
    await page.locator("#auth-form button").click();
    await page.getByText("Your first workspace", { exact: true }).waitFor();
    assert.equal(await page.locator("body").getAttribute("data-dark"), "false");
    assert.deepEqual(
      await page.evaluate(() => [
        localStorage.getItem("backendos.workspaces.v1"),
        localStorage.getItem("backendos.preferences.v1"),
      ]),
      ["preserved", "preserved appearance"],
    );
    await page.locator("#sign-out").click();
    await page.locator('[data-auth-mode="reset"]').click();
    await page.locator("#auth-email").fill("a@example.com");
    await page.locator("#auth-form button").click();
    await page.getByText("If the account exists", { exact: false }).waitFor();
    await page.evaluate(() => recover());
    await page.locator("#auth-password").fill("newpassword123");
    await page.locator("#auth-form button").click();
    await page.locator("#sign-out").waitFor();
    assert.ok(
      await page.evaluate(() => calls.some((c) => c[0] === "password")),
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});

test("workspace switching keeps personal homepages and member controls", async () => {
  const server = http.createServer((req, res) => {
    res.setHeader(
      "Content-Type",
      req.url.endsWith(".js") ? "application/javascript" : "text/html",
    );
    res.end(
      req.url === "/client.js"
        ? mock
        : req.url === "/hotel-tax.js"
          ? readFileSync("dist/hotel-tax.js")
          : req.url === "/app.js"
            ? readFileSync("dist/app.js")
            : readFileSync("dist/index.html"),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("http://127.0.0.1:" + server.address().port);
    await page.evaluate(() => {
      tables.workspaces = [
        {
          id: "A",
          name: "Business A",
          business: {},
          enabled_apps: ["documents", "customers"],
        },
        {
          id: "B",
          name: "Business B",
          business: {},
          enabled_apps: ["documents", "customers"],
        },
      ];
      tables.workspace_members = [
        { workspace_id: "A", user_id: "user-a", role: "owner" },
        { workspace_id: "A", user_id: "user-b", role: "member" },
        { workspace_id: "B", user_id: "user-b", role: "owner" },
      ];
      tables.workspace_homes = [
        { workspace_id: "A", user_id: "user-a", shortcuts: ["customers"] },
        { workspace_id: "A", user_id: "user-b", shortcuts: ["documents"] },
        { workspace_id: "B", user_id: "user-b", shortcuts: ["customers"] },
      ];
    });
    await page.locator("#auth-email").fill("b@example.com");
    await page.locator("#auth-password").fill("password123");
    await page.locator("#auth-form button").click();
    await page.locator('[data-open="documents"]').waitFor();
    assert.equal(await page.locator('[data-open="customers"]').count(), 0);
    await page.locator('.dock [data-route="appearance"]').click();
    await page.locator('.settings-nav [data-route="workspace"]').click();
    assert.equal(await page.locator("#business-name").isDisabled(), true);
    assert.equal(await page.locator("#member-form").count(), 0);
    await page.locator("#workspace-switcher").click();
    await page.locator('[data-switch="B"]').click();
    await page.locator('[data-open="customers"]').waitFor();
    assert.equal(await page.locator('[data-open="documents"]').count(), 0);
    await page.locator('.dock [data-route="appearance"]').click();
    await page.locator('.settings-nav [data-route="workspace"]').click();
    assert.equal(await page.locator("#business-name").isDisabled(), false);
    await page.locator("#member-form").waitFor();
    await page.locator('.settings-nav [data-route="account"]').click();
    await page.locator("#sign-out").click();
    await page.locator("#auth-email").fill("a@example.com");
    await page.locator("#auth-password").fill("password123");
    await page.locator("#auth-form button").click();
    await page.locator("#workspace-switcher").waitFor();
    await page.locator("#workspace-switcher").click();
    assert.equal(await page.locator('[data-switch="B"]').count(), 0);
    await page.locator('[data-switch="A"]').click();
    await page.locator('[data-open="customers"]').waitFor();
    assert.equal(await page.locator('[data-open="documents"]').count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});
