# Runs one task (checks/tasks/<name>.R) and writes <out>/<name>.json:
#   status, error, warnings, the values the task recorded with record(), and the versions of loaded packages.
# Usage: Rscript task.R NAME OUT
args <- commandArgs(trailingOnly = TRUE)
name <- args[1]
out <- args[2]
root <- "/checks"

helpers <- new.env()
sys.source(file.path(root, "lib", "helpers.R"), envir = helpers)
env <- new.env(parent = helpers)
dir.create(helpers$work <- file.path(tempdir(), name), recursive = TRUE, showWarnings = FALSE)

warnings <- character()
error <- NULL
started <- Sys.time()
withCallingHandlers(
  tryCatch(sys.source(file.path(root, "tasks", paste0(name, ".R")), envir = env, keep.source = FALSE),
           error = function(e) error <<- paste(c(conditionMessage(e), deparse(conditionCall(e))[1]), collapse = "\n  in: ")),
  warning = function(w) {
    warnings <<- c(warnings, paste0(conditionMessage(w), if (!is.null(conditionCall(w))) paste0(" [", deparse(conditionCall(w))[1], "]")))
    invokeRestart("muffleWarning")
  }
)

loaded <- sort(loadedNamespaces())
result <- list(
  task = name,
  status = if (is.null(error)) "ok" else "failed",
  error = error,
  warnings = unique(warnings),
  seconds = round(as.numeric(difftime(Sys.time(), started, units = "secs")), 1),
  values = if (length(helpers$recorded)) helpers$recorded else setNames(list(), character()),
  packages = as.list(setNames(vapply(loaded, function(p) as.character(utils::packageVersion(p)), ""), loaded))
)
if (!is.null(error)) cat("  error: ", error, "\n", sep = "")
for (w in result$warnings) cat("  warning: ", w, "\n", sep = "")
jsonlite::write_json(result, file.path(out, paste0(name, ".json")), auto_unbox = TRUE, pretty = TRUE, digits = NA, null = "null")
quit(status = if (is.null(error)) 0 else 1)
