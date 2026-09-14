# Jesse's Bakery — Forecasting Engine Handover

**v1.0.0 · 18 August 2026 · Fred → Javonte**

Everything needed to build the forecasting engine: the design we agreed, how the legacy engine actually works, what not to reproduce, and what the data will and won't support.

---

## 1. The design

Deterministic code, layered. A language model answers questions and explains results; it never generates quantities.

### Layer 1 — Replenishment loop

The bulk of the waste reduction. Arithmetic, not prediction.

```
forecast = baseline + (service_level_z × demand_stddev)
target   = min(forecast, shelf_max)
order    = clamp(target − estimated_on_hand, min_units, shelf_max)
```

`estimated_on_hand` = previous delivery minus units sold since. This is the step the legacy system is missing entirely, and it is why Coles Ashfield receives 100 units into a 45-unit shelf.

### Layer 2 — Baseline forecast

Day-of-week seasonal average per store per product, with a recent-trend adjustment. Effectively a `GROUP BY` over the last N weeks by weekday, trimmed to reduce outlier sensitivity.

### Layer 3 — Safety buffer

Newsvendor model. Buffer size comes from the relative cost of selling out versus wasting a unit:

```
critical_ratio = margin_lost_on_stockout / (margin_lost_on_stockout + cost_of_waste)
```

This is what the unit economics unlock. Note we currently have **revenue** (`Invoice_Cost`), not **cost of goods**. Production cost per unit is still outstanding from Simona.

### Layer 4 — Machine learning

Only if it beats layers 1 to 3 in a backtest on real history. Many store/product series are low-volume and intermittent, which heavy models tend to overfit. Do not ship it because it is more impressive.

---

## 2. How the legacy engine actually works

Source: `usp_PopulateForecastByDay2.x`. Nine versions exist in the database side by side. The live view `FinalForecastByDay` reads `dbo.ForecastByDay`; version 2.11 writes to a **separate** table and is not in production.

The procedure:

1. **Weekly volume** = `SUM(Quantity) / 4` over a 28-day window. Flat average. No trend, no growth, no seasonality beyond weekday.
2. **Regional uplift** multiplies that by `(1 + Percentage)` from `Region_Percentage_Uplift`. These are the values Simona said she guessed.
3. **20 "specialty" products** get a hardcoded Wednesday/Thursday split, ignoring their actual sales pattern.
4. **Everything else** is allocated across delivery days in proportion to real day-of-week demand, assigned to whichever delivery day services each sales day, with largest-remainder rounding.
5. **Production offset**: 2 days earlier for six products, 1 day for the rest.
6. **Minimum rule**: any allocation of 1 becomes 2.

`FinalForecastByDay` then aggregates that output with standing orders and manual adjustments.

### What it never does

No reference anywhere to `Shelf_Limit` or to stock already on the shelf. `Weekly_Inventory_Ledger` (20,223 rows, correctly typed) exists and is never read. `Store_Delivery_CarryForward_Rules` (73,930 rows) exists and is only consumed by the non-live 2.11 branch.

### Accuracy note for client conversations

The daily split is genuinely demand-based and defensible. The weekly total is naive. Nothing anywhere reads shelf stock or capacity. "It ignores day of week" is not accurate and will not survive scrutiny.

---

## 3. Five bugs — do not reproduce

**Non-deterministic date window.** `SELECT TOP 1 @TargetDate = [DateToDelete] FROM [dbo].[TempDates2]` with no `ORDER BY`. If that table ever holds more than one row the forecast window changes silently. The column name is left over from another purpose.

**Every order of 1 becomes 2.** `UPDATE #AllocatedForecast SET AllocatedQuantity = 2 WHERE AllocatedQuantity = 1`. Systematic doubling of the smallest lines across hundreds of store/product/day combinations. Directly measurable waste.

**The most recent week is excluded.** The window ends 7 days before it runs, so the last week of trading never influences the forecast.

**Stores without Thursday or Friday delivery get zero specialty products.** The `CROSS APPLY` in step 4 has no fallback branch, so 20 products silently vanish for those stores.

**`INNER JOIN` to the master tables at the end** silently drops any store or product missing from `Stores_Master` or `Products_Master`. Given the store renumbering, worth checking what falls out.

---

## 4. Business rules to preserve

**Shabbat.** The 20 "specialty" products are the entire Challah range plus Babkas. Challah is eaten Friday night. Producing Wednesday and Thursday for Friday delivery is correct behaviour, not arbitrary hardcoding. It also shows up in `Stores_Master.SPECIAL_FRIDAY`, which is set on the Jewish institutions and the areas with concentrated Jewish communities. Model it explicitly; do not remove it.

**Lead times.** Sourdough family plus Dark Rye are 2-day (`PRO096`, `097`, `098`, `099`, `100`, `054`). Everything else is 1-day. Currently a hardcoded product-ID list inside SQL, which is why Simona cannot add products. In the new schema this is a column on the product.

**Region is the delivery run.** Every store in a region shares one delivery pattern, and the groupings are operational rather than geographic. `Stores_Master.SUN_OVERRIDE` through `SAT_OVERRIDE` hold a **region name**, reassigning that store to a different run on that day. Coles Maroubra rides four different runs in one week. Store-to-run assignment is per day of week, not per store.

**Store archetypes already exist.** `Products_Standard_Baskets` carries nine basket profiles: three store types (standard, sourdough-led, bagel-led) across three sizes. 15 products flagged as the standard subset, 12 with quantities. That matches Simona's "12, like 15 is what every store gets".

**Minimum quantity exists but is empty.** `Products_Min_Prod_Mix.MinQtyToSend` is zero for all 113 products, which is why she said the system never sends her minimum. Small ask to populate: 15 core products, not 116.

---

## 5. What the data supports

**Backtesting is viable.** `FinalForecastByDate_SnapshotVersions` holds 615,618 dated forecast snapshots with a real key. Replay what the old system predicted against what actually sold, then run the new loop over the same history and compare. That is the 32%-to-X% number, computed rather than asserted.

**Revenue is available, cost is not.** `Invoice_Cost` is populated on 1,147,250 of 1,147,256 rows across all three retailers back to mid-2024. Unit price is `Invoice_Cost / Sales_Qty`. `Std_Unit_Cost` is Coles-only and redundant. `Waste_Qty` is Coles-only, 50,126 rows, **all zero**, and only between March and August 2024 — it is a dead field.

**Waste must be inferred.** Delivered minus sold. No retailer reports it.

**The 32% figure is unreliable.** Their wastage report compares every historical week against *current* production, because `CurrentProduction` has no date filter and no history. Only the most recent week's percentage means anything.

---

## 6. Known data issues

- **Coles is stale from 3 August.** Format change to Power BI; the pipeline reports success while loading zero rows. Anything Coles-derived is unreliable until fixed.
- Everything in the legacy schema is stored as text, including dates, quantities, prices and booleans.
- No foreign keys anywhere; 24 of 43 tables have no primary key.
- `Combined_Sales_Data` is a straight append of the three raw feeds; read `Combined_Sales_Data_Final`, which dedupes.
- A "Grand Total" row is ingested into `Coles_Report`. Exclude it.
- `Week` in the raw tables holds a date, not a week.

---

## 7. Open questions

- Production cost per unit (Simona) — blocks the service-level buffer
- Real shelf min/max per store (Simona) — `Shelf_Limit` ranges 35 to 80 but is not a physical capacity
- Which store is which size/archetype (Simona) — the baskets exist, the assignment does not
- Which `usp_PopulateForecastByDay` version is live, and what invokes it
- What Make.com connects to the database for
