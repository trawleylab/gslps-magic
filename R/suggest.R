# suggest.R
# Substitution suggestions. Two flavours:
#   * suggest_swap_for(out_id, ...)  — given a player going off, rank the bench
#   * suggest_next_sub(...)          — coach asks "who should I sub now?", we
#                                      return the most defensible one-for-one swap
#
# The ranking is deliberately simple and explainable. We score each candidate
# swap higher when:
#   - the incoming player has fewer minutes (fairness)
#   - the outgoing player has more consecutive minutes (fatigue)
#   - the proposed lineup still satisfies the soft rules (no warnings)
#   - the role-mix is preserved (a primary scorer going off prefers another
#     primary or secondary coming on)

#' Score a single (out, in) swap.
#'
#' Returns a list with $score (numeric, higher = better) and $reasons (chr).
score_swap <- function(out_id, in_id, current_on_court, roster,
                       minutes, consecutive, rule_results) {
  reasons <- character(0)
  score   <- 0

  # --- fairness: prefer bringing on the lowest-minutes player ----------------
  in_min  <- minutes[[as.character(in_id)]] %||% 0
  team_avg <- mean(minutes, na.rm = TRUE)
  fairness <- (team_avg - in_min)            # positive if below average
  score <- score + fairness * 2
  if (fairness > 1) reasons <- c(reasons, sprintf("low minutes (%.1f vs avg %.1f)", in_min, team_avg))

  # --- fatigue: reward subbing off a tired player ----------------------------
  out_consec <- consecutive[[as.character(out_id)]] %||% 0
  score <- score + out_consec * 1.5
  if (out_consec > 3) reasons <- c(reasons, sprintf("rests tired player (%.1f consec min)", out_consec))

  # --- rule compliance: punish swaps that trigger warnings -------------------
  if (!rule_results$all_passed) {
    score <- score - 10 * length(rule_results$failed)
    reasons <- c(reasons, sprintf("triggers %d rule warning(s)", length(rule_results$failed)))
  }

  # --- role match: a like-for-like substitution is usually safer ------------
  out_row <- roster[roster$player_id == out_id, , drop = FALSE]
  in_row  <- roster[roster$player_id == in_id,  , drop = FALSE]
  if (nrow(out_row) && nrow(in_row)) {
    if (as.character(out_row$scorer_tier) == as.character(in_row$scorer_tier)) {
      score <- score + 1
      reasons <- c(reasons, "same scorer tier")
    }
    if (out_row$ball_handler && in_row$ball_handler) {
      score <- score + 0.5
      reasons <- c(reasons, "ball-handler swap")
    }
  }

  list(score = score, reasons = reasons)
}

#' Rank bench players for a given outgoing court player.
#'
#' Returns a data.frame ordered best-first, with columns:
#'   in_id, in_name, score, reasons (semicolon-joined)
suggest_swap_for <- function(out_id, on_court_ids, roster, minutes,
                             consecutive, rule_engine_state, enabled_rules,
                             top_n = 3) {
  bench_ids <- setdiff(roster$player_id, on_court_ids)
  if (length(bench_ids) == 0) return(NULL)

  scored <- lapply(bench_ids, function(in_id) {
    proposed_ids <- c(setdiff(on_court_ids, out_id), in_id)
    proposed_oc  <- roster[match(proposed_ids, roster$player_id), , drop = FALSE]
    state <- modifyList(rule_engine_state, list(proposed_on_court = proposed_oc))
    rr <- evaluate_rules(state, enabled = enabled_rules)
    res <- score_swap(out_id, in_id, on_court_ids, roster, minutes, consecutive, rr)
    name <- roster$name[roster$player_id == in_id]
    data.frame(
      in_id   = in_id,
      in_name = name,
      score   = res$score,
      reasons = paste(res$reasons, collapse = "; "),
      stringsAsFactors = FALSE
    )
  })
  out <- do.call(rbind, scored)
  out <- out[order(-out$score), , drop = FALSE]
  utils::head(out, top_n)
}

#' "Who should I sub now?" — pick the best one-for-one across all on-court
#' players. Returns a one-row data.frame with out_name/in_name/reasons or NULL.
suggest_next_sub <- function(on_court_ids, roster, minutes, consecutive,
                             rule_engine_state, enabled_rules) {
  if (length(on_court_ids) < LINEUP_SIZE) return(NULL)

  best <- NULL
  for (out_id in on_court_ids) {
    cands <- suggest_swap_for(out_id, on_court_ids, roster, minutes,
                              consecutive, rule_engine_state, enabled_rules,
                              top_n = 1)
    if (is.null(cands) || nrow(cands) == 0) next
    out_row <- roster[roster$player_id == out_id, , drop = FALSE]
    cand <- cands[1, , drop = FALSE]
    cand$out_id   <- out_id
    cand$out_name <- out_row$name
    if (is.null(best) || cand$score > best$score) best <- cand
  }
  if (is.null(best)) return(NULL)
  best[, c("out_id", "out_name", "in_id", "in_name", "score", "reasons")]
}
