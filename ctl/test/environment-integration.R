# Synthetic fixtures only. Run in a disposable container as analyst, with network disabled.
source("/usr/local/lib/fnkc/environment.R")
dir <- "/home/analyst/fixture"
dir.create(dir, recursive = TRUE)
setwd(dir)
Sys.setenv(FNKC_PROJECT = "fixture", R_PROFILE = "/usr/local/lib/fnkc/Rprofile.R")
lockfile <- file.path(dir, "renv.lock")
lock <- list(R = list(Version = as.character(getRversion()), Repositories = list(list(Name = "CRAN", URL = "https://example.invalid"))),
  Packages = list(jsonlite = list(Package = "jsonlite", Version = as.character(packageVersion("jsonlite")), Source = "Repository", Repository = "CRAN")))
write_lock <- function(x) fnkc_atomic_write(jsonlite::toJSON(x, auto_unbox = TRUE, pretty = TRUE), lockfile)
write_lock(lock)
run <- function(args, env = character()) {
  out <- suppressWarnings(system2("Rscript", args, stdout = TRUE, stderr = TRUE, env = env))
  list(code = if (is.null(attr(out, "status"))) 0L else attr(out, "status"), out = out)
}
show <- function(a) paste(a$out, collapse = "\n")
analysis <- c("-e", shQuote('cat("ANALYSIS_EXECUTED\\n")'))
failed <- "renv/.fnkc-restore-failed"
# Noninteractive startup must restore and verify, not silently use the image's installed version.
a <- run(analysis)
stopifnot(a$code == 0L, any(grepl("ANALYSIS_EXECUTED", a$out)), file.exists("renv/.fnkc-restored"))
# A broken lock (a locked package that cannot be installed) warns and runs; it is never a success marker.
bad <- lock
bad$Packages$fnkcfixture <- list(Package = "fnkcfixture", Version = "0.9.0", Source = "Repository", Repository = "CRAN")
write_lock(bad)
before <- readBin(lockfile, "raw", file.size(lockfile))
a <- run(analysis)
if (a$code != 0L || !any(grepl("ANALYSIS_EXECUTED", a$out))) stop(show(a))
stopifnot(any(grepl("WARNING: R packages do not match renv.lock", a$out)),
  any(grepl("fnkcfixture 0.9.0 -> not installed", a$out, fixed = TRUE)), any(grepl("fnkc-projects snapshot", a$out)),
  !file.exists("renv/.fnkc-restored"), file.exists(failed))
# The recorded failure is not retried at the next start (Quarto starts R repeatedly), but it still warns.
a <- run(analysis)
stopifnot(a$code == 0L, any(grepl("ANALYSIS_EXECUTED", a$out)), !any(grepl("Verifying R packages", a$out)),
  any(grepl("WARNING: R packages do not match renv.lock", a$out)))
# Strict mode keeps the hard stop: it retries and stops before any analysis.
a <- run(analysis, env = "FNKC_STRICT_ENV=1")
stopifnot(a$code == 1L, !any(grepl("ANALYSIS_EXECUTED", a$out)), any(grepl("Verifying R packages", a$out)))
# A snapshot while the failed package is still missing must preserve the exact lockfile.
a <- run("/usr/local/lib/fnkc/snapshot.R", env = "FNKC_RENV_ACTION=snapshot")
stopifnot(a$code != 0L, identical(before, readBin(lockfile, "raw", file.size(lockfile))))
# A changed renv.lock is retried.
bad$Packages$fnkcfixture$Version <- "0.9.1"
write_lock(bad)
a <- run(analysis)
stopifnot(a$code == 0L, any(grepl("Verifying R packages", a$out)),
  any(grepl("fnkcfixture 0.9.1 -> not installed", a$out, fixed = TRUE)))
# Retry succeeds without restarting the container and clears the recorded failure.
write_lock(lock)
a <- run(c("-e", shQuote('cat("RECOVERED\\n")')))
stopifnot(a$code == 0L, any(grepl("RECOVERED", a$out)), file.exists("renv/.fnkc-restored"), !file.exists(failed))
# Same version, different source commit is not the same package identity.
a <- list(Package = "fixture", Version = "1.0.0", Source = "GitHub", RemoteSha = "aaa")
b <- a; b$RemoteSha <- "bbb"
stopifnot(!identical(fnkc_record(a), fnkc_record(b)))
# Fixing a failed restore: install another version of the failed package, then snapshot records it.
write_lock(bad)
a <- run(analysis)
stopifnot(a$code == 0L, file.exists(failed))
# Exercise renv's actual snapshot path with two commits of the same synthetic package version.
package <- file.path(dir, "package")
dir.create(package)
writeLines(c("Package: fnkcfixture", "Version: 1.0.0", "Title: Synthetic Fixture", "Description: A test fixture.",
  "Authors@R: person('Test', 'Fixture', email='test@example.invalid', role=c('aut','cre'))",
  "License: MIT", "RemoteType: github", "RemoteHost: api.github.com", "RemoteUsername: fixture",
  "RemoteRepo: fnkcfixture", "RemoteRef: HEAD", paste0("RemoteSha: ", strrep("a", 40))), file.path(package, "DESCRIPTION"))
writeLines(character(), file.path(package, "NAMESPACE"))
lib <- renv::paths$library(project = dir)
status <- system2("R", c("CMD", "INSTALL", "--no-byte-compile", paste0("--library=", shQuote(lib)), shQuote(package)),
  env = "FNKC_RENV_ACTION=snapshot", stdout = FALSE, stderr = FALSE)
stopifnot(status == 0L)
a <- run("/usr/local/lib/fnkc/snapshot.R", env = "FNKC_RENV_ACTION=snapshot")
if (a$code != 0L) stop(show(a))
stopifnot(identical(jsonlite::read_json(lockfile)$Packages$fnkcfixture$RemoteSha, strrep("a", 40)),
  any(grepl("fnkcfixture: 0.9.1 (Repository) -> 1.0.0", a$out, fixed = TRUE)),
  identical(readLines("renv/.fnkc-restored"), unname(tools::md5sum(lockfile))), !file.exists(failed))
a <- run(analysis)
if (a$code != 0L || any(grepl("WARNING|Verifying R packages", a$out))) stop(show(a))
description <- file.path(lib, "fnkcfixture", "DESCRIPTION")
writeLines(sub(strrep("a", 40), strrep("b", 40), readLines(description)), description)
# Installed package metadata is what packageDescription reads.
metadata <- file.path(lib, "fnkcfixture", "Meta", "package.rds")
meta <- readRDS(metadata); meta$DESCRIPTION[["RemoteSha"]] <- strrep("b", 40); saveRDS(meta, metadata)
a <- run("/usr/local/lib/fnkc/snapshot.R", env = "FNKC_RENV_ACTION=snapshot")
if (a$code != 0L) stop(show(a))
stopifnot(identical(jsonlite::read_json(lockfile)$Packages$fnkcfixture$RemoteSha, strrep("b", 40)))
# Simulate an interrupted candidate write: the committed lockfile remains valid and byte-identical.
before <- readBin(lockfile, "raw", file.size(lockfile))
writeLines('{"incomplete":', ".fnkc-snapshot-interrupted")
stopifnot(identical(before, readBin(lockfile, "raw", file.size(lockfile))))
stopifnot(inherits(try(fnkc_atomic_write("{", lockfile), silent = TRUE), "try-error"))
stopifnot(identical(before, readBin(lockfile, "raw", file.size(lockfile))))
# An edit landing while the candidate is serialized/written/parsed is detected before rename: the
# `lines` promise is forced inside fnkc_atomic_write, i.e. during candidate preparation.
edited <- c(readLines(lockfile), "")
stale <- unname(tools::md5sum(lockfile))
candidate <- function() { writeLines(edited, lockfile); jsonlite::toJSON(lock, auto_unbox = TRUE, pretty = TRUE) }
stopifnot(inherits(try(fnkc_atomic_write(candidate(), lockfile, expected_hash = stale), silent = TRUE), "try-error"))
stopifnot(identical(edited, readLines(lockfile)), !length(setdiff(list.files(dir, "^\\.fnkc-", all.files = TRUE), ".fnkc-snapshot-interrupted")))
cat("PASS: verification, failed restore warns once (strict mode stops), retry on lock change, snapshot after a fix,",
  "provenance, atomic writes, concurrent edit\n")
