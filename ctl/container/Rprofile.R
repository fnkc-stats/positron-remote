# Loaded at the start of every R session in a project container (sourced from Rprofile.site by the entrypoint).
local({
  # When the container reaches its memory limit, the kernel stops the process with the highest score: make it
  # the R session (Positron offers to restart it) rather than Positron's own processes in the container.
  try(writeLines("1000", "/proc/self/oom_score_adj"), silent = TRUE)

  # Tell the user if the previous R session was stopped for using too much memory
  if (interactive()) {
    events <- tryCatch(readLines("/sys/fs/cgroup/memory.events", warn = FALSE), error = function(e) character())
    kills <- suppressWarnings(as.integer(sub("^oom_kill ", "", grep("^oom_kill ", events, value = TRUE))))
    seen_file <- "/tmp/.positron-oom-seen"
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

# Projects with their own renv.lock: the first R console after each container start runs renv::restore().
# The library goes to <project>/renv/library on the project volume, so later starts only check it.
# The image's site library stays visible to the project (renv "external library"): a locked package whose
# exact version is already in the image is used from there, not downloaded again. Other versions, and packages
# the image lacks, go to the project library, which comes first in .libPaths(), so the lockfile wins.
# The renv cache is the host's shared volume at /var/cache/positron-renv (agent setting sharedRenvCache):
# a package version installed for one project, by any user, is linked from there for all others. Without that
# volume the cache is off: renv's default cache is in the home directory, which is lost when the container is
# recreated and would leave the project library with broken links. Packages come from the host's rRepository
# (POSITRON_R_REPOSITORY; default CRAN, built from source), not from the repository named in the lockfile.
local({
  # renv's one-time "Do you want to proceed?" question would take over the console during the automatic
  # restore (and its answer is lost with the home directory): using renv here is the agreed setup.
  if (is.null(getOption("renv.consent"))) options(renv.consent = TRUE)
  # The image's own repository (a Posit Package Manager snapshot) may be unreachable from the host:
  # install.packages() and renv use the host's choice instead, for every project.
  repo <- Sys.getenv("POSITRON_R_REPOSITORY")
  if (nzchar(repo)) {
    options(repos = c(CRAN = repo))
    if (!nzchar(Sys.getenv("RENV_CONFIG_REPOS_OVERRIDE"))) Sys.setenv(RENV_CONFIG_REPOS_OVERRIDE = repo)
  }
  project <- Sys.getenv("POSITRON_PROJECT")
  if (!nzchar(project)) return()
  dir <- file.path("/home/analyst", project)
  if (!file.exists(file.path(dir, "renv.lock"))) return()
  site <- unique(c(.Library.site, "/usr/local/lib/R/site-library"))
  site <- site[dir.exists(site) & site != .Library]
  cache <- "/var/cache/positron-renv"
  shared <- dir.exists(cache) && file.access(cache, 2) == 0
  if (shared && !nzchar(Sys.getenv("RENV_PATHS_CACHE"))) Sys.setenv(RENV_PATHS_CACHE = cache)
  if (!nzchar(Sys.getenv("RENV_CONFIG_CACHE_ENABLED")))
    Sys.setenv(RENV_CONFIG_CACHE_ENABLED = if (shared) "TRUE" else "FALSE")
  if (length(site) && !nzchar(Sys.getenv("RENV_CONFIG_EXTERNAL_LIBRARIES")))
    Sys.setenv(RENV_CONFIG_EXTERNAL_LIBRARIES = paste(site, collapse = ":"))

  marker <- "/tmp/.positron-renv-restored"
  if (!interactive() || file.exists(marker)) return()
  if (!requireNamespace("renv", quietly = TRUE)) {
    message("renv.lock found, but renv is not installed in this image: packages were not restored.")
    return()
  }
  # Written first, so a failed or interrupted restore does not repeat in every new console
  try(writeLines(format(Sys.time()), marker), silent = TRUE)
  message("Restoring R packages from ", file.path(project, "renv.lock"), " (once per container start) ...")
  # The project is not activated yet (its .Rprofile runs after this file), so the target library is explicit:
  # without it renv would install into .libPaths()[1], the image's read-only site library.
  # Packages found in any of these libraries with the locked version are not installed again.
  projlib <- renv::paths$library(project = dir)
  # A project with only renv.lock has no renv/.gitignore yet: keep the library out of Git, as renv::init() does
  ignore <- file.path(dir, "renv", ".gitignore")
  if (!file.exists(ignore)) try({
    dir.create(dirname(ignore), showWarnings = FALSE)
    writeLines(c("library/", "local/", "cellar/", "lock/", "python/", "sandbox/", "staging/"), ignore)
  }, silent = TRUE)
  ok <- tryCatch({
    renv::restore(project = dir, library = c(projlib, site), prompt = FALSE)
    TRUE
  }, error = function(e) {
    message("renv::restore() failed: ", conditionMessage(e), "\nFix it and run renv::restore() in the console.")
    FALSE
  })
  # A project with only renv.lock (no renv/activate.R from its .Rprofile) still gets its library on .libPaths()
  if (ok && !file.exists(file.path(dir, "renv", "activate.R")))
    .libPaths(c(projlib, site))
})
