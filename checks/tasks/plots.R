# Figures: ggplot2 with extensions (also ggdist and ggpubr), combined with patchwork and cowplot, saved through ragg (PNG, also with
# Cyrillic text) and as PDF; interactive plotly saved as a self-contained HTML widget.
library(ggplot2)
d <- patients()
v <- visits()

saved <- function(p, name, ...) {
  f <- file.path(work, name)
  ggsave(f, p, width = 6, height = 4, dpi = 100, ...)
  check(file.exists(f) && file.size(f) > 2000, paste("saved", name))
  f
}

p1 <- ggplot(d, aes(group, y, colour = group)) +
  ggbeeswarm::geom_quasirandom(alpha = 0.4) +
  stat_summary(fun.data = mean_se, colour = "black") +
  ggsignif::geom_signif(comparisons = list(c("control", "treatment")), test = "t.test") +
  scale_colour_viridis_d(end = 0.8) + theme_minimal()
p2 <- ggplot(v, aes(visit, value, group = id, colour = group)) +
  geom_line(alpha = 0.2) + geom_smooth(aes(group = group), method = "lm", formula = y ~ x) +
  facet_wrap(~ group) + theme_bw()
p3 <- ggplot(d, aes(age, y)) + geom_point(alpha = 0.3) + geom_smooth(method = "gam", formula = y ~ s(x)) +
  ggrepel::geom_text_repel(data = d[which.max(d$y), ], aes(label = id))
p4 <- plot(ggeffects::predict_response(lm(y ~ age * group, data = d), terms = c("age", "group")))
check(all(vapply(list(p1, p2, p3, p4), ggplot2::is_ggplot, logical(1))), "every plot is a ggplot")

png <- saved(patchwork::wrap_plots(p1, p2, p3, p4, ncol = 2) + patchwork::plot_annotation(tag_levels = "A"),
             "combined.png", device = ragg::agg_png)
# Width and height are 4-byte integers at bytes 17-24 of a PNG file
header <- readBin(png, "raw", 24)
size <- c(readBin(header[17:20], "integer", endian = "big"), readBin(header[21:24], "integer", endian = "big"))
check(identical(size, c(600L, 400L)), "PNG has the requested size")
saved(cowplot::plot_grid(p1, p3, labels = "AUTO"), "cowplot.png", device = ragg::agg_png)
cyr <- p1 + labs(title = "\u0413\u0440\u0443\u043f\u043f\u044b \u043f\u0430\u0446\u0438\u0435\u043d\u0442\u043e\u0432", x = "\u0413\u0440\u0443\u043f\u043f\u0430")
saved(cyr, "cyrillic.png", device = ragg::agg_png)
saved(p3, "plot.pdf")

# Built plot data stays the same between versions unless ggplot2 changes how it computes layers
built <- ggplot_build(p3)
record("gam_smooth_first_y", built$data[[2]]$y[1])

w <- plotly::ggplotly(p2)
html <- file.path(work, "interactive.html")
htmlwidgets::saveWidget(w, html, selfcontained = TRUE)
check(file.size(html) > 100000, "plotly widget saved as a self-contained HTML file")

g <- tidygraph::as_tbl_graph(data.frame(from = c("a", "b", "c", "a"), to = c("b", "c", "a", "d")))
gp <- ggraph::ggraph(g, layout = "stress") + ggraph::geom_edge_link() + ggraph::geom_node_point()
saved(gp, "graph.png", device = ragg::agg_png)

# Distributions with ggdist; publication-style plots with ggpubr and a test added by stat_compare_means()
gd <- ggplot(d, aes(y = group, x = y)) + ggdist::stat_halfeye() + ggdist::stat_dotsinterval(side = "bottom")
saved(gd, "ggdist.png", device = ragg::agg_png)
gb <- ggpubr::ggboxplot(d, x = "group", y = "y", color = "group", add = "jitter") +
  ggpubr::stat_compare_means(method = "t.test")
saved(gb, "ggpubr.png", device = ragg::agg_png)
ct <- ggpubr::compare_means(y ~ group, data = d, method = "t.test")
check(ct$p < 0.001, "ggpubr::compare_means finds the simulated difference")
