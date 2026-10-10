const { test } = require("node:test");
const assert = require("node:assert/strict");
const { chromium } = require("playwright-core");
const { readFileSync } = require("node:fs");
const http = require("node:http");
const mock = require("./helpers/hotel-mock.cjs");
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
          ? readFileSync("dist/app.js")
          : req.url === "/hotel-tax.js"
            ? readFileSync("dist/hotel-tax.js")
            : readFileSync("dist/index.html"),
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

test("calculator cloud CRUD, rates, filters and persistence without Data tools", () =>
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
    assert.equal(
      await page
        .locator(
          ".hotel-data,#hotel-restore-file,[data-hotel=csv],[data-hotel=backup],[data-hotel=restore],[data-hotel=clear]",
        )
        .count(),
      0,
    );
    page.on("dialog", (d) => d.accept());
    await page.locator("#hotel-mode").selectOption("year");
    await page.locator("#hotel-period").fill("2025");
    await page.locator("#hotel-period").dispatchEvent("change");
    await page.waitForFunction(
      () => document.querySelector("#hotel-due").textContent === "$0.00",
    );
    await page.locator("#hotel-period").fill("2026");
    await page.locator("#hotel-period").dispatchEvent("change");
    await page.getByText("Updated group", { exact: true }).waitFor();
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
    await page.getByText("Updated group", { exact: true }).waitFor();
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

test("appearance changes recolor the shell, persist privately and follow system theme", () =>
  harness(async (page) => {
    await page.emulateMedia({ colorScheme: "light" });
    await signin(page, "b@example.com");
    await page.locator('.dock [data-route="appearance"]').click();
    async function idle() {
      await page.waitForFunction(
        () =>
          document.querySelector("main").getAttribute("aria-busy") === "false",
      );
    }
    for (const [name, color] of [
      ["Blue", "rgb(56, 121, 214)"],
      ["Emerald", "rgb(39, 138, 117)"],
      ["Terracotta", "rgb(197, 103, 64)"],
    ]) {
      await page
        .getByRole("button", { name: name + " accent", exact: true })
        .click();
      await idle();
      assert.equal(
        await page
          .locator(".brand-os")
          .evaluate((el) => getComputedStyle(el).color),
        color,
      );
      assert.equal(
        await page
          .locator(".settings-nav button.active")
          .evaluate((el) => getComputedStyle(el).color),
        color,
      );
    }
    await page.emulateMedia({ forcedColors: "active" });
    await page
      .getByText("Your browser is enforcing a contrast palette", {
        exact: false,
      })
      .waitFor();
    await page
      .getByRole("button", { name: "Blue accent", exact: true })
      .click();
    await idle();
    assert.equal(
      await page.evaluate(
        () =>
          tables.user_preferences.find((p) => p.user_id === "user-b").appearance
            .accent,
      ),
      "#3879d6",
    );
    await page.emulateMedia({ forcedColors: "none" });
    await page.waitForFunction(() => !document.querySelector(".notice"));
    assert.equal(
      await page
        .locator(".brand-os")
        .evaluate((el) => getComputedStyle(el).color),
      "rgb(56, 121, 214)",
    );
    await page
      .getByRole("button", { name: "Terracotta accent", exact: true })
      .click();
    await idle();
    await page.locator('[data-pref="theme"][data-value="dark"]').click();
    await idle();
    assert.equal(
      await page
        .locator("html")
        .evaluate((el) => getComputedStyle(el).colorScheme),
      "dark",
    );
    assert.equal(
      await page
        .locator("body")
        .evaluate((el) => getComputedStyle(el).backgroundColor),
      "rgb(21, 23, 34)",
    );
    assert.equal(
      await page.locator("h1").evaluate((el) => getComputedStyle(el).color),
      "rgb(240, 241, 248)",
    );
    assert.equal(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue(
          "--accent-soft",
        ),
      ),
      await page.evaluate(() =>
        getComputedStyle(document.body).getPropertyValue("--accent-soft"),
      ),
    );
    await page.locator('[data-pref="theme"][data-value="light"]').click();
    await idle();
    assert.equal(
      await page
        .locator("html")
        .evaluate((el) => getComputedStyle(el).colorScheme),
      "light",
    );
    assert.equal(
      await page
        .locator("body")
        .evaluate((el) => getComputedStyle(el).backgroundColor),
      "rgb(245, 246, 250)",
    );
    await page.locator('[data-pref="theme"][data-value="system"]').click();
    await idle();
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(
      () => document.documentElement.dataset.dark === "true",
    );
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForFunction(
      () => document.documentElement.dataset.dark === "false",
    );
    await page.locator("#workspace-switcher").click();
    await page.locator('[data-switch="B"]').click();
    assert.equal(
      await page
        .locator(".brand-os")
        .evaluate((el) => getComputedStyle(el).color),
      "rgb(197, 103, 64)",
    );
    const saved = await page.evaluate(() => structuredClone(tables));
    await page.route("**/client.js", (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: mock + "\nObject.assign(tables," + JSON.stringify(saved) + ");",
      }),
    );
    await page.reload();
    await signin(page, "b@example.com");
    assert.equal(
      await page
        .locator(".brand-os")
        .evaluate((el) => getComputedStyle(el).color),
      "rgb(197, 103, 64)",
    );
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(
      () => document.documentElement.dataset.dark === "true",
    );
    await signout(page);
    await signin(page, "a@example.com");
    assert.equal(
      await page.evaluate(
        () =>
          tables.user_preferences.find((p) => p.user_id === "user-a").appearance
            .accent,
      ),
      "#c56740",
    );
  }));

test("usernames save privately and Owners confirm exact matches before membership", () =>
  harness(async (page) => {
    await page.evaluate(() => {
      tables.workspace_members = tables.workspace_members.filter(
        (m) => !(m.workspace_id === "A" && m.user_id === "user-b"),
      );
      tables.user_profiles = [{ user_id: "user-b", username: "bob" }];
    });
    await signin(page, "a@example.com");
    await page.locator('.dock [data-route="appearance"]').click();
    await page.locator('.settings-nav [data-route="account"]').click();
    await page.locator("#account-username").fill("Alice");
    await page.locator("#username-form button").click();
    await page.waitForFunction(() =>
      tables.user_profiles.some(
        (p) => p.user_id === "user-a" && p.username === "alice",
      ),
    );
    await page.waitForFunction(
      () =>
        document.querySelector("main").getAttribute("aria-busy") === "false",
    );
    await page.locator("#account-username").fill("BoB");
    await page.locator("#username-form button").click();
    await page
      .getByText("That username is already taken.", { exact: true })
      .waitFor();
    assert.equal(
      await page.evaluate(
        () => tables.user_profiles.find((p) => p.user_id === "user-a").username,
      ),
      "alice",
    );
    await page.locator('.settings-nav [data-route="workspace"]').click();
    await page.locator("#member-id").fill("bo");
    await page.locator("#member-form button").click();
    await page
      .getByText("No account has that username.", { exact: true })
      .waitFor();
    await page.locator("#member-id").fill("BOB");
    await page.locator("#member-form button").click();
    await page.locator("#confirm-member-form").waitFor();
    assert.equal(
      await page.evaluate(() =>
        tables.workspace_members.some(
          (m) => m.workspace_id === "A" && m.user_id === "user-b",
        ),
      ),
      false,
    );
    // A renamed account invalidates the pending confirmation rather than granting an unintended user access.
    await page.evaluate(
      () =>
        (tables.user_profiles.find((p) => p.user_id === "user-b").username =
          "robert"),
    );
    await page.locator("#confirm-member-form button").click();
    await page
      .getByText("Username changed or was not found. Look it up again.", {
        exact: true,
      })
      .waitFor();
    await page.locator("dialog .close").click();
    await page.locator("#member-id").fill("ROBERT");
    await page.locator("#member-form button").click();
    await page.locator("#confirm-member-form").waitFor();
    await page.locator("#confirm-member-form button").click();
    await page.waitForFunction(() =>
      tables.workspace_members.some(
        (m) =>
          m.workspace_id === "A" &&
          m.user_id === "user-b" &&
          m.role === "member",
      ),
    );
    await page.waitForFunction(
      () =>
        document.querySelector("main").getAttribute("aria-busy") === "false",
    );
    await signout(page);
    await signin(page, "b@example.com");
    await page.locator('.dock [data-route="appearance"]').click();
    await page.locator('.settings-nav [data-route="workspace"]').click();
    assert.equal(await page.locator("#member-form").count(), 0);
    await page.locator('.settings-nav [data-route="account"]').click();
    assert.equal(
      await page.locator("#account-username").inputValue(),
      "robert",
    );
    await page.locator("#account-username").fill("bob_new");
    await page.locator("#username-form button").click();
    await page.waitForFunction(
      () =>
        tables.user_profiles.find((p) => p.user_id === "user-b").username ===
        "bob_new",
    );
    assert.equal(
      await page.evaluate(() =>
        tables.workspace_members.some(
          (m) => m.workspace_id === "A" && m.user_id === "user-b",
        ),
      ),
      true,
    );
  }));

test("accounts can choose a username before joining any workspace", () =>
  harness(async (page) => {
    await page.evaluate(() => {
      tables.workspaces = [];
      tables.workspace_members = [];
      tables.workspace_homes = [];
    });
    await page.locator("#auth-email").fill("a@example.com");
    await page.locator("#auth-password").fill("password123");
    await page.locator("#auth-form button").click();
    await page.getByRole("heading", { name: "Your first workspace" }).waitFor();
    await page.locator("#account-username").fill("new_user");
    await page.locator("#username-form button").click();
    await page.waitForFunction(
      () =>
        tables.user_profiles.find((p) => p.user_id === "user-a")?.username ===
        "new_user",
    );
    await page.waitForFunction(
      () =>
        document.querySelector("main").getAttribute("aria-busy") === "false",
    );
    assert.equal(
      await page.locator("#account-username").inputValue(),
      "new_user",
    );
    assert.equal(await page.locator("#sign-out").count(), 1);
  }));

test("legacy CSV requires Owner preview and confirmation, skips duplicates and optionally imports rates", () =>
  harness(async (page) => {
    await signin(page, "a@example.com");
    await open(page);
    const raw =
      '"Date","Name","Thursday Guests","Weekend Guests","Charged Guests","Free Guests","Actual Guests","Entry Charge"\r\n"2026-10-01","Legacy, group",1.5,2,3,0.5,3.5,1043.40\r\n\r\nThursday Cost,200\r\nWeekend Cost,282\r\nTax Rate,6%\r\nTax Discount,1%\r\n';
    const file = {
      name: "old-tracker.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(raw),
    };
    await page.locator("#hotel-csv-file").setInputFiles(file);
    await page.getByRole("heading", { name: "Preview CSV import" }).waitFor();
    assert.equal(await page.evaluate(() => tables.hotel_tax_entries.length), 0);
    await page.locator('[data-hotel="cancel-csv"]').click();
    assert.equal(await page.locator('[data-hotel="confirm-csv"]').count(), 0);
    await page.locator("#hotel-csv-file").setInputFiles(file);
    await page.locator("#hotel-csv-rates").check();
    await page.evaluate(() => (window.failWrite = true));
    await page.locator('[data-hotel="confirm-csv"]').click();
    await page.getByText("Write denied", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => tables.hotel_tax_entries.length), 0);
    await page.locator('[data-hotel="confirm-csv"]').click();
    await page
      .getByText("1 entries imported; 0 duplicates skipped.", { exact: true })
      .waitFor();
    await page.locator(".hotel-table tbody tr").waitFor();
    assert.equal(await page.locator("#hotel-due").textContent(), "$51.32");
    await page.locator("#hotel-csv-file").setInputFiles(file);
    await page.locator('[data-hotel="confirm-csv"]').click();
    await page
      .getByText("0 entries imported; 1 duplicates skipped.", { exact: true })
      .waitFor();
    assert.equal(await page.evaluate(() => tables.hotel_tax_entries.length), 1);
    assert.equal(
      await page.evaluate(() => tables.hotel_tax_entries[0].workspace_id),
      "A",
    );
    await page
      .locator("#hotel-csv-file")
      .setInputFiles({
        name: "bad.csv",
        mimeType: "text/csv",
        buffer: Buffer.from("wrong,header"),
      });
    await page
      .getByText("Choose the CSV exported by the old Hotel Tax Tracker", {
        exact: false,
      })
      .waitFor();
    assert.equal(await page.locator('[data-hotel="confirm-csv"]').count(), 0);
    await signout(page);
    await signin(page, "b@example.com");
    await open(page);
    assert.equal(await page.locator('[data-hotel="import-csv"]').count(), 0);
    await page.locator("#workspace-switcher").click();
    await page.locator('[data-switch="B"]').click();
    await open(page);
    await page.locator("#hotel-csv-file").setInputFiles(file);
    await page.locator('[data-hotel="confirm-csv"]').click();
    await page
      .getByText("1 entries imported; 0 duplicates skipped.", { exact: true })
      .waitFor();
    assert.equal(
      await page.evaluate(
        () =>
          tables.hotel_tax_entries.filter((e) => e.workspace_id === "B").length,
      ),
      1,
    );
  }));
