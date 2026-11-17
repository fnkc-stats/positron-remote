# Entry point inside the container (checks/run.sh): Rscript /checks/check.R OUT [TASK...]
# Runs the package check and then every task, each in its own R process: a crash in compiled code
# (the typical result of packages built against different versions) fails one step, not the whole run.
args <- commandArgs(trailingOnly = TRUE)
if (!requireNamespace("jsonlite", quietly = TRUE)) {
  message("The checks need the jsonlite package, which this library does not have: ", paste(.libPaths(), collapse = ", "))
  quit(status = 1)
}
out <- args[1]
wanted <- args[-1]
root <- "/checks"
rscript <- file.path(R.home("bin"), "Rscript")
timeout <- as.integer(Sys.getenv("R_ENV_CHECK_TIMEOUT", "900"))

tasks <- sub("\\.R$", "", list.files(file.path(root, "tasks"), pattern = "\\.R$"))
steps <- c("packages", tasks)
if (length(wanted)) {
  unknown <- setdiff(wanted, steps)
  if (length(unknown)) stop("Unknown task: ", paste(unknown, collapse = ", "), ". Known: ", paste(steps, collapse = ", "))
  steps <- intersect(steps, wanted)
}

cat(sprintf("R %s, %s, %d steps\n\n", getRversion(), R.version$platform, length(steps)))
results <- lapply(steps, function(step) {
  script <- if (step == "packages") file.path(root, "lib", "packages.R") else file.path(root, "lib", "task.R")
  cat(sprintf("==> %s\n", step))
  started <- Sys.time()
  status <- suppressWarnings(system2(rscript, c(script, step, out), timeout = timeout))
  seconds <- round(as.numeric(difftime(Sys.time(), started, units = "secs")), 1)
  file <- file.path(out, paste0(step, ".json"))
  res <- if (file.exists(file)) jsonlite::read_json(file) else list()
  # No result file: the process died before writing it (crash, timeout, out of memory)
  ok <- identical(status, 0L) && identical(res$status, "ok")
  if (!file.exists(file)) res$error <- sprintf("R process ended with status %s and wrote no result (crash or timeout)", status)
  cat(sprintf("    %s in %.0f s%s\n\n", if (ok) "ok" else "FAILED", seconds,
              if (length(res$warnings)) sprintf(", %d warning(s)", length(res$warnings)) else ""))
  list(step = step, ok = ok, seconds = seconds, warnings = length(res$warnings), error = res$error)
})

failed <- Filter(function(r) !r$ok, results)
warned <- Filter(function(r) r$ok && r$warnings > 0, results)
jsonlite::write_json(list(
  R = as.character(getRversion()), platform = R.version$platform,
  lockfile_sha256 = tryCatch(sub(" .*", "", readLines("/usr/local/share/r-env/renv.lock.sha256")), error = function(e) NA, warning = function(w) NA),
  steps = results
), file.path(out, "summary.json"), auto_unbox = TRUE, pretty = TRUE, null = "null")

cat(sprintf("%d of %d steps passed\n", length(results) - length(failed), length(results)))
for (r in warned) cat(sprintf("  warnings: %s (%d), see %s.json\n", r$step, r$warnings, r$step))
for (r in failed) cat(sprintf("  FAILED:   %s: %s\n", r$step, if (is.null(r$error)) "see its JSON file" else r$error))
quit(status = if (length(failed)) 1 else 0)
