# Builds the R packages of a lockfile into /library (a Docker volume), inside a helper container from the base
# image the library is for (positron-ctl admin build-library). Runs as root with access to the R repository;
# packages are built from source, so they link against exactly this image's system libraries.
#   /build/renv.lock           the lockfile
#   POSITRON_R_REPOSITORY      where packages come from (the host's rRepository)
#   POSITRON_BUILD_JOBS        parallel compiler jobs
# An interrupted build can be run again: renv keeps the packages that are already installed at the locked version.
# Writes /library/.positron-library/renv.lock and build.dcf; the agent marks the library ready after the checks.
lockfile <- "/build/renv.lock"
lib <- "/library"
meta <- file.path(lib, ".positron-library")
repo <- Sys.getenv("POSITRON_R_REPOSITORY", "https://cloud.r-project.org")
jobs <- max(1L, as.integer(Sys.getenv("POSITRON_BUILD_JOBS", "2")))
started <- Sys.time()
dir.create(meta, showWarnings = FALSE)
if (file.exists(file.path(meta, "ready"))) stop("this library is already built and checked; it is never changed")

# renv for the build itself, outside the library; renv installs its own locked version into the library.
# renv (1.3 and later) builds several packages at once; pak as its installer could not resolve the exact older
# versions of a lockfile (2026-11-17), so it is not used.
boot <- file.path(tempdir(), "bootstrap")
dir.create(boot)
.libPaths(c(boot, .libPaths()))
options(repos = c(CRAN = repo), Ncpus = jobs)
install.packages("renv", lib = boot, quiet = TRUE)
Sys.setenv(
  RENV_CONFIG_CACHE_ENABLED = "FALSE", RENV_CONFIG_SANDBOX_ENABLED = "FALSE", RENV_CONFIG_REPOS_OVERRIDE = repo,
  RENV_CONFIG_PAK_ENABLED = "FALSE", MAKEFLAGS = sprintf("-j%d", jobs)
)
message(sprintf("Building %s with renv %s, %d jobs, from %s", lockfile, packageVersion("renv"), jobs, repo))

# Outside a project, so that renv does not treat the working directory as one
owd <- setwd(tempdir())
renv::restore(lockfile = lockfile, library = lib, prompt = FALSE, clean = FALSE)
setwd(owd)

# Every locked package is installed at its locked version, in the library or (R's own packages) in the image
locked <- renv::lockfile_read(lockfile)$Packages
want <- vapply(locked, `[[`, "", "Version")
ip <- installed.packages(c(lib, .Library), noCache = TRUE)
ip <- ip[!duplicated(ip[, "Package"]), , drop = FALSE]
have <- setNames(ip[, "Version"], ip[, "Package"])[names(want)]
bad <- names(want)[is.na(have) | have != want]
if (length(bad)) stop("not installed at the locked version: ", paste(sprintf("%s %s (have %s)", bad, want[bad], have[bad]), collapse = ", "))

invisible(file.copy(lockfile, file.path(meta, "renv.lock"), overwrite = TRUE))
write.dcf(data.frame(
  Lockfile = paste0("sha256:", Sys.getenv("POSITRON_LIBRARY_HASH")),
  Image = Sys.getenv("POSITRON_IMAGE_ID"),
  R = as.character(getRversion()), Platform = R.version$platform,
  Installer = paste("renv", packageVersion("renv")),
  Jobs = jobs, Repository = repo, Packages = length(want),
  InLibrary = sum(ip[, "LibPath"] == lib), Built = format(started, "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
  Minutes = round(as.numeric(difftime(Sys.time(), started, units = "mins")), 1)
), file.path(meta, "build.dcf"))
message(sprintf("Built %d packages into the library in %.0f minutes", sum(ip[, "LibPath"] == lib),
                as.numeric(difftime(Sys.time(), started, units = "mins"))))
