# persistence.R
# Disk I/O helpers. Roster lives in CSV (trivial to edit in Excel). In-progress
# game state autosaves to JSON for crash recovery on a courtside tablet.
# Completed games append a flat row-per-event CSV to GAME_LOG_PATH.

# ---- roster ------------------------------------------------------------------

load_roster <- function(path = ROSTER_PATH) {
  if (!file.exists(path)) return(empty_roster())
  df <- readr::read_csv(path, show_col_types = FALSE)

  # Backfill any missing columns so older CSVs still load.
  required <- c("player_id", "name", "jersey", "scorer_tier", "ball_handler")
  for (col in setdiff(required, names(df))) df[[col]] <- NA

  # Generate ids if missing — stable string ids keep the event log readable.
  if (any(is.na(df$player_id) | df$player_id == "")) {
    df$player_id <- ifelse(is.na(df$player_id) | df$player_id == "",
                           paste0("p", seq_len(nrow(df))),
                           df$player_id)
  }
  df$ball_handler <- as.logical(df$ball_handler)
  df$scorer_tier  <- factor(df$scorer_tier, levels = c("primary", "secondary", "role"))
  df[, required, drop = FALSE]
}

save_roster <- function(df, path = ROSTER_PATH) {
  dir.create(dirname(path), showWarnings = FALSE, recursive = TRUE)
  readr::write_csv(df, path)
}

empty_roster <- function() {
  tibble::tibble(
    player_id    = character(0),
    name         = character(0),
    jersey       = integer(0),
    scorer_tier  = factor(character(0), levels = c("primary", "secondary", "role")),
    ball_handler = logical(0)
  )
}

# ---- game state autosave (crash recovery) ------------------------------------

#' Snapshot of in-progress game state. Written every AUTOSAVE_INTERVAL_MS while
#' a game is running. Read on app startup to offer "resume game?".
save_game_state <- function(state, path = GAME_STATE_PATH) {
  dir.create(dirname(path), showWarnings = FALSE, recursive = TRUE)
  payload <- list(
    saved_at        = format(Sys.time(), "%Y-%m-%dT%H:%M:%S"),
    period          = state$period,
    time_remaining  = state$time_remaining,
    running         = FALSE,   # never autosave as running — always resume paused
    on_court_ids    = state$on_court_ids,
    events          = state$events,
    halftime_breaks = state$halftime_breaks
  )
  jsonlite::write_json(payload, path, auto_unbox = TRUE, pretty = TRUE,
                       POSIXt = "ISO8601")
}

load_game_state <- function(path = GAME_STATE_PATH) {
  if (!file.exists(path)) return(NULL)
  raw <- tryCatch(jsonlite::read_json(path, simplifyVector = TRUE),
                  error = function(e) NULL)
  if (is.null(raw)) return(NULL)
  # jsonlite's simplifyVector turns 0-row frames into empty lists — patch.
  if (is.list(raw$events) && length(raw$events) == 0) raw$events <- empty_events()
  raw
}

clear_game_state <- function(path = GAME_STATE_PATH) {
  if (file.exists(path)) file.remove(path)
}

# ---- completed game log (append-only) ----------------------------------------

#' Append a finished game's event log to GAME_LOG_PATH for season-level
#' analysis later. One row per event, with a game_id grouping column.
append_game_log <- function(events, game_id = format(Sys.time(), "%Y%m%d_%H%M%S"),
                            path = GAME_LOG_PATH) {
  if (nrow(events) == 0) return(invisible(NULL))
  dir.create(dirname(path), showWarnings = FALSE, recursive = TRUE)
  events$game_id <- game_id
  if (file.exists(path)) {
    readr::write_csv(events, path, append = TRUE)
  } else {
    readr::write_csv(events, path)
  }
  invisible(game_id)
}
