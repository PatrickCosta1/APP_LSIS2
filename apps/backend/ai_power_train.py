from __future__ import annotations

import datetime as dt
import json
import math
import os
import sqlite3
from dataclasses import dataclass
from typing import Any


def _now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


@dataclass(frozen=True)
class Customer:
    id: str
    segment: str
    contracted_power_kva: float
    home_area_m2: float
    household_size: int
    has_solar: int
    ev_count: int


def feature_names() -> list[str]:
    return [
        "contracted_power_kva",
        "peak_watts_30d",
        "avg_watts_30d",
        "home_area_m2",
        "household_size",
        "has_solar",
        "ev_count",
        "segment_residential",
        "segment_sme",
        "segment_industrial",
    ]


def dot(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b, strict=True))


def mat_transpose(m: list[list[float]]) -> list[list[float]]:
    return [list(row) for row in zip(*m, strict=True)]


def mat_mul(a: list[list[float]], b: list[list[float]]) -> list[list[float]]:
    bt = mat_transpose(b)
    return [[dot(row, col) for col in bt] for row in a]


def identity(n: int) -> list[list[float]]:
    return [[1.0 if i == j else 0.0 for j in range(n)] for i in range(n)]


def invert_matrix(a: list[list[float]]) -> list[list[float]]:
    n = len(a)
    aug = [row[:] + ident_row[:] for row, ident_row in zip(a, identity(n), strict=True)]

    for col in range(n):
        pivot = col
        for r in range(col + 1, n):
            if abs(aug[r][col]) > abs(aug[pivot][col]):
                pivot = r
        if abs(aug[pivot][col]) < 1e-12:
            raise ValueError("Matriz singular ou mal condicionada")
        if pivot != col:
            aug[col], aug[pivot] = aug[pivot], aug[col]

        pv = aug[col][col]
        inv_pv = 1.0 / pv
        aug[col] = [x * inv_pv for x in aug[col]]

        for r in range(n):
            if r == col:
                continue
            factor = aug[r][col]
            if abs(factor) < 1e-12:
                continue
            aug[r] = [rv - factor * cv for rv, cv in zip(aug[r], aug[col], strict=True)]

    return [row[n:] for row in aug]


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
    stds = [s if s > 1e-9 else 1.0 for s in stds]

    xz = [[(row[j] - means[j]) / stds[j] for j in range(d)] for row in x]
    return xz, means, stds


def ridge_fit(x: list[list[float]], y: list[float], l2: float) -> tuple[list[float], float, list[float], list[float]]:
    xz, means, stds = standardize(x)
    n = len(xz)
    d = len(xz[0])

    y_mean = sum(y) / n
    yc = [v - y_mean for v in y]

    xt = mat_transpose(xz)
    xtx = mat_mul(xt, xz)

    for j in range(d):
        xtx[j][j] += l2

    xty = [dot(col, yc) for col in xt]

    inv = invert_matrix(xtx)
    w = [dot(row, xty) for row in inv]
    b = y_mean
    return w, b, means, stds


def predict_row(row: list[float], w: list[float], b: float, means: list[float], stds: list[float]) -> float:
    xz = [(row[j] - means[j]) / stds[j] for j in range(len(row))]
    return b + dot(xz, w)


def metrics(y_true: list[float], y_pred: list[float]) -> dict[str, float]:
    n = len(y_true)
    mae = sum(abs(a - b) for a, b in zip(y_true, y_pred, strict=True)) / n
    mse = sum((a - b) ** 2 for a, b in zip(y_true, y_pred, strict=True)) / n
    rmse = math.sqrt(mse)

    y_mean = sum(y_true) / n
    ss_tot = sum((v - y_mean) ** 2 for v in y_true)
    ss_res = sum((a - b) ** 2 for a, b in zip(y_true, y_pred, strict=True))
    r2 = 1.0 - (ss_res / ss_tot) if ss_tot > 1e-12 else 0.0

    return {"mae": float(mae), "rmse": float(rmse), "r2": float(r2)}


def load_customers(conn: sqlite3.Connection) -> list[Customer]:
    rows = conn.execute(
        "SELECT id, segment, contracted_power_kva, home_area_m2, household_size, has_solar, ev_count FROM customers"
    ).fetchall()
    out: list[Customer] = []
    for r in rows:
        out.append(
            Customer(
                id=str(r[0]),
                segment=str(r[1]),
                contracted_power_kva=float(r[2]),
                home_area_m2=float(r[3] if r[3] is not None else 80),
                household_size=int(r[4] if r[4] is not None else 2),
                has_solar=int(r[5] if r[5] is not None else 0),
                ev_count=int(r[6] if r[6] is not None else 0),
            )
        )
    return out


def get_latest_ts(conn: sqlite3.Connection, customer_id: str) -> str | None:
    row = conn.execute(
        "SELECT ts FROM customer_telemetry_15m WHERE customer_id = ? ORDER BY ts DESC LIMIT 1",
        (customer_id,),
    ).fetchone()
    return str(row[0]) if row else None


def get_stats_30d(conn: sqlite3.Connection, customer_id: str, end_iso: str) -> tuple[float, float]:
    end = dt.datetime.fromisoformat(end_iso).astimezone(dt.timezone.utc)
    start = end - dt.timedelta(days=30)
    row = conn.execute(
        """
        SELECT COALESCE(MAX(watts), 0), COALESCE(AVG(watts), 0)
        FROM customer_telemetry_15m
        WHERE customer_id = ? AND ts BETWEEN ? AND ?
        """,
        (customer_id, start.isoformat(), end.isoformat()),
    ).fetchone()
    peak = float(row[0] if row and row[0] is not None else 0)
    avg = float(row[1] if row and row[1] is not None else 0)
    return peak, avg


def target_ideal_kva(customer: Customer, peak_watts_30d: float, avg_watts_30d: float) -> float:
    # "Ground-truth" sintético: margem sobre o pico + mínimo proporcional ao consumo médio.
    peak_kva = (peak_watts_30d / 1000.0) / 0.85 if peak_watts_30d > 0 else 1.0
    avg_kva = (avg_watts_30d / 1000.0) * 2.2 if avg_watts_30d > 0 else 1.0

    seg_margin = 0.15 if customer.segment == "industrial" else 0.10 if customer.segment == "sme" else 0.08
    base = max(peak_kva, avg_kva) * (1.0 + seg_margin)

    # discretiza para passos típicos (~0.1)
    kva = math.ceil(base * 10) / 10.0
    return float(min(60.0, max(1.0, kva)))


def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    default_db = os.path.join(here, "data", "app.db")
    db_path = os.environ.get("KYNEX_DB_PATH", default_db)

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    customers = load_customers(conn)

    x: list[list[float]] = []
    y: list[float] = []

    for c in customers:
        latest = get_latest_ts(conn, c.id)
        if not latest:
            continue
        peak30, avg30 = get_stats_30d(conn, c.id, latest)

        seg_res = 1.0 if c.segment == "residential" else 0.0
        seg_sme = 1.0 if c.segment == "sme" else 0.0
        seg_ind = 1.0 if c.segment == "industrial" else 0.0

        feats = [
            float(c.contracted_power_kva),
            float(peak30),
            float(avg30),
            float(c.home_area_m2),
            float(c.household_size),
            float(c.has_solar),
            float(c.ev_count),
            seg_res,
            seg_sme,
            seg_ind,
        ]
        x.append(feats)
        y.append(target_ideal_kva(c, peak30, avg30))

    if len(x) < 10:
        raise SystemExit("Poucos dados para treinar (precisa de pelo menos 10 clientes com telemetria)")

    l2 = float(os.environ.get("KYNEX_POWER_L2", "1.0"))
    w, b, means, stds = ridge_fit(x, y, l2)

    preds = [predict_row(row, w, b, means, stds) for row in x]
    m = metrics(y, preds)

    out: dict[str, Any] = {
        "version": 1,
        "trained_at": _now_utc().isoformat(),
        "l2": l2,
        "feature_names": feature_names(),
        "mean": means,
        "std": stds,
        "weights": w,
        "bias": b,
        "metrics": m,
    }

    out_path = os.path.join(here, "data", "ai_power_model.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)

    print(f"OK: modelo potência gravado em {out_path}")
    print(f"metrics: mae={m['mae']:.3f} rmse={m['rmse']:.3f} r2={m['r2']:.3f}")


if __name__ == "__main__":
    main()
