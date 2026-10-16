"""Minimal FastAPI wrapper exposing the trained model to a separate frontend.

Run from the project root with:
    uvicorn api.app:app --reload --port 8000
"""
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

import numpy as np
import pandas as pd
from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from src import fetch_data, train_model, wrangle
from src.predict import MODEL_PATH, _load_pipeline, predict_value

PROCESSED_DIR = Path(__file__).resolve().parent.parent / "data" / "processed"
DATASET_PATH = PROCESSED_DIR / "dataset.csv"

app = FastAPI(title="Transfer Value Predictor API")

# Wide open CORS: this API is meant to be called directly from a separately
# hosted frontend (e.g. a Claude Design canvas artifact, or a local dev
# server on any port) - there's no cookie/session auth to protect here.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_pipeline = None

_refresh_lock = threading.Lock()
_refresh_state = {
    "status": "idle",  # idle | running | done | error
    "started_at": None,
    "finished_at": None,
    "error": None,
}


def get_pipeline():
    global _pipeline
    if _pipeline is None:
        _pipeline = _load_pipeline()
    return _pipeline


def _run_refresh():
    """Re-download the dataset, rebuild features, and retrain the model.

    Runs in a background thread; only one refresh can be in flight at a time.
    """
    global _pipeline
    try:
        fetch_data.download(force=True)

        PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
        dataset = wrangle.build_dataset()
        dataset.to_csv(DATASET_PATH, index=False)

        train_model.train(model_name="linear", save=True)
        _pipeline = None  # force reload of the freshly trained pipeline

        _refresh_state["status"] = "done"
        _refresh_state["error"] = None
    except Exception as exc:  # noqa: BLE001 - surface any failure to the frontend
        _refresh_state["status"] = "error"
        _refresh_state["error"] = str(exc)
    finally:
        _refresh_state["finished_at"] = datetime.now(timezone.utc).isoformat()
        _refresh_lock.release()


def get_dataset() -> pd.DataFrame:
    if not DATASET_PATH.exists():
        raise HTTPException(
            status_code=503,
            detail="Processed dataset not found. Run `python -m src.wrangle` first.",
        )
    return pd.read_csv(DATASET_PATH)


def to_records(df: pd.DataFrame) -> List[dict]:
    """df.to_dict() leaves numpy scalar types in place; cast them to native
    Python int/float so Pydantic response-model validation doesn't choke."""
    records = df.to_dict(orient="records")
    for record in records:
        for key, value in record.items():
            if isinstance(value, np.integer):
                record[key] = int(value)
            elif isinstance(value, np.floating):
                record[key] = float(value)
    return records


class PlayerSeason(BaseModel):
    player_id: int
    name: str
    image_url: str
    season: int
    position_group: str
    age: float
    years_from_peak: float
    goals: int
    assists: int
    goals_per_90: float
    assists_per_90: float
    minutes_played: int
    minutes_share: float
    market_value_eur: float


class PlayerSeasonWithPrediction(PlayerSeason):
    predicted_value_eur: float


class PredictRequest(BaseModel):
    goals: float = Field(..., ge=0)
    assists: float = Field(..., ge=0)
    age: float = Field(..., gt=0)
    minutes_played: float = Field(..., ge=0)
    position_group: str = Field(..., pattern="^(GK|DEF|MID|FWD)$")
    minutes_share: float = Field(1.0, ge=0, le=1)


class PredictResponse(BaseModel):
    predicted_value_eur: float


@app.get("/health")
def health():
    """Lightweight liveness check for the frontend's connected/unreachable state."""
    return {
        "status": "ok",
        "dataset_available": DATASET_PATH.exists(),
        "model_available": MODEL_PATH.exists(),
    }


@app.get("/players", response_model=List[PlayerSeason])
def list_players(season: Optional[int] = None):
    """Return player-season rows for a table view, optionally filtered to one season.

    If `season` has no matching rows, returns an empty list rather than an error.
    """
    df = get_dataset()
    if season is not None:
        df = df[df["season"] == season]
    return to_records(df)


@app.get("/players/{name}", response_model=PlayerSeasonWithPrediction)
def get_player(name: str, season: Optional[int] = None):
    """Return one player's stats plus a predicted value.

    Without `season`, returns that player's most recent season. With `season`,
    returns that specific season, or 404 if the player has no data for it.
    """
    df = get_dataset()
    matches = df[df["name"].str.lower() == name.lower()]
    if season is not None:
        matches = matches[matches["season"] == season]
    if matches.empty:
        raise HTTPException(status_code=404, detail="Player not found")

    latest = matches.sort_values("season").iloc[-1]
    stats = to_records(pd.DataFrame([latest]))[0]

    predicted = predict_value(
        goals=stats["goals"],
        assists=stats["assists"],
        age=stats["age"],
        minutes_played=stats["minutes_played"],
        position_group=stats["position_group"],
        minutes_share=stats["minutes_share"],
        pipeline=get_pipeline(),
    )
    stats["predicted_value_eur"] = predicted
    return stats


@app.post("/predict", response_model=PredictResponse)
def predict(request: PredictRequest):
    """Predict a transfer value for arbitrary stats supplied by the caller."""
    value = predict_value(
        goals=request.goals,
        assists=request.assists,
        age=request.age,
        minutes_played=request.minutes_played,
        position_group=request.position_group,
        minutes_share=request.minutes_share,
        pipeline=get_pipeline(),
    )
    return PredictResponse(predicted_value_eur=value)


@app.post("/refresh", status_code=202)
def refresh(background_tasks: BackgroundTasks):
    """Kick off a re-download + re-wrangle + re-train in the background.

    Takes roughly 1-3 minutes (mostly the Kaggle download), so it does not
    block the request - poll GET /refresh/status for progress.
    """
    if not _refresh_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="A refresh is already in progress.")

    _refresh_state["status"] = "running"
    _refresh_state["started_at"] = datetime.now(timezone.utc).isoformat()
    _refresh_state["finished_at"] = None
    _refresh_state["error"] = None

    background_tasks.add_task(_run_refresh)
    return {"status": "running"}


@app.get("/refresh/status")
def refresh_status():
    """Poll this after POST /refresh to know when new data/model are ready."""
    return _refresh_state
