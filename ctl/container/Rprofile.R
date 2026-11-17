# Loaded at the start of every R session in a project container (sourced from Rprofile.site by the entrypoint).
local({
  # When the container reaches its memory limit, the kernel stops the process with the highest score: make it
  # the R session (Positron offers to restart it) rather than Positron's own processes in the container.
  try(writeLines("1000", "/proc/self/oom_score_adj"), silent = TRUE)

  # Tell the user if the previous R session was stopped for using too much memory
  if (interactive()) {
    events <- tryCatch(readLines("/sys/fs/cgroup/memory.events", warn = FALSE), error = function(e) character())
    kills <- suppressWarnings(as.integer(sub("^oom_kill ", "", grep("^oom_kill ", events, value = TRUE))))
    seen_file <- "/tmp/.fnkc-oom-seen"
    seen <- suppressWarnings(as.integer(tryCatch(readLines(seen_file, warn = FALSE), error = function(e) "0")))
    if (length(kills) == 1 && !is.na(kills) && kills > max(0L, seen[1], na.rm = TRUE)) {
      limit <- tryCatch(readLines("/sys/fs/cgroup/memory.max", warn = FALSE), error = function(e) "max")
      gb <- if (grepl("^[0-9]+$", limit)) sprintf("%.1f GB", as.numeric(limit) / 2^30) else "its limit"
      message(
        "\nNote: the previous R session was stopped because the project used all of its memory (", gb, ").\n",
        "Load less at once (arrow, duckdb or data.table instead of whole data frames; rm() and gc() after large\n",
        "intermediate results), or ask the server admin to raise limits.memory.\n"
      )
      try(writeLines(as.character(kills), seen_file), silent = TRUE)
    }
  }

  # Packages in the project library (~/.fnkc-library, kept across restarts) are loaded before the image's.
  # Name the ones that replace an image version: the image's checks were run with the image's version.
  # Not in renv projects: renv replaces the library paths with its own (see below).
  project <- Sys.getenv("FNKC_PROJECT")
  renv_project <- nzchar(project) && file.exists(file.path("/home/analyst", project, "renv.lock"))
  if (interactive() && !renv_project) {
    lib <- Sys.getenv("R_LIBS_USER")
    if (nzchar(lib) && grepl("/[.]fnkc-library/", lib) && dir.exists(lib)) {
      versions <- function(loc) tryCatch({
        ip <- utils::installed.packages(lib.loc = loc, noCache = TRUE)
        stats::setNames(ip[, "Version"], ip[, "Package"])
      }, error = function(e) character())
      own <- versions(lib)
      if (length(own)) {
        image <- versions(setdiff(.libPaths(), lib))
        image <- image[!duplicated(names(image))]
        both <- intersect(names(own), names(image))
        both <- both[own[both] != image[both]]
        message(sprintf("Project library: %d package(s) installed in this project (%s).", length(own), lib))
        if (length(both)) {
          message("  Replacing the image's version: ",
                  paste(sprintf("%s %s (image %s)", both, own[both], image[both]), collapse = ", "), "\n",
                  "  To go back to the image's version: remove.packages(\"<name>\", lib = Sys.getenv(\"R_LIBS_USER\"))")
        }
      }
    }
  }
})

# Projects with renv.lock: the first R console after each container start, and after each change of renv.lock
# (a pull, a snapshot elsewhere), runs renv::restore() into <project>/renv/library on the project volume. The
# entrypoint keeps renv's cache on the project's library volume (RENV_PATHS_CACHE), so the library's links into
# it survive recreation of the container, and makes the image's site-library an external library
# (RENV_CONFIG_EXTERNAL_LIBRARIES): a locked version the image has is used from there, not installed again.
# Packages come from the repositories in renv.lock; a host without network access can only use the image's.
local({
  # renv's one-time "Do you want to proceed?" question would take over the console during the automatic
  # restore (and its answer is kept in the home directory, lost on recreation): renv is the agreed setup here.
  if (is.null(getOption("renv.consent"))) options(renv.consent = TRUE)
  project <- Sys.getenv("FNKC_PROJECT")
  if (!nzchar(project)) return()
  dir <- file.path("/home/analyst", project)
  lockfile <- file.path(dir, "renv.lock")
  if (!file.exists(lockfile)) return()
  if (!requireNamespace("renv", quietly = TRUE)) {
    if (interactive()) message("renv.lock found, but renv is not installed in this image: packages were not restored.")
    return()
  }
  projlib <- renv::paths$library(project = dir)
  site <- "/usr/local/lib/R/site-library"
  # A project with only renv.lock (no renv/activate.R from its .Rprofile): its library comes first in every R
  # process, the console as well as Rscript and quarto render, so install.packages() writes there and
  # renv::snapshot() finds it. The library is kept out of Git, as renv::init() does.
  if (!file.exists(file.path(dir, "renv", "activate.R"))) {
    ignore <- file.path(dir, "renv", ".gitignore")
    if (!file.exists(ignore)) try({
      dir.create(dirname(ignore), showWarnings = FALSE)
      writeLines(c("library/", "local/", "cellar/", "lock/", "python/", "sandbox/", "staging/"), ignore)
    }, silent = TRUE)
    if (!dir.exists(projlib)) try(dir.create(projlib, recursive = TRUE), silent = TRUE)
    if (dir.exists(projlib)) .libPaths(c(projlib, .libPaths()))
  }
  if (!interactive()) return()
  # The marker holds the checksum of the renv.lock last restored; the entrypoint removes it at every start
  marker <- "/tmp/.fnkc-renv-restored"
  sum <- unname(tools::md5sum(lockfile))
  if (file.exists(marker) && identical(tryCatch(readLines(marker, warn = FALSE), error = function(e) ""), sum)) return()
  # Written first, so a failed or interrupted restore does not repeat in every new console
  try(writeLines(sum, marker), silent = TRUE)
  # The project is not activated yet (its .Rprofile runs after this file), so the libraries are explicit: the
  # first is where packages are installed (without it renv would pick .libPaths()[1]); a package found with the
  # locked version in any of them is not installed again.
  message("Restoring R packages from ", file.path(project, "renv.lock"), " ...")
  # No questions at all, also not renv's offer to install other versions when a download fails: they would read
  # the next lines typed into the console. renv's default answer (no) is kept.
  old <- options(renv.prompt.enabled = FALSE)
  tryCatch(renv::restore(project = dir, library = c(projlib, site[dir.exists(site)]), prompt = FALSE),
    error = function(e) {
      message("renv::restore() failed: ", conditionMessage(e), "\nFix it and run renv::restore() in the console.")
    }, finally = options(old))
})
