# Time-to-event analysis: Kaplan-Meier, log-rank, Cox regression, competing risks, survival plots and tables.
library(survival)
d <- patients()
d$any_event <- as.integer(d$status == 1)

km <- survfit(Surv(time, any_event) ~ group, data = d)
s5 <- summary(km, times = 5)$surv
check(length(s5) == 2 && s5[2] > s5[1], "Kaplan-Meier: treatment survives longer at 5 years")
record("km_surv5_control", s5[1])
lr <- survdiff(Surv(time, any_event) ~ group, data = d)
record("logrank_chisq", lr$chisq)

cox <- coxph(Surv(time, any_event) ~ group + age, data = d)
hr <- coef(cox)[["grouptreatment"]]
check(near(hr, log(0.6), 0.3), "Cox regression recovers the hazard ratio")
record("cox_log_hr", hr)
check(all(cox.zph(cox)$table[, "p"] >= 0), "cox.zph runs")
check(nrow(broom::tidy(cox)) == 2, "broom::tidy for coxph")

# Competing risks: cumulative incidence of event 1 with event 2 competing
d$outcome <- factor(d$status, levels = 0:2, labels = c("censored", "event", "competing"))
ci <- tidycmprsk::cuminc(Surv(time, outcome) ~ group, data = d)
est <- broom::tidy(ci, times = 5)
check(nrow(est) > 0 && all(est$estimate >= 0 & est$estimate <= 1), "tidycmprsk::cuminc")
fg <- tidycmprsk::crr(Surv(time, outcome) ~ group + age, data = d)
record("finegray_log_shr", broom::tidy(fg)$estimate[1])
cr <- cmprsk::cuminc(d$time, d$status, d$group)
check(length(cr) >= 4, "cmprsk::cuminc")

p <- ggsurvfit::survfit2(Surv(time, any_event) ~ group, data = d) |>
  ggsurvfit::ggsurvfit() + ggsurvfit::add_confidence_interval() + ggsurvfit::add_risktable()
png <- file.path(work, "km.png")
ggplot2::ggsave(png, p, width = 7, height = 5, dpi = 100, device = ragg::agg_png)
check(file.size(png) > 10000, "ggsurvfit plot with a risk table")

tb <- gtsummary::tbl_survfit(km, times = c(2, 5), label_header = "**{time} years**")
check(inherits(gtsummary::as_gt(tb), "gt_tbl"), "gtsummary::tbl_survfit")
