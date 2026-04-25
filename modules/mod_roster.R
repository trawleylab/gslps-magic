# mod_roster.R
# Roster management. View/edit the team roster, save to CSV, reload from disk.
# Exposes the current roster as a reactive consumed by mod_court / mod_dashboard.
#
# Reactive flow:
#   roster_rv$df <── load on init from ROSTER_PATH (or sample)
#                  ── editable DT, edits flow into roster_rv$df
#                  ── save button writes back to CSV
#   exposed:  list(df = reactive(roster_rv$df), set = function(df))

rosterUI <- function(id) {
  ns <- NS(id)
  tagList(
    div(class = "roster-header",
      h3("Roster"),
      div(class = "roster-actions",
        actionButton(ns("add"),    "Add player",  class = "btn-lg btn-primary"),
        actionButton(ns("remove"), "Remove selected", class = "btn-lg"),
        actionButton(ns("save"),   "Save to CSV", class = "btn-lg btn-success"),
        actionButton(ns("reload"), "Reload from CSV", class = "btn-lg")
      )
    ),
    DT::DTOutput(ns("table"))
  )
}

rosterServer <- function(id) {
  moduleServer(id, function(input, output, session) {

    roster_rv <- reactiveValues(df = load_roster())

    # If no CSV exists yet, seed with the sample so the UI isn't empty on first run.
    observe({
      if (nrow(roster_rv$df) == 0) {
        roster_rv$df <- load_roster()  # tries again — sample CSV may be present
      }
    }, priority = 100, autoDestroy = TRUE)

    output$table <- DT::renderDT({
      df <- roster_rv$df
      DT::datatable(
        df,
        editable = list(target = "cell",
                        disable = list(columns = 0)),  # player_id is read-only
        selection = "multiple",
        rownames = FALSE,
        options = list(
          pageLength = 20,
          dom = "t",
          columnDefs = list(list(className = "dt-center", targets = "_all"))
        )
      )
    }, server = FALSE)

    # Apply inline edits back into the reactive df. DT 0-indexes columns.
    observeEvent(input$table_cell_edit, {
      info <- input$table_cell_edit
      df <- roster_rv$df
      col <- names(df)[info$col + 1]
      val <- info$value
      # Coerce by column type
      df[[col]][info$row] <- switch(col,
        jersey       = suppressWarnings(as.integer(val)),
        ball_handler = isTRUE(as.logical(val)) || tolower(val) %in% c("true", "t", "1", "yes"),
        scorer_tier  = factor(val, levels = c("primary", "secondary", "role")),
        as.character(val)
      )
      roster_rv$df <- df
    })

    observeEvent(input$add, {
      df <- roster_rv$df
      new_id <- paste0("p", as.integer(Sys.time()) %% 1e6)
      new_row <- tibble::tibble(
        player_id    = new_id,
        name         = "New Player",
        jersey       = NA_integer_,
        scorer_tier  = factor("role", levels = c("primary", "secondary", "role")),
        ball_handler = FALSE
      )
      roster_rv$df <- dplyr::bind_rows(df, new_row)
    })

    observeEvent(input$remove, {
      sel <- input$table_rows_selected
      if (length(sel) == 0) return()
      roster_rv$df <- roster_rv$df[-sel, , drop = FALSE]
    })

    observeEvent(input$save, {
      save_roster(roster_rv$df)
      showNotification("Roster saved.", type = "message", duration = 2)
    })

    observeEvent(input$reload, {
      roster_rv$df <- load_roster()
      showNotification("Roster reloaded.", type = "message", duration = 2)
    })

    list(
      df  = reactive(roster_rv$df),
      set = function(df) roster_rv$df <- df
    )
  })
}
