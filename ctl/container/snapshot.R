# Explicit dependency changes only: fnkc-projects snapshot holds the environment lock.
# A failed or never-completed restore cannot rewrite the project's intended environment.
local({
  project <- Sys.getenv("FNKC_PROJECT")
  dir <- file.path("/home/analyst", project)
  lockfile <- file.path(dir, "renv.lock")
  if (!nzchar(project) || !file.exists(lockfile)) stop("project renv.lock is required")
  source("/usr/local/lib/fnkc/environment.R")
  marker <- file.path(dir, "renv", ".fnkc-restored")
  before_hash <- unname(tools::md5sum(lockfile))
  if (!file.exists(marker) || !identical(readLines(marker, warn = FALSE), before_hash)) {
    stop("restore the current renv.lock successfully before recording intentional package changes")
  }
  options(renv.consent = TRUE, renv.config.activate.prompt = FALSE, renv.prompt.enabled = FALSE)
  before <- jsonlite::read_json(lockfile)
  locked <- names(before$Packages)
  missing <- setdiff(locked, rownames(utils::installed.packages(noCache = TRUE)))
  if (length(missing)) stop("locked packages are missing: ", paste(missing, collapse = ", "))
  projlib <- renv::paths$library(project = dir)
  own <- if (dir.exists(projlib)) rownames(utils::installed.packages(lib.loc = projlib, noCache = TRUE)) else character()
  candidate <- tempfile(".fnkc-snapshot-", tmpdir = dir)
  on.exit(unlink(candidate))
  renv::snapshot(project = dir, library = .libPaths(), lockfile = candidate,
    packages = union(locked, own), prompt = FALSE)
  now <- lapply(renv::lockfile_read(candidate)$Packages, fnkc_record)
  old <- lapply(before$Packages, fnkc_record)
  if (!all(locked %in% names(now))) stop("snapshot would drop locked packages")
  if (identical(now[sort(names(now))], old[sort(names(old))])) return(invisible())
  if (!identical(before_hash, unname(tools::md5sum(lockfile)))) stop("renv.lock changed during snapshot; retry")
  before$Packages <- now[c(locked, sort(setdiff(names(now), locked)))]
  fnkc_atomic_write(jsonlite::toJSON(before, auto_unbox = TRUE, pretty = TRUE), lockfile)
  fnkc_atomic_write(unname(tools::md5sum(lockfile)), marker)
  message("renv.lock updated. Review and commit the intentional dependency changes.")
})
