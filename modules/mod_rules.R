# mod_rules.R
# Settings panel for the rule engine. Coach can toggle individual rules on/off
# and tweak thresholds. Exposes two reactives consumed by mod_court:
#   - enabled() : named logical vector keyed by rule_id
#   - params()  : list of parameter values (consec threshold, spread tolerance...)

rulesUI <- function(id) {
  ns <- NS(id)
  card(
    card_header("Rule settings"),
    p(em("Toggle rules on/off and adjust thresholds. Changes apply to the next sub.")),
    uiOutput(ns("rule_toggles")),
    hr(),
    h5("Thresholds"),
    sliderInput(ns("consec_threshold"),
                "Consecutive-minutes warning threshold",
                min = 2, max = 12, step = 0.5,
                value = DEFAULT_RULE_PARAMS$consecutive_minutes_threshold),
    sliderInput(ns("spread_tolerance"),
                "Minutes-spread tolerance (± from team average)",
                min = 1, max = 8, step = 0.5,
                value = DEFAULT_RULE_PARAMS$minutes_spread_tolerance),
    sliderInput(ns("warn_color_minutes"),
                "Dashboard 'tired' colour kicks in at",
                min = 2, max = 10, step = 0.5,
                value = DEFAULT_RULE_PARAMS$warn_color_minutes)
  )
}

rulesServer <- function(id) {
  moduleServer(id, function(input, output, session) {
    ns <- session$ns

    # Render one switch per rule. Done in renderUI so adding a rule to the
    # registry automatically surfaces it here.
    output$rule_toggles <- renderUI({
      tagList(lapply(names(RULES), function(rid) {
        label <- RULE_LABELS[[rid]] %||% rid
        div(class = "rule-toggle-row",
          tags$label(class = "switch",
            tags$input(type = "checkbox",
                       id = ns(paste0("enable_", rid)),
                       checked = if (DEFAULT_RULES_ENABLED[[rid]]) "checked" else NULL,
                       onclick = sprintf(
                         "Shiny.setInputValue('%s', {id: '%s', checked: this.checked, n: Math.random()}, {priority: 'event'})",
                         ns("toggle_rule"), rid
                       )),
            tags$span(class = "slider-knob")
          ),
          tags$span(class = "rule-label", label)
        )
      }))
    })

    enabled_rv <- reactiveVal(DEFAULT_RULES_ENABLED)

    observeEvent(input$toggle_rule, {
      ev <- input$toggle_rule
      cur <- enabled_rv()
      cur[[ev$id]] <- isTRUE(ev$checked)
      enabled_rv(cur)
    })

    params <- reactive({
      list(
        consecutive_minutes_threshold = input$consec_threshold %||% 5,
        minutes_spread_tolerance      = input$spread_tolerance %||% 4,
        warn_color_minutes            = input$warn_color_minutes %||% 4
      )
    })

    list(
      enabled = enabled_rv,
      params  = params
    )
  })
}
