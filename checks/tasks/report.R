# Reports: Quarto renders report.qmd (gtsummary table, ggplot figure, inline results) to HTML and Word;
# R Markdown renders the same content through rmarkdown and knitr.
file.copy(task_file("report.qmd"), work)
quarto <- function(...) {
  log <- suppressWarnings(system2("quarto", c(...), stdout = TRUE, stderr = TRUE))
  status <- attr(log, "status")
  if (!is.null(status) && status != 0) stop("quarto ", paste(c(...), collapse = " "), " failed:\n", paste(tail(log, 30), collapse = "\n"))
  log
}
old <- setwd(work)
quarto("render", "report.qmd", "--to", "html")
quarto("render", "report.qmd", "--to", "docx")
setwd(old)

html <- readLines(file.path(work, "report.html"), warn = FALSE)
check(any(grepl("Patients by group", html)), "HTML report has the table")
check(any(grepl("data:image/png;base64", html)), "HTML report embeds the figure")
check(any(grepl("estimated treatment effect is [0-9]", html)), "HTML report has inline results")
docx <- file.path(work, "report.docx")
check(file.exists(docx) && file.size(docx) > 20000, "Word report")
xml <- readLines(unz(docx, "word/document.xml"), warn = FALSE)
check(any(grepl("Patients by group", xml)), "Word report has the table")

rmd <- file.path(work, "report.Rmd")
writeLines(c("---", "title: R Markdown", "output: html_document", "---", "",
             "```{r}", "summary(lm(dist ~ speed, data = cars))$r.squared", "plot(cars)", "```"), rmd)
out <- rmarkdown::render(rmd, quiet = TRUE, envir = new.env())
check(file.size(out) > 10000, "R Markdown renders to HTML")
