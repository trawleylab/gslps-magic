# app.R
# GSLPS Magic — courtside substitution manager.
#
# Reactive flow at a glance:
#
#   mod_roster   ──► roster()                          (data frame of players)
#   mod_clock    ──► period(), time_remaining(), elapsed(), running(),
#                    halftime_breaks()
#   mod_rules    ──► enabled(), params()
#                          │
#                          ▼
#   mod_court    ── owns on_court_ids and the events log; calls evaluate_rules()
#                  on confirm; opens the warning modal on failure; emits
#                  on_court_ids() / events() / minutes() / consec() reactives.
#                          │
#                          ▼
#   mod_dashboard ── projection of (roster, court state, clock) — read-only.
#
# Crash recovery: app.R registers an observer that autosaves the in-progress
# game state to disk every AUTOSAVE_INTERVAL_MS. On startup we look for a
# saved snapshot and offer to resume.

source("global.R", local = TRUE)

# ---- UI ----------------------------------------------------------------------

ui <- page_navbar(
  title = "GSLPS Magic — Sub Manager",
  theme = bs_theme(
    version = 5,
    bootswatch = "flatly",
    base_font = font_google("Inter"),
    "font-size-base" = "1.15rem",
    "btn-padding-y"  = "0.9rem",
    "btn-padding-x"  = "1.4rem",
    primary = "#1f6feb"
  ),
  header = tags$head(
    tags$link(rel = "stylesheet", href = "styles.css"),
    tags$meta(name = "viewport",
              content = "width=device-width, initial-scale=1, user-scalable=no")
  ),

  nav_panel("Game",
    layout_columns(
      col_widths = c(3, 9), gap = "1rem",
      div(
        clockUI("clock"),
        br(),
        actionButton("end_game", "End game & save log",
                     class = "btn-lg btn-danger w-100")
      ),
      courtUI("court")
    ),
    br(),
    dashboardUI("dashboard")
  ),

  nav_panel("Roster",
    rosterUI("roster")
  ),

  nav_panel("Rules",
    rulesUI("rules")
  ),

  nav_spacer(),
  nav_item(textOutput("clock_mini", inline = TRUE))
)

# ---- server ------------------------------------------------------------------

server <- function(input, output, session) {

  # Initialize modules. Order matters: clock and rules have no deps; roster is
  # standalone; court depends on the others; dashboard depends on court.
  rules_settings <- rulesServer("rules")
  clock          <- clockServer("clock")
  roster_mod     <- rosterServer("roster")
  court          <- courtServer("court", roster_mod$df, clock, rules_settings)
  dashboardServer("dashboard", roster_mod$df, court, clock, rules_settings)

  # Mini clock in the navbar so the time stays visible from any tab.
  output$clock_mini <- renderText({
    sprintf("⏱ %s  •  Half %d", fmt_clock(clock$time_remaining()), clock$period())
  })

  # ---- crash recovery: offer to restore a saved game on startup -------------
  saved <- load_game_state()
  if (!is.null(saved) && length(saved$on_court_ids %||% NULL) > 0) {
    showModal(modalDialog(
      title = "Resume in-progress game?",
      sprintf("A saved game from %s is on disk. Resume it, or start fresh?",
              saved$saved_at %||% "earlier"),
      footer = tagList(
        actionButton("resume_yes", "Resume", class = "btn-lg btn-primary"),
        actionButton("resume_no",  "Start fresh", class = "btn-lg btn-secondary")
      ),
      easyClose = FALSE
    ))
  }

  observeEvent(input$resume_yes, {
    if (!is.null(saved)) {
      court$restore(
        on_court_ids = unlist(saved$on_court_ids),
        events       = if (is.data.frame(saved$events)) saved$events else empty_events()
      )
      clock$restore(
        period         = saved$period         %||% 1,
        time_remaining = saved$time_remaining %||% PERIOD_LENGTH_SECONDS,
        halftime_breaks = saved$halftime_breaks %||% numeric(0)
      )
    }
    removeModal()
  })

  observeEvent(input$resume_no, {
    clear_game_state()
    removeModal()
  })

  # ---- autosave loop --------------------------------------------------------
  # Snapshot to disk every AUTOSAVE_INTERVAL_MS so a tablet crash mid-game
  # doesn't lose minutes / lineup state.
  autosave_trigger <- reactiveTimer(AUTOSAVE_INTERVAL_MS, session)
  observe({
    autosave_trigger()
    isolate({
      if (length(court$on_court_ids()) > 0) {
        save_game_state(list(
          period          = clock$period(),
          time_remaining  = clock$time_remaining(),
          on_court_ids    = court$on_court_ids(),
          events          = court$events(),
          halftime_breaks = clock$halftime_breaks()
        ))
      }
    })
  })

  # ---- end game: append log, clear autosave ---------------------------------
  observeEvent(input$end_game, {
    showModal(modalDialog(
      title = "End game?",
      "This appends the event log to data/game_log.csv and resets the live state.",
      footer = tagList(
        actionButton("end_yes", "End game", class = "btn-lg btn-danger"),
        modalButton("Cancel")
      ),
      easyClose = FALSE
    ))
  })

  observeEvent(input$end_yes, {
    append_game_log(court$events())
    court$reset()
    clear_game_state()
    removeModal()
    showNotification("Game ended. Log saved to data/game_log.csv.",
                     type = "message", duration = 5)
  })
}

shinyApp(ui, server)
