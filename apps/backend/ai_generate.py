from __future__ import annotations

import argparse
import datetime as dt
import math
import os
import random
import sqlite3
import string
import time
from dataclasses import dataclass
from typing import Iterable

RATE_EUR_PER_KWH = 0.20
INTERVAL_MINUTES = 15
INTERVAL_HOURS = INTERVAL_MINUTES / 60.0

SEGMENTS = ["residential", "sme", "industrial"]
TARIFFS = ["Simples", "Bi-horário"]
UTILITIES = ["EDP", "Endesa", "Iberdrola"]
CITIES = [
    "Porto",
    "Matosinhos",
    "Maia",
    "Vila Nova de Gaia",
    "Braga",
    "Aveiro",
    "Coimbra",
    "Lisboa",
]


@dataclass(frozen=True)
class Customer:
    id: str
    name: str
    segment: str
    city: str
    contracted_power_kva: float
    tariff: str
    utility: str
    price_eur_per_kwh: float
    fixed_daily_fee_eur: float
    has_smart_meter: int
    home_area_m2: float
    household_size: int
    locality_type: str
    dwelling_type: str
    build_year_band: str
    heating_sources: str
    has_solar: int
    ev_count: int
    alert_sensitivity: str
    main_appliances: str


def _now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _floor_to_15m(ts: dt.datetime) -> dt.datetime:
    ts = ts.astimezone(dt.timezone.utc)
    minute = (ts.minute // INTERVAL_MINUTES) * INTERVAL_MINUTES
    return ts.replace(minute=minute, second=0, microsecond=0)


def _next_15m_boundary(ts: dt.datetime) -> dt.datetime:
    ts0 = _floor_to_15m(ts)
    if ts0 == ts.replace(second=0, microsecond=0):
        return ts0
    return ts0 + dt.timedelta(minutes=INTERVAL_MINUTES)


def _rand_id(prefix: str, rng: random.Random) -> str:
    suffix = "".join(rng.choice(string.ascii_uppercase + string.digits) for _ in range(8))
    return f"{prefix}_{suffix}"


def _rand_name(rng: random.Random, segment: str) -> str:
    if segment == "residential":
        first = rng.choice(["Ana", "João", "Rita", "Tiago", "Inês", "Miguel", "Sofia", "Bruno"])
        last = rng.choice(["Silva", "Ferreira", "Santos", "Oliveira", "Costa", "Pereira", "Ribeiro"])
        return f"{first} {last}"
    if segment == "industrial":
        return rng.choice(["MetalNorte", "AgroVale", "TecFabril", "LogiPort", "QuimAtlantic"]) + " S.A."
    return rng.choice(["Café", "Oficina", "Farmácia", "Padaria", "Lavandaria"]) + " " + rng.choice(
        ["Central", "do Bairro", "Alfa", "Norte", "Express"]
    )


def ensure_schema(conn: sqlite3.Connection) -> None:
    def ensure_column(table: str, column: str, definition: str) -> None:
        info = conn.execute(f"PRAGMA table_info({table})").fetchall()
        exists = any(r[1] == column for r in info)
        if not exists:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS customers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          segment TEXT NOT NULL,
          city TEXT NOT NULL,
          contracted_power_kva REAL NOT NULL,
          tariff TEXT NOT NULL,
          utility TEXT NOT NULL,
          price_eur_per_kwh REAL NOT NULL DEFAULT 0.2,
          fixed_daily_fee_eur REAL NOT NULL DEFAULT 0,
          has_smart_meter INTEGER NOT NULL DEFAULT 1,
          home_area_m2 REAL NOT NULL DEFAULT 80,
          household_size INTEGER NOT NULL DEFAULT 2,
          locality_type TEXT NOT NULL DEFAULT 'Urbana',
          dwelling_type TEXT NOT NULL DEFAULT 'Apartamento',
          build_year_band TEXT NOT NULL DEFAULT '2000-2014',
          heating_sources TEXT NOT NULL DEFAULT '',
          has_solar INTEGER NOT NULL DEFAULT 0,
          ev_count INTEGER NOT NULL DEFAULT 0,
          alert_sensitivity TEXT NOT NULL DEFAULT 'Média',
          main_appliances TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        )
        """
    )

    # compat
    ensure_column("customers", "price_eur_per_kwh", "REAL NOT NULL DEFAULT 0.2")
    ensure_column("customers", "fixed_daily_fee_eur", "REAL NOT NULL DEFAULT 0")
    ensure_column("customers", "has_smart_meter", "INTEGER NOT NULL DEFAULT 1")
    ensure_column("customers", "home_area_m2", "REAL NOT NULL DEFAULT 80")
    ensure_column("customers", "household_size", "INTEGER NOT NULL DEFAULT 2")
    ensure_column("customers", "locality_type", "TEXT NOT NULL DEFAULT 'Urbana'")
    ensure_column("customers", "dwelling_type", "TEXT NOT NULL DEFAULT 'Apartamento'")
    ensure_column("customers", "build_year_band", "TEXT NOT NULL DEFAULT '2000-2014'")
    ensure_column("customers", "heating_sources", "TEXT NOT NULL DEFAULT ''")
    ensure_column("customers", "has_solar", "INTEGER NOT NULL DEFAULT 0")
    ensure_column("customers", "ev_count", "INTEGER NOT NULL DEFAULT 0")
    ensure_column("customers", "alert_sensitivity", "TEXT NOT NULL DEFAULT 'Média'")
    ensure_column("customers", "main_appliances", "TEXT NOT NULL DEFAULT ''")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS customer_telemetry_15m (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          customer_id TEXT NOT NULL,
          ts TEXT NOT NULL,
          watts REAL NOT NULL,
          euros REAL NOT NULL,
          temp_c REAL,
          is_estimated INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY(customer_id) REFERENCES customers(id)
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_customer_telemetry_15m_customer_ts ON customer_telemetry_15m(customer_id, ts)"
    )
    conn.commit()


def load_customers(conn: sqlite3.Connection) -> list[Customer]:
    rows = conn.execute(
        "SELECT id, name, segment, city, contracted_power_kva, tariff, utility, price_eur_per_kwh, fixed_daily_fee_eur, has_smart_meter, home_area_m2, household_size, locality_type, dwelling_type, build_year_band, heating_sources, has_solar, ev_count, alert_sensitivity, main_appliances FROM customers ORDER BY id ASC"
    ).fetchall()
    return [
        Customer(
            id=row[0],
            name=row[1],
            segment=row[2],
            city=row[3],
            contracted_power_kva=float(row[4]),
            tariff=row[5],
            utility=row[6],
            price_eur_per_kwh=float(row[7]),
            fixed_daily_fee_eur=float(row[8]),
            has_smart_meter=int(row[9]),
            home_area_m2=float(row[10]),
            household_size=int(row[11]),
            locality_type=str(row[12]),
            dwelling_type=str(row[13]),
            build_year_band=str(row[14]),
            heating_sources=str(row[15] or ""),
            has_solar=int(row[16] or 0),
            ev_count=int(row[17] or 0),
            alert_sensitivity=str(row[18] or "Média"),
            main_appliances=str(row[19] or ""),
        )
        for row in rows
    ]


def create_customers(conn: sqlite3.Connection, count: int, seed: int) -> list[Customer]:
    rng = random.Random(seed)

    customers: list[Customer] = []
    for _ in range(count):
        segment = rng.choices(SEGMENTS, weights=[0.72, 0.22, 0.06], k=1)[0]
        tariff = rng.choices(TARIFFS, weights=[0.7, 0.3], k=1)[0]
        city = rng.choice(CITIES)
        utility = rng.choice(UTILITIES)

        if segment == "residential":
            contracted = rng.choice([3.45, 4.6, 5.75, 6.9, 10.35])
        elif segment == "sme":
            contracted = rng.choice([10.35, 13.8, 17.25])
        else:
            contracted = rng.choice([17.25, 20.7, 27.6])

        price = float(max(0.08, min(0.45, rng.gauss(0.20, 0.03))))
        fixed_daily = float(max(0.0, min(1.5, rng.gauss(0.22, 0.09))))
        has_smart_meter = 1 if rng.random() < 0.88 else 0

        if segment == "residential":
            home_area = float(rng.choice([45, 70, 95, 130, 180]) + rng.uniform(-6, 10))
            household = int(rng.choices([1, 2, 3, 4, 5], weights=[0.18, 0.34, 0.22, 0.16, 0.10], k=1)[0])
            dwelling_type = rng.choice(["Apartamento", "Moradia isolada", "Moradia geminada"])
        elif segment == "sme":
            home_area = float(rng.choice([120, 180, 260, 420]) + rng.uniform(-20, 30))
            household = int(rng.choice([3, 5, 8, 12]))
            dwelling_type = "Comercial"
        else:
            home_area = float(rng.choice([800, 1500, 2600]) + rng.uniform(-120, 180))
            household = int(rng.choice([20, 35, 60]))
            dwelling_type = "Industrial"

        locality_type = rng.choice(["Urbana", "Suburbana", "Rural"])
        build_year_band = rng.choice(["Antes de 1980", "1980-1999", "2000-2014", "2015-2020", "2021 ou mais recente"])
        heating_sources = ",".join(rng.sample(["Elétrico", "Gás", "Bomba de calor", "Lenha / Pellets"], k=rng.choice([1, 2])))
        has_solar = 1 if (segment == "residential" and rng.random() < 0.22) else 0
        ev_count = int(rng.choices([0, 1, 2], weights=[0.78, 0.18, 0.04], k=1)[0]) if segment == "residential" else 0
        alert_sens = rng.choice(["Baixa", "Média", "Alta"])
        main_appliances = ",".join(
            rng.sample(["Ar condicionado", "Termoacumulador", "Piscina", "Bomba de água", "Secador de roupa"], k=rng.choice([0, 1, 2, 3]))
        )

        customer = Customer(
            id=_rand_id("C", rng),
            name=_rand_name(rng, segment),
            segment=segment,
            city=city,
            contracted_power_kva=float(contracted),
            tariff=tariff,
            utility=utility,
            price_eur_per_kwh=price,
            fixed_daily_fee_eur=fixed_daily,
            has_smart_meter=has_smart_meter,
            home_area_m2=home_area,
            household_size=household,
            locality_type=locality_type,
            dwelling_type=dwelling_type,
            build_year_band=build_year_band,
            heating_sources=heating_sources,
            has_solar=has_solar,
            ev_count=ev_count,
            alert_sensitivity=alert_sens,
            main_appliances=main_appliances,
        )
        customers.append(customer)

    now = _now_utc().isoformat()
    conn.executemany(
        "INSERT INTO customers (id, name, segment, city, contracted_power_kva, tariff, utility, price_eur_per_kwh, fixed_daily_fee_eur, has_smart_meter, home_area_m2, household_size, locality_type, dwelling_type, build_year_band, heating_sources, has_solar, ev_count, alert_sensitivity, main_appliances, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (
                c.id,
                c.name,
                c.segment,
                c.city,
                c.contracted_power_kva,
                c.tariff,
                c.utility,
                c.price_eur_per_kwh,
                c.fixed_daily_fee_eur,
                c.has_smart_meter,
                c.home_area_m2,
                c.household_size,
                c.locality_type,
                c.dwelling_type,
                c.build_year_band,
                c.heating_sources,
                c.has_solar,
                c.ev_count,
                c.alert_sensitivity,
                c.main_appliances,
                now,
            )
            for c in customers
        ],
    )
    conn.commit()
    return customers


def seasonal_temperature(ts: dt.datetime, city: str) -> float:
    # Portugal: inverno suave, verão quente; simplificado por dia do ano + ruído.
    day_of_year = ts.timetuple().tm_yday
    base = 16.0 + 7.0 * math.sin(2 * math.pi * (day_of_year - 170) / 365.0)
    coast_bias = -1.0 if city in {"Porto", "Matosinhos", "Vila Nova de Gaia", "Aveiro"} else 0.0
    return base + coast_bias


def simulate_watts(ts: dt.datetime, customer: Customer, last_watts: float | None, rng: random.Random) -> tuple[float, float]:
    hour = ts.hour + ts.minute / 60.0
    dow = ts.weekday()  # 0=Mon
    is_weekend = 1.0 if dow >= 5 else 0.0

    temp_c = seasonal_temperature(ts, customer.city) + rng.gauss(0.0, 1.2)

    if customer.segment == "residential":
        base = 180.0
        morning = 220.0 * math.exp(-((hour - 7.5) ** 2) / 5.5)
        evening = 380.0 * math.exp(-((hour - 20.5) ** 2) / 7.0)
        weekend_boost = 1.15 if is_weekend else 1.0
        load = (base + morning + evening) * weekend_boost
    elif customer.segment == "sme":
        base = 420.0
        business = 900.0 * math.exp(-((hour - 13.0) ** 2) / 18.0)
        weekend_penalty = 0.55 if is_weekend else 1.0
        load = (base + business) * weekend_penalty
    else:
        base = 1500.0
        shift = 1200.0 * math.exp(-((hour - 11.0) ** 2) / 26.0)
        load = base + shift

    # Ajuste por tipologia (área/pessoas) para tornar o contexto relevante
    area_factor = 1.0 + (customer.home_area_m2 - 80.0) / 420.0
    area_factor = max(0.7, min(2.2, area_factor))
    household_factor = 1.0 + (customer.household_size - 2) * 0.08
    household_factor = max(0.75, min(2.0, household_factor))
    load = load * area_factor * household_factor

    # Efeito de temperatura (aquecimento/arrefecimento): mais consumo quando muito frio/quente
    comfort = 19.0
    temp_effect = 18.0 * max(0.0, comfort - temp_c) + 14.0 * max(0.0, temp_c - 25.0)

    # Solar: reduz consumo diurno (produção própria) em clientes com painéis
    if customer.has_solar and 10 <= hour <= 16:
        solar_cut = 0.10 + 0.18 * math.exp(-((hour - 13.0) ** 2) / 4.5)
        load = load * (1.0 - solar_cut)

    # EV: picos noturnos (carregamento) quando existe veículo elétrico
    if customer.ev_count > 0 and (0 <= hour <= 6) and rng.random() < 0.10:
        load += 900.0 * customer.ev_count

    # Limite por potência contratada (kVA ~ kW assumido para simplificar)
    contracted_watts = customer.contracted_power_kva * 1000.0
    cap = contracted_watts * 0.92

    # Auto-correlação suave (mantém o perfil estável)
    if last_watts is None:
        last_watts = load

    noise = rng.gauss(0.0, max(12.0, 0.03 * load))
    watts = 0.70 * load + 0.25 * last_watts + 0.05 * temp_effect + noise
    watts = max(40.0, min(watts, cap))

    # Picos ocasionais (forno/industrial machine)
    if rng.random() < (0.004 if customer.segment == "residential" else 0.002):
        watts = min(cap, watts + rng.uniform(800.0, 2200.0))

    euros = (watts / 1000.0) * RATE_EUR_PER_KWH * INTERVAL_HOURS
    return float(watts), float(temp_c), float(euros)


def latest_ts(conn: sqlite3.Connection) -> dt.datetime | None:
    row = conn.execute("SELECT ts FROM customer_telemetry_15m ORDER BY ts DESC LIMIT 1").fetchone()
    if not row:
        return None
    return dt.datetime.fromisoformat(row[0]).astimezone(dt.timezone.utc)


def latest_watts_by_customer(conn: sqlite3.Connection) -> dict[str, float]:
    rows = conn.execute(
        """
        SELECT t.customer_id, t.watts
        FROM customer_telemetry_15m t
        JOIN (
          SELECT customer_id, MAX(ts) AS ts
          FROM customer_telemetry_15m
          GROUP BY customer_id
        ) last
        ON last.customer_id = t.customer_id AND last.ts = t.ts
        """
    ).fetchall()
    return {row[0]: float(row[1]) for row in rows}


def generate_steps(
    conn: sqlite3.Connection,
    customers: list[Customer],
    start_ts: dt.datetime,
    steps: int,
    seed: int,
) -> None:
    rng = random.Random(seed)
    last_by_customer = latest_watts_by_customer(conn)

    ts = start_ts
    insert_sql = (
        "INSERT INTO customer_telemetry_15m (customer_id, ts, watts, euros, temp_c, is_estimated) VALUES (?, ?, ?, ?, ?, 0)"
    )

    for _ in range(steps):
        rows = []
        ts_iso = ts.isoformat()
        for c in customers:
            last_watts = last_by_customer.get(c.id)
            watts, temp_c, euros = simulate_watts(ts, c, last_watts, rng)
            last_by_customer[c.id] = watts
            rows.append((c.id, ts_iso, watts, euros, temp_c))

        conn.executemany(insert_sql, rows)
        conn.commit()
        ts = ts + dt.timedelta(minutes=INTERVAL_MINUTES)


def main() -> None:
    parser = argparse.ArgumentParser(description="Gera clientes fictícios e consumos a cada 15 minutos (dados sintéticos).")
    parser.add_argument("--db", default=os.path.join(os.path.dirname(__file__), "data", "app.db"))
    parser.add_argument("--customers", type=int, default=25)
    parser.add_argument("--days", type=int, default=14, help="Se não houver dados, gera histórico de N dias.")
    parser.add_argument("--steps", type=int, default=96, help="Quantos intervalos de 15m gerar (modo rápido).")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--reset-customers", action="store_true", help="Apaga clientes + telemetria multi-cliente antes de gerar.")
    parser.add_argument("--realtime", action="store_true", help="Gera 1 amostra por cliente a cada 15m (loop infinito).")

    args = parser.parse_args()

    db_dir = os.path.dirname(args.db)
    os.makedirs(db_dir, exist_ok=True)

    conn = sqlite3.connect(args.db)
    conn.execute("PRAGMA journal_mode=WAL")
    ensure_schema(conn)

    if args.reset_customers:
        conn.execute("DELETE FROM customer_telemetry_15m")
        conn.execute("DELETE FROM customers")
        conn.commit()

    customers = load_customers(conn)
    if not customers:
        customers = create_customers(conn, args.customers, args.seed)

    last = latest_ts(conn)
    if last is None:
        start = _floor_to_15m(_now_utc() - dt.timedelta(days=args.days))
    else:
        start = last + dt.timedelta(minutes=INTERVAL_MINUTES)

    if args.realtime:
        while True:
            now = _now_utc()
            target = _next_15m_boundary(now)
            sleep_s = (target - now).total_seconds()
            if sleep_s > 0:
                time.sleep(sleep_s)
            # Gera exatamente 1 passo no boundary
            generate_steps(conn, customers, target, steps=1, seed=args.seed)
            # dorme até ao próximo boundary (extra safety)
            time.sleep(INTERVAL_MINUTES * 60)
    else:
        generate_steps(conn, customers, start, steps=args.steps, seed=args.seed)


if __name__ == "__main__":
    main()
