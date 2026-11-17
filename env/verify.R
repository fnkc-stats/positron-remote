# Run during image build and CI. No implicit recommended-package exemptions.
lock <- jsonlite::read_json('/usr/local/share/r-env/renv.lock')
stopifnot(identical(as.character(getRversion()), lock$R$Version))
versions <- vapply(names(lock$Packages), function(p) {
  if (!requireNamespace(p, quietly = TRUE)) stop('Cannot load locked package: ', p)
  utils::packageDescription(p, fields = 'Version')
}, character(1))
expected <- vapply(lock$Packages, `[[`, character(1), 'Version')
bad <- names(expected)[is.na(versions[names(expected)]) | versions[names(expected)] != expected]
if (length(bad)) stop('Versions differ from renv.lock: ', paste(bad, collapse = ', '))
ip <- installed.packages()
manifest <- list(R = as.character(getRversion()), platform = R.version$platform,
                 packages = as.data.frame(ip[, c('Package', 'Version', 'LibPath')]),
                 locale = Sys.getlocale(), timezone = Sys.getenv('TZ'),
                 libraries = .libPaths(), external = as.list(extSoftVersion()))
args <- commandArgs(trailingOnly = TRUE)
if (length(args)) jsonlite::write_json(manifest, args[1], pretty = TRUE, auto_unbox = TRUE)
cat('Verified', length(expected), 'locked package versions and namespace loading\n')
