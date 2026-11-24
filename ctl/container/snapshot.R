# Explicit dependency changes only: fnkc-projects snapshot holds the environment lock.
# A never-completed restore cannot rewrite the project's intended environment. After a recorded failed restore of
# this renv.lock, the user installs the failed packages (another version or source) and records them here.
local({
  project <- Sys.getenv("FNKC_PROJECT")
  dir <- file.path("/home/analyst", project)
  lockfile <- file.path(dir, "renv.lock")
  if (!nzchar(project) || !file.exists(lockfile)) stop("project renv.lock is required")
  source("/usr/local/lib/fnkc/environment.R", local = TRUE)
  marker <- file.path(dir, "renv", ".fnkc-restored")
  before_hash <- unname(tools::md5sum(lockfile))
  restored <- file.exists(marker) && identical(readLines(marker, warn = FALSE), before_hash)
  if (!restored && is.null(fnkc_failure(dir, before_hash))) {
    stop("restore the current renv.lock (start R, or run fnkc-projects restore) before recording package changes")
  }
  options(renv.consent = TRUE, renv.config.activate.prompt = FALSE, renv.prompt.enabled = FALSE)
  before <- jsonlite::read_json(lockfile)
  locked <- names(before$Packages)
  missing <- setdiff(locked, rownames(utils::installed.packages(noCache = TRUE)))
  if (length(missing)) stop("locked packages are missing: ", paste(missing, collapse = ", "),
    "; install them first (renv::install(\"pkg@<version>\") or renv::install(\"owner/pkg@<commit>\"))")
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
  before$Packages <- now[c(locked, sort(setdiff(names(now), locked)))]
  # The hash check runs after the candidate is serialized and validated, immediately before rename.
  fnkc_atomic_write(jsonlite::toJSON(before, auto_unbox = TRUE, pretty = TRUE), lockfile, expected_hash = before_hash)
  fnkc_atomic_write(unname(tools::md5sum(lockfile)), marker)
  unlink(fnkc_failure_file(dir))
  describe <- function(r) if (is.null(r)) "none" else paste0(r$Version, " (", r$Source,
    if (!is.null(r$RemoteSha)) paste0(" ", substr(r$RemoteSha, 1, 12)), ")")
  changed <- Filter(function(k) !identical(now[[k]], old[[k]]), union(names(old), names(now)))
  message("renv.lock entries changed:\n", paste0("  ", changed, ": ", vapply(old[changed], describe, ""),
    " -> ", vapply(now[changed], describe, ""), collapse = "\n"))
  message("renv.lock updated. Review and commit the intentional dependency changes.")
})
