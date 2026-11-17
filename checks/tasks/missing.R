# Missing data: describing it (naniar, visdat) and multiple imputation with pooled estimates (mice).
d <- patients()[, c("y", "group", "age", "bmi", "smoker", "sex")]

ms <- naniar::miss_var_summary(d)
check(ms$n_miss[ms$variable == "bmi"] == sum(is.na(d$bmi)), "naniar::miss_var_summary")
p <- naniar::gg_miss_var(d)
check(inherits(p, "ggplot"), "naniar::gg_miss_var")
check(inherits(visdat::vis_miss(d), "ggplot"), "visdat::vis_miss")

imp <- mice::mice(d, m = 5, maxit = 5, seed = 20261117, printFlag = FALSE)
check(!anyNA(mice::complete(imp, 1)), "mice fills every missing value")
pooled <- summary(mice::pool(with(imp, lm(y ~ group + age + bmi))))
b <- pooled$estimate[pooled$term == "grouptreatment"]
check(near(b, 3, 1), "pooled estimate recovers the treatment effect")
record("mice_pooled_treatment", b)
record("mice_pooled_bmi", pooled$estimate[pooled$term == "bmi"])
tb <- gtsummary::tbl_regression(with(imp, lm(y ~ group + age + bmi)))
check(inherits(tb, "tbl_regression"), "gtsummary::tbl_regression for imputed data")
