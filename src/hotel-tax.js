/* Hotel Tax Calculator: no browser prototype storage is read or imported. */
(() => {
  const defaults = {
    thursday_cost: 319.6,
    weekend_cost: 282,
    tax_rate: 6,
    tax_discount: 1,
  };
  const guestFields = [
    "thursday_guests",
    "weekend_guests",
    "charged_guests",
    "free_guests",
  ];
  const rateFields = Object.keys(defaults);
  const labels = {
    thursday_cost: "Thursday cost",
    weekend_cost: "Weekend cost",
    tax_rate: "Tax rate (%)",
    tax_discount: "Tax discount (%)",
    thursday_guests: "Thursday guests",
    weekend_guests: "Weekend guests",
    charged_guests: "Charged guests",
    free_guests: "Free guests",
  };
  const esc = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const money = (value) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(value);
  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function validateNumbers(value, fields) {
    const result = {};
    for (const field of fields) {
      const raw = value[field];
      const n = Number(raw);
      const max =
        field === "tax_rate" || field === "tax_discount" ? 100 : 1000000;
      if (
        raw === null ||
        raw === undefined ||
        raw === "" ||
        !["number", "string"].includes(typeof raw) ||
        !Number.isFinite(n) ||
        n < 0 ||
        n > max ||
        (guestFields.includes(field) && n % 0.5 !== 0)
      )
        throw Error(`Invalid ${labels[field].toLowerCase()}.`);
      result[field] = n;
    }
    return result;
  }
  function validateEntry(value) {
    const date = value.date;
    if (
      typeof date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      date < "2000-01-01" ||
      date > "2100-12-31" ||
      new Date(date + "T00:00:00Z").toISOString().slice(0, 10) !== date
    )
      throw Error("Enter a valid date between 2000 and 2100.");
    if (
      typeof value.name !== "string" ||
      !value.name.trim() ||
      value.name.trim().length > 200
    )
      throw Error("Enter a guest or group name (up to 200 characters).");
    return {
      date,
      name: value.name.trim(),
      ...validateNumbers(value, guestFields),
    };
  }
  function validateBackup(value) {
    if (
      !value ||
      value.app !== "BackendOS Hotel Tax Calculator" ||
      value.version !== 2 ||
      !Array.isArray(value.entries) ||
      value.entries.length > 10000 ||
      !value.settings ||
      typeof value.settings !== "object"
    )
      throw Error(
        "Choose a BackendOS Hotel Tax Calculator v2 backup. Prototype backups are not imported.",
      );
    return {
      app: value.app,
      version: 2,
      settings: validateNumbers(value.settings, rateFields),
      entries: value.entries.map(validateEntry),
    };
  }
  function summarize(entries, settings) {
    const totals = Object.fromEntries(
      guestFields.map((f) => [
        f,
        entries.reduce((sum, e) => sum + Number(e[f]), 0),
      ]),
    );
    totals.actual_guests = totals.charged_guests + totals.free_guests;
    totals.charge =
      totals.thursday_guests * settings.thursday_cost +
      totals.weekend_guests * settings.weekend_cost;
    totals.tax = (totals.charge * settings.tax_rate) / 100;
    totals.discount = (totals.tax * settings.tax_discount) / 100;
    totals.due = totals.tax - totals.discount;
    return totals;
  }
  // v5's "Year to Date" includes every entry in the selected calendar year.
  function visible(entries, mode, period) {
    return entries
      .filter((e) => e.date.startsWith(mode === "year" ? period + "-" : period))
      .sort(
        (a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name),
      );
  }
  function csv(entries, settings) {
    const t = summarize(entries, settings);
    const rows = [
      [
        "Date",
        "Name",
        "Thursday Guests",
        "Weekend Guests",
        "Charged Guests",
        "Free Guests",
        "Actual Guests",
        "Entry Charge",
      ],
      ...entries.map((e) => [
        e.date,
        e.name,
        ...guestFields.map((f) => e[f]),
        Number(e.charged_guests) + Number(e.free_guests),
        (
          e.thursday_guests * settings.thursday_cost +
          e.weekend_guests * settings.weekend_cost
        ).toFixed(2),
      ]),
      [],
      ...rateFields.map((f) => [labels[f], settings[f]]),
      ...Object.entries(t).map(([f, v]) => [
        f,
        ["charge", "tax", "discount", "due"].includes(f) ? v.toFixed(2) : v,
      ]),
    ];
    // Quoting alone does not prevent spreadsheet formula execution.
    return rows
      .map((row) =>
        row
          .map((v) => {
            let s = String(v);
            if (/^[\s]*[=+@-]/.test(s)) s = "'" + s;
            return '"' + s.replaceAll('"', '""') + '"';
          })
          .join(","),
      )
      .join("\r\n");
  }
  function create({ db, root, context, toast, setWriting }) {
    let data = null,
      error = "",
      loading = false,
      settingsOpen = false,
      editor = null;
    let mode = "month",
      month = today().slice(0, 7),
      year = month.slice(0, 4),
      generation = 0,
      controller = null;
    const check = (result) => {
      if (result.error) throw Error(result.error.message);
      return result.data;
    };
    function cancel() {
      generation++;
      controller?.abort();
      controller = null;
      data = null;
      error = "";
      loading = false;
      settingsOpen = false;
      editor = null;
    }
    function isCurrent(c, version) {
      const now = context();
      return (
        generation === version &&
        now?.workspaceId === c.workspaceId &&
        now?.userId === c.userId
      );
    }
    async function fetchData(c, signal) {
      // PostgREST's default response cap is 1000; never calculate from a truncated list.
      const workspace = check(
        await db
          .from("workspaces")
          .select("id,enabled_apps")
          .eq("id", c.workspaceId)
          .maybeSingle()
          .abortSignal(signal),
      );
      if (!workspace || !workspace.enabled_apps.includes("tax-tracker"))
        throw Error(
          "This calculator is unavailable. Your membership may have changed or the app may be disabled.",
        );
      const entries = [];
      const settings = check(
        await db
          .from("hotel_tax_settings")
          .select("*")
          .eq("workspace_id", c.workspaceId)
          .maybeSingle()
          .abortSignal(signal),
      );
      for (let offset = 0; ; offset += 500) {
        const rows = check(
          await db
            .from("hotel_tax_entries")
            .select("*")
            .eq("workspace_id", c.workspaceId)
            .order("date")
            .order("id")
            .range(offset, offset + 499)
            .abortSignal(signal),
        );
        entries.push(...rows);
        if (rows.length < 500) break;
      }
      return {
        settings: settings
          ? validateNumbers(settings, rateFields)
          : { ...defaults },
        entries,
        settingsSaved: !!settings,
      };
    }
    async function load() {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal,
        version = ++generation,
        c = context();
      if (!c) return;
      loading = true;
      error = "";
      data = null;
      draw();
      try {
        const result = await fetchData(c, signal);
        if (isCurrent(c, version)) data = result;
      } catch (e) {
        if (isCurrent(c, version)) error = e.message;
      } finally {
        if (isCurrent(c, version)) {
          loading = false;
          draw();
        }
      }
    }
    function inputs(fields, values, disabled = false) {
      return fields
        .map(
          (f) =>
            `<div><label class="form-label" for="hotel-${f}">${labels[f]}</label><input id="hotel-${f}" name="${f}" type="number" required min="0" max="${f === "tax_rate" || f === "tax_discount" ? 100 : 1000000}" step="${guestFields.includes(f) ? ".5" : "any"}" value="${esc(values[f])}" ${disabled ? "disabled" : ""}></div>`,
        )
        .join("");
    }
    function draw() {
      const c = context();
      if (!c) return;
      const owner = c.role === "owner";
      const header = `<div class="topline"><div><div class="eyebrow">Mini App · ${esc(c.workspaceName)}</div><h1>Hotel Tax Calculator</h1><p>Guest entries in, hotel tax worked out.</p></div><div class="top-actions"><button class="btn" data-route="home">Back to home</button><button class="btn" data-hotel="settings" aria-expanded="${settingsOpen}">Settings</button></div></div>`;
      if (loading || !data) {
        root.innerHTML =
          header +
          `<section class="panel hotel-space" role="status">${loading ? "Loading entries…" : `<p role="alert">${esc(error || "Unable to load calculator.")}</p><button class="btn" data-hotel="retry">Retry</button>`}</section>`;
        return;
      }
      const rows = visible(data.entries, mode, mode === "year" ? year : month),
        t = summarize(rows, data.settings);
      root.innerHTML =
        header +
        `
      ${settingsOpen ? `<section class="panel hotel-space"><h2>Rates & settings</h2><p>These workspace rates apply to all entries, including previous periods. ${owner ? "" : "Only the Owner can change rates."}</p><form id="hotel-settings-form"><div class="form-grid hotel-space">${inputs(rateFields, data.settings, !owner)}</div>${owner ? '<button class="btn primary hotel-space" type="submit">Save rates</button>' : ""}</form></section>` : ""}
      <section class="hotel-toolbar hotel-space" aria-label="Period and data actions"><div><label class="form-label" for="hotel-mode">View</label><select id="hotel-mode"><option value="month" ${mode === "month" ? "selected" : ""}>Month</option><option value="year" ${mode === "year" ? "selected" : ""}>Year to Date</option></select></div><div><label class="form-label" for="hotel-period">${mode === "year" ? "Year" : "Month"}</label><input id="hotel-period" type="${mode === "year" ? "number" : "month"}" ${mode === "year" ? 'min="2000" max="2100" step="1"' : 'min="2000-01" max="2100-12"'} value="${esc(mode === "year" ? year : month)}" required></div><button class="btn" data-hotel="refresh">Refresh</button><details class="hotel-data"><summary class="btn">Data tools</summary><div class="hotel-data-menu"><button class="btn" data-hotel="csv">Export current view (CSV)</button><button class="btn" data-hotel="backup">Backup workspace data</button>${owner ? '<button class="btn" data-hotel="restore">Restore BackendOS backup</button><button class="btn" data-hotel="clear">Clear current view</button>' : "<p>Ask the Owner to restore or clear data.</p>"}</div></details></section>
      <div class="hotel-summary hotel-space"><section class="panel hotel-due"><p>Tax due after discount</p><strong id="hotel-due">${money(t.due)}</strong><p>${data.settings.tax_rate}% tax · ${data.settings.tax_discount}% discount on tax</p></section><section class="panel"><p>Total amount charged</p><strong>${money(t.charge)}</strong><p>Thursday ${money(data.settings.thursday_cost)} · Weekend ${money(data.settings.weekend_cost)}</p></section><section class="panel"><p>Tax before discount</p><strong>${money(t.tax)}</strong><p>Discount ${money(t.discount)}</p></section></div>
      <div class="hotel-guests hotel-space">${[...guestFields, "actual_guests"].map((f) => `<div><span>${labels[f] || "Actual guests"}</span><strong>${t[f]}</strong></div>`).join("")}</div>
      <section class="panel hotel-space"><div class="panel-title"><h2>Guest entries · ${esc(mode === "year" ? year + " Year to Date" : month)}</h2><button class="btn primary" data-hotel="add">Add entry</button></div>${mode === "year" ? "<p>Includes all entries in the selected calendar year, matching the original app.</p>" : ""}
      ${editor ? `<form id="hotel-entry-form" class="hotel-space"><h3>${editor.id ? "Edit entry" : "Add guest entry"}</h3><div class="form-grid"><div><label class="form-label" for="hotel-date">Date</label><input id="hotel-date" name="date" type="date" min="2000-01-01" max="2100-12-31" required value="${esc(editor.date)}"></div><div><label class="form-label" for="hotel-name">Guest or group name</label><input id="hotel-name" name="name" maxlength="200" required value="${esc(editor.name)}"></div>${inputs(guestFields, editor)}</div><div class="top-actions"><button class="btn primary" type="submit">${editor.id ? "Save entry" : "Add guest entry"}</button><button class="btn" data-hotel="cancel" type="button">Cancel</button></div><p class="form-error" role="alert"></p></form>` : ""}
      <div class="hotel-table" tabindex="0" role="region" aria-label="Guest entries, scroll horizontally for all columns"><table><thead><tr><th scope="col">Date</th><th scope="col">Name</th><th scope="col">Thursday</th><th scope="col">Weekend</th><th scope="col">Charged</th><th scope="col">Free</th><th scope="col">Actual</th><th scope="col">Entry charge</th><th scope="col">Actions</th></tr></thead><tbody>${rows.map((e) => `<tr><td>${esc(e.date)}</td><td>${esc(e.name)}</td>${guestFields.map((f) => `<td>${esc(e[f])}</td>`).join("")}<td>${Number(e.charged_guests) + Number(e.free_guests)}</td><td>${money(e.thursday_guests * data.settings.thursday_cost + e.weekend_guests * data.settings.weekend_cost)}</td><td><div class="hotel-actions"><button class="btn" data-hotel="edit" data-entry="${esc(e.id)}">Edit</button>${owner ? `<button class="btn" data-hotel="delete" data-entry="${esc(e.id)}">Delete</button>` : ""}</div></td></tr>`).join("")}</tbody></table></div>${rows.length ? "" : '<p class="hotel-space">No guest entries for this period. Add an entry to get started.</p>'}</section>
      <input id="hotel-restore-file" type="file" accept=".json,application/json" hidden><p class="hotel-space">Saved to this workspace. Members can add and edit entries; the Owner manages rates, deletes, clears, and restores.</p>`;
    }
    async function write(fn, message, onSuccess) {
      const c = context(),
        version = generation;
      if (!c) return;
      setWriting(true);
      try {
        await fn(c);
        if (isCurrent(c, version)) {
          onSuccess?.();
          toast(message);
          editor = null;
          await load();
        }
      } catch (e) {
        if (isCurrent(c, version)) {
          toast(e.message);
          const field = root.querySelector("#hotel-entry-form .form-error");
          if (field) field.textContent = e.message;
        }
      } finally {
        setWriting(false);
      }
    }
    function download(content, type, name) {
      const url = URL.createObjectURL(new Blob([content], { type }));
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    root.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-hotel]");
      if (!b || !context()) return;
      const action = b.dataset.hotel;
      try {
        if (action === "retry" || action === "refresh") {
          editor = null;
          await load();
          return;
        }
        if (!data) return;
        if (action === "settings") {
          settingsOpen = !settingsOpen;
          draw();
        }
        if (action === "add") {
          editor = {
            date: today(),
            name: "",
            ...Object.fromEntries(guestFields.map((f) => [f, 0])),
          };
          draw();
          root.querySelector("#hotel-name").focus();
        }
        if (action === "cancel") {
          editor = null;
          draw();
        }
        if (action === "edit") {
          editor = { ...data.entries.find((x) => x.id === b.dataset.entry) };
          draw();
          root.querySelector("#hotel-name").focus();
        }
        if (action === "delete") {
          if (context().role !== "owner")
            throw Error("Only the Owner can delete entries.");
          if (confirm("Delete this guest entry?"))
            await write(
              (c) =>
                db
                  .from("hotel_tax_entries")
                  .delete()
                  .eq("workspace_id", c.workspaceId)
                  .eq("id", b.dataset.entry)
                  .select("id")
                  .then((r) => {
                    if (check(r).length !== 1)
                      throw Error(
                        "Entry could not be deleted. Refresh and check your access.",
                      );
                  }),
              "Entry deleted",
            );
        }
        if (action === "clear") {
          if (context().role !== "owner")
            throw Error("Only the Owner can clear entries.");
          const period = mode === "year" ? year : month,
            rows = visible(data.entries, mode, period);
          if (!rows.length) {
            toast("No entries to clear.");
            return;
          }
          if (
            confirm(
              `Clear all ${rows.length} entries for ${period}? This cannot be undone.`,
            )
          )
            await write(async (c) => {
              const start = mode === "year" ? `${year}-01-01` : `${month}-01`;
              let end;
              if (mode === "year") end = `${Number(year) + 1}-01-01`;
              else {
                const [y, m] = month.split("-").map(Number);
                end = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01`;
              }
              const removed = check(
                await db
                  .from("hotel_tax_entries")
                  .delete()
                  .eq("workspace_id", c.workspaceId)
                  .gte("date", start)
                  .lt("date", end)
                  .select("id"),
              );
              if (!removed.length)
                throw Error(
                  "No entries deleted. Refresh and check your access.",
                );
            }, "Current view cleared");
        }
        if (action === "csv")
          download(
            csv(
              visible(data.entries, mode, mode === "year" ? year : month),
              data.settings,
            ),
            "text/csv",
            `hotel-tax-${mode === "year" ? year : month}.csv`,
          );
        if (action === "backup") {
          const c = context(),
            version = generation;
          setWriting(true);
          try {
            const fresh = await fetchData(c, controller.signal);
            if (isCurrent(c, version))
              download(
                JSON.stringify(
                  {
                    app: "BackendOS Hotel Tax Calculator",
                    version: 2,
                    exportedAt: new Date().toISOString(),
                    settings: fresh.settings,
                    entries: fresh.entries.map(validateEntry),
                  },
                  null,
                  2,
                ),
                "application/json",
                `hotel-tax-backup-${today()}.json`,
              );
          } finally {
            setWriting(false);
          }
        }
        if (action === "restore") {
          if (context().role !== "owner")
            throw Error("Only the Owner can restore data.");
          root.querySelector("#hotel-restore-file").click();
        }
      } catch (e) {
        toast(e.message);
      }
    });
    root.addEventListener("submit", async (e) => {
      if (!e.target.matches("#hotel-entry-form,#hotel-settings-form")) return;
      e.preventDefault();
      if (!data || !context()) return;
      const values = Object.fromEntries(new FormData(e.target));
      try {
        if (e.target.id === "hotel-settings-form") {
          if (context().role !== "owner")
            throw Error("Only the Owner can change rates.");
          const settings = validateNumbers(values, rateFields);
          await write(async (c) => {
            check(
              await (
                data.settingsSaved
                  ? db
                      .from("hotel_tax_settings")
                      .update(settings)
                      .eq("workspace_id", c.workspaceId)
                  : db
                      .from("hotel_tax_settings")
                      .insert({ workspace_id: c.workspaceId, ...settings })
              )
                .select("*")
                .single(),
            );
          }, "Rates saved");
        } else {
          const entry = validateEntry(values),
            id = editor?.id;
          await write(
            async (c) => {
              const q = id
                ? db
                    .from("hotel_tax_entries")
                    .update(entry)
                    .eq("workspace_id", c.workspaceId)
                    .eq("id", id)
                : db
                    .from("hotel_tax_entries")
                    .insert({ workspace_id: c.workspaceId, ...entry });
              check(await q.select("*").single());
            },
            "Entry saved",
            () => {
              month = entry.date.slice(0, 7);
              year = month.slice(0, 4);
            },
          );
        }
      } catch (e) {
        toast(e.message);
      }
    });
    root.addEventListener("change", async (e) => {
      if (!context()) return;
      if (e.target.id === "hotel-mode") {
        mode = e.target.value;
        editor = null;
        draw();
      }
      if (e.target.id === "hotel-period") {
        if (!e.target.validity.valid || !e.target.value) return;
        if (mode === "year") year = e.target.value;
        else {
          month = e.target.value;
          year = month.slice(0, 4);
        }
        editor = null;
        draw();
      }
      if (e.target.id === "hotel-restore-file") {
        const file = e.target.files[0],
          c = context(),
          version = generation;
        if (!file) return;
        try {
          if (c.role !== "owner")
            throw Error("Only the Owner can restore data.");
          if (file.size > 10 * 1024 * 1024)
            throw Error("Backup must be smaller than 10 MB.");
          const backup = validateBackup(JSON.parse(await file.text()));
          if (!isCurrent(c, version)) return;
          if (
            confirm(
              `Replace all entries and rates in ${c.workspaceName} with ${backup.entries.length} backed-up entries? This cannot be undone.`,
            )
          )
            await write(
              async (current) =>
                check(
                  await db.rpc("restore_hotel_tax", {
                    target_workspace: current.workspaceId,
                    backup,
                  }),
                ),
              "Backup restored",
            );
        } catch (e) {
          if (isCurrent(c, version)) toast(e.message);
        } finally {
          if (isCurrent(c, version)) e.target.value = "";
        }
      }
    });
    return { draw, load, cancel };
  }
  const api = {
    create,
    defaults,
    validateEntry,
    validateBackup,
    summarize,
    visible,
    csv,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else window.HotelTax = api;
})();
