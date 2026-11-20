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
# Noninteractive startup must restore and verify, not silently use the image's installed version.
a <- run(c("-e", shQuote('cat("ANALYSIS_EXECUTED\\n")')))
stopifnot(a$code == 0L, any(grepl("ANALYSIS_EXECUTED", a$out)), file.exists("renv/.fnkc-restored"))
bad <- lock
bad$Packages$jsonlite$Version <- "999.0.0"
write_lock(bad)
before <- readBin(lockfile, "raw", file.size(lockfile))
a <- run(c("-e", shQuote('cat("ANALYSIS_EXECUTED\\n")')))
stopifnot(a$code != 0L, !any(grepl("ANALYSIS_EXECUTED", a$out)), !file.exists("renv/.fnkc-restored"))
# A snapshot after failed restoration must preserve the exact lockfile, even when the package name exists.
a <- run("/usr/local/lib/fnkc/snapshot.R", env = "FNKC_RENV_ACTION=snapshot")
stopifnot(a$code != 0L, identical(before, readBin(lockfile, "raw", file.size(lockfile))))
# Retry succeeds without restarting the container; a failed attempt is never a success marker.
write_lock(lock)
a <- run(c("-e", shQuote('cat("RECOVERED\\n")')))
stopifnot(a$code == 0L, any(grepl("RECOVERED", a$out)))
# Same version, different source commit is not the same package identity.
a <- list(Package = "fixture", Version = "1.0.0", Source = "GitHub", RemoteSha = "aaa")
b <- a; b$RemoteSha <- "bbb"
stopifnot(!identical(fnkc_record(a), fnkc_record(b)))
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
if (a$code != 0L) stop(paste(a$out, collapse = "\n"))
stopifnot(identical(jsonlite::read_json(lockfile)$Packages$fnkcfixture$RemoteSha, strrep("a", 40)))
description <- file.path(lib, "fnkcfixture", "DESCRIPTION")
writeLines(sub(strrep("a", 40), strrep("b", 40), readLines(description)), description)
# Installed package metadata is what packageDescription reads.
metadata <- file.path(lib, "fnkcfixture", "Meta", "package.rds")
meta <- readRDS(metadata); meta$DESCRIPTION[["RemoteSha"]] <- strrep("b", 40); saveRDS(meta, metadata)
a <- run("/usr/local/lib/fnkc/snapshot.R", env = "FNKC_RENV_ACTION=snapshot")
if (a$code != 0L) stop(paste(a$out, collapse = "\n"))
stopifnot(identical(jsonlite::read_json(lockfile)$Packages$fnkcfixture$RemoteSha, strrep("b", 40)))
# Simulate an interrupted candidate write: the committed lockfile remains valid and byte-identical.
before <- readBin(lockfile, "raw", file.size(lockfile))
writeLines('{"incomplete":', ".fnkc-snapshot-interrupted")
stopifnot(identical(before, readBin(lockfile, "raw", file.size(lockfile))))
stopifnot(inherits(try(fnkc_atomic_write("{", lockfile), silent = TRUE), "try-error"))
stopifnot(identical(before, readBin(lockfile, "raw", file.size(lockfile))))
cat("PASS: noninteractive verification, failed restore, snapshot refusal, retry, provenance, atomic writes\n")
