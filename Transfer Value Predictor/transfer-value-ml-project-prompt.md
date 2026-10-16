# Project Prompt: Football Player Transfer Value Predictor (Linear Regression)

Use this prompt to kick off a coding session (e.g. with Claude Code) to build the project.

---

## Prompt to use

```
Build a machine learning project that predicts a football (soccer) player's
transfer market value using a linear regression model trained on performance
statistics. The project should be a clean, well-documented Python codebase
I can run end-to-end and later connect to a separate frontend.

GOAL
Predict a continuous target variable: estimated transfer market value (in EUR)
for a given player-season, using performance data.

DATA SOURCE
- Use the free Kaggle dataset "Football Data from Transfermarkt" by David
  Cariboo (kaggle.com/datasets/davidcariboo/player-scores). It's free, no
  paid API key required, updated weekly, and — critically — it contains
  BOTH performance stats and transfer market values in one place, joinable
  by shared IDs, so no second data source is needed.
- Download via the Kaggle API (`kaggle datasets download -d
  davidcariboo/player-scores`) or manually from the Kaggle dataset page,
  and unzip into data/raw/. Requires a free Kaggle account and API token
  (~/.kaggle/kaggle.json) if using the CLI.
- Relevant CSV files within the dataset:
    players.csv           -> player_id, name, position, date_of_birth,
                              (derive age), current market value
    player_valuations.csv -> player_id, date, market_value_in_eur
                              (historical time series — use this as the label)
    appearances.csv        -> player_id, game_id, date, minutes_played,
                              goals, assists, yellow_cards, red_cards
    games.csv              -> game_id, date, season, competition_id
                              (needed to group appearances into seasons)
    clubs.csv / competitions.csv -> optional, for context/filtering to
                              specific leagues
- Join appearances.csv (grouped by player_id + season, derived via games.csv)
  with the closest player_valuations.csv entry for that season, using
  players.csv for position and date_of_birth (to compute age).
- Cache the downloaded/extracted CSVs locally so repeated runs don't
  re-download; treat data/raw/ as the untouched source and never overwrite it.

FEATURES TO ENGINEER
1. Goals — season total goals, and goals per 90 minutes played
2. Assists — season total assists, and a proxy for "chances created"
   (key passes per 90 if available, else assists per 90 as fallback)
3. Age — player age, plus "years from peak" (peak assumed ~27, so
   years_from_peak = abs(age - 27))
4. Minutes played — total minutes and share of available season minutes
   (minutes_played / max_possible_minutes) as an availability/fitness proxy
5. Position — categorical: GK, DEF, MID, FWD — one-hot encode this

Also compute:
- goals_per_90 = (goals / minutes_played) * 90
- assists_per_90 = (assists / minutes_played) * 90
- Handle divide-by-zero for players with very few minutes (set a minimum
  minutes threshold, e.g. exclude players with < 450 minutes played)

TECH STACK (use exactly this)
1. Data pulling: `kaggle` CLI/API (or manual download) to fetch the
   Transfermarkt CSVs listed above; `pandas.read_csv` to load them
2. Data wrangling: `pandas` — clean, merge multiple seasons/competitions,
   handle missing values, engineer the features above
3. Modeling: `scikit-learn` — LinearRegression (also add a Ridge and/or
   ElasticNet variant behind the same interface for comparison, since raw
   Linear Regression can overfit with correlated features like goals and
   goals_per_90)
4. Visualization: `matplotlib` — predicted vs. actual scatter plot with a
   y=x reference line, plus a residuals plot and a feature-importance
   (coefficient magnitude) bar chart

PROJECT STRUCTURE
Please scaffold it like this:

  transfer-value-predictor/
  ├── data/
  │   ├── raw/              # cached API pulls, raw CSVs
  │   └── processed/        # cleaned, merged, feature-engineered dataset
  ├── src/
  │   ├── fetch_data.py     # football-data.org API client + caching
  │   ├── wrangle.py        # cleaning, merging seasons, feature engineering
  │   ├── train_model.py    # train/test split, fit LinearRegression, save model
  │   ├── evaluate.py       # R², MAE, RMSE, predicted-vs-actual + residual plots
  │   └── predict.py        # load saved model, predict value for a single player
  ├── models/
  │   └── linear_regression_model.pkl   # saved trained model (joblib)
  ├── notebooks/
  │   └── exploration.ipynb # optional EDA notebook
  ├── outputs/
  │   └── figures/          # saved matplotlib PNGs
  ├── api/
  │   └── app.py            # a small FastAPI (or Flask) wrapper exposing
  │                          # /predict so a separate frontend (built in
  │                          # Claude Design) can call it
  ├── requirements.txt
  └── README.md

REQUIREMENTS FOR EACH STEP

1. fetch_data.py
   - Function to download the Kaggle "player-scores" dataset (via the
     kaggle CLI/API, falling back to a clear error message with manual
     download instructions if no Kaggle API token is configured)
   - Unzip and place the CSVs (players.csv, player_valuations.csv,
     appearances.csv, games.csv, clubs.csv, competitions.csv) into
     data/raw/
   - Skip re-downloading if the files already exist in data/raw/ unless
     a --force flag is passed

2. wrangle.py
   - Load players.csv, player_valuations.csv, appearances.csv, and
     games.csv from data/raw/
   - Group appearances.csv by player_id + season (join via games.csv to
     get each game's season) to get season totals: goals, assists,
     minutes_played
   - Join in the closest player_valuations.csv entry (by date) for that
     player-season as the target market_value_eur
   - Join in players.csv for position and date_of_birth -> compute age
     at that season
   - Engineer all features listed above
   - Drop or impute missing values (document the strategy used)
   - Filter out players below the minutes threshold
   - Save the final modeling dataset to data/processed/dataset.csv

3. train_model.py
   - Split data into train/test (e.g. 80/20, with a fixed random_state)
   - Build a scikit-learn Pipeline: ColumnTransformer (OneHotEncoder for
     position, StandardScaler for numeric features) -> LinearRegression
   - Fit the model
   - Save the fitted pipeline with joblib to models/linear_regression_model.pkl

4. evaluate.py
   - Report R², MAE, RMSE on the test set
   - Plot predicted vs. actual transfer value (matplotlib scatter + y=x line)
   - Plot residuals vs. predicted value
   - Plot standardized coefficients to show which features drive value most
   - Save all figures as PNGs to outputs/figures/

5. predict.py
   - CLI or function that takes a single player's stats (goals, assists,
     age, minutes, position) as input and returns a predicted transfer value
   - This is the function the API layer will call

6. api/app.py
   - Minimal FastAPI app with:
       GET  /players          -> returns the processed dataset (for a table view)
       GET  /players/{name}   -> returns one player's stats + predicted value
       POST /predict          -> accepts stats JSON, returns predicted value
   - Enable CORS so a frontend built elsewhere (Claude Design / a static site)
     can call it directly
   - This is the API surface the separate frontend project will consume —
     no frontend code needed here, just the endpoints.

7. README.md
   - How to create a free Kaggle account and API token
     (~/.kaggle/kaggle.json) to use the kaggle CLI, plus the manual
     download link as a fallback:
     https://www.kaggle.com/datasets/davidcariboo/player-scores
   - How to run the pipeline end-to-end (fetch -> wrangle -> train -> evaluate)
   - How to run the API locally
   - Example curl request/response for /predict
   - Model limitations (small transfer market samples, non-linear real-world
     value dynamics, injury/reputation/contract-length effects not captured)

DELIVER
Working, runnable code with clear inline comments, a requirements.txt with
pinned key versions, and a short summary at the end of what R²/MAE the model
achieves and which features matter most.
```

---

## Notes for you (not part of the prompt above)

- **Why this dataset**: the Kaggle "Football Data from Transfermarkt" set
  (davidcariboo/player-scores) is free, requires no paid API key, and — unlike
  football-data.org or most free football APIs — gives you both performance
  stats AND transfer market values in one connected set of CSVs. That removes
  the need to stitch together two separate sources for your label vs. your
  features. It's also updated weekly and backed by an open-source scraper on
  GitHub, so it's actively maintained rather than a one-off static dump.
- **Kaggle access**: you'll need a free Kaggle account either way. Using the
  `kaggle` CLI (via an API token) lets fetch_data.py automate the download;
  otherwise you can click "Download" on the dataset page and unzip manually
  into data/raw/.
- **Static snapshot caveat**: this is a downloaded dataset, not a live feed —
  fine for training/demoing a model, but it won't reflect transfers or
  valuation changes from after whenever you download it. If you want live
  data later, football-data.org or FBref (via the `soccerdata` package) can
  still supply fresher performance stats, joined against this dataset's
  valuation history.
- **Frontend split**: the prompt intentionally stops at a FastAPI layer with
  `/players` and `/predict` endpoints — that's the contract your Claude Design
  frontend will call. Once you have the API running locally (or deployed),
  hand Claude Design the endpoint list above plus example JSON responses.
- **Linear regression caveat worth keeping**: goals, goals_per_90, assists,
  and minutes are all correlated, so plain OLS coefficients can be unstable.
  The prompt asks for Ridge/ElasticNet as a comparison — worth keeping so
  your predicted-vs-actual plot isn't misleading.

You can paste the fenced prompt block directly into Claude Code (or a new
Claude chat) to start building.
