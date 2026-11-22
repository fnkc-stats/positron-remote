# Shared environment invariants. Sourcing defines helpers; --restore runs in a vanilla R subprocess
# under flock, so restoration cannot recursively invoke the site's startup profile.
fnkc_record <- function(p) {
  keys <- sort(intersect(c("Package", "Version", "Source", "Repository",
    grep("^Remote", names(p), value = TRUE)), names(p)))
  lapply(p[keys], as.character)
}

fnkc_matches <- function(lock, libraries) {
  all(vapply(lock$Packages, function(p) {
    found <- suppressWarnings(utils::packageDescription(p$Package, lib.loc = libraries))
    if (!is.list(found) || !identical(as.character(found$Version), as.character(p$Version))) return(FALSE)
    # Source provenance is part of identity even if the package version has not changed.
    fields <- grep("^Remote", names(p), value = TRUE)
    all(vapply(fields, function(k) identical(as.character(found[[k]]), as.character(p[[k]])), logical(1)))
  }, logical(1)))
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

fnkc_restore <- function(dir) {
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
  if (!fnkc_matches(lock, libs)) {
    renv::restore(project = dir, library = projlib, lockfile = lockfile, prompt = FALSE)
  }
  if (!fnkc_matches(lock, libs)) stop("installed package versions or provenance do not match renv.lock")
  if (!identical(hash, unname(tools::md5sum(lockfile)))) stop("renv.lock changed during restoration; retry")
  fnkc_atomic_write(hash, marker)
  message("R environment synchronized with renv.lock")
}

args <- commandArgs(trailingOnly = TRUE)
if (length(args) == 2L && identical(args[[1]], "--restore")) fnkc_restore(args[[2]])
