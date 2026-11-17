# Run during image build and CI. No implicit recommended-package exemptions.
# Checks renv.lock (the team's packages) and, in a derived image, extra.lock (the packages it adds). A derived
# image only adds packages: a version in extra.lock that differs from renv.lock is an error, so every image
# built from the same r-env has the team's packages at the same versions.
dir <- '/usr/local/share/r-env'
lock <- jsonlite::read_json(file.path(dir, 'renv.lock'))
stopifnot(identical(as.character(getRversion()), lock$R$Version))
expected <- vapply(lock$Packages, `[[`, character(1), 'Version')
if (file.exists(file.path(dir, 'extra.lock'))) {
  extra <- jsonlite::read_json(file.path(dir, 'extra.lock'))
  if (!identical(extra$R$Version, lock$R$Version)) stop('extra.lock is for R ', extra$R$Version, ', the image has ', lock$R$Version)
  added <- vapply(extra$Packages, `[[`, character(1), 'Version')
  common <- intersect(names(added), names(expected))
  changed <- common[added[common] != expected[common]]
  if (length(changed)) stop('extra.lock changes versions of the base image: ', paste(changed, collapse = ', '),
                            '. A derived image only adds packages; change env/renv.lock instead.')
  expected <- c(expected, added[setdiff(names(added), common)])
}
versions <- vapply(names(expected), function(p) {
  if (!requireNamespace(p, quietly = TRUE)) stop('Cannot load locked package: ', p)
  utils::packageDescription(p, fields = 'Version')
}, character(1))
bad <- names(expected)[is.na(versions[names(expected)]) | versions[names(expected)] != expected]
if (length(bad)) stop('Versions differ from the lockfiles: ', paste(bad, collapse = ', '))
ip <- installed.packages()
manifest <- list(R = as.character(getRversion()), platform = R.version$platform,
                 packages = as.data.frame(ip[, c('Package', 'Version', 'LibPath')]),
                 locale = Sys.getlocale(), timezone = Sys.getenv('TZ'),
                 libraries = .libPaths(), external = as.list(extSoftVersion()))
args <- commandArgs(trailingOnly = TRUE)
if (length(args)) jsonlite::write_json(manifest, args[1], pretty = TRUE, auto_unbox = TRUE)
cat('Verified', length(expected), 'locked package versions and namespace loading\n')
