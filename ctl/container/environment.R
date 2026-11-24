# Shared environment invariants. Sourcing defines helpers; --restore runs in a vanilla R subprocess
# under flock, so restoration cannot recursively invoke the site's startup profile.
fnkc_record <- function(p) {
  keys <- sort(intersect(c("Package", "Version", "Source", "Repository",
    grep("^Remote", names(p), value = TRUE)), names(p)))
  lapply(p[keys], as.character)
}

# Locked packages whose installed version or provenance differs from renv.lock (not installed: NA).
fnkc_mismatches <- function(lock, libraries) {
  found <- lapply(lock$Packages, function(p) {
    found <- suppressWarnings(utils::packageDescription(p$Package, lib.loc = libraries))
    if (!is.list(found)) return(NA_character_)
    if (!identical(as.character(found$Version), as.character(p$Version))) return(as.character(found$Version))
    # Source provenance is part of identity even if the package version has not changed.
    fields <- grep("^Remote", names(p), value = TRUE)
    same <- all(vapply(fields, function(k) identical(as.character(found[[k]]), as.character(p[[k]])), logical(1)))
    if (same) NULL else as.character(found$Version)
  })
  found <- found[!vapply(found, is.null, logical(1))]
  vapply(found, identity, character(1))
}

fnkc_matches <- function(lock, libraries) length(fnkc_mismatches(lock, libraries)) == 0L

# A failed restore of one renv.lock (by its md5) is recorded once: later R starts warn instead of retrying it.
# A changed renv.lock, `fnkc-projects restore` and strict mode (FNKC_STRICT_ENV=1) try again.
fnkc_failure_file <- function(dir) file.path(dir, "renv", ".fnkc-restore-failed")

fnkc_failure <- function(dir, hash) {
  failure <- tryCatch(jsonlite::read_json(fnkc_failure_file(dir), simplifyVector = TRUE), error = function(e) NULL)
  if (is.list(failure) && identical(failure$lock, hash)) failure else NULL
}

fnkc_failure_text <- function(failure) {
  packages <- if (length(failure$packages)) paste0("  ", failure$packages, collapse = "\n") else "  (see the errors below)"
  errors <- if (length(failure$errors)) paste0("  ", failure$errors, collapse = "\n") else "  (none recorded)"
  paste0(
    "\n==================== WARNING: R packages do not match renv.lock ====================\n",
    "Restoring renv.lock failed. R runs with the packages that are installed; results may differ\n",
    "from the locked environment. Packages that do not match (locked -> installed):\n", packages, "\n",
    "First errors:\n", errors, "\n",
    "Fix: install a version that works, e.g. renv::install(\"owner/pkg@<commit>\") from GitHub or\n",
    "renv::install(\"pkg@<version>\"), then run `fnkc-projects snapshot` in the terminal and commit renv.lock.\n",
    "To retry the restore as it is (e.g. after a network error): `fnkc-projects restore`.\n",
    "===================================================================================\n")
}

# `expected_hash`: refuse unless `path` still has this md5. All serialization and validation happen
# first (`lines` is evaluated lazily inside writeLines), so only the hash check and the rename remain
# in the window. Writers outside the environment lock (Git, editors) can still land in that window:
# this narrows it, it does not close it.
fnkc_atomic_write <- function(lines, path, expected_hash = NULL) {
  tmp <- tempfile(".fnkc-", tmpdir = dirname(path))
  on.exit(unlink(tmp))
  writeLines(lines, tmp)
  # Validate JSON before the only mutation of the original lockfile.
  if (grepl("\\.lock$", path)) jsonlite::read_json(tmp)
  if (!is.null(expected_hash) && !identical(expected_hash, unname(tools::md5sum(path)))) {
    stop(basename(path), " changed while its replacement was prepared; nothing was written, retry")
  }
  if (!file.rename(tmp, path)) stop("cannot atomically replace ", path)
}

fnkc_restore <- function(dir, retry = FALSE) {
  lockfile <- file.path(dir, "renv.lock")
  marker <- file.path(dir, "renv", ".fnkc-restored")
  dir.create(dirname(marker), recursive = TRUE, showWarnings = FALSE)
  lock <- jsonlite::read_json(lockfile)
  hash <- unname(tools::md5sum(lockfile))
  projlib <- renv::paths$library(project = dir)
  dir.create(projlib, recursive = TRUE, showWarnings = FALSE)
  libs <- unique(c(projlib, .libPaths()))
  options(renv.consent = TRUE, renv.config.activate.prompt = FALSE, renv.prompt.enabled = FALSE)
  # A failure cannot leave a success marker, including failure during verification.
  unlink(marker)
  # Another R process may have failed on this renv.lock while this one waited for the lock.
  if (!retry && !is.null(fnkc_failure(dir, hash)) && !fnkc_matches(lock, libs)) quit(save = "no", status = 1L)
  errors <- character()
  if (!fnkc_matches(lock, libs)) tryCatch(
    renv::restore(project = dir, library = projlib, lockfile = lockfile, prompt = FALSE),
    error = function(e) errors <<- conditionMessage(e))
  bad <- fnkc_mismatches(lock, libs)
  if (!identical(hash, unname(tools::md5sum(lockfile)))) stop("renv.lock changed during restoration; retry")
  if (length(bad)) {
    if (!length(errors)) errors <- "installed package versions or provenance do not match renv.lock"
    errors <- head(trimws(Filter(nzchar, unlist(strsplit(errors, "\n")))), 5L)
    locked <- vapply(lock$Packages[names(bad)], function(p) as.character(p$Version), character(1))
    packages <- paste0(names(bad), " ", locked, " -> ", ifelse(is.na(bad), "not installed", bad))
    fnkc_atomic_write(jsonlite::toJSON(list(lock = hash, packages = packages, errors = errors), auto_unbox = TRUE),
      fnkc_failure_file(dir))
    stop("restoring renv.lock failed for: ", paste(names(bad), collapse = ", "))
  }
  fnkc_atomic_write(hash, marker)
  unlink(fnkc_failure_file(dir))
  message("R environment synchronized with renv.lock")
}

args <- commandArgs(trailingOnly = TRUE)
if (length(args) %in% 2:3 && identical(args[[1]], "--restore")) fnkc_restore(args[[2]], identical(args[3], "--retry"))
