# Data preparation: dplyr, tidyr, janitor, forcats, lubridate, stringr, purrr, data.table, dtplyr.
library(dplyr, warn.conflicts = FALSE)
d <- patients()

by_group <- d |>
  mutate(age_band = cut(age, c(0, 40, 60, Inf), labels = c("<40", "40-59", "60+")),
         month = lubridate::floor_date(enrolled, "month"),
         site_no = as.integer(stringr::str_extract(site, "[0-9]+"))) |>
  group_by(group, age_band) |>
  summarise(n = n(), across(c(y, bmi), list(mean = ~ mean(.x, na.rm = TRUE), sd = ~ sd(.x, na.rm = TRUE))),
            .groups = "drop")
check(sum(by_group$n) == nrow(d), "group_by/summarise counts every row")
check(all(c("y_mean", "y_sd", "bmi_mean") %in% names(by_group)), "across() names columns")

wide <- tidyr::pivot_wider(by_group, id_cols = age_band, names_from = group, values_from = y_mean)
long <- tidyr::pivot_longer(wide, -age_band, names_to = "group", values_to = "y_mean")
check(nrow(long) == nrow(by_group), "pivot_wider and pivot_longer are inverse")

j <- d |> left_join(tibble(site = levels(d$site), region = rep(c("north", "south"), 4)), by = "site")
check(nrow(j) == nrow(d) && !anyNA(j$region), "left_join")

tab <- janitor::tabyl(d, group, smoker, show_na = FALSE) |> janitor::adorn_totals("both")
check(tail(tab$Total, 1) == sum(!is.na(d$smoker)), "janitor::tabyl totals")
names_clean <- names(janitor::clean_names(data.frame(`Age (years)` = 1, `BMI kg/m2` = 2, check.names = FALSE)))
check(identical(names_clean, c("age_years", "bmi_kg_m2")), "janitor::clean_names")

f <- forcats::fct_lump_n(forcats::fct_infreq(d$site), 3, ties.method = "first")
check(nlevels(f) == 4 && levels(f)[4] == "Other", "forcats lumping")

# data.table and dtplyr give the same means as dplyr
dt <- data.table::as.data.table(d)
m_dt <- dt[, .(y = mean(y)), keyby = group]
m_dplyr <- d |> group_by(group) |> summarise(y = mean(y))
m_dtplyr <- dtplyr::lazy_dt(d) |> group_by(group) |> summarise(y = mean(y)) |> as_tibble()
check(isTRUE(all.equal(m_dt$y, m_dplyr$y)) && isTRUE(all.equal(m_dtplyr$y, m_dplyr$y)), "data.table, dtplyr and dplyr agree")

per_site <- split(d, d$site) |> purrr::map_dbl(~ coef(lm(y ~ age, data = .x))[["age"]])
check(length(per_site) == 8 && all(is.finite(per_site)), "purrr::map over split data")

record("mean_y_treatment_minus_control", diff(m_dplyr$y))
record("mean_age_slope_per_site", mean(per_site))
