# rules.R
# Rule engine for evaluating a *proposed* on-court lineup before a substitution
# commits. Each rule is an independent function — see "Adding a new rule" in the
# README for the contract.
#
# A rule receives a `state` list:
#   state$proposed_on_court  : data.frame of the 5 players proposed to be on court
#                              (columns: player_id, name, jersey, scorer_tier, ball_handler)
#   state$current_minutes    : named numeric — minutes played per player_id so far
#   state$consecutive_minutes: named numeric — minutes on court without a rest, per player_id
#   state$elapsed_game_min   : numeric — total game minutes elapsed so far
#   state$params             : list of rule parameters (thresholds etc.)
#
# A rule returns a list with:
#   passed   : TRUE if the lineup is fine for this rule
#   severity : "info" | "warning"
#   message  : human-readable string for the modal
#   rule_id  : short id (matches the registry key)

# ---- individual rules --------------------------------------------------------

rule_scorer_balance <- function(state) {
  oc <- state$proposed_on_court
  primary   <- sum(oc$scorer_tier == "primary")
  secondary <- sum(oc$scorer_tier == "secondary")

  # Key rule: don't sub off both scoring threats at once.
  # Failing condition = fewer than 1 primary AND fewer than 2 secondary.
  if (primary < 1 && secondary < 2) {
    return(list(
      passed   = FALSE,
      severity = "warning",
      message  = sprintf(
        "Scoring thin on court: %d primary scorer(s), %d secondary scorer(s). Need at least 1 primary OR 2 secondary.",
        primary, secondary
      ),
      rule_id  = "scorer_balance"
    ))
  }
  list(passed = TRUE, severity = "info", message = "Scoring balance OK.", rule_id = "scorer_balance")
}

rule_ball_handler <- function(state) {
  oc <- state$proposed_on_court
  if (sum(oc$ball_handler) < 1) {
    return(list(
      passed   = FALSE,
      severity = "warning",
      message  = "No ball-handler on court.",
      rule_id  = "ball_handler"
    ))
  }
  list(passed = TRUE, severity = "info", message = "Ball-handler on court.", rule_id = "ball_handler")
}

rule_consecutive_minutes <- function(state) {
  threshold <- state$params$consecutive_minutes_threshold %||% 5
  oc_ids    <- state$proposed_on_court$player_id

  # Only flag players who *would remain* on court after the proposed sub.
  # If a tired player is being subbed off, that's already addressing the issue.
  consecutive <- state$consecutive_minutes[oc_ids]
  consecutive <- consecutive[!is.na(consecutive)]
  over <- consecutive[consecutive > threshold]

  if (length(over) > 0) {
    names_over <- state$proposed_on_court$name[match(names(over), state$proposed_on_court$player_id)]
    return(list(
      passed   = FALSE,
      severity = "warning",
      message  = sprintf(
        "%s would be on for more than %d consecutive minutes without a rest.",
        paste(sprintf("%s (%.1f min)", names_over, over), collapse = ", "),
        threshold
      ),
      rule_id  = "consecutive_minutes"
    ))
  }
  list(passed = TRUE, severity = "info", message = "No fatigue concerns.", rule_id = "consecutive_minutes")
}

rule_minutes_spread <- function(state) {
  tolerance <- state$params$minutes_spread_tolerance %||% 4

  # Only meaningful once at least a few minutes into the game.
  if (state$elapsed_game_min < 4) {
    return(list(passed = TRUE, severity = "info",
                message = "Too early in the game to flag spread.", rule_id = "minutes_spread"))
  }

  mins   <- state$current_minutes
  if (length(mins) < 2) {
    return(list(passed = TRUE, severity = "info", message = "Not enough players.", rule_id = "minutes_spread"))
  }
  team_avg <- mean(mins)
  outliers <- mins[abs(mins - team_avg) > tolerance]

  if (length(outliers) > 0) {
    msg <- paste(
      sprintf("%s: %.1f min (avg %.1f)",
              names(outliers),
              outliers,
              team_avg),
      collapse = "; "
    )
    return(list(
      passed   = FALSE,
      severity = "warning",
      message  = sprintf("Minutes are uneven (>%d min from average): %s", tolerance, msg),
      rule_id  = "minutes_spread"
    ))
  }
  list(passed = TRUE, severity = "info", message = "Minutes spread is even.", rule_id = "minutes_spread")
}

# ---- registry ----------------------------------------------------------------
# To add a new rule:
#   1. Write rule_my_thing(state) returning list(passed, severity, message, rule_id)
#   2. Add it to RULES below with a stable id
#   3. Add a default-enabled entry to DEFAULT_RULES_ENABLED
#   4. Optionally add a parameter to DEFAULT_RULE_PARAMS in global.R and reference
#      it via state$params in your rule

RULES <- list(
  scorer_balance      = rule_scorer_balance,
  ball_handler        = rule_ball_handler,
  consecutive_minutes = rule_consecutive_minutes,
  minutes_spread      = rule_minutes_spread
)

# Human-friendly labels shown in the settings panel
RULE_LABELS <- list(
  scorer_balance      = "Keep at least 1 primary or 2 secondary scorers on court",
  ball_handler        = "Keep a ball-handler on court",
  consecutive_minutes = "Warn after N consecutive minutes without a rest",
  minutes_spread      = "Warn if minutes are uneven across players"
)

DEFAULT_RULES_ENABLED <- setNames(rep(TRUE, length(RULES)), names(RULES))

# ---- engine ------------------------------------------------------------------

#' Evaluate all enabled rules over a proposed lineup state.
#'
#' @param state    list as documented at the top of this file
#' @param enabled  named logical vector — which rules to run (defaults to all)
#' @return list with $all_passed, $failed (list of failed results), $passed
#'         (list of passed results), $raw (all results)
evaluate_rules <- function(state, enabled = DEFAULT_RULES_ENABLED) {
  active_ids   <- names(enabled)[as.logical(enabled)]
  active_rules <- RULES[active_ids]

  results <- lapply(active_rules, function(rule) {
    # If a rule throws, treat as a soft warning rather than crashing the app —
    # the coach still needs to be able to make the swap.
    tryCatch(rule(state), error = function(e) {
      list(passed = FALSE, severity = "warning",
           message = paste("Rule errored:", conditionMessage(e)),
           rule_id = "internal_error")
    })
  })

  list(
    all_passed = all(vapply(results, `[[`, logical(1), "passed")),
    failed     = Filter(function(r) !r$passed, results),
    passed     = Filter(function(r) r$passed,  results),
    raw        = results
  )
}

# Small null-coalesce used above
`%||%` <- function(a, b) if (is.null(a)) b else a
