# Meta-analysis: the treatment effect estimated in each site of patients() is pooled with metafor and meta;
# the two packages must agree, and the pooled effect must recover the simulated one. Forest plots are saved.
d <- patients(2000)
sites <- do.call(rbind, lapply(split(d, d$site), function(s) {
  tr <- s$y[s$group == "treatment"]; ct <- s$y[s$group == "control"]
  data.frame(site = s$site[1], m1 = mean(tr), sd1 = sd(tr), n1 = length(tr), m2 = mean(ct), sd2 = sd(ct), n2 = length(ct))
}))

es <- metafor::escalc(measure = "MD", m1i = m1, sd1i = sd1, n1i = n1, m2i = m2, sd2i = sd2, n2i = n2, data = sites)
re <- metafor::rma(yi, vi, data = es, method = "REML")
check(near(re$b[1], 3, 1.2), "metafor::rma recovers the pooled difference")
record("metafor_pooled", re$b[1])
record("metafor_tau2", re$tau2)
record("metafor_i2", re$I2)
check(nrow(as.data.frame(metafor::leave1out(re))) == nrow(sites), "metafor::leave1out")
check(is.numeric(metafor::regtest(re)$pval), "metafor::regtest (Egger test)")

mc <- meta::metacont(n1, m1, sd1, n2, m2, sd2, studlab = site, data = sites, sm = "MD", method.tau = "REML")
check(near(mc$TE.random, re$b[1], 1e-6), "meta and metafor agree on the random effects estimate")
record("meta_pooled_common", mc$TE.common)

png <- file.path(work, "forest.png")
ragg::agg_png(png, width = 900, height = 600, res = 100)
meta::forest(mc)
dev.off()
check(file.size(png) > 5000, "meta::forest plot saved")
pdf(file.path(work, "forest_metafor.pdf"))
metafor::forest(re)
dev.off()
check(file.size(file.path(work, "forest_metafor.pdf")) > 2000, "metafor::forest plot saved")
