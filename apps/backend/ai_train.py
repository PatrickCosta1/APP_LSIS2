from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import random
import sqlite3
from dataclasses import dataclass
from typing import Any

INTERVAL_MINUTES = 15


def _now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _parse_ts(ts: str) -> dt.datetime:
    return dt.datetime.fromisoformat(ts).astimezone(dt.timezone.utc)


@dataclass(frozen=True)
class Customer:
    id: str
    segment: str
    city: str
    contracted_power_kva: float
    tariff: str
    home_area_m2: float
    household_size: int
    has_solar: int
    ev_count: int


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
          created_at TEXT NOT NULL
        )
        """
    )

    ensure_column("customers", "home_area_m2", "REAL NOT NULL DEFAULT 80")
    ensure_column("customers", "household_size", "INTEGER NOT NULL DEFAULT 2")
    ensure_column("customers", "has_solar", "INTEGER NOT NULL DEFAULT 0")
    ensure_column("customers", "ev_count", "INTEGER NOT NULL DEFAULT 0")
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


def load_customers(conn: sqlite3.Connection) -> dict[str, Customer]:
    rows = conn.execute(
        "SELECT id, segment, city, contracted_power_kva, tariff, home_area_m2, household_size, has_solar, ev_count FROM customers ORDER BY id ASC"
    ).fetchall()
    return {
        row[0]: Customer(
            id=row[0],
            segment=row[1],
            city=row[2],
            contracted_power_kva=float(row[3]),
            tariff=row[4],
            home_area_m2=float(row[5] if row[5] is not None else 80),
            household_size=int(row[6] if row[6] is not None else 2),
            has_solar=int(row[7] if row[7] is not None else 0),
            ev_count=int(row[8] if row[8] is not None else 0),
        )
        for row in rows
    }


def _seasonal_temp(ts: dt.datetime, city: str) -> float:
    day = ts.timetuple().tm_yday
    base = 16.0 + 7.0 * math.sin(2 * math.pi * (day - 170) / 365.0)
    coast_bias = -1.0 if city in {"Porto", "Matosinhos", "Vila Nova de Gaia", "Aveiro"} else 0.0
    return base + coast_bias


def feature_names() -> list[str]:
    return [
        "last_watts",
        "hour_sin",
        "hour_cos",
        "dow_sin",
        "dow_cos",
        "is_weekend",
        "temp_c",
        "contracted_power_kva",
        "tariff_simples",
        "tariff_bihorario",
        "segment_residential",
        "segment_sme",
        "segment_industrial",
        "home_area_m2",
        "household_size",
        "has_solar",
        "ev_count",
    ]


def make_features(ts: dt.datetime, customer: Customer, last_watts: float, temp_c: float | None) -> list[float]:
    hour = ts.hour + ts.minute / 60.0
    dow = ts.weekday()
    is_weekend = 1.0 if dow >= 5 else 0.0

    hour_rad = 2 * math.pi * (hour / 24.0)
    dow_rad = 2 * math.pi * (dow / 7.0)

    if temp_c is None:
        temp_c = _seasonal_temp(ts, customer.city)

    t_simple = 1.0 if customer.tariff == "Simples" else 0.0
    t_bi = 1.0 if customer.tariff == "Bi-horário" else 0.0

    s_res = 1.0 if customer.segment == "residential" else 0.0
    s_sme = 1.0 if customer.segment == "sme" else 0.0
    s_ind = 1.0 if customer.segment == "industrial" else 0.0

    return [
        float(last_watts),
        math.sin(hour_rad),
        math.cos(hour_rad),
        math.sin(dow_rad),
        math.cos(dow_rad),
        float(is_weekend),
        float(temp_c),
        float(customer.contracted_power_kva),
        t_simple,
        t_bi,
        s_res,
        s_sme,
        s_ind,
        float(customer.home_area_m2),
        float(customer.household_size),
        float(customer.has_solar),
        float(customer.ev_count),
    ]


def dot(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b, strict=True))


def mat_transpose(m: list[list[float]]) -> list[list[float]]:
    return [list(row) for row in zip(*m, strict=True)]


def mat_mul(a: list[list[float]], b: list[list[float]]) -> list[list[float]]:
    bt = mat_transpose(b)
    return [[dot(row, col) for col in bt] for row in a]


def mat_vec_mul(a: list[list[float]], v: list[float]) -> list[float]:
    return [dot(row, v) for row in a]


def identity(n: int) -> list[list[float]]:
    return [[1.0 if i == j else 0.0 for j in range(n)] for i in range(n)]


def invert_matrix(a: list[list[float]]) -> list[list[float]]:
    # Gauss-Jordan elimination
    n = len(a)
    aug = [row[:] + ident_row[:] for row, ident_row in zip(a, identity(n), strict=True)]

    for col in range(n):
        # pivot
        pivot = col
        for r in range(col + 1, n):
            if abs(aug[r][col]) > abs(aug[pivot][col]):
                pivot = r
        if abs(aug[pivot][col]) < 1e-12:
            raise ValueError("Matriz singular ou mal condicionada")
        if pivot != col:
            aug[col], aug[pivot] = aug[pivot], aug[col]

        # normalize pivot row
        pv = aug[col][col]
        inv_pv = 1.0 / pv
        aug[col] = [x * inv_pv for x in aug[col]]

        # eliminate other rows
        for r in range(n):
            if r == col:
                continue
            factor = aug[r][col]
            if abs(factor) < 1e-12:
                continue
            aug[r] = [rv - factor * cv for rv, cv in zip(aug[r], aug[col], strict=True)]

    inv = [row[n:] for row in aug]
    return inv


def standardize(x: list[list[float]]) -> tuple[list[list[float]], list[float], list[float]]:
    n = len(x)
    d = len(x[0])

    means = [0.0] * d
    for row in x:
        for j, v in enumerate(row):
            means[j] += v
    means = [m / n for m in means]

    stds = [0.0] * d
    for row in x:
        for j, v in enumerate(row):
            stds[j] += (v - means[j]) ** 2
    stds = [math.sqrt(s / max(1, n - 1)) for s in stds]

    # avoid zeros
    stds = [s if s > 1e-9 else 1.0 for s in stds]

    xz = [[(row[j] - means[j]) / stds[j] for j in range(d)] for row in x]
    return xz, means, stds


def ridge_fit(x: list[list[float]], y: list[float], l2: float) -> tuple[list[float], float, list[float], list[float]]:
    # Standardize X and fit ridge with bias
    xz, means, stds = standardize(x)
    n = len(xz)
    d = len(xz[0])

    # Center y to fit bias separately
    y_mean = sum(y) / n
    yc = [v - y_mean for v in y]

    xt = mat_transpose(xz)
    xtx = mat_mul(xt, xz)
    for i in range(d):
        xtx[i][i] += l2

    xty = mat_vec_mul(xt, yc)
    inv = invert_matrix(xtx)
    w = mat_vec_mul(inv, xty)

    # bias is y_mean - sum(w_j * mean_xz_j) but mean of xz is ~0, so bias=y_mean
    bias = y_mean
    return w, bias, means, stds


def predict_row(x: list[float], w: list[float], bias: float, means: list[float], stds: list[float]) -> float:
    xz = [(x[j] - means[j]) / stds[j] for j in range(len(x))]
    return dot(xz, w) + bias


def metrics(y_true: list[float], y_pred: list[float]) -> dict[str, float]:
    n = len(y_true)
    err = [yp - yt for yt, yp in zip(y_true, y_pred, strict=True)]
    mae = sum(abs(e) for e in err) / n
    rmse = math.sqrt(sum(e * e for e in err) / n)
    y_mean = sum(y_true) / n
    ss_tot = sum((yt - y_mean) ** 2 for yt in y_true)
    ss_res = sum((yt - yp) ** 2 for yt, yp in zip(y_true, y_pred, strict=True))
    r2 = 1.0 - (ss_res / ss_tot if ss_tot > 1e-12 else 0.0)
    return {"mae": float(mae), "rmse": float(rmse), "r2": float(r2)}


def load_training_pairs(conn: sqlite3.Connection, customer_map: dict[str, Customer], since: str) -> tuple[list[list[float]], list[float]]:
    # Carrega por cliente em ordem temporal e cria pares (t -> t+1)
    x: list[list[float]] = []
    y: list[float] = []

    cust_ids = list(customer_map.keys())
    for cid in cust_ids:
        rows = conn.execute(
            "SELECT ts, watts, temp_c FROM customer_telemetry_15m WHERE customer_id = ? AND ts >= ? ORDER BY ts ASC",
            (cid, since),
        ).fetchall()
        if len(rows) < 3:
            continue

        c = customer_map[cid]
        for i in range(len(rows) - 1):
            ts = _parse_ts(rows[i][0])
            last_watts = float(rows[i][1])
            temp_c = rows[i][2]
            feats = make_features(ts, c, last_watts=last_watts, temp_c=float(temp_c) if temp_c is not None else None)
            target = float(rows[i + 1][1])
            x.append(feats)
            y.append(target)

    return x, y


def main() -> None:
    parser = argparse.ArgumentParser(description="Treina um modelo simples (ridge linear) para prever o próximo consumo (15m).")
    parser.add_argument("--db", default=os.path.join(os.path.dirname(__file__), "data", "app.db"))
    parser.add_argument("--days", type=int, default=14)
    parser.add_argument("--lambda", dest="l2", type=float, default=2.0)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "data", "ai_model.json"))

    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    ensure_schema(conn)

    customer_map = load_customers(conn)
    if not customer_map:
        raise SystemExit("Sem clientes. Execute primeiro: py -3 apps/backend/ai_generate.py --customers 25")

    since = (_now_utc() - dt.timedelta(days=args.days)).isoformat()
    x, y = load_training_pairs(conn, customer_map, since)
    if len(x) < 200:
        raise SystemExit(
            f"Poucos dados para treinar ({len(x)} amostras). Gere mais: py -3 apps/backend/ai_generate.py --days 30 --steps 96"
        )

    rng = random.Random(args.seed)
    idx = list(range(len(x)))
    rng.shuffle(idx)

    split = int(len(idx) * 0.8)
    tr_idx = idx[:split]
    te_idx = idx[split:]

    x_tr = [x[i] for i in tr_idx]
    y_tr = [y[i] for i in tr_idx]
    x_te = [x[i] for i in te_idx]
    y_te = [y[i] for i in te_idx]

    w, bias, means, stds = ridge_fit(x_tr, y_tr, l2=float(args.l2))
    preds = [predict_row(row, w, bias, means, stds) for row in x_te]
    m = metrics(y_te, preds)

    payload: dict[str, Any] = {
        "version": 1,
        "trained_at": _now_utc().isoformat(),
        "interval_minutes": INTERVAL_MINUTES,
        "l2": float(args.l2),
        "feature_names": feature_names(),
        "mean": [float(v) for v in means],
        "std": [float(v) for v in stds],
        "weights": [float(v) for v in w],
        "bias": float(bias),
        "metrics": m,
        "notes": "Modelo linear ridge (sintético). Treinar novamente quando houver mais dados reais.",
    }

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    print(f"Modelo guardado em: {args.out}")
    print(f"Amostras treino/teste: {len(x_tr)}/{len(x_te)}")
    print(f"Métricas: {m}")


if __name__ == "__main__":
    main()
