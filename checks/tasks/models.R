# Regression models: lm/glm with broom, car, sandwich; mixed models with lme4, lmerTest, glmmTMB;
# ordinal regression; GAM; estimated marginal means with emmeans and ggeffects.
# Each model must recover the effect simulated in patients() / visits() (lib/helpers.R).
d <- patients()
v <- visits()

fit <- lm(y ~ group + age + bmi + sex, data = d)
co <- broom::tidy(fit, conf.int = TRUE)
b <- co$estimate[co$term == "grouptreatment"]
check(near(b, 3, 1), "lm recovers the treatment effect")
record("lm_treatment", b)
record("lm_treatment_p", co$p.value[co$term == "grouptreatment"])
check(nrow(broom::glance(fit)) == 1, "broom::glance")
a <- car::Anova(fit, type = 2)
record("anova_age_F", a["age", "F value"])
robust <- sqrt(diag(sandwich::vcovHC(fit, type = "HC3")))[["grouptreatment"]]
check(robust > 0, "sandwich::vcovHC")
record("lm_treatment_se_hc3", robust)

lg <- glm(event ~ group + age, family = binomial, data = d)
or <- broom::tidy(lg, exponentiate = TRUE, conf.int = TRUE)
check(near(log(or$estimate[2]), 0.8, 0.5), "logistic regression recovers the odds ratio")
record("glm_log_or", log(or$estimate[2]))

# Mixed models: random intercept per site, and random slopes over visits
mm <- lmerTest::lmer(y ~ group + age + (1 | site), data = d)
ct <- summary(mm)$coefficients
check(near(ct["grouptreatment", "Estimate"], 3, 1), "lmer recovers the treatment effect")
record("lmer_treatment", ct["grouptreatment", "Estimate"])
record("lmer_treatment_df_satterthwaite", ct["grouptreatment", "df"])
rs <- lme4::lmer(value ~ visit * group + (visit | id), data = v)
fe <- lme4::fixef(rs)
check(near(fe[["visit"]], 1.5, 0.3) && near(fe[["visit:grouptreatment"]], 0.8, 0.4), "random slopes model recovers the slopes")
record("lmer_visit_by_treatment", fe[["visit:grouptreatment"]])
check(!lme4::isSingular(rs), "random slopes model is not singular")
check(nrow(broom.mixed::tidy(rs)) > 0, "broom.mixed::tidy")
gm <- lme4::glmer(event ~ group + (1 | site), family = binomial, data = d)
record("glmer_log_or", lme4::fixef(gm)[["grouptreatment"]])

nb <- glmmTMB::glmmTMB(visits_count ~ group + (1 | site), family = glmmTMB::nbinom2, data = d)
rr <- glmmTMB::fixef(nb)$cond[["grouptreatment"]]
check(near(rr, log(0.7), 0.25), "glmmTMB negative binomial recovers the rate ratio")
record("glmmtmb_log_rr", rr)

ol <- ordinal::clm(score ~ group + age, data = d)
check(near(coef(ol)[["grouptreatment"]], 0.7, 0.4), "ordinal::clm recovers the shift")
record("clm_treatment", coef(ol)[["grouptreatment"]])

gam <- mgcv::gam(y ~ group + s(age) + s(site, bs = "re"), data = d, method = "REML")
check(near(coef(gam)[["grouptreatment"]], 3, 1), "mgcv::gam recovers the treatment effect")
record("gam_edf_age", summary(gam)$edf[1])

# Estimated marginal means and contrasts (Kenward-Roger degrees of freedom need pbkrtest)
em <- emmeans::emmeans(mm, ~ group, lmer.df = "kenward-roger")
pc <- as.data.frame(emmeans::contrast(em, "revpairwise"))
check(near(pc$estimate, 3, 1), "emmeans contrast")
record("emmeans_contrast", pc$estimate)
record("emmeans_df_kenward_roger", pc$df)
em_slopes <- as.data.frame(emmeans::emtrends(rs, ~ group, var = "visit"))
check(near(diff(em_slopes$visit.trend), 0.8, 0.4), "emmeans::emtrends")
pr <- ggeffects::predict_response(fit, terms = c("age", "group"))
check(nrow(pr) > 0 && all(c("predicted", "conf.low") %in% names(pr)), "ggeffects::predict_response")
record("ggeffects_first_prediction", pr$predicted[1])
