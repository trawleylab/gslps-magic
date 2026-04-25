# mod_court.R
# On-court / bench interface, substitution flow, rule-warning modal, and the
# "who should I sub next" suggestion panel.
#
# Owns:
#   - on_court_ids        : 5 player ids currently on the floor
#   - events              : append-only event log of all subs
#   - selection_court / selection_bench : tap-state for the proposed swap
#
# Reads:
#   - roster()            : from mod_roster
#   - clock$elapsed()     : from mod_clock
#   - clock$halftime_breaks()
#   - rule_settings()     : enabled rules + params, from mod_rules
#
# Reactive flow on confirm:
#   tap court + bench buttons ── selection sets update ── proposed_lineup() reactive
#   confirm clicked ── evaluate_rules(state, enabled) ── if any failed, show modal
#   modal "override and confirm" OR clean confirm ── append events ── update on_court_ids

# ---- helper: render a single player button ----------------------------------
# Uses a tiny JS handler so we don't need one observer per player_id.
player_button <- function(player, ns, kind, selected = FALSE) {
  cls <- paste(
    "player-btn",
    paste0("player-btn-", kind),
    paste0("tier-bg-", player$scorer_tier),
    if (selected) "selected" else ""
  )
  tags$button(
    class = cls,
    type  = "button",
    onclick = sprintf(
      "Shiny.setInputValue('%s', {id: '%s', kind: '%s', n: Math.random()}, {priority: 'event'})",
      ns("player_click"), player$player_id, kind
    ),
    div(class = "player-jersey", paste0("#", player$jersey)),
    div(class = "player-name",   player$name),
    div(class = "player-badges",
      span(class = paste0("badge tier-badge tier-", player$scorer_tier),
           toupper(substr(as.character(player$scorer_tier), 1, 1))),
      if (isTRUE(player$ball_handler)) span(class = "badge bh-badge", "BH")
    )
  )
}

courtUI <- function(id) {
  ns <- NS(id)
  tagList(
    layout_columns(
      col_widths = c(7, 5),
      gap = "1rem",

      # ---- left: court + bench panels -----------------------------------
      div(
        layout_columns(
          col_widths = c(6, 6), gap = "1rem",
          card(
            card_header("On Court (tap to select)"),
            uiOutput(ns("court_panel"))
          ),
          card(
            card_header("Bench (tap to bring on)"),
            uiOutput(ns("bench_panel"))
          )
        ),
        div(class = "court-controls",
          actionButton(ns("confirm"), "Confirm swap",
                       class = "btn-lg btn-primary btn-confirm"),
          actionButton(ns("cancel"), "Cancel",
                       class = "btn-lg btn-cancel")
        )
      ),

      # ---- right: suggestions panel -------------------------------------
      card(
        card_header("Suggestions"),
        actionButton(ns("suggest_next"), "Suggest a sub now",
                     class = "btn-lg btn-suggest"),
        uiOutput(ns("suggestion_panel"))
      )
    )
  )
}

courtServer <- function(id, roster, clock, rule_settings) {
  moduleServer(id, function(input, output, session) {
    ns <- session$ns

    # ---- state ----------------------------------------------------------
    state <- reactiveValues(
      on_court_ids     = character(0),    # 5 player ids
      events           = empty_events(),
      selection_court  = character(0),
      selection_bench  = character(0),
      lineup_locked    = FALSE            # TRUE once initial 5 picked
    )

    # When the roster first loads (or changes from empty → populated), seed the
    # initial lineup with the first 5 players. The coach can swap immediately.
    observeEvent(roster(), {
      r <- roster()
      if (!state$lineup_locked && nrow(r) >= LINEUP_SIZE) {
        ids <- r$player_id[seq_len(LINEUP_SIZE)]
        state$on_court_ids <- ids
        state$lineup_locked <- TRUE
        # Record initial sub_on events at elapsed = 0
        for (pid in ids) {
          state$events <- rbind(state$events, data.frame(
            player_id = pid, event_type = "sub_on",
            elapsed_seconds = 0,
            period = 1L, wall_time = Sys.time(),
            stringsAsFactors = FALSE
          ))
        }
      }
    }, ignoreNULL = TRUE)

    # ---- derived reactives ---------------------------------------------
    bench_ids <- reactive({
      r <- roster()
      setdiff(r$player_id, state$on_court_ids)
    })

    minutes <- reactive({
      r <- roster()
      if (nrow(r) == 0) return(setNames(numeric(0), character(0)))
      minutes_from_events(state$events, clock$elapsed(), r$player_id)
    })

    consec <- reactive({
      consecutive_minutes(state$events, clock$elapsed(),
                          state$on_court_ids, clock$halftime_breaks())
    })

    proposed_ids <- reactive({
      cur <- state$on_court_ids
      out <- state$selection_court
      inc <- state$selection_bench
      if (length(out) != length(inc)) return(NULL)
      c(setdiff(cur, out), inc)
    })

    proposed_lineup_df <- reactive({
      pid <- proposed_ids()
      if (is.null(pid)) return(NULL)
      r <- roster()
      r[match(pid, r$player_id), , drop = FALSE]
    })

    rule_state_for <- function(proposed_oc) {
      list(
        proposed_on_court   = proposed_oc,
        current_minutes     = minutes(),
        consecutive_minutes = consec(),
        elapsed_game_min    = clock$elapsed() / 60,
        params              = rule_settings$params()
      )
    }

    # ---- panels ---------------------------------------------------------
    output$court_panel <- renderUI({
      r <- roster()
      ids <- state$on_court_ids
      if (length(ids) == 0) {
        return(div(class = "empty-msg", "Add players to your roster to start."))
      }
      sel <- state$selection_court
      tagList(lapply(ids, function(pid) {
        p <- r[r$player_id == pid, , drop = FALSE]
        if (nrow(p) == 0) return(NULL)
        # decorate with consecutive-minutes warning
        cm <- consec()[as.character(pid)] %||% 0
        warn <- isTRUE(cm > (rule_settings$params()$warn_color_minutes %||% 4))
        div(class = if (warn) "tired-wrap" else NULL,
            player_button(p, ns, "court", pid %in% sel))
      }))
    })

    output$bench_panel <- renderUI({
      r <- roster()
      ids <- bench_ids()
      if (length(ids) == 0) {
        return(div(class = "empty-msg", "Bench is empty."))
      }
      sel <- state$selection_bench
      tagList(lapply(ids, function(pid) {
        p <- r[r$player_id == pid, , drop = FALSE]
        if (nrow(p) == 0) return(NULL)
        player_button(p, ns, "bench", pid %in% sel)
      }))
    })

    # ---- click handler --------------------------------------------------
    observeEvent(input$player_click, {
      ev <- input$player_click
      if (ev$kind == "court") {
        if (ev$id %in% state$selection_court) {
          state$selection_court <- setdiff(state$selection_court, ev$id)
        } else {
          state$selection_court <- c(state$selection_court, ev$id)
        }
      } else {
        if (ev$id %in% state$selection_bench) {
          state$selection_bench <- setdiff(state$selection_bench, ev$id)
        } else {
          state$selection_bench <- c(state$selection_bench, ev$id)
        }
      }
    })

    # ---- cancel ---------------------------------------------------------
    observeEvent(input$cancel, {
      state$selection_court <- character(0)
      state$selection_bench <- character(0)
      removeModal()
    })

    # ---- confirm — evaluate rules, show modal if warnings ---------------
    observeEvent(input$confirm, {
      out <- state$selection_court
      inc <- state$selection_bench
      if (length(out) == 0 || length(inc) == 0) {
        showNotification("Tap at least one court player and one bench player.",
                         type = "warning", duration = 3)
        return()
      }
      if (length(out) != length(inc)) {
        showNotification(sprintf("Mismatched selection: %d going off, %d coming on.",
                                 length(out), length(inc)),
                         type = "error", duration = 3)
        return()
      }
      proposed_oc <- proposed_lineup_df()
      results <- evaluate_rules(rule_state_for(proposed_oc),
                                enabled = rule_settings$enabled())

      if (results$all_passed) {
        commit_swap(out, inc)
        showNotification("Substitution applied.", type = "message", duration = 2)
      } else {
        showModal(rule_warning_modal(results, ns))
      }
    })

    # Modal triggers a hidden override button
    observeEvent(input$override_confirm, {
      out <- state$selection_court
      inc <- state$selection_bench
      commit_swap(out, inc)
      removeModal()
      showNotification("Substitution applied (overrode warnings).",
                       type = "warning", duration = 3)
    })

    # ---- the swap commit ------------------------------------------------
    commit_swap <- function(out_ids, in_ids) {
      now_elapsed <- clock$elapsed()
      now_period  <- clock$period()
      new_events <- empty_events()
      for (pid in out_ids) {
        new_events <- rbind(new_events, data.frame(
          player_id = pid, event_type = "sub_off",
          elapsed_seconds = now_elapsed,
          period = now_period, wall_time = Sys.time(),
          stringsAsFactors = FALSE
        ))
      }
      for (pid in in_ids) {
        new_events <- rbind(new_events, data.frame(
          player_id = pid, event_type = "sub_on",
          elapsed_seconds = now_elapsed,
          period = now_period, wall_time = Sys.time(),
          stringsAsFactors = FALSE
        ))
      }
      state$events <- rbind(state$events, new_events)
      state$on_court_ids <- c(setdiff(state$on_court_ids, out_ids), in_ids)
      state$selection_court <- character(0)
      state$selection_bench <- character(0)
    }

    # ---- suggestions panel ---------------------------------------------
    output$suggestion_panel <- renderUI({
      r <- roster()
      if (nrow(r) == 0 || length(state$on_court_ids) < LINEUP_SIZE) return(NULL)

      # If exactly one court player is selected and no bench yet → suggest replacements
      if (length(state$selection_court) == 1 && length(state$selection_bench) == 0) {
        out_id <- state$selection_court[1]
        st <- rule_state_for(roster()[match(state$on_court_ids, r$player_id), ])
        sugg <- suggest_swap_for(out_id, state$on_court_ids, r,
                                 minutes(), consec(), st,
                                 rule_settings$enabled(), top_n = 3)
        if (is.null(sugg) || nrow(sugg) == 0) return(p("No bench players available."))
        out_name <- r$name[r$player_id == out_id]
        return(tagList(
          p(strong(out_name), " coming off — tap a suggestion to pre-select:"),
          lapply(seq_len(nrow(sugg)), function(i) {
            row <- sugg[i, , drop = FALSE]
            actionButton(
              ns(paste0("apply_sugg_", row$in_id)),
              label = HTML(sprintf("<strong>%s</strong><br/><small>%s</small>",
                                   row$in_name,
                                   row$reasons %||% "")),
              class = "btn-suggest-item btn-lg",
              onclick = sprintf(
                "Shiny.setInputValue('%s', {id: '%s', kind: 'bench', n: Math.random()}, {priority: 'event'})",
                ns("player_click"), row$in_id
              )
            )
          })
        ))
      }
      # Otherwise show preview of the proposed swap, if any
      if (length(state$selection_court) > 0 || length(state$selection_bench) > 0) {
        return(div(class = "selection-summary",
          p(strong("Going off: "),
            paste(r$name[match(state$selection_court, r$player_id)], collapse = ", ")),
          p(strong("Coming on: "),
            paste(r$name[match(state$selection_bench, r$player_id)], collapse = ", ")),
          p(em("Tap Confirm to apply."))
        ))
      }
      div(class = "muted",
          p("Tap a court player to see suggested replacements,"),
          p("or press \"Suggest a sub now\" for a one-tap recommendation."))
    })

    # "Suggest a sub now" — pre-fills the selection with the engine's pick.
    observeEvent(input$suggest_next, {
      r <- roster()
      if (length(state$on_court_ids) < LINEUP_SIZE) {
        showNotification("Need 5 on court before suggesting.", type = "warning")
        return()
      }
      st <- rule_state_for(r[match(state$on_court_ids, r$player_id), ])
      pick <- suggest_next_sub(state$on_court_ids, r,
                               minutes(), consec(), st,
                               rule_settings$enabled())
      if (is.null(pick)) {
        showNotification("No suggestion available.", type = "warning")
        return()
      }
      state$selection_court <- pick$out_id
      state$selection_bench <- pick$in_id
      showNotification(sprintf("Suggested: %s ⇄ %s. Reasons: %s. Tap Confirm if happy.",
                               pick$out_name, pick$in_name, pick$reasons),
                       duration = 6, type = "message")
    })

    # ---- exposed --------------------------------------------------------
    list(
      on_court_ids = reactive(state$on_court_ids),
      events       = reactive(state$events),
      minutes      = minutes,
      consec       = consec,
      restore = function(on_court_ids, events) {
        state$on_court_ids <- on_court_ids
        state$events       <- events
        state$lineup_locked <- length(on_court_ids) > 0
      },
      reset = function() {
        state$on_court_ids   <- character(0)
        state$events         <- empty_events()
        state$selection_court <- character(0)
        state$selection_bench <- character(0)
        state$lineup_locked  <- FALSE
      }
    )
  })
}

# ---- modal builder ------------------------------------------------------------

rule_warning_modal <- function(results, ns) {
  warn_items <- lapply(results$failed, function(r) {
    div(class = paste0("rule-msg rule-", r$severity),
        tags$strong(toupper(r$severity)),
        ": ",
        r$message)
  })
  modalDialog(
    title = "Sub triggers warnings",
    size  = "l",
    easyClose = FALSE,
    do.call(tagList, warn_items),
    p(em("The coach can override and proceed, or cancel and adjust the swap.")),
    footer = tagList(
      actionButton(ns("override_confirm"), "Override and confirm",
                   class = "btn-lg btn-warning"),
      actionButton(ns("cancel"), "Cancel",
                   class = "btn-lg btn-secondary")
    )
  )
}
