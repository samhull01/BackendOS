const { test } = require("node:test");
const assert = require("node:assert/strict");
const { chromium } = require("playwright-core");
const { readFileSync } = require("node:fs");
const http = require("node:http");
const mock = require("./helpers/hotel-mock.cjs");
const defaults = require("../src/hotel-tax.js").defaults;
async function harness(fn) {
  const server = http.createServer((req, res) => {
    res.setHeader(
      "Content-Type",
      req.url.endsWith(".js") ? "application/javascript" : "text/html",
    );
    res.end(
      req.url === "/client.js"
        ? mock
        : req.url === "/app.js"
          ? readFileSync("src/app.js")
          : req.url === "/hotel-tax.js"
            ? readFileSync("src/hotel-tax.js")
            : readFileSync("index.html"),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    page.setDefaultTimeout(6000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      localStorage.setItem("hotelTaxTrackerEntriesV1", "prototype preserved");
      localStorage.setItem("hotelTaxTrackerSettingsV1", "rates preserved");
    });
    await page.goto("http://127.0.0.1:" + server.address().port);
    await fn(page);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}
async function signin(page, email) {
  await page.evaluate(() => history.replaceState(null, "", "#home"));
  await page.locator("#auth-email").fill(email);
  await page.locator("#auth-password").fill("password123");
  await page.locator("#auth-form button").click();
  await page.getByRole("heading", { name: "Welcome home." }).waitFor();
}
async function open(page) {
  await page.locator('[data-open="tax-tracker"]').click();
  await page.locator("#hotel-due").waitFor();
}
async function signout(page) {
  await page.locator('.dock [data-route="appearance"]').click();
  await page.locator('.settings-nav [data-route="account"]').click();
  await page.locator("#sign-out").click();
  await page.locator("#auth-email").waitFor();
}
async function downloadText(download) {
  return readFileSync(await download.path(), "utf8");
}
test("calculator CRUD, rates, exports, safe restore, filters and persistence in the shell", () =>
  harness(async (page) => {
    await signin(page, "a@example.com");
    await open(page);
    assert.equal(await page.locator("#hotel-settings-form").count(), 0);
    assert.equal(await page.locator("body").getAttribute("data-dark"), "true");
    assert.equal(await page.locator("#hotel-due").textContent(), "$0.00");
    assert.equal(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--accent")
          .trim(),
      ),
      "#c56740",
    );
    await page.locator('[data-hotel="add"]').click();
    await page.locator("#hotel-date").fill("2026-10-07");
    await page.locator("#hotel-name").fill("Group <one>");
    for (const [field, v] of Object.entries({
      thursday_guests: "1.5",
      weekend_guests: "2",
      charged_guests: "3",
      free_guests: ".5",
    }))
      await page.locator("#hotel-" + field).fill(v);
    await page.locator('#hotel-entry-form button[type="submit"]').click();
    await page.getByText("Group <one>", { exact: true }).waitFor();
    assert.equal(await page.locator("#hotel-due").textContent(), "$61.98");
    await page.locator('[data-hotel="settings"]').click();
    await page.locator("#hotel-thursday_cost").fill("200");
    await page.locator("#hotel-settings-form button").click();
    await page.waitForFunction(
      () => tables.hotel_tax_settings[0]?.thursday_cost === 200,
    );
    await page.waitForFunction(
      () => document.querySelector("#hotel-due")?.textContent === "$51.32",
    );
    await page.locator("#hotel-settings-form button").click();
    await page.waitForFunction(() =>
      calls.some((c) => c.table === "hotel_tax_settings" && c.op === "update"),
    );
    await page.waitForFunction(
      () =>
        document.querySelector("main").getAttribute("aria-busy") === "false",
    );
    await page.locator('[data-hotel="edit"]').click();
    await page.locator("#hotel-name").fill("Updated group");
    await page.evaluate(() => (window.failWrite = true));
    await page.locator('#hotel-entry-form button[type="submit"]').click();
    await page
      .locator("#hotel-entry-form .form-error")
      .getByText("Write denied")
      .waitFor();
    assert.equal(
      await page.evaluate(() => tables.hotel_tax_entries[0].name),
      "Group <one>",
    );
    await page.locator('#hotel-entry-form button[type="submit"]').click();
    await page.getByText("Updated group", { exact: true }).waitFor();
    await page.locator(".hotel-data summary").click();
    let waiting = page.waitForEvent("download");
    await page.locator('[data-hotel="csv"]').click();
    const csv = await downloadText(await waiting);
    assert.ok(csv.includes("Updated group"));
    assert.ok(csv.includes('"due","51.32"'));
    waiting = page.waitForEvent("download");
    await page.locator('[data-hotel="backup"]').click();
    const backup = JSON.parse(await downloadText(await waiting));
    assert.equal(backup.app, "BackendOS Hotel Tax Calculator");
    assert.equal(backup.entries.length, 1);
    assert.equal(backup.entries[0].workspace_id, undefined);
    page.on("dialog", (d) => d.accept());
    await page.locator("#hotel-restore-file").setInputFiles({
      name: "prototype.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          app: "Hotel Tax Tracker",
          version: 1,
          entries: [],
          settings: defaults,
        }),
      ),
    });
    await page
      .getByText(
        "Choose a BackendOS Hotel Tax Calculator v2 backup. Prototype backups are not imported.",
        { exact: true },
      )
      .waitFor();
    assert.equal(
      await page.evaluate(
        () => calls.filter((c) => c.name === "restore_hotel_tax").length,
      ),
      0,
    );
    await page.locator("#hotel-restore-file").setInputFiles({
      name: "backup.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          ...backup,
          entries: [{ ...backup.entries[0], name: "Restored group" }],
        }),
      ),
    });
    await page.getByText("Restored group", { exact: true }).waitFor();
    await page.locator("#hotel-mode").selectOption("year");
    await page.locator("#hotel-period").fill("2025");
    await page.locator("#hotel-period").dispatchEvent("change");
    await page.waitForFunction(
      () => document.querySelector("#hotel-due").textContent === "$0.00",
    );
    await page.locator("#hotel-period").fill("2026");
    await page.locator("#hotel-period").dispatchEvent("change");
    await page.getByText("Restored group", { exact: true }).waitFor();
    const persisted = await page.evaluate(() => structuredClone(tables));
    await page.route("**/client.js", (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body:
          mock + "\nObject.assign(tables," + JSON.stringify(persisted) + ");",
      }),
    );
    await page.reload();
    await signin(page, "a@example.com");
    await open(page);
    await page.getByText("Restored group", { exact: true }).waitFor();
    await page.screenshot({
      path: "/tmp/hotel-tax-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: "/tmp/hotel-tax-mobile.png",
      fullPage: true,
    });
    await page.locator('[data-hotel="delete"]').click();
    await page
      .getByText(
        "No guest entries for this period. Add an entry to get started.",
        { exact: true },
      )
      .waitFor();
    await page.evaluate(() => {
      tables.hotel_tax_entries.push(
        ...["2026-10-01", "2026-11-01"].map((date, i) => ({
          id: "clear" + i,
          workspace_id: "A",
          date,
          name: "Clear test " + i,
          thursday_guests: 1,
          weekend_guests: 0,
          charged_guests: 1,
          free_guests: 0,
        })),
      );
    });
    await page.locator('[data-hotel="refresh"]').click();
    await page.getByText("Clear test 0", { exact: true }).waitFor();
    await page.locator(".hotel-data summary").click();
    await page.locator('[data-hotel="clear"]').click();
    await page
      .getByText(
        "No guest entries for this period. Add an entry to get started.",
        { exact: true },
      )
      .waitFor();
    assert.deepEqual(
      await page.evaluate(() => tables.hotel_tax_entries.map((e) => e.date)),
      ["2026-11-01"],
    );
    await page.locator("#hotel-mode").selectOption("year");
    await page.getByText("Clear test 1", { exact: true }).waitFor();
    await page.locator(".hotel-data summary").click();
    await page.locator('[data-hotel="clear"]').click();
    await page
      .getByText(
        "No guest entries for this period. Add an entry to get started.",
        { exact: true },
      )
      .waitFor();
    assert.deepEqual(
      await page.evaluate(() => [
        localStorage.getItem("hotelTaxTrackerEntriesV1"),
        localStorage.getItem("hotelTaxTrackerSettingsV1"),
      ]),
      ["prototype preserved", "rates preserved"],
    );
  }));
test("two accounts/workspaces, Member controls, failed loads and stale response cancellation", () =>
  harness(async (page) => {
    await page.evaluate(() => {
      tables.hotel_tax_entries = [
        {
          id: "a-entry",
          workspace_id: "A",
          date: "2026-10-07",
          name: "A private group",
          thursday_guests: 1,
          weekend_guests: 0,
          charged_guests: 1,
          free_guests: 0,
        },
        {
          id: "b-entry",
          workspace_id: "B",
          date: "2026-10-07",
          name: "B private group",
          thursday_guests: 0,
          weekend_guests: 1,
          charged_guests: 1,
          free_guests: 0,
        },
      ];
    });
    await signin(page, "b@example.com");
    await open(page);
    await page.getByText("A private group", { exact: true }).waitFor();
    assert.equal(
      await page.getByText("B private group", { exact: true }).count(),
      0,
    );
    await page.locator('[data-hotel="settings"]').click();
    assert.equal(await page.locator("#hotel-thursday_cost").isDisabled(), true);
    assert.equal(await page.locator('[data-hotel="delete"]').count(), 0);
    assert.equal(await page.locator('[data-hotel="clear"]').count(), 0);
    assert.equal(await page.locator('[data-hotel="restore"]').count(), 0);
    await page.locator('[data-hotel="edit"]').click();
    await page.locator("#hotel-name").fill("Member update");
    await page.locator('#hotel-entry-form button[type="submit"]').click();
    await page.getByText("Member update", { exact: true }).waitFor();
    await page.evaluate(() => (window.delayEntries = 400));
    await page.locator('[data-hotel="refresh"]').click();
    await page.locator("#workspace-switcher").click();
    await page.locator('[data-switch="B"]').click();
    await open(page);
    await page.getByText("B private group", { exact: true }).waitFor();
    assert.equal(
      await page.getByText("Member update", { exact: true }).count(),
      0,
    );
    await page.evaluate(() => {
      window.delayEntries = 0;
      window.failLoad = true;
    });
    await page.locator('[data-hotel="refresh"]').click();
    await page.getByText("Load denied", { exact: true }).waitFor();
    assert.equal(await page.locator("#hotel-due").count(), 0);
    await page.locator('[data-hotel="retry"]').click();
    await page.getByText("B private group", { exact: true }).waitFor();
    await page.locator('[data-hotel="settings"]').click();
    assert.equal(
      await page.locator("#hotel-thursday_cost").isDisabled(),
      false,
    );
    await signout(page);
    await signin(page, "a@example.com");
    await open(page);
    await page.getByText("Member update", { exact: true }).waitFor();
    assert.equal(
      await page.getByText("B private group", { exact: true }).count(),
      0,
    );
    await page.locator("#workspace-switcher").click();
    assert.equal(await page.locator('[data-switch="B"]').count(), 0);
    await page.locator("dialog .close").click();
    // Membership revocation is detected by the next calculator refresh.
    await page.evaluate(() => {
      tables.workspace_members = tables.workspace_members.filter(
        (m) => m.user_id !== "user-a",
      );
    });
    await page.locator('[data-hotel="refresh"]').click();
    await page
      .getByText(
        "This calculator is unavailable. Your membership may have changed or the app may be disabled.",
        { exact: true },
      )
      .waitFor();
    assert.equal(await page.locator("#hotel-due").count(), 0);
  }));
test("pagination includes entries beyond the Data API default cap", () =>
  harness(async (page) => {
    await page.evaluate(() => {
      tables.hotel_tax_entries = Array.from({ length: 1001 }, (_, i) => ({
        id: "e" + i,
        workspace_id: "A",
        date: "2026-10-07",
        name: "Guest " + i,
        thursday_guests: 1,
        weekend_guests: 0,
        charged_guests: 1,
        free_guests: 0,
      }));
    });
    await signin(page, "a@example.com");
    await open(page);
    assert.equal(await page.locator(".hotel-table tbody tr").count(), 1001);
    assert.equal(await page.locator("#hotel-due").textContent(), "$19,003.22");
  }));
