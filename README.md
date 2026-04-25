# GSLPS Magic — Sub Manager

A courtside Shiny app for managing basketball substitutions on a tablet. Built
for the GSLPS Magic junior team (2 × 20-minute halves) but the period structure
is configurable.

## What it does

- Tracks game clock, period, and per-player cumulative minutes
- Two-panel "On Court / Bench" interface with large tap targets (≥ 60 px)
- Multi-select substitutions with a confirm step
- Soft rule warnings (scorer balance, ball-handler, fatigue, minutes spread)
- "Suggest a sub" — one-tap recommendation using a transparent scoring heuristic
- Live minutes dashboard with colour-coded fatigue indicators
- Crash recovery: in-progress game state is autosaved to disk every 5 s
- Roster persisted as CSV; completed games appended to a season-level CSV log

## Setup

```r
install.packages(c("shiny", "bslib", "DT", "dplyr", "tibble", "readr",
                   "jsonlite"))
```

Then from the project directory:

```r
shiny::runApp(".")
```

## File structure

```
.
├── app.R                  # entry point, navbar layout, autosave loop
├── global.R               # libraries, constants, sources modules
├── R/                     # auto-loaded helpers
│   ├── rules.R            # rule registry + evaluate_rules() engine
│   ├── suggest.R          # substitution scoring + recommendation
│   ├── persistence.R      # roster CSV, game-state JSON, log CSV
│   └── time_helpers.R     # event-log → minutes/consecutive-time projections
├── modules/               # Shiny modules (sourced from global.R)
│   ├── mod_clock.R        # game clock, period, halftime
│   ├── mod_roster.R       # editable roster table
│   ├── mod_court.R        # on-court / bench / suggestion / confirm flow
│   ├── mod_dashboard.R    # live minutes table
│   └── mod_rules.R        # rule on/off toggles + thresholds
├── data/
│   ├── roster.csv         # 10 fictional players to start with
│   ├── game_state.json    # autosave (created at runtime)
│   └── game_log.csv       # season log (created on first "End game")
└── www/styles.css         # tablet-friendly CSS (large buttons, contrast)
```

## How the reactivity flows

```
mod_roster ─► roster()                       data frame of players
mod_clock  ─► period(), time_remaining(),
              elapsed(), halftime_breaks()
mod_rules  ─► enabled(), params()
                       │
                       ▼
mod_court  ── owns on_court_ids and the events log.
              On confirm: builds proposed_lineup, calls evaluate_rules(),
              shows the warning modal if any rule fails.
              Exposes events(), minutes(), consec(), on_court_ids().
                       │
                       ▼
mod_dashboard ── pure projection of (roster, court state, clock).
```

The event log is the single source of truth for minutes. Anything time-derived
(minutes played, consecutive minutes, time since last sub) is recomputed from
the log via `R/time_helpers.R`. That keeps the model robust to undo/redo and
crash recovery.

## Rules

Rules live in `R/rules.R`. Each rule is an independent function with this
contract:

```r
rule_my_thing <- function(state) {
  list(
    passed   = TRUE / FALSE,
    severity = "warning" | "info",
    message  = "Human-readable string for the modal",
    rule_id  = "my_thing"
  )
}
```

The `state` arg includes:

| Field                  | What it is                                          |
|------------------------|-----------------------------------------------------|
| `proposed_on_court`    | data.frame of the 5 players proposed on court       |
| `current_minutes`      | named numeric, minutes played per player_id         |
| `consecutive_minutes`  | named numeric, on-court time without rest           |
| `elapsed_game_min`     | total game minutes elapsed                          |
| `params`               | thresholds (configurable via the Rules tab)         |

### Adding a new rule

1. Write the function in `R/rules.R` following the contract above.
2. Add it to the `RULES` list with a stable `rule_id`.
3. Add a friendly label to `RULE_LABELS`.
4. Add `rule_id = TRUE` to `DEFAULT_RULES_ENABLED`.
5. (Optional) If your rule needs a tunable threshold, add a default to
   `DEFAULT_RULE_PARAMS` in `global.R` and a `sliderInput` in
   `modules/mod_rules.R`.

The settings tab will pick up the new rule automatically — `rule_toggles`
iterates `names(RULES)`.

### Disabling a rule at runtime

Toggle it off in the **Rules** tab. The toggle state feeds
`evaluate_rules(state, enabled = ...)` — disabled rules aren't evaluated.

## Rules included

| ID                    | What it checks                                                         |
|-----------------------|------------------------------------------------------------------------|
| `scorer_balance`      | Need at least 1 primary OR 2 secondary scorers on court                |
| `ball_handler`        | At least one ball-handler on court                                     |
| `consecutive_minutes` | No on-court player past the configurable threshold (default 5 min)     |
| `minutes_spread`      | No player more than ±N min from team average (default 4)               |

## Suggestion algorithm

When a court player is tapped (and no bench player yet), the right panel ranks
the bench by:

- **Fairness** (×2): bringing on a low-minutes player gets a higher score
- **Fatigue** (×1.5): subbing off a tired player gets a higher score
- **Rule penalty** (-10 per failed rule): rule-breaking swaps drop sharply
- **Role match** (+1 same tier, +0.5 ball-handler-for-ball-handler)

Every suggestion shows its reasons. The "Suggest a sub now" button picks the
best one-for-one across all on-court players.

## Roster CSV schema

```
player_id    chr   stable id used in the event log
name         chr
jersey       int
scorer_tier  chr   "primary" | "secondary" | "role"
ball_handler bool  TRUE / FALSE
```

Edit in Excel or in-app on the Roster tab. The `player_id` column is read-only
in-app — keep it stable so historical game logs remain joinable.

## Game log CSV

`data/game_log.csv` is appended each time you press "End game". One row per
event with columns: `player_id`, `event_type` (`sub_on`/`sub_off`),
`elapsed_seconds`, `period`, `wall_time`, `game_id`.

## Tablet tips

- The viewport meta tag is set so iPad/Android won't zoom on tap.
- Targets are minimum 60 px (most are 72 px). Confirm/Cancel are 88 px.
- The mini-clock in the navbar stays visible from any tab.

## Design decisions worth knowing

- **CSV-only persistence** (no SQLite). Roster is a single small file; game
  logs are append-only flat rows. Simpler dependency tree, easier to inspect.
- **Halftime resets the consecutive-minutes counter** for everyone, since the
  break between halves is a real rest period.
- **Game state autosaves every 5 seconds** to `data/game_state.json`. On
  startup the app offers to resume if a saved game is found.
- **The clock is wall-clock-based**, not tick-decremented, so it doesn't drift
  over a 20-minute half even under heavy reactive load.
- **Rules are soft warnings, never hard blocks** — the coach always has the
  override-and-confirm path.
