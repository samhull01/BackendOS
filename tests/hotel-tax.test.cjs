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
test("guest entry validation rejects invalid dates and counts", () => {
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

const csvHeader =
  "Date,Name,Thursday Guests,Weekend Guests,Charged Guests,Free Guests,Actual Guests,Entry Charge\r\n";
test("legacy CSV parses BOM, quotes, multiline names, half guests and summary rates", () => {
  const result = tax.parseLegacyCsv(
    "\ufeff" +
      csvHeader +
      '2026-10-01,"Guest, ""one""\nteam",1.5,2,3,0.5,3.5,1043.40\r\n\r\nThursday Cost,319.60\r\nWeekend Cost,282\r\nTax Rate,6%\r\nTax Discount,1%\r\nFinal Tax Owed,61.98\r\n',
  );
  assert.equal(result.entries[0].name, 'Guest, "one"\nteam');
  assert.deepEqual(result.rates, tax.defaults);
  assert.equal(result.entries[0].thursday_guests, 1.5);
  for (const bad of [
    csvHeader + "2026-10-01,Guest,.3,2,3,0,3,100",
    csvHeader + "2026-02-30,Guest,1,2,3,0,3,100",
    csvHeader + "2026-10-01,Guest,1,2,3,0,4,100",
    csvHeader + '2026-10-01,"Guest,1,2,3,0,3,100',
    csvHeader + "2026-10-01,Guest,1,2,3,0,3,100\nThursday Cost,200",
    "wrong,header",
  ])
    assert.throws(() => tax.parseLegacyCsv(bad));
});
