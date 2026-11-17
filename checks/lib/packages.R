# Checks that the installed packages fit together, over all libraries in .libPaths() (in a project with
# renv.lock: the project library and the image's library together). Writes <out>/packages.json.
#   - every Depends/Imports/LinkingTo requirement is installed in an allowed version, and R is new enough;
#   - Suggests that are installed are in an allowed version (a package uses them when a feature needs them);
#   - compiled packages were built for this R version (major.minor) and platform;
#   - every package's namespace loads without errors or warnings. Warnings at load time are how packages such as
#     glmmTMB and lme4 report that they were built against a different version of TMB or Matrix.
# Usage: Rscript packages.R packages OUT
out <- commandArgs(trailingOnly = TRUE)[2]

ip <- installed.packages(fields = "Built")
# A package in an earlier library hides the same package in later ones, as library() sees it
shadowed <- ip[duplicated(ip[, "Package"]), , drop = FALSE]
ip <- ip[!duplicated(ip[, "Package"]), , drop = FALSE]
installed <- setNames(ip[, "Version"], ip[, "Package"])

problems <- list()
problem <- function(package, kind, detail) problems[[length(problems) + 1]] <<- list(package = package, kind = kind, detail = detail)

parse_requirements <- function(field) {
  if (is.na(field) || !nzchar(trimws(field))) return(list())
  parts <- trimws(strsplit(gsub("\\s+", " ", field), ",", fixed = TRUE)[[1]])
  lapply(parts[nzchar(parts)], function(x) {
    m <- regmatches(x, regexec("^([A-Za-z][A-Za-z0-9.]*)\\s*(?:\\(\\s*(>=|<=|==|!=|>|<)\\s*([^) ]+)\\s*\\))?$", x, perl = TRUE))[[1]]
    if (!length(m)) return(list(name = x, op = NA, version = NA, unparsed = TRUE))
    list(name = m[2], op = if (nzchar(m[3])) m[3] else NA, version = if (nzchar(m[4])) m[4] else NA, unparsed = FALSE)
  })
}

satisfies <- function(have, op, want) {
  if (is.na(op)) return(TRUE)
  tryCatch(isTRUE(match.fun(op)(package_version(have), package_version(want))), error = function(e) FALSE)
}

r_version <- getRversion()
minor <- function(v) paste(unlist(package_version(v))[1:2], collapse = ".")
for (i in seq_len(nrow(ip))) {
  pkg <- ip[i, "Package"]
  for (field in c("Depends", "Imports", "LinkingTo", "Suggests")) {
    for (req in parse_requirements(ip[i, field])) {
      if (req$unparsed) { problem(pkg, "unreadable requirement", sprintf("%s: '%s'", field, req$name)); next }
      want <- if (is.na(req$op)) "" else sprintf(" (%s %s)", req$op, req$version)
      if (req$name == "R") {
        if (!satisfies(as.character(r_version), req$op, req$version))
          problem(pkg, "R too old", sprintf("needs R%s, this is R %s", want, r_version))
        next
      }
      have <- installed[req$name]
      if (is.na(have)) {
        # Binary packages need LinkingTo packages only when they are built; Suggests are optional
        if (field %in% c("Depends", "Imports")) problem(pkg, "missing dependency", sprintf("%s: %s%s is not installed", field, req$name, want))
        next
      }
      if (!satisfies(have, req$op, req$version))
        problem(pkg, if (field == "LinkingTo") "built against another version" else "dependency version",
                sprintf("%s: %s%s, installed %s", field, req$name, want, have))
    }
  }
  built <- ip[i, "Built"]
  if (!is.na(built)) {
    parts <- trimws(strsplit(built, ";", fixed = TRUE)[[1]])
    if (!identical(minor(sub("^R ", "", parts[1])), minor(r_version)))
      problem(pkg, "built for another R", sprintf("built with %s, this is R %s", parts[1], r_version))
    if (length(parts) >= 2 && nzchar(parts[2]) && parts[2] != R.version$platform)
      problem(pkg, "built for another platform", sprintf("built for %s, this is %s", parts[2], R.version$platform))
  }
}

# Load every namespace; packages are loaded in alphabetical order, so a warning raised while loading a dependency
# is reported under the first package that needed it.
load_warnings <- list()
# tcltk needs the Tcl/Tk system libraries, which the image leaves out: containers have no desktop
for (pkg in setdiff(sort(names(installed)), "tcltk")) {
  warned <- character()
  err <- tryCatch(withCallingHandlers(
    { loadNamespace(pkg); NULL },
    warning = function(w) { warned <<- c(warned, conditionMessage(w)); invokeRestart("muffleWarning") }
  ), error = function(e) conditionMessage(e))
  if (!is.null(err)) problem(pkg, "does not load", err)
  for (w in unique(warned)) problem(pkg, "warning while loading", w)
}

libraries <- .libPaths()
cat(sprintf("  %d packages in %d libraries: %s\n", length(installed), length(libraries), paste(libraries, collapse = ", ")))
if (nrow(shadowed)) {
  cat(sprintf("  %d packages are hidden by a version in an earlier library (expected for a project's renv.lock):\n", nrow(shadowed)))
  for (j in seq_len(nrow(shadowed))) cat(sprintf("    %s %s in %s (used: %s)\n", shadowed[j, "Package"], shadowed[j, "Version"],
                                                  shadowed[j, "LibPath"], installed[shadowed[j, "Package"]]))
}
for (p in problems) cat(sprintf("  %s: %s: %s\n", p$package, p$kind, p$detail))
if (!length(problems)) cat("  all requirements met, every namespace loads without warnings\n")

jsonlite::write_json(list(
  task = "packages",
  status = if (length(problems)) "failed" else "ok",
  error = if (length(problems)) sprintf("%d problem(s) with installed packages", length(problems)),
  warnings = list(),
  libraries = libraries,
  problems = problems,
  shadowed = lapply(seq_len(nrow(shadowed)), function(j) as.list(shadowed[j, c("Package", "Version", "LibPath")])),
  packages = as.list(installed)
), file.path(out, "packages.json"), auto_unbox = TRUE, pretty = TRUE, null = "null")
quit(status = if (length(problems)) 1 else 0)
