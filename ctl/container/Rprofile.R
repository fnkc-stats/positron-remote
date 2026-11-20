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
  # The project is used without renv's activation (see below): renv::snapshot() would otherwise ask whether to
  # activate it, and activation writes renv/activate.R and .Rprofile. Without the question it uses .libPaths().
  if (is.null(getOption("renv.config.activate.prompt"))) options(renv.config.activate.prompt = FALSE)
  if (!requireNamespace("renv", quietly = TRUE)) {
    message("renv.lock requires renv in this image; refusing an unverified environment")
    quit(save = "no", status = 1L, runLast = FALSE)
  }
  projlib <- renv::paths$library(project = dir)
  site <- "/usr/local/lib/R/site-library"
  # A project with only renv.lock (no renv/activate.R from its .Rprofile): its library comes first in every R
  # process, the console as well as Rscript and quarto render, so renv::install() writes there and
  # renv::snapshot() finds it. The library is kept out of Git, as renv::init() does.
  if (!file.exists(file.path(dir, "renv", "activate.R"))) {
    ignore <- file.path(dir, "renv", ".gitignore")
    if (!file.exists(ignore)) try({
      dir.create(dirname(ignore), showWarnings = FALSE)
      writeLines(c("library/", "local/", "cellar/", "lock/", "python/", "sandbox/", "staging/", ".fnkc-*"), ignore)
    }, silent = TRUE)
    if (!dir.exists(projlib)) try(dir.create(projlib, recursive = TRUE), silent = TRUE)
    if (dir.exists(projlib)) .libPaths(c(projlib, .libPaths()))
  }
  dir.create(file.path(dir, "renv"), showWarnings = FALSE)
  exclude <- file.path(dir, ".git", "info", "exclude")
  if (dir.exists(dirname(exclude))) {
    lines <- if (file.exists(exclude)) readLines(exclude, warn = FALSE) else character()
    if (!"/renv/.fnkc-*" %in% lines) write("/renv/.fnkc-*", exclude, append = TRUE)
  }
  # Snapshot is an explicit user command, and must observe installed changes without restoring over them.
  if (identical(Sys.getenv("FNKC_RENV_ACTION"), "snapshot")) return()
  source("/usr/local/lib/fnkc/environment.R")
  lock <- jsonlite::read_json(lockfile)
  marker <- file.path(dir, "renv", ".fnkc-restored")
  hash <- unname(tools::md5sum(lockfile))
  verified <- file.exists(marker) && identical(readLines(marker, warn = FALSE), hash) &&
    fnkc_matches(lock, unique(c(projlib, .libPaths())))
  if (verified) return()
  # Every execution path (console, Rscript, Quarto) waits for the same kernel lock and verifies its environment.
  message("Verifying R packages from ", file.path(project, "renv.lock"), " ...")
  status <- system2("flock", c("-w", "120", shQuote(file.path(dir, "renv", ".fnkc-environment.lock")),
    "Rscript", "--vanilla", "/usr/local/lib/fnkc/environment.R", "--restore", shQuote(dir)))
  if (status != 0L) {
    message("Environment restoration failed. No analysis was run. Fix the dependency source and retry.")
    quit(save = "no", status = 1L, runLast = FALSE)
  }
})
