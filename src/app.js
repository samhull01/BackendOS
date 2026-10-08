const db = window.supabaseClient;
let writing = false;
function setWriting(value) {
  writing = value;
  document.querySelector("main").setAttribute("aria-busy", String(value));
}
for (const event of ["click", "submit", "change"])
  document.addEventListener(
    event,
    (e) => {
      if (writing) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );

const WorkspaceStore = (() => {
  let user = {},
    state = { workspaces: [], members: [], homes: [], activeWorkspaceId: null },
    pending = Promise.resolve(),
    loadEpoch = 0;
  const appIds = ["reservations", "customers", "tax-tracker", "documents"];
  const check = ({ data, error }) => {
    if (error) throw error;
    return data;
  };
  const queue = (fn) => {
    setWriting(true);
    pending = pending.then(fn);
  };
  async function initialize(session) {
    const epoch = ++loadEpoch;
    const loadedUser = { id: session.user.id, name: session.user.email };
    const [ws, ms, hs, ps, profiles, ownProfile] = await Promise.all([
      db.from("workspaces").select("*"),
      db.from("workspace_members").select("*"),
      db.from("workspace_homes").select("*"),
      db
        .from("user_preferences")
        .select("*")
        .eq("user_id", loadedUser.id)
        .maybeSingle(),
      db.from("user_profiles").select("*"),
      db.from("user_profiles").select("*").eq("user_id", loadedUser.id),
    ]);
    if (epoch !== loadEpoch) return;
    const profileRows = check(profiles);
    user = {
      ...loadedUser,
      username: check(ownProfile)[0]?.username || "",
    };
    state.workspaces = check(ws).map((w) => ({
      ...w,
      enabledApps: w.enabled_apps,
    }));
    state.members = check(ms).map((m) => ({
      ...m,
      workspaceId: m.workspace_id,
      userId: m.user_id,
      name:
        profileRows.find((p) => p.user_id === m.user_id)?.username ||
        (m.user_id === user.id ? user.name : m.user_id),
    }));
    state.homes = check(hs).map((h) => ({
      ...h,
      workspaceId: h.workspace_id,
      userId: h.user_id,
    }));
    const previous = state.activeWorkspaceId;
    state.activeWorkspaceId = state.workspaces.some((w) => w.id === previous)
      ? previous
      : state.workspaces[0]?.id;
    const saved = check(ps)?.appearance || {};
    for (const k of ["theme", "accent", "wallpaper", "density", "layout"]) {
      const allowed = {
        theme: ["light", "dark", "system"],
        accent: accentColors.map(([color]) => color),
        wallpaper: ["glow", "plain"],
        density: ["detailed", "compact"],
        layout: ["grid", "list"],
      };
      prefs[k] = allowed[k].includes(saved[k]) ? saved[k] : defaults[k];
    }
  }
  const active = () =>
    state.workspaces.find((w) => w.id === state.activeWorkspaceId);
  const role = (wid = state.activeWorkspaceId) =>
    state.members.find((m) => m.workspaceId === wid && m.userId === user.id)
      ?.role;
  const owner = () => {
    if (role() !== "owner")
      throw Error("Only owners can manage this workspace.");
  };
  const shortcuts = () =>
    state.homes.find(
      (h) => h.workspaceId === state.activeWorkspaceId && h.userId === user.id,
    )?.shortcuts || [...appIds];
  function setShortcuts(ids) {
    const wid = state.activeWorkspaceId;
    const row = {
      workspaceId: wid,
      userId: user.id,
      shortcuts: [...new Set(ids)].filter((v) => appIds.includes(v)),
    };
    state.homes = state.homes.filter((h) => h.workspaceId !== wid);
    state.homes.push(row);
    queue(async () =>
      check(
        await db.from("workspace_homes").upsert({
          workspace_id: wid,
          user_id: user.id,
          shortcuts: row.shortcuts,
        }),
      ),
    );
  }
  async function create(name) {
    setWriting(true);
    try {
      const wid = check(
        await db.rpc("create_workspace", { workspace_name: name }),
      );
      await initialize({ user: { id: user.id, email: user.name } });
      return wid;
    } finally {
      setWriting(false);
    }
  }
  function updateBusiness(values) {
    owner();
    const w = active();
    w.name = values.name.trim();
    w.business = {
      email: values.email,
      phone: values.phone,
      address: values.address,
    };
    queue(async () =>
      check(
        await db
          .from("workspaces")
          .update({ name: w.name, business: w.business })
          .eq("id", w.id)
          .select()
          .single(),
      ),
    );
  }
  function enableApp(id, enabled) {
    owner();
    const w = active();
    w.enabledApps = enabled
      ? [...new Set([...w.enabledApps, id])]
      : w.enabledApps.filter((a) => a !== id);
    queue(async () =>
      check(
        await db
          .from("workspaces")
          .update({ enabled_apps: w.enabledApps })
          .eq("id", w.id)
          .select()
          .single(),
      ),
    );
  }
  async function flush() {
    const task = pending;
    pending = Promise.resolve();
    try {
      await task;
    } catch (e) {
      await initialize({ user: { id: user.id, email: user.name } });
      throw e;
    } finally {
      setWriting(false);
    }
  }
  function saveAppearance() {
    const uid = user.id;
    const appearance = Object.fromEntries(
      ["theme", "accent", "wallpaper", "density", "layout"].map((k) => [
        k,
        prefs[k],
      ]),
    );
    queue(async () =>
      check(
        await db.from("user_preferences").upsert({ user_id: uid, appearance }),
      ),
    );
  }
  async function addMember(id) {
    setWriting(true);
    try {
      owner();
      check(
        await db
          .from("workspace_members")
          .insert({ workspace_id: active().id, user_id: id, role: "member" }),
      );
      await initialize({ user: { id: user.id, email: user.name } });
    } finally {
      setWriting(false);
    }
  }
  async function setUsername(value) {
    const username = value.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]{2,29}$/.test(username))
      throw Error(
        "Use 3–30 characters: start with a letter, then letters, numbers, or underscores.",
      );
    setWriting(true);
    try {
      const q = user.username
        ? db.from("user_profiles").update({ username }).eq("user_id", user.id)
        : db.from("user_profiles").insert({ user_id: user.id, username });
      const result = await q.select("*").single();
      if (result.error?.code === "23505")
        throw Error("That username is already taken.");
      check(result);
      await initialize({ user: { id: user.id, email: user.name } });
    } finally {
      setWriting(false);
    }
  }
  async function removeMember(id) {
    setWriting(true);
    try {
      owner();
      check(
        await db
          .from("workspace_members")
          .delete()
          .eq("workspace_id", active().id)
          .eq("user_id", id)
          .eq("role", "member")
          .select()
          .single(),
      );
      await initialize({ user: { id: user.id, email: user.name } });
    } finally {
      setWriting(false);
    }
  }
  return {
    get user() {
      return user;
    },
    initialize,
    invalidate() {
      loadEpoch++;
      state = {
        workspaces: [],
        members: [],
        homes: [],
        activeWorkspaceId: null,
      };
      user = {};
    },
    list: () => state.workspaces,
    active,
    role,
    shortcuts,
    setShortcuts,
    create,
    updateBusiness,
    enableApp,
    saveAppearance,
    flush,
    addMember,
    setUsername,
    removeMember,
    members: () =>
      state.members.filter((m) => m.workspaceId === state.activeWorkspaceId),
    switchTo(id) {
      if (!state.workspaces.some((w) => w.id === id))
        throw Error("Workspace unavailable");
      state.activeWorkspaceId = id;
    },
    get persistenceError() {
      return false;
    },
  };
})();

/* Shared lifecycle used by future Mini Apps. A switch immediately clears the
   previous view, aborts requests, empties caches, and notifies every subscriber.
   Loaders must use load() to reject a stale response after a switch. */
const WorkspaceContext = (() => {
  let epoch = 0,
    controller = new AbortController();
  const listeners = new Set(),
    cache = new Map();
  function switchTo(workspaceId, clear) {
    if (!WorkspaceStore.list().some((w) => w.id === workspaceId))
      throw Error("This workspace is not available.");
    controller.abort();
    controller = new AbortController();
    epoch++;
    cache.clear();
    clear();
    WorkspaceStore.switchTo(workspaceId);
    const context = current();
    for (const fn of listeners) fn(context);
    return context;
  }
  function current() {
    return {
      workspaceId: WorkspaceStore.active().id,
      userId: WorkspaceStore.user.id,
      role: WorkspaceStore.role(),
      signal: controller.signal,
    };
  }
  async function load(loader, commit) {
    const version = epoch,
      context = current();
    try {
      const result = await loader(context);
      if (version !== epoch || context.signal.aborted) return false;
      commit(result, context);
      return true;
    } catch (error) {
      if (version !== epoch || context.signal.aborted) return false;
      throw error;
    }
  }
  return Object.freeze({
    switchTo,
    current,
    load,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    cache,
  });
})();

/* BackendOS foundation. Register future Mini Apps here; keep shared navigation,
   appearance and preferences in the shell. Examples have no business data. */
const apps = [
  {
    id: "reservations",
    name: "Reservations",
    description: "Bookings and guest stays",
    icon: "calendar",
    color: "#6177e7",
  },
  {
    id: "customers",
    name: "Customers",
    description: "People and contact details",
    icon: "users",
    color: "#cf8151",
  },
  {
    id: "tax-tracker",
    name: "Hotel Tax Calculator",
    description: "Guest charges and hotel tax",
    icon: "receipt",
    color: "var(--accent)",
  },
  {
    id: "documents",
    name: "Documents",
    description: "Files and paperwork",
    icon: "folder",
    color: "#a370d7",
  },
];
const paths = {
  list: '<path d="M9 5h12M9 12h12M9 19h12"/><rect x="3" y="4" width="2" height="2" rx=".5"/><rect x="3" y="11" width="2" height="2" rx=".5"/><rect x="3" y="18" width="2" height="2" rx=".5"/>',
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  settings:
    '<path d="m9 3-1 3-3 1-2 4 2 2v4l4 3 3-1 3 1 4-3v-4l2-2-2-4-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/>',
  calendar:
    '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4m8-4v4m-9 7h2m4 0h2m-8 3h2"/>',
  users:
    '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-16a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5"/>',
  receipt: '<path d="M5 3h14v18l-3-2-4 2-4-2-3 2Zm4 5h6m-6 4h6m-6 4h3"/>',
  folder:
    '<path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="m4 16 12-12 4 4L8 20H4Zm9-9 4 4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  moon: '<path d="M21 13A9 9 0 0 1 11 3a9 9 0 1 0 10 10Z"/>',
  monitor:
    '<rect x="3" y="3" width="18" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  link: '<path d="m10 14 4-4m-6 6-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m4 0 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.01"/>',
  up: '<path d="m6 14 6-6 6 6"/>',
  down: '<path d="m6 10 6 6 6-6"/>',
  minus: '<path d="M5 12h14"/>',
  check: '<path d="m5 12 4 4 10-10"/>',
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.grid}</svg>`;
const accentColors = [
  ["#6b58e8", "Violet"],
  ["#3879d6", "Blue"],
  ["#278a75", "Emerald"],
  ["#c56740", "Terracotta"],
  ["#5363bb", "Indigo"],
  ["#24869a", "Teal"],
  ["#ad557c", "Rose"],
  ["#a87926", "Amber"],
];
const defaults = {
  theme: "light",
  accent: "#6b58e8",
  wallpaper: "glow",
  density: "detailed",
  layout: "grid",
  visible: apps.map((a) => a.id),
};
const key = "backendos.preferences.v1";
let prefs = structuredClone(defaults),
  storageFailed = false;
Object.defineProperty(prefs, "visible", {
  enumerable: false,
  get() {
    return WorkspaceStore.shortcuts().filter((id) =>
      WorkspaceStore.active().enabledApps.includes(id),
    );
  },
  set(ids) {
    const disabled = WorkspaceStore.shortcuts().filter(
      (id) => !WorkspaceStore.active().enabledApps.includes(id),
    );
    WorkspaceStore.setShortcuts([...ids, ...disabled]);
  },
});
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const workspaceApps = () =>
  apps.filter((a) => WorkspaceStore.active().enabledApps.includes(a.id));
let usernameMatch = null;
let draft = null,
  route = "home";
const main = document.querySelector("main"),
  systemTheme = matchMedia("(prefers-color-scheme: dark)"),
  forcedColors = matchMedia("(forced-colors: active)");
function applyAppearance() {
  const dark =
    prefs.theme === "dark" || (prefs.theme === "system" && systemTheme.matches);
  document.documentElement.dataset.dark = String(dark);
  document.body.dataset.dark = String(dark);
  document.body.dataset.wallpaper = prefs.wallpaper;
  document.body.dataset.density = prefs.density;
  document.body.dataset.layout = prefs.layout;
  document.documentElement.style.setProperty("--accent", prefs.accent);
  document.querySelector('meta[name="theme-color"]').content = prefs.accent;
}
function save() {
  WorkspaceStore.saveAppearance();
  return true;
}
let toastTimer;
function toast(message) {
  const el = document.querySelector("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3500);
}
function appIcon(a) {
  return `<span class="app-icon" style="--app-color:${a.color}">${icon(a.icon)}</span>`;
}
function headline(eyebrow, title, subtitle, actions = "") {
  return `<div class="topline"><div><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p>${subtitle}</p></div>${actions ? `<div class="top-actions">${actions}</div>` : ""}</div>`;
}
function home() {
  return (
    headline(
      esc(WorkspaceStore.active().name),
      "Welcome home.",
      "Everything you need, in your own space.",
      `<button class="btn" data-route="edit">${icon("edit")} Edit home</button>`,
    ) +
    `<div class="section-head"><h2>Your Mini Apps</h2><span>${prefs.visible.length} shortcuts</span></div><div class="app-grid">${prefs.visible
      .map((id) => {
        const a = apps.find((a) => a.id === id);
        return `<button class="tile" data-open="${id}">${appIcon(a)}<span class="tile-content"><strong>${a.name}</strong>${prefs.density === "detailed" ? `<small>${a.description}</small>` : ""}</span></button>`;
      })
      .join(
        "",
      )}<button class="tile add-tile" data-route="library"><span class="app-icon">${icon("plus")}</span><span class="tile-content"><strong>Add Mini Apps</strong>${prefs.density === "detailed" ? "<small>Browse available Mini Apps</small>" : ""}</span></button></div><div class="home-note">${icon("info")}<span>Your workspace, your shortcuts. <button data-route="library">Explore the app library</button></span></div>`
  );
}
function library() {
  const list = draft || prefs.visible;
  return (
    headline(
      "APP LIBRARY",
      "App library",
      "Choose which shortcuts appear on your home screen.",
    ) +
    `<div class="notice">Hotel Tax Calculator is ready to use. The other shortcuts are examples for future Mini Apps.</div><div class="library-list">${workspaceApps()
      .map(
        (a) =>
          `<article class="library-card">${appIcon(a)}<div><h3>${a.name}</h3><p>${a.description}</p><small class="badge">${a.id === "tax-tracker" ? "Available" : "Example"}</small></div><button class="btn ${list.includes(a.id) ? "" : "primary"}" data-toggle="${a.id}">${icon(list.includes(a.id) ? "check" : "plus")} ${list.includes(a.id) ? "On home" : "Add to home"}</button></article>`,
      )
      .join(
        "",
      )}</div><p class="workspace-help">Only this workspace’s enabled Mini Apps appear here. ${WorkspaceStore.role() === "owner" ? '<button class="text-btn" data-route="workspace">Manage enabled apps</button>' : "Ask the owner to enable additional Mini Apps."}</p>`
  );
}
function edit() {
  return (
    headline(
      "CUSTOMIZE",
      "Edit your home screen",
      "Move shortcuts up or down to change their order.",
      `<button class="btn" data-cancel>Cancel</button><button class="btn primary" data-done>${icon("check")} Save changes</button>`,
    ) +
    `<div class="edit-list">${
      draft.length
        ? draft
            .map((id, i) => {
              const a = apps.find((a) => a.id === id);
              return `<div class="edit-row">${appIcon(a)}<strong>${a.name}</strong><div class="row-actions"><button class="icon-btn" data-move="${id}" data-dir="-1" ${i === 0 ? "disabled" : ""} aria-label="Move ${a.name} earlier">${icon("up")}</button><button class="icon-btn" data-move="${id}" data-dir="1" ${i === draft.length - 1 ? "disabled" : ""} aria-label="Move ${a.name} later">${icon("down")}</button><button class="icon-btn" data-remove="${id}" aria-label="Hide ${a.name}">${icon("minus")}</button></div></div>`;
            })
            .join("")
        : `<div class="empty"><h2>A clean slate.</h2><p>Add Mini Apps below to make this space yours.</p></div>`
    }</div><div class="section-head"><h2>Available shortcuts</h2><span>Hiding keeps app data</span></div><div class="library-list">${
      workspaceApps()
        .filter((a) => !draft.includes(a.id))
        .map(
          (a) =>
            `<article class="library-card">${appIcon(a)}<div><h3>${a.name}</h3><p>${a.id === "tax-tracker" ? a.description : "Example shortcut"}</p></div><button class="btn" data-toggle="${a.id}">${icon("plus")} Add</button></article>`,
        )
        .join("") || "<p>All enabled Mini Apps are on your home screen.</p>"
    }</div>`
  );
}
const tabs = [
  ["workspace", "grid", "Workspace"],
  ["appearance", "sun", "Appearance"],
  ["account", "user", "Account"],
  ["connections", "link", "Connections"],
];
function options(k, values) {
  return `<div class="segmented">${values.map(([value, label, ico]) => `<button data-pref="${k}" data-value="${value}" class="${prefs[k] === value ? "selected" : ""}" aria-pressed="${prefs[k] === value}">${ico ? icon(ico) : ""}${label}</button>`).join("")}</div>`;
}
function appearance() {
  return `<section class="panel"><h2>Appearance</h2><p>A workspace that feels like yours.</p>${forcedColors.matches ? '<div class="notice" role="status">Your browser is enforcing a contrast palette, which overrides the selected accent and theme. To use the app’s colors, check Windows Settings → Accessibility → Contrast themes and select None. Your appearance choices are still saved.</div>' : ""}<div class="setting-row"><span class="setting-title">Theme</span>${options(
    "theme",
    [
      ["light", "Light", "sun"],
      ["dark", "Dark", "moon"],
      ["system", "System", "monitor"],
    ],
  )}</div><div class="setting-row"><span class="setting-title">Accent color</span><div class="swatches">${accentColors.map(([color, label]) => `<button class="swatch ${prefs.accent === color ? "selected" : ""}" style="--swatch:${color}" data-pref="accent" data-value="${color}" aria-label="${label} accent" title="${label}" aria-pressed="${prefs.accent === color}"></button>`).join("")}</div></div><div class="setting-row"><span class="setting-title">Background</span>${options(
    "wallpaper",
    [
      ["glow", "Soft glow"],
      ["plain", "Plain"],
    ],
  )}</div><div class="setting-row"><span class="setting-title">Home layout</span>${options(
    "layout",
    [
      ["grid", "Grid", "grid"],
      ["list", "List", "list"],
    ],
  )}</div><div class="setting-row"><span class="setting-title">App details</span>${options(
    "density",
    [
      ["compact", "Compact"],
      ["detailed", "Detailed"],
    ],
  )}<p class="setting-help">Compact shows app names. Detailed adds a short description.</p></div></section><p style="margin-top:18px;font-size:14px">Your appearance is personal and stays consistent across workspaces. Preferences are saved privately to your account.</p>`;
}
function account() {
  return `<section class="panel"><h2>BackendOS account</h2><div class="detail-row"><strong>Email</strong><span>${esc(WorkspaceStore.user.name)}</span></div><div class="detail-row"><strong>Your user ID</strong><span>${esc(WorkspaceStore.user.id)}</span></div><form id="username-form"><label class="form-label" for="account-username">Username</label><input id="account-username" name="username" value="${esc(WorkspaceStore.user.username)}" required minlength="3" maxlength="30" pattern="[A-Za-z][A-Za-z0-9_]{2,29}" autocomplete="username" placeholder="e.g. samhull"><p>3–30 letters, numbers, or underscores; start with a letter. Usernames are unique and ignore capitalization. Changing yours keeps your memberships.</p><p class="form-error" role="alert"></p><button class="btn primary" type="submit">Save username</button></form><p>Share your username (or user ID) with a workspace Owner to join their workspace.</p><button class="btn" id="sign-out">Sign out</button></section>`;
}
function connections() {
  return `<section class="panel"><h2>Connected accounts</h2><p>Manage the services used by your Mini Apps.</p>${[
    ["Email", "Send and organize business correspondence."],
    ["Calendar", "Connect bookings and schedules."],
    ["File storage", "Access your business documents."],
  ]
    .map(
      ([name, desc]) =>
        `<div class="detail-row"><div><strong>${name}</strong><p style="font-size:14px;margin-top:5px">${desc}</p></div><span class="badge">Not configured</span></div>`,
    )
    .join(
      "",
    )}</section><div class="notice">Account connections need secure provider setup before they can be enabled. You’ll connect each service here once it is available.</div>`;
}
function settings() {
  return (
    headline(
      "PREFERENCES",
      "Settings",
      "Manage your workspace, appearance, and account.",
    ) +
    `<div class="settings-layout"><nav class="settings-nav" aria-label="Settings sections">${tabs.map(([id, ico, label]) => `<button data-route="${id}" class="${route === id ? "active" : ""}" ${route === id ? 'aria-current="page"' : ""}>${icon(ico)}${label}</button>`).join("")}</nav><div>${route === "workspace" ? workspaceSettings() : route === "appearance" ? appearance() : route === "account" ? account() : connections()}</div></div>`
  );
}
const hotelTax = window.HotelTax?.create({
  db,
  root: main,
  toast,
  setWriting,
  context: () =>
    cloudReady &&
    route === "hotel-tax" &&
    WorkspaceStore.active()?.enabledApps.includes("tax-tracker")
      ? {
          ...WorkspaceContext.current(),
          workspaceName: WorkspaceStore.active().name,
        }
      : null,
});
function render() {
  if (!WorkspaceStore.active()) {
    emptyView();
    return;
  }
  document.querySelector("#active-workspace-name").textContent =
    WorkspaceStore.active().name;
  document
    .querySelector("#workspace-switcher")
    .setAttribute(
      "aria-label",
      `Switch workspace, active business: ${WorkspaceStore.active().name}`,
    );
  document.querySelectorAll(".dock button").forEach((b) => {
    const active =
      b.dataset.route === route ||
      (b.dataset.route === "appearance" && tabs.some((t) => t[0] === route)) ||
      (b.dataset.route === "home" && ["edit", "hotel-tax"].includes(route));
    b.classList.toggle("active", active);
    if (active) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  if (route === "hotel-tax") {
    hotelTax.draw();
    document.title = "BackendOS · Hotel Tax Calculator";
    return;
  }
  main.innerHTML =
    route === "home"
      ? home()
      : route === "library"
        ? library()
        : route === "edit"
          ? edit()
          : settings();
  document.title = `BackendOS · ${route === "home" ? "Home" : route === "library" ? "App library" : route === "edit" ? "Edit home" : "Settings"}`;
}
function navigate(next) {
  if (!WorkspaceStore.active()) {
    emptyView();
    return;
  }
  if (
    ![
      "home",
      "library",
      "edit",
      "hotel-tax",
      ...tabs.map((t) => t[0]),
    ].includes(next)
  )
    next = "home";
  if (
    next === "hotel-tax" &&
    !WorkspaceStore.active().enabledApps.includes("tax-tracker")
  )
    next = "home";
  const enterHotel = next === "hotel-tax" && route !== next;
  if (next !== route) hotelTax?.cancel();
  if (route === "edit" && next !== "edit") draft = null;
  route = next;
  if (route === "edit" && !draft) draft = [...prefs.visible];
  if (location.hash !== `#${next}`) history.pushState(null, "", `#${next}`);
  render();
  if (enterHotel) hotelTax?.load();
  window.scrollTo(0, 0);
  main.focus({ preventScroll: true });
}
document.addEventListener("click", async (e) => {
  if (!cloudReady) return;
  try {
    const b = e.target.closest("button");
    if (!b || b.hasAttribute("data-hotel")) return;
    if (b.hasAttribute("data-remove-member")) {
      await WorkspaceStore.removeMember(b.dataset.removeMember);
      render();
      return;
    }
    if (b.id === "workspace-switcher") {
      workspaceDialog();
      return;
    }
    if (b.dataset.switch) {
      switchWorkspace(b.dataset.switch);
      return;
    }
    if (b.hasAttribute("data-new-workspace")) {
      createWorkspaceDialog();
      return;
    }
    if (b.dataset.route) navigate(b.dataset.route);
    else if (b.hasAttribute("data-pref")) {
      prefs[b.dataset.pref] = b.dataset.value;
      applyAppearance();
      const ok = save();
      const focusKey = b.dataset.pref,
        focusValue = b.dataset.value;
      render();
      document
        .querySelector(`[data-pref="${focusKey}"][data-value="${focusValue}"]`)
        ?.focus();
      if (ok) {
        await WorkspaceStore.flush();
        toast("Appearance saved");
      }
    } else if (b.dataset.toggle) {
      const list = route === "edit" ? draft : prefs.visible;
      const id = b.dataset.toggle;
      const index = list.indexOf(id);
      if (index >= 0) list.splice(index, 1);
      else list.push(id);
      if (route !== "edit") {
        prefs.visible = list;
        save();
      }
      render();
      document.querySelector(`[data-toggle="${id}"]`)?.focus();
      if (route !== "edit") {
        await WorkspaceStore.flush();
        toast(
          index >= 0 ? "Shortcut hidden from home" : "Shortcut added to home",
        );
      }
    } else if (b.dataset.move) {
      const i = draft.indexOf(b.dataset.move),
        j = i + Number(b.dataset.dir);
      if (j >= 0 && j < draft.length) {
        [draft[i], draft[j]] = [draft[j], draft[i]];
        render();
        document
          .querySelector(
            `[data-move="${b.dataset.move}"][data-dir="${b.dataset.dir}"]`,
          )
          ?.focus();
      }
    } else if (b.dataset.remove) {
      draft = draft.filter((id) => id !== b.dataset.remove);
      render();
      document.querySelector("[data-done]")?.focus();
    } else if (b.hasAttribute("data-done")) {
      prefs.visible = [...draft];
      draft = null;
      const ok = save();
      navigate("home");
      if (ok) {
        await WorkspaceStore.flush();
        toast("Home screen saved");
      }
    } else if (b.hasAttribute("data-cancel")) {
      draft = null;
      navigate("home");
    } else if (b.dataset.open) {
      const a = workspaceApps().find((a) => a.id === b.dataset.open);
      if (!a) {
        toast("This Mini App is not enabled in the active workspace.");
        return;
      }
      if (a.id === "tax-tracker") {
        navigate("hotel-tax");
        await WorkspaceStore.flush();
        return;
      }
      document.querySelector("#dialog-content").innerHTML =
        `${appIcon(a)}<h2>${a.name}</h2><p>This is an example shortcut. The ${a.name.toLowerCase()} Mini App hasn’t been built yet.</p><button class="btn primary" data-close>Back to home</button>`;
      document.querySelector("dialog").showModal();
    } else if (b.matches(".close,[data-close]"))
      document.querySelector("dialog").close();
    await WorkspaceStore.flush();
  } catch (error) {
    toast(error.message);
    render();
    applyAppearance();
  }
});
window.addEventListener("popstate", () => {
  if (cloudReady) navigate(location.hash.slice(1));
});
window.addEventListener("hashchange", () => {
  if (cloudReady) navigate(location.hash.slice(1));
});
systemTheme.addEventListener("change", applyAppearance);
forcedColors.addEventListener("change", () => {
  if (cloudReady && route === "appearance") render();
});
document
  .querySelectorAll("[data-icon]")
  .forEach((el) => (el.innerHTML = icon(el.dataset.icon)));
applyAppearance();

function workspaceSaved(message) {
  toast(
    WorkspaceStore.persistenceError
      ? "Changes apply now, but browser storage could not save them."
      : message,
  );
}
function switchWorkspace(workspaceId) {
  try {
    usernameMatch = null;
    hotelTax?.cancel();
    WorkspaceContext.switchTo(workspaceId, () => {
      draft = null;
      main.replaceChildren();
      document.querySelector("#dialog-content").replaceChildren();
      document.querySelector("dialog").close();
    });
    document.querySelector(".dock").hidden = false;
    document.querySelector("#workspace-switcher").hidden = false;
    document.querySelector(".avatar").hidden = false;
    navigate("home");
    workspaceSaved("Switched to " + WorkspaceStore.active().name);
  } catch (error) {
    toast(error.message);
  }
}
function workspaceDialog() {
  const w = WorkspaceStore.active();
  document.querySelector("#dialog-content").innerHTML =
    `<h2>Switch workspace</h2><p>Each business has its own settings and Mini Apps.</p><div class="workspace-options">${WorkspaceStore.list()
      .map(
        (item) =>
          `<button class="workspace-option ${item.id === w.id ? "selected" : ""}" data-switch="${esc(item.id)}" ${item.id === w.id ? 'aria-current="true"' : ""}><span class="workspace-monogram">${esc(item.name.slice(0, 1).toUpperCase())}</span><span><strong>${esc(item.name)}</strong><small>${WorkspaceStore.role(item.id) === "owner" ? "Owner" : "Member"}${item.example ? " · Example" : ""}</small></span>${item.id === w.id ? icon("check") : ""}</button>`,
      )
      .join(
        "",
      )}</div><button class="btn primary full-width" data-new-workspace>${icon("plus")} Create workspace</button><div class="prototype-note">Cloud workspace · Your account</div>`;
  document.querySelector("dialog").showModal();
}
function createWorkspaceDialog() {
  document.querySelector("#dialog-content").innerHTML =
    `<h2>Create a workspace</h2><p>Give this business a name. You’ll be its owner.</p><form id="create-workspace-form"><label class="form-label" for="workspace-name">Workspace name</label><input id="workspace-name" name="name" required maxlength="80" placeholder="Business name" autocomplete="organization"><p class="form-error" role="alert"></p><button type="submit" class="btn primary full-width">Create workspace</button></form><div class="prototype-note">Creates a new cloud workspace. Browser prototype data is not imported.</div>`;
  const dialog = document.querySelector("dialog");
  if (!dialog.open) dialog.showModal();
  document.querySelector("#workspace-name").focus();
}
function workspaceSettings() {
  const w = WorkspaceStore.active(),
    owner = WorkspaceStore.role() === "owner",
    business = w.business;
  return `<section class="panel"><div class="panel-title"><h2>${esc(w.name)}</h2><span class="badge">${owner ? "Owner" : "Member"}${w.example ? " · Example" : ""}</span></div><p>Business information belongs to this workspace.</p><div class="prototype-note">Cloud workspace · Membership enforced by database permissions.</div><form id="workspace-business-form"><fieldset ${owner ? "" : "disabled"}><div class="form-grid"><div class="wide"><label class="form-label" for="business-name">Workspace / business name</label><input id="business-name" name="name" value="${esc(w.name)}" maxlength="80" required></div><div><label class="form-label" for="business-email">Business email</label><input id="business-email" name="email" type="email" maxlength="254" value="${esc(business.email)}" autocomplete="email"></div><div><label class="form-label" for="business-phone">Phone</label><input id="business-phone" name="phone" type="tel" maxlength="40" value="${esc(business.phone)}" autocomplete="tel"></div><div class="wide"><label class="form-label" for="business-address">Business address</label><textarea id="business-address" name="address" maxlength="300" rows="2" autocomplete="street-address">${esc(business.address)}</textarea></div></div><p class="form-error" role="alert"></p>${owner ? '<button class="btn primary" type="submit">Save business information</button>' : ""}</fieldset></form>${owner ? "" : '<p class="workspace-help">Only the owner can edit business information and manage membership.</p>'}</section>
 <section class="panel"><h2>Enabled Mini Apps</h2><p>Workspace-wide availability. Hiding your personal shortcut never changes this list.</p>${apps.map((a) => `<div class="detail-row"><div><strong>${a.name}</strong><p class="example-caption">${a.id === "tax-tracker" ? "Hotel Tax Calculator" : "Example Mini App"}</p></div><label class="toggle-label"><input type="checkbox" data-enable="${a.id}" ${w.enabledApps.includes(a.id) ? "checked" : ""} ${owner ? "" : "disabled"}><span>Enabled</span></label></div>`).join("")}${owner ? "" : '<p class="workspace-help">Members use the Mini Apps enabled by the owner.</p>'}</section>
 <section class="panel"><h2>Members</h2><p>Owners manage the business. Members use its enabled Mini Apps.</p>${WorkspaceStore.members()
   .map(
     (m) =>
       `<div class="detail-row"><strong>${esc(m.name)}</strong><span class="badge">${m.role === "owner" ? "Owner" : "Member"}</span>${owner && m.role === "member" ? `<button class="btn" data-remove-member="${esc(m.userId)}">Remove member</button>` : ""}</div>`,
   )
   .join(
     "",
   )}${owner ? `<form id="member-form"><label class="form-label" for="member-id">Username or user ID</label><input id="member-id" name="user_id" required maxlength="36" placeholder="e.g. samhull"><p class="workspace-help">Enter an exact username to find the account, then confirm. A user ID can still be added directly.</p><p class="form-error" role="alert"></p><button class="btn" type="submit">Find user / add by ID</button></form>` : ""}</section>`;
}
document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (
    ![
      "create-workspace-form",
      "workspace-business-form",
      "member-form",
      "username-form",
      "confirm-member-form",
    ].includes(form.id)
  )
    return;
  event.preventDefault();
  const values = Object.fromEntries(new FormData(form));
  try {
    if (form.id === "create-workspace-form") {
      const workspaceId = await WorkspaceStore.create(values.name);
      switchWorkspace(workspaceId);
    } else if (form.id === "workspace-business-form") {
      WorkspaceStore.updateBusiness(values);
      await WorkspaceStore.flush();
      render();
      workspaceSaved("Business information saved");
    } else if (form.id === "username-form") {
      await WorkspaceStore.setUsername(values.username);
      if (WorkspaceStore.active()) render();
      else emptyView();
      toast("Username saved");
    } else if (form.id === "confirm-member-form") {
      const confirmed = usernameMatch;
      if (
        !confirmed ||
        confirmed.workspaceId !== WorkspaceStore.active()?.id ||
        confirmed.ownerId !== WorkspaceStore.user.id
      )
        throw Error("Look up this username again.");
      setWriting(true);
      try {
        const result = await db.rpc("add_workspace_member_by_username", {
          target_workspace: confirmed.workspaceId,
          requested_username: confirmed.username,
          expected_user_id: confirmed.user_id,
        });
        if (result.error) throw result.error;
        usernameMatch = null;
        await WorkspaceStore.initialize({
          user: { id: WorkspaceStore.user.id, email: WorkspaceStore.user.name },
        });
        document.querySelector("dialog").close();
        render();
        toast("Member added");
      } finally {
        setWriting(false);
      }
    } else {
      const value = values.user_id.trim();
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          value,
        )
      ) {
        const wid = WorkspaceStore.active().id,
          uid = WorkspaceStore.user.id;
        setWriting(true);
        try {
          const result = await db.rpc("lookup_workspace_username", {
            target_workspace: wid,
            requested_username: value.toLowerCase(),
          });
          if (result.error) throw result.error;
          if (
            WorkspaceStore.active()?.id !== wid ||
            WorkspaceStore.user.id !== uid
          )
            return;
          const match = result.data?.[0];
          if (!match) throw Error("No account has that username.");
          if (WorkspaceStore.members().some((m) => m.userId === match.user_id))
            throw Error("This user is already in the workspace.");
          usernameMatch = { ...match, workspaceId: wid, ownerId: uid };
          document.querySelector("#dialog-content").innerHTML =
            `<h2>Add Member?</h2><p>Add <strong>${esc(match.username)}</strong> to ${esc(WorkspaceStore.active().name)}?</p><p>User ID: ${esc(match.user_id)}</p><form id="confirm-member-form"><p class="form-error" role="alert"></p><button class="btn primary" type="submit">Confirm add Member</button></form>`;
          document.querySelector("dialog").showModal();
        } finally {
          setWriting(false);
        }
        return;
      }
      await WorkspaceStore.addMember(value);
      render();
      workspaceSaved("Member added");
    }
  } catch (error) {
    form.querySelector(".form-error").textContent = error.message;
  }
});
document.addEventListener("change", async (event) => {
  const input = event.target;
  if (input.dataset.enable) {
    try {
      WorkspaceStore.enableApp(input.dataset.enable, input.checked);
      await WorkspaceStore.flush();
      render();
      workspaceSaved(
        input.checked
          ? "Mini App enabled for this workspace"
          : "Mini App disabled for this workspace. Data is kept.",
      );
    } catch (error) {
      toast(error.message);
      render();
    }
  }
});

let cloudReady = false,
  authMode = "signin",
  authGeneration = 0;
function emptyView() {
  document.querySelector(".dock").hidden = true;
  document.querySelector("#workspace-switcher").hidden = true;
  document.querySelector(".avatar").hidden = true;
  main.innerHTML =
    '<section class="panel"><h1>Your first workspace</h1><p>Create a new cloud workspace, or ask an owner to add your user ID.</p><p id="account-id"></p><button class="btn primary" data-new-workspace>Create workspace</button></section>';
  document.querySelector("#account-id").textContent = WorkspaceStore.user.id;
  main.insertAdjacentHTML("beforeend", account());
}
function gate(message = "") {
  usernameMatch = null;
  hotelTax?.cancel();
  if (route === "hotel-tax") route = "home";
  WorkspaceStore.invalidate();
  for (const k of ["theme", "accent", "wallpaper", "density", "layout"])
    prefs[k] = defaults[k];
  applyAppearance();
  cloudReady = false;
  draft = null;
  document.querySelector("dialog").close();
  document.querySelector("#dialog-content").replaceChildren();
  main.replaceChildren();
  document.querySelector(".dock").hidden = true;
  document.querySelector("#workspace-switcher").hidden = true;
  document.querySelector(".avatar").hidden = true;
  document.querySelector("#active-workspace-name").textContent = "";
  if (!db) {
    main.innerHTML =
      '<section class="panel"><h1>Connect your workspace</h1><p>Configure SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY, then rebuild. See README.md.</p></section>';
    return;
  }
  const recovery = authMode === "recovery",
    reset = authMode === "reset";
  main.innerHTML = `<section class="panel" style="max-width:480px;margin:auto"><h1>${recovery ? "Choose a new password" : reset ? "Reset password" : authMode === "signup" ? "Create your account" : "Welcome back."}</h1><p>${esc(message)}</p><p class="workspace-help">Browser-local prototype data is preserved and is never automatically uploaded.</p><form id="auth-form">${recovery ? "" : '<label class="form-label" for="auth-email">Email</label><input id="auth-email" name="email" type="email" autocomplete="email" required>'}${reset ? "" : '<label class="form-label" for="auth-password">Password</label><input id="auth-password" name="password" type="password" minlength="8" autocomplete="' + (authMode === "signin" ? "current-password" : "new-password") + '" required>'}<p class="form-error" role="alert"></p><button class="btn primary" type="submit">${recovery ? "Save password" : reset ? "Send reset email" : authMode === "signup" ? "Sign up" : "Sign in"}</button></form><div class="top-actions"><button class="btn" data-auth-mode="signin">Sign in</button><button class="btn" data-auth-mode="signup">Sign up</button><button class="btn" data-auth-mode="reset">Forgot password?</button></div></section>`;
}
async function hydrate(session) {
  const generation = ++authGeneration;
  gate("Loading your workspaces…");
  try {
    for (const k of ["theme", "accent", "wallpaper", "density", "layout"])
      prefs[k] = defaults[k];
    await WorkspaceStore.initialize(session);
    if (generation !== authGeneration) return;
    applyAppearance();
    document.querySelector("#workspace-switcher").hidden = false;
    document.querySelector(".avatar").hidden = false;
    if (!WorkspaceStore.list().length) {
      cloudReady = true;
      emptyView();
      return;
    }
    cloudReady = true;
    document.querySelector(".dock").hidden = false;
    navigate(location.hash.slice(1) || "home");
  } catch (error) {
    if (generation === authGeneration) {
      gate(error.message);
      main.insertAdjacentHTML(
        "beforeend",
        '<button class="btn" id="retry-cloud">Retry loading</button><button class="btn" id="sign-out">Sign out</button>',
      );
    }
  }
}
document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.authMode) {
    authMode = button.dataset.authMode;
    gate();
  }
  if (button.id === "retry-cloud") {
    const { data } = await db.auth.getSession();
    if (data.session) await hydrate(data.session);
  }
  if (button.id === "sign-out") {
    button.disabled = true;
    try {
      await WorkspaceStore.flush();
      const { error } = await db.auth.signOut();
      if (error) throw error;
      authGeneration++;
      authMode = "signin";
      gate("Signed out.");
    } catch (error) {
      toast(error.message);
      button.disabled = false;
    }
  }
});
document.addEventListener("submit", async (event) => {
  if (event.target.id !== "auth-form") return;
  event.preventDefault();
  const form = event.target,
    values = Object.fromEntries(new FormData(form)),
    button = form.querySelector("button");
  button.disabled = true;
  try {
    const redirectTo = location.origin + "/";
    let result;
    if (authMode === "signup")
      result = await db.auth.signUp({
        email: values.email,
        password: values.password,
        options: { emailRedirectTo: redirectTo },
      });
    else if (authMode === "reset")
      result = await db.auth.resetPasswordForEmail(values.email, {
        redirectTo,
      });
    else if (authMode === "recovery")
      result = await db.auth.updateUser({ password: values.password });
    else result = await db.auth.signInWithPassword(values);
    if (result.error) throw result.error;
    if (authMode === "reset") {
      gate("If the account exists, check your email for the reset link.");
    } else if (authMode === "signup" && !result.data.session) {
      authMode = "signin";
      gate("Check your email to confirm your account before signing in.");
    } else if (authMode === "recovery") {
      authMode = "signin";
      await hydrate((await db.auth.getSession()).data.session);
      toast("Password updated");
    }
  } catch (error) {
    form.querySelector(".form-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
if (db) {
  db.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") {
      authMode = "recovery";
      authGeneration++;
      gate();
    } else if (event === "SIGNED_OUT") {
      authGeneration++;
      gate();
    } else if (
      session &&
      ["INITIAL_SESSION", "SIGNED_IN"].includes(event) &&
      authMode !== "recovery"
    ) {
      if (cloudReady && WorkspaceStore.user.id === session.user.id) return;
      const generation = authGeneration;
      setTimeout(() => {
        if (generation === authGeneration) hydrate(session);
      }, 0);
    } else if (event === "INITIAL_SESSION" && !session) gate();
  });
  gate();
} else gate();
