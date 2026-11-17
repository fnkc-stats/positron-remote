# Publication tables: gtsummary (descriptive tables with tests, regression tables, merged tables) through gt,
# saved as HTML, Word and Excel. gtsummary relies on cards/cardx/broom.helpers, a chain that breaks easily
# when only some of them are updated.
library(gtsummary)
d <- patients()
d$event <- factor(d$event, 0:1, c("no", "yes"))
d <- labelled::set_variable_labels(d, age = "Age, years", bmi = "BMI, kg/m\u00b2", y = "Outcome score")

t1 <- tbl_summary(d, by = group, include = c(age, sex, bmi, smoker, y, event, score), missing = "ifany") |>
  add_p() |> add_overall() |> add_n() |> bold_labels()
body <- t1$table_body
check(all(c("age", "sex", "bmi", "smoker", "y", "event", "score") %in% body$variable), "tbl_summary has every variable")
check(any(grepl("Age, years", body$label)), "tbl_summary uses variable labels")
p_y <- body$p.value[body$variable == "y" & body$row_type == "label"]
check(length(p_y) == 1 && p_y < 0.001, "add_p finds the simulated difference in the outcome")
record("tbl_summary_p_bmi", body$p.value[body$variable == "bmi" & body$row_type == "label"])

t2 <- tbl_regression(glm(event ~ group + age + bmi, family = binomial, data = d), exponentiate = TRUE) |> bold_p()
or <- t2$table_body$estimate[t2$table_body$variable == "group" & t2$table_body$row_type == "level" & !t2$table_body$reference_row]
check(length(or) == 1 && or > 1, "tbl_regression with exponentiated estimates")
record("tbl_regression_or", or)
t3 <- tbl_regression(lm(y ~ group + age + bmi, data = d))
merged <- tbl_merge(list(t2, t3), tab_spanner = c("**Event**", "**Outcome score**"))
check(inherits(merged, "tbl_merge"), "tbl_merge")
st <- tbl_stack(list(t3, tbl_regression(lme4::lmer(y ~ group + age + (1 | site), data = d))))
check(inherits(st, "tbl_stack"), "tbl_stack with a mixed model")

g <- as_gt(t1) |> gt::tab_header(title = "Table 1")
html <- file.path(work, "table1.html")
gt::gtsave(g, html)
check(any(grepl("Age, years", readLines(html, warn = FALSE), fixed = TRUE)), "gt saves HTML")
docx <- file.path(work, "table1.docx")
gt::gtsave(g, docx)
check(file.size(docx) > 5000, "gt saves Word")

xlsx <- file.path(work, "table1.xlsx")
openxlsx::write.xlsx(as_tibble(t1, col_labels = FALSE), xlsx)
check(nrow(readxl::read_excel(xlsx)) == nrow(body), "gtsummary table to Excel")

# Plain gt table with formatting
gt_tab <- gt::gt(head(d[, c("id", "age", "y", "enrolled")])) |>
  gt::fmt_number(y, decimals = 1) |> gt::fmt_date(enrolled, date_style = "iso")
check(grepl("2024-", gt::as_raw_html(gt_tab)), "gt formats dates")
