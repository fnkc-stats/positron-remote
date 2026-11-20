# Records the project's R packages in its renv.lock: run by the entrypoint when the container stops (as the analyst
# user, so the project library comes first in .libPaths(), see Rprofile.R), and by `fnkc-projects snapshot`.
# Recorded: the packages already in renv.lock and the ones installed into the project library (renv/library), with
# their dependencies, at the installed versions. Other packages of the image are not added. Records are written in
# the short form of the templates (env/lock.sh), so a snapshot changes only the lines of changed packages. renv.lock
# is only rewritten when something changed; commit it like any other change.
local({
  project <- Sys.getenv("FNKC_PROJECT")
  dir <- file.path("/home/analyst", project)
  lockfile <- file.path(dir, "renv.lock")
  if (!nzchar(project) || !file.exists(lockfile)) return(invisible())
  if (!requireNamespace("renv", quietly = TRUE)) {
    message("renv is not installed in this image: renv.lock was not updated")
    return(invisible())
  }
  options(renv.consent = TRUE, renv.config.activate.prompt = FALSE, renv.prompt.enabled = FALSE)
  before <- jsonlite::read_json(lockfile)
  # A package of renv.lock that is not installed (a restore that failed or never ran) would be dropped from the
  # file: leave it as it is
  locked <- names(before$Packages)
  missing <- setdiff(locked, rownames(utils::installed.packages(noCache = TRUE)))
  if (length(missing)) {
    message("renv.lock was not updated, not installed: ", paste(missing, collapse = ", "), ". Run renv::restore() first.")
    return(invisible())
  }
  projlib <- renv::paths$library(project = dir)
  own <- if (dir.exists(projlib)) rownames(utils::installed.packages(lib.loc = projlib, noCache = TRUE)) else character()
  text <- readLines(lockfile, warn = FALSE)
  # renv rewrites renv/activate.R for its own version: a change nobody made, which would wait to be committed (and
  # Delete Project would count it as work not on Gitea). The project's file stays as it is.
  activate <- file.path(dir, "renv", "activate.R")
  kept <- if (file.exists(activate)) readBin(activate, "raw", file.size(activate))
  tryCatch(renv::snapshot(project = dir, library = .libPaths(), packages = union(locked, own), prompt = FALSE),
    finally = if (!is.null(kept) && !identical(readBin(activate, "raw", file.size(activate)), kept)) writeBin(kept, activate))
  # Short records: what restore needs (and the Remote* fields of packages from GitHub and the like)
  short <- function(p) {
    p <- p[intersect(c("Package", "Version", "Source", "Repository", sort(grep("^Remote", names(p), value = TRUE))), names(p))]
    lapply(p, as.character)
  }
  now <- lapply(renv::lockfile_read(lockfile)$Packages, short)
  old <- lapply(before$Packages, short)
  before$Packages <- old
  added <- setdiff(names(now), locked)
  # Same version from the same kind of source: the old record stays (renv may name the repository differently)
  same <- function(p) identical(now[[p]][c("Version", "Source")], old[[p]][c("Version", "Source")])
  changed <- Filter(Negate(same), intersect(locked, names(now)))
  for (p in setdiff(intersect(locked, names(now)), changed)) now[[p]] <- old[[p]]
  if (!length(added) && !length(changed)) {
    # Nothing changed (renv writes another layout and repository URL): keep the file as it was
    writeLines(text, lockfile)
    return(invisible())
  }
  # The file as it was (its R section, the order of its packages), with the changes; new packages at the end.
  # Written with jsonlite in the layout of env/lock.sh (renv::lockfile_write would sort and reformat every line).
  lock <- before
  lock$Packages <- now[c(intersect(locked, names(now)), sort(added))]
  writeLines(jsonlite::toJSON(lock, auto_unbox = TRUE, pretty = TRUE), lockfile)
  message("renv.lock updated", if (length(added)) paste0("; added: ", paste(added, collapse = ", ")),
          if (length(changed)) paste0("; other version: ", paste(changed, collapse = ", ")), ". Review and commit it.")
})
