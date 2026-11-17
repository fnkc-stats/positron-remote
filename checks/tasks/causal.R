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
check(all(abs(s$sum.matched[c("age", "sexmale"), "Std. Mean Diff."]) < 0.1), "matching balances age and sex")
record("matched_pairs", s$nn["Matched", "Treated"])
md <- MatchIt::match.data(m)
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
