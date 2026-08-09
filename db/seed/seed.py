#!/usr/bin/env python3
"""
Jesse's Bakery OS — deterministic seed.

Generates a believable Sydney distribution network and 6 weeks of daily
history using a real FIFO shelf-life simulation, so that sales, deliveries,
captured wastage and the on-hand ledger are internally consistent (the same
way the live system will derive them). Retailers only ever "report" what
sold — waste is what the FIFO sim expires, exactly like reality.

Swap DATABASE_URL for the Supabase connection string to seed a real project.
"""
import os, random, uuid, datetime as dt
from collections import deque
import psycopg

URL = os.environ.get("DATABASE_URL", "postgres://postgres@127.0.0.1:5433/jesses")
random.seed(20260809)          # reproducible network
TODAY = dt.date.today()
# 10 weeks of history: the dashboard's 6-week window (42 days) then sits in
# steady state, past the FIFO warm-up where shelves start empty. Views window
# by date, so the extra weeks simply prime the ledger and never mislead.
DAYS = 70
DATES = [TODAY - dt.timedelta(days=DAYS - 1 - i) for i in range(DAYS)]
DOW_MULT = [0.85, 0.85, 0.95, 1.0, 1.3, 1.55, 1.4]   # Mon..Sun

REGIONS = {
    'Eastern Suburbs': ['Bondi Junction','Randwick','Coogee','Maroubra','Rose Bay','Waterloo','Pagewood'],
    'Inner West': ['Ashfield','Marrickville','Balmain','Leichhardt','Newtown','Burwood'],
    'City': ['Town Hall','Pyrmont','World Square','Surry Hills','Kings Cross','Potts Point'],
    'North Shore': ['Chatswood','Gordon','Pymble','Asquith','Hornsby','Lindfield'],
    'South': ['Sylvania','Caringbah','Miranda','Hurstville','Kogarah'],
    'Northern Beaches': ['Manly','Dee Why','Mona Vale','Brookvale'],
    'Hills': ['Castle Hill','Cherrybrook','Baulkham Hills','Rouse Hill'],
    'Western Sydney': ['Parramatta','Epping','Blacktown','Penrith','Olympic Park'],
    'Canberra': ['Manuka','Belconnen','Woden','Gungahlin'],
    'Central Coast': ['Gosford','Erina','Tuggerah'],
    'Newcastle': ['Newcastle West','Charlestown','Kotara'],
    'Northwest': ['Kellyville','Bella Vista','Norwest'],
}
REGION_STATE = {'Canberra': 'ACT'}   # rest NSW

RETAILERS = ['coles','woolworths','harris_farm']
RETAILER_LABEL = {'coles':'Coles','woolworths':'Woolworths','harris_farm':'Harris Farm'}

# (name, category, lead_time, shelf_life, min_on_shelf, popularity weight)
PRODUCTS = [
    ('White Sourdough', 'sourdough', 2, 5, 2, 1.00),
    ('Rye Sourdough',   'sourdough', 2, 5, 2, 0.55),
    ('Plain Bagel',     'bagel',     1, 4, 2, 0.80),
    ('Sesame Bagel',    'bagel',     1, 4, 2, 0.60),
    ('Poppy Bagel',     'bagel',     1, 4, 2, 0.45),
    ('Mini Challah',    'challah',   1, 3, 2, 0.40),
    ('Pita',            'pita',      1, 7, 3, 0.50),
]
SIZE_MAX = {'small': 45, 'medium': 75, 'large': 150}

def ri(a, b): return random.randint(a, b)

def main():
    with psycopg.connect(URL, autocommit=False) as conn:
        cur = conn.cursor()
        # clean slate (idempotent reseed)
        cur.execute("""truncate wastage, delivery_items, delivery_photos, deliveries,
                       on_hand_ledger, sales_daily, sales_intraday, replenishment_plans,
                       standing_orders, store_run_overrides, feed_status_log, events,
                       stores, runs, regions, product_prices, products, pricing_tiers,
                       app_users, packing_records restart identity cascade;""")

        # ---- pricing tiers ----
        tiers = {}
        for t in ['Coles','Woolworths','Harris Farm','Cafe','Distributor']:
            tid = uuid.uuid4(); tiers[t] = tid
            cur.execute("insert into pricing_tiers(id,name) values(%s,%s)", (tid, t))

        # ---- products ----
        prods = []
        for name, cat, lead, shelf, minsh, pop in PRODUCTS:
            pid = uuid.uuid4()
            cur.execute("""insert into products(id,name,category,is_core,lead_time_days,
                           shelf_life_days,min_on_shelf) values(%s,%s,%s,%s,%s,%s,%s)""",
                        (pid, name, cat, pop >= 0.6, lead, shelf, minsh))
            prods.append({'id': pid, 'name': name, 'cat': cat, 'lead': lead,
                          'shelf': shelf, 'min': minsh, 'pop': pop})
            base = {'sourdough': 7.5, 'bagel': 5.0, 'challah': 6.0, 'pita': 4.5}[cat]
            for t, tid in tiers.items():
                cur.execute("insert into product_prices(tier_id,product_id,unit_price) values(%s,%s,%s)",
                            (tid, pid, round(base * random.uniform(0.9, 1.15), 2)))

        # ---- users ----
        users = {}
        for full, email, role, dept in [
            ('Simona','simona@jessesbakery.com.au','ops','Operations'),
            ('Jesse','jesse@jessesbakery.com.au','admin','Owner'),
            ('Dan Kelly','dan@jessesbakery.com.au','driver','Logistics'),
            ('Mike Rowe','mike@jessesbakery.com.au','driver','Logistics'),
            ('Ana Silva','ana@jessesbakery.com.au','packer','Bakery'),
            ('Tomas Vue','tomas@jessesbakery.com.au','packer','Bakery'),
        ]:
            uid = uuid.uuid4(); users[full] = {'id': uid, 'role': role}
            cur.execute("insert into app_users(id,full_name,email,role,department) values(%s,%s,%s,%s,%s)",
                        (uid, full, email, role, dept))
        drivers = [u['id'] for u in users.values() if u['role'] == 'driver']

        # ---- regions + runs + stores ----
        stores = []
        sto_n = 100
        for region, subs in REGIONS.items():
            rid = uuid.uuid4()
            cur.execute("insert into regions(id,name,state,buffer_pct) values(%s,%s,%s,%s)",
                        (rid, region, REGION_STATE.get(region, 'NSW'), round(random.uniform(0, 3), 1)))
            run_id = uuid.uuid4()
            cur.execute("insert into runs(id,region_id,name,run_days) values(%s,%s,%s,%s)",
                        (run_id, rid, f"{region} run", ['mon','tue','wed','thu','fri','sat','sun']))
            for sub in subs:
                for _ in range(ri(1, 2)):
                    size = random.choice(['small','small','medium','medium','large'])
                    smax = SIZE_MAX[size]
                    retailer = random.choice(RETAILERS)
                    sid = uuid.uuid4(); sto_n += 1
                    size_base = {'small': ri(6,11), 'medium': ri(14,22), 'large': ri(28,40)}[size]
                    problem = random.random() < 0.09          # chronic over-senders -> red
                    overs = random.uniform(0.90, 1.12) + (random.uniform(0.35, 0.6) if problem else 0)
                    cur.execute("""insert into stores(id,name,retailer,region_id,default_run_id,
                                   size_category,shelf_min,shelf_max,retailer_store_id,supplier_code,
                                   xero_contact_id,pricing_tier_id,postcode,onboarded_at)
                                   values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                                (sid, f"{RETAILER_LABEL[retailer]} {sub}", retailer, rid, run_id,
                                 size, max(2, size_base // 3), smax, f"STO{sto_n}",
                                 str(ri(100, 999)), str(uuid.uuid4()),
                                 tiers[RETAILER_LABEL[retailer]], str(ri(2000, 2914)),
                                 TODAY - dt.timedelta(days=ri(120, 900))))
                    stores.append({'id': sid, 'size_base': size_base, 'overs': overs,
                                   'problem': problem, 'smax': smax, 'run': run_id,
                                   'region': rid, 'retailer': retailer})

        # ---- FIFO simulation -> sales, deliveries, wastage, ledger ----
        sales_rows, deliv_rows, ditem_rows, waste_rows, ledger_rows = [], [], [], [], []
        for st in stores:
            # one delivery header per store per day
            deliv_ids = {}
            for d in DATES:
                did = uuid.uuid4(); deliv_ids[d] = did
                deliv_rows.append((did, st['id'], st['run'], random.choice(drivers), d, 'delivered', d))
            for p in prods:
                base = max(1.0, st['size_base'] * p['pop'] * random.uniform(0.85, 1.15))
                lots = deque()            # (age_days, qty) FIFO
                prev_close = 0
                # recent demand memory for legacy sizing
                recent = [base * DOW_MULT[(DATES[0].weekday())]] * 5
                for di, d in enumerate(DATES):
                    dow = d.weekday()
                    demand = max(0, round(base * DOW_MULT[dow] * random.uniform(0.8, 1.25)))
                    # legacy order-up sizing: avg recent * overs, weekend bump for problem stores
                    avg_recent = sum(recent[-5:]) / len(recent[-5:])
                    sent = round(avg_recent * st['overs'] * (1.15 if (st['problem'] and dow >= 5) else 1)) + ri(0, 2)
                    sent = min(sent, st['smax'])            # HARD shelf cap
                    sent = max(sent, p['min'])
                    # age existing lots, expire those beyond shelf life
                    expired = 0
                    for k in range(len(lots)):
                        lots[k] = (lots[k][0] + 1, lots[k][1])
                    while lots and lots[0][0] >= p['shelf']:
                        expired += lots.popleft()[1]
                    opening = prev_close
                    # receive today's delivery (closing = opening - expired + delivered - sold)
                    lots.append((0, sent))
                    # sell FIFO from oldest stock
                    need = demand; sold = 0
                    while need > 0 and lots:
                        age, q = lots[0]
                        take = min(q, need)
                        sold += take; need -= take
                        if take == q: lots.popleft()
                        else: lots[0] = (age, q - take)
                    closing = sum(q for _, q in lots)
                    recent.append(demand)
                    prev_close = closing
                    # rows (retailer reports SOLD only)
                    sales_rows.append((st['id'], p['id'], d, sold, st['retailer']))
                    ditem_rows.append((deliv_ids[d], p['id'], sent, sent))
                    if expired > 0:
                        waste_rows.append((st['id'], p['id'], d, expired, random.choice(drivers)))
                    ledger_rows.append((st['id'], p['id'], d, opening, sent, sold, expired, closing))

        # ---- bulk load ----
        with cur.copy("copy deliveries(id,store_id,run_id,driver_id,delivery_date,status,delivered_at) from stdin") as cp:
            for r in deliv_rows: cp.write_row(r)
        with cur.copy("copy delivery_items(delivery_id,product_id,qty_sent,qty_delivered) from stdin") as cp:
            for r in ditem_rows: cp.write_row(r)
        with cur.copy("copy sales_daily(store_id,product_id,sale_date,units_sold,source) from stdin") as cp:
            for r in sales_rows: cp.write_row(r)
        with cur.copy("copy wastage(store_id,product_id,waste_date,qty,captured_by) from stdin") as cp:
            for r in waste_rows: cp.write_row(r)
        with cur.copy("copy on_hand_ledger(store_id,product_id,as_of_date,opening_on_hand,delivered,sold,expired,closing_on_hand) from stdin") as cp:
            for r in ledger_rows: cp.write_row(r)

        # ---- feed health: Harris Farm 2 days stale (matches the dashboard chip) ----
        for src, status, ago in [('coles','ok',0),('woolworths','ok',0),('harris_farm','stale',2)]:
            cur.execute("insert into feed_status_log(source,as_of,status,detail) values(%s,%s,%s,%s)",
                        (src, TODAY - dt.timedelta(days=ago), status,
                         'last loaded 2 days ago' if status=='stale' else 'current'))

        # ---- events calendar (seasonality) ----
        for name, kind, state, sd, ed, up in [
            ('Christmas','retail_event',None,(TODAY.year,12,18),(TODAY.year,12,24),40),
            ('Easter','public_holiday',None,(TODAY.year,4,3),(TODAY.year,4,6),25),
            ('NSW School Holidays','school_holiday','NSW',(TODAY.year,7,1),(TODAY.year,7,14),-15),
            ('Halloween','retail_event',None,(TODAY.year,10,28),(TODAY.year,10,31),15),
        ]:
            cur.execute("""insert into events(name,kind,state,start_date,end_date,uplift_pct)
                           values(%s,%s,%s,%s,%s,%s)""",
                        (name, kind, state, dt.date(*sd), dt.date(*ed), up))

        conn.commit()
        cur.execute("select count(*) from stores"); ns = cur.fetchone()[0]
        cur.execute("select count(*) from sales_daily"); nsl = cur.fetchone()[0]
        cur.execute("select * from v_network_week")
        cols = [c.name for c in cur.description]; net = dict(zip(cols, cur.fetchone()))
        print(f"Seeded {ns} stores, {nsl} sales rows.")
        print(f"Network: {net['red']} red / {net['amber']} amber / {net['green']} green | waste {net['waste_pct']}%")

if __name__ == "__main__":
    main()
