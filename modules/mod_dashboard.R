# mod_dashboard.R
# Live minutes table. Updates every second while the clock runs.
# Read-only — pure projection of (roster, events, clock).
#
# Columns shown:
#   Name | # | Status | Minutes | Consecutive | Time since last sub
# Rows are colour-coded amber when consecutive minutes pass the warn threshold.

dashboardUI <- function(id) {
  ns <- NS(id)
  card(
    card_header("Minutes dashboard"),
    DT::DTOutput(ns("table"))
  )
}

dashboardServer <- function(id, roster, court, clock, rule_settings) {
  moduleServer(id, function(input, output, session) {

    # Refresh once a second so live minutes tick visibly while clock runs.
    tick <- reactive({
      if (isTRUE(clock$running())) invalidateLater(1000, session)
      Sys.time()
    })

    table_df <- reactive({
      tick()
      r <- roster()
      if (nrow(r) == 0) return(data.frame())
      mins   <- court$minutes()
      consec <- court$consec()
      tsls   <- time_since_last_sub(court$events(), clock$elapsed(), r$player_id)
      on_now <- court$on_court_ids()

      data.frame(
        Name        = r$name,
        `#`         = r$jersey,
        Status      = ifelse(r$player_id %in% on_now, "ON", "bench"),
        Minutes     = sprintf("%.1f", mins[r$player_id]),
        Consecutive = ifelse(r$player_id %in% on_now,
                             sprintf("%.1f", consec[r$player_id] %||% 0),
                             "—"),
        `Time since last sub` = ifelse(is.na(tsls[r$player_id]),
                                       "—",
                                       fmt_clock(tsls[r$player_id])),
        check.names = FALSE,
        stringsAsFactors = FALSE
      )
    })

    output$table <- DT::renderDT({
      df <- table_df()
      r  <- roster()
      consec_threshold <- rule_settings$params()$warn_color_minutes %||% 4
      consec_vals <- court$consec()
      # Build a row-level "tired" flag for highlighting
      tired_idx <- which(r$player_id %in% court$on_court_ids() &
                         (consec_vals[r$player_id] %||% 0) > consec_threshold)
      on_idx    <- which(r$player_id %in% court$on_court_ids())

      dt <- DT::datatable(
        df,
        rownames = FALSE,
        selection = "none",
        options = list(
          dom = "t",
          pageLength = 50,
          ordering = TRUE,
          columnDefs = list(list(className = "dt-center", targets = "_all"))
        )
      )
      if (length(on_idx) > 0) {
        dt <- DT::formatStyle(dt, "Status",
                              target = "row",
                              backgroundColor = DT::styleEqual("ON", "#e8f4ff"))
      }
      if (length(tired_idx) > 0) {
        # Override: tired rows go amber regardless of ON status
        # We do this by colouring the Consecutive column heavily.
        dt <- DT::formatStyle(dt, "Consecutive",
          backgroundColor = DT::styleInterval(consec_threshold,
                                              c("transparent", "#ffd27a")),
          fontWeight = "bold")
      }
      dt
    })
  })
}
