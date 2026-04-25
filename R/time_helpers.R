# time_helpers.R
# Pure-function helpers for converting between events, elapsed game time, and
# per-player minutes. No reactive dependencies — easy to unit-test.

#' Format seconds as MM:SS for the clock display.
fmt_clock <- function(seconds) {
  seconds <- max(0, round(seconds))
  sprintf("%02d:%02d", seconds %/% 60, seconds %% 60)
}

#' Total elapsed game seconds from start of game.
#' period       : 1-based current period
#' time_remaining : seconds left in current period
elapsed_game_seconds <- function(period, time_remaining,
                                 period_length = PERIOD_LENGTH_SECONDS) {
  (period - 1) * period_length + (period_length - time_remaining)
}

#' Compute cumulative on-court seconds per player from an event log.
#'
#' events : data.frame with columns
#'   player_id, event_type ("sub_on" / "sub_off"), elapsed_seconds
#' current_elapsed : current total elapsed game seconds (used to close out
#'                   players still on court)
#' all_player_ids  : all known player ids (so bench players show as 0, not NA)
minutes_from_events <- function(events, current_elapsed, all_player_ids) {
  totals <- setNames(rep(0, length(all_player_ids)), all_player_ids)

  if (nrow(events) == 0) return(totals / 60)

  events <- events[order(events$elapsed_seconds), ]
  for (pid in unique(events$player_id)) {
    pe <- events[events$player_id == pid, , drop = FALSE]
    on_since <- NA_real_
    total <- 0
    for (i in seq_len(nrow(pe))) {
      if (pe$event_type[i] == "sub_on") {
        on_since <- pe$elapsed_seconds[i]
      } else if (pe$event_type[i] == "sub_off" && !is.na(on_since)) {
        total <- total + (pe$elapsed_seconds[i] - on_since)
        on_since <- NA_real_
      }
    }
    if (!is.na(on_since)) {
      total <- total + max(0, current_elapsed - on_since)
    }
    if (pid %in% names(totals)) totals[[as.character(pid)]] <- total
  }
  totals / 60   # return minutes
}

#' Per-player consecutive minutes since they last came on court.
#' For bench players: 0. For on-court players: time since their most recent
#' sub_on event (or, after halftime, since the start of period 2).
consecutive_minutes <- function(events, current_elapsed, on_court_ids,
                                halftime_breaks = numeric(0)) {
  out <- setNames(numeric(length(on_court_ids)), on_court_ids)
  if (length(on_court_ids) == 0) return(out)

  for (pid in on_court_ids) {
    pe <- events[events$player_id == pid & events$event_type == "sub_on", , drop = FALSE]
    if (nrow(pe) == 0) {
      out[[as.character(pid)]] <- 0
      next
    }
    last_on <- max(pe$elapsed_seconds)
    # If a halftime break occurred *after* the player's last sub_on, treat that
    # as a rest — consecutive minutes count from the halftime resume.
    later_breaks <- halftime_breaks[halftime_breaks > last_on]
    rest_at <- if (length(later_breaks) > 0) max(later_breaks) else last_on
    out[[as.character(pid)]] <- max(0, current_elapsed - rest_at) / 60
  }
  out
}

#' Time since a player was last subbed (on or off), in seconds.
#' Used by the dashboard's "time since last sub" column.
time_since_last_sub <- function(events, current_elapsed, all_player_ids) {
  out <- setNames(rep(NA_real_, length(all_player_ids)), all_player_ids)
  if (nrow(events) == 0) return(out)
  for (pid in all_player_ids) {
    pe <- events[events$player_id == pid, , drop = FALSE]
    if (nrow(pe) == 0) next
    out[[as.character(pid)]] <- max(0, current_elapsed - max(pe$elapsed_seconds))
  }
  out
}

#' Empty events frame — used for resets and initial state.
empty_events <- function() {
  data.frame(
    player_id       = character(0),
    event_type      = character(0),
    elapsed_seconds = numeric(0),
    period          = integer(0),
    wall_time       = as.POSIXct(character(0)),
    stringsAsFactors = FALSE
  )
}
