const { test } = require("node:test");
const assert = require("node:assert/strict");
const tax = require("../src/hotel-tax.js");
const entry = {
  date: "2026-10-07",
  name: "Group",
  thursday_guests: 1.5,
  weekend_guests: 2,
  charged_guests: 3,
  free_guests: 0.5,
};
test("v5 formula, half guests, discount on tax and calendar-year view", () => {
  const t = tax.summarize([entry], tax.defaults);
  assert.equal(t.charge, 1043.4);
  assert.equal(t.actual_guests, 3.5);
  assert.ok(Math.abs(t.tax - 62.604) < 1e-10);
  assert.ok(Math.abs(t.due - 61.97796) < 1e-10);
  assert.equal(
    tax.visible(
      [
        entry,
        { ...entry, date: "2026-12-10" },
        { ...entry, date: "2025-10-07" },
      ],
      "year",
      "2026",
    ).length,
    2,
  );
  assert.equal(
    tax.visible([entry, { ...entry, date: "2026-12-10" }], "month", "2026-10")
      .length,
    1,
  );
  assert.equal(tax.summarize([], tax.defaults).due, 0);
});
test("strict backup validation refuses prototype data and removes identities", () => {
  assert.throws(() =>
    tax.validateBackup({
      app: "Hotel Tax Tracker",
      version: 1,
      entries: [entry],
      settings: tax.defaults,
    }),
  );
  const valid = tax.validateBackup({
    app: "BackendOS Hotel Tax Calculator",
    version: 2,
    entries: [{ ...entry, id: "old-id", workspace_id: "foreign" }],
    settings: tax.defaults,
  });
  assert.deepEqual(valid.entries, [entry]);
  for (const change of [
    { date: "2026-02-30" },
    { thursday_guests: -1 },
    { weekend_guests: Infinity },
    { charged_guests: 0.1 },
    { free_guests: null },
    { name: " " },
  ])
    assert.throws(() => tax.validateEntry({ ...entry, ...change }));
});
test("CSV preserves quote/newline names and neutralizes spreadsheet formulas", () => {
  const output = tax.csv(
    [{ ...entry, name: '=HYPERLINK("bad")\nnext' }],
    tax.defaults,
  );
  assert.ok(output.includes('"\'=HYPERLINK(""bad"")\nnext"'));
  assert.ok(output.includes('"due","61.98"'));
  assert.ok(output.includes('"1043.40"'));
});
