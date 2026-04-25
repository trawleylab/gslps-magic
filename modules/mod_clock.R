# mod_clock.R
# Game clock module. Owns the period number, time remaining, and running flag.
# Exposes a reactive that other modules read to compute elapsed game time.
#
# Reactive flow:
#   tick() ── invalidateLater(1000) when running ──┐
#                                                  ▼
#   time_remaining() ── (running) ? at_pause - (now - running_since) : at_pause
#                                                  │
#   elapsed() ── (period - 1) * len + (len - time_remaining())
#                                                  │
#   exposed via the returned list to mod_court / mod_dashboard / mod_rules

clockUI <- function(id) {
  ns <- NS(id)
  card(
    class = "clock-card",
    card_header(textOutput(ns("period_label"), inline = TRUE)),
    div(class = "clock-display", textOutput(ns("clock"))),
    layout_column_wrap(
      width = 1/2, gap = "0.5rem",
      actionButton(ns("toggle"),    label = "Start",  class = "btn-clock btn-lg"),
      actionButton(ns("reset"),     label = "Reset",  class = "btn-clock btn-lg"),
      actionButton(ns("next_period"), label = "End half", class = "btn-clock btn-lg"),
      actionButton(ns("nudge"),     label = "-10s",   class = "btn-clock btn-lg")
    )
  )
}

clockServer <- function(id, on_period_end = function(elapsed) {}) {
  moduleServer(id, function(input, output, session) {

    # rv holds the clock's authoritative state. Computed values are reactives.
    rv <- reactiveValues(
      period          = 1L,
      time_at_pause   = PERIOD_LENGTH_SECONDS,  # seconds remaining when last paused
      running         = FALSE,
      running_since   = NULL,                   # wall-clock time started
      halftime_breaks = numeric(0)              # elapsed-game-seconds at each period boundary
    )

    # Compute current time remaining. While running, use wall-clock to avoid
    # the drift you'd get from invalidateLater + naive decrement.
    time_remaining <- reactive({
      if (rv$running) {
        invalidateLater(500, session)
        elapsed_run <- as.numeric(difftime(Sys.time(), rv$running_since, units = "secs"))
        max(0, rv$time_at_pause - elapsed_run)
      } else {
        rv$time_at_pause
      }
    })

    elapsed <- reactive({
      elapsed_game_seconds(rv$period, time_remaining())
    })

    # ---- displays --------------------------------------------------------
    output$period_label <- renderText({
      sprintf("Half %d of %d", rv$period, N_PERIODS)
    })
    output$clock <- renderText(fmt_clock(time_remaining()))

    # Update the toggle button label based on running state.
    observe({
      updateActionButton(session, "toggle",
                        label = if (rv$running) "Stop" else "Start")
    })

    # ---- start/stop ------------------------------------------------------
    observeEvent(input$toggle, {
      if (rv$running) {
        # stop: capture exact remaining
        rv$time_at_pause <- time_remaining()
        rv$running       <- FALSE
        rv$running_since <- NULL
      } else {
        # start (only if time left)
        if (rv$time_at_pause > 0) {
          rv$running       <- TRUE
          rv$running_since <- Sys.time()
        }
      }
    })

    observeEvent(input$reset, {
      rv$running       <- FALSE
      rv$running_since <- NULL
      rv$time_at_pause <- PERIOD_LENGTH_SECONDS
    })

    observeEvent(input$nudge, {
      # -10s correction for human error. Doesn't cross zero.
      cur <- time_remaining()
      rv$time_at_pause <- max(0, cur - 10)
      if (rv$running) rv$running_since <- Sys.time()
    })

    # End the current half and advance period. Records the halftime point so
    # consecutive_minutes() treats it as a rest for everyone.
    observeEvent(input$next_period, {
      # Stop clock first
      if (rv$running) {
        rv$time_at_pause <- time_remaining()
        rv$running       <- FALSE
      }
      end_at <- elapsed_game_seconds(rv$period, rv$time_at_pause)
      rv$halftime_breaks <- c(rv$halftime_breaks, end_at)

      if (rv$period < N_PERIODS) {
        rv$period        <- rv$period + 1L
        rv$time_at_pause <- PERIOD_LENGTH_SECONDS
      } else {
        # game over — clock pinned at 0 of last period
        rv$time_at_pause <- 0
      }
      on_period_end(end_at)
    })

    # If the clock naturally hits 0 while running, stop and fire the period-end
    # handler. We poll cheaply via observe + isolate.
    observe({
      tr <- time_remaining()
      if (rv$running && tr <= 0) {
        rv$running       <- FALSE
        rv$running_since <- NULL
        rv$time_at_pause <- 0
        end_at <- elapsed_game_seconds(rv$period, 0)
        rv$halftime_breaks <- c(rv$halftime_breaks, end_at)
        on_period_end(end_at)
      }
    })

    # ---- exposed API to other modules -----------------------------------
    list(
      period          = reactive(rv$period),
      time_remaining  = time_remaining,
      elapsed         = elapsed,
      running         = reactive(rv$running),
      halftime_breaks = reactive(rv$halftime_breaks),
      # Setters used by load_game_state to restore from disk
      restore = function(period, time_remaining, halftime_breaks) {
        rv$running         <- FALSE
        rv$period          <- as.integer(period)
        rv$time_at_pause   <- as.numeric(time_remaining)
        rv$halftime_breaks <- as.numeric(halftime_breaks %||% numeric(0))
      }
    )
  })
}
