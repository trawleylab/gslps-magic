# global.R
# Loaded once at app startup. Holds libraries, constants, and sources helper / module files.

suppressPackageStartupMessages({
  library(shiny)
  library(bslib)
  library(DT)
  library(dplyr)
  library(tibble)
  library(readr)
  library(jsonlite)
})

# ---- constants ----------------------------------------------------------------

# GSLPS Magic plays 2 x 20 minute halves. Change PERIOD_LENGTH_SECONDS / N_PERIODS
# here if the team ever switches to quarters or different lengths.
N_PERIODS              <- 2
PERIOD_LENGTH_SECONDS  <- 20 * 60
LINEUP_SIZE            <- 5

DATA_DIR               <- "data"
ROSTER_PATH            <- file.path(DATA_DIR, "roster.csv")
GAME_STATE_PATH        <- file.path(DATA_DIR, "game_state.json")   # autosaved in-progress game
GAME_LOG_PATH          <- file.path(DATA_DIR, "game_log.csv")       # appended on game end

AUTOSAVE_INTERVAL_MS   <- 5000   # how often to flush game state to disk

# Default rule parameters. The mod_rules settings panel can tweak these at runtime.
DEFAULT_RULE_PARAMS <- list(
  consecutive_minutes_threshold = 5,    # warn if a player has been on this long without a rest
  minutes_spread_tolerance      = 4,    # warn if a player is this many minutes above/below team avg
  warn_color_minutes            = 4     # dashboard goes amber at this many consecutive minutes
)

# ---- source helpers (modules folder is sourced explicitly; R/ auto-loads) -----

# Source modules. R/ subdirectory is auto-loaded by Shiny so helpers there don't
# need an explicit source().
local({
  module_files <- list.files("modules", pattern = "\\.R$", full.names = TRUE)
  for (f in module_files) source(f, local = FALSE)
})
