# Observational comparisons: propensity score matching and weighting balance with MatchIt, the treatment effect
# in the matched sample, and the sensitivity of the result to unmeasured confounding with EValue.
# Older and male patients are treated more often here, and age also raises y: the crude difference is biased.
d <- patients(1000)
set.seed(1)
d$treated <- rbinom(nrow(d), 1, plogis(-2 + 0.04 * (d$age - 25) + 0.5 * (d$sex == "male")))
d$outcome <- 10 + 2 * d$treated + 0.15 * d$age + rnorm(nrow(d), 0, 3)
crude <- coef(lm(outcome ~ treated, data = d))[["treated"]]
check(crude > 2.5, "the crude difference is confounded")
record("crude_difference", crude)

m <- MatchIt::matchit(treated ~ age + sex, data = d, method = "nearest", distance = "glm", caliper = 0.2)
s <- summary(m)
md <- MatchIt::match.data(m)
# The caliper: 0.2 standard deviations of the propensity score; no matched pair may be further apart.
# MatchIt before 4.5.4 ignores it on Linux (fixed in 4.5.4, MatchIt issue #163): the R 4.2 snapshot has 4.5.3,
# where every treated patient is matched and the balance below is not reached. Recorded there, not failed.
width <- 0.2 * sd(m$distance)
gap <- max(tapply(md$distance, md$subclass, function(x) diff(range(x))))
record("matchit_caliper_respected", gap <= width + 1e-9)
if (utils::packageVersion("MatchIt") >= "4.5.4") {
  check(gap <= width + 1e-9, sprintf("matched pairs are within the caliper (%.4g, widest pair %.4g)", width, gap))
  smd <- s$sum.matched[c("age", "sexmale"), "Std. Mean Diff."]
  check(all(abs(smd) < 0.1), paste("matching balances age and sex; standardized mean differences:", paste(signif(smd, 3), collapse = ", ")))
}
record("matched_pairs", s$nn["Matched", "Treated"])
att <- lm(outcome ~ treated + age + sex, data = md, weights = weights)
se <- sqrt(sandwich::vcovCL(att, cluster = ~ subclass)["treated", "treated"])
check(near(coef(att)[["treated"]], 2, 0.6), "the matched comparison recovers the effect")
record("matched_effect", coef(att)[["treated"]])
record("matched_effect_se_cluster", se)

# E-values: for a risk ratio, and for the difference above as a standardized mean difference
ev <- EValue::evalues.RR(est = 1.8, lo = 1.3, hi = 2.5)
check(near(ev["E-values", "point"], 1.8 + sqrt(1.8 * 0.8), 1e-6), "EValue::evalues.RR (formula RR + sqrt(RR(RR - 1)))")
smd <- coef(att)[["treated"]] / sd(md$outcome)
evm <- EValue::evalues.MD(est = smd, se = se / sd(md$outcome))
check(evm["E-values", "point"] > 1, "EValue::evalues.MD")
record("evalue_md", evm["E-values", "point"])
