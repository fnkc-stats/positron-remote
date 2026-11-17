#!/usr/bin/env bash
# Adds CRAN packages to env/renv.lock (the team image r-env): the given packages and those of their dependencies
# the image lacks, at the versions of the image's CRAN snapshot. Versions already in renv.lock never change: a
# package whose requirements need a newer version of one of them is refused (that needs a new snapshot instead).
# Runs in a container of the published r-env image on this computer, which needs Docker and network.
#
# Usage: env/add-packages.sh [--image repository@sha256:...] package ...
#   Default image: project-template/container.json. It must have been built from the current env/renv.lock.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }
image=""
if [ "${1:-}" = --image ]; then image="${2:?--image needs repository@sha256:...}"; shift 2; fi
[ $# -gt 0 ] || { echo "usage: env/add-packages.sh [--image repository@sha256:...] package ..." >&2; exit 2; }
[ -n "$image" ] || image="$(jq -r .image "$here/../project-template/container.json")"
echo "Image: $image"

# Under the repository (ignored by git): Colima mounts only directories under the home directory
out="$here/../.cache/add-packages"
rm -rf "$out"; mkdir -p "$out"; trap 'rm -rf "$out"' EXIT
chmod 0777 "$out"
cp "$here/renv.lock" "$out/renv.lock"
docker run --rm --user 1000:1000 -e HOME=/tmp -w /tmp -v "$out:/out" --entrypoint Rscript "$image" -e '
pkgs <- commandArgs(trailingOnly = TRUE)
locked <- jsonlite::read_json("/out/renv.lock")$Packages
have <- installed.packages()[, "Version"]
if (!identical(have[names(locked)], vapply(locked, `[[`, character(1), "Version")))
  stop("the image was not built from the current env/renv.lock; pass the image built from it with --image")
if (length(intersect(pkgs, names(locked)))) message("Already in renv.lock, not added: ", paste(intersect(pkgs, names(locked)), collapse = ", "))
pkgs <- setdiff(pkgs, names(locked))
if (!length(pkgs)) stop("no packages to add")

lib <- file.path(tempdir(), "lib")
dir.create(lib)
.libPaths(c(lib, .libPaths()))
install.packages(pkgs, lib = lib)
added <- rownames(installed.packages(lib.loc = lib))
if (length(setdiff(pkgs, added))) stop("not installed: ", paste(setdiff(pkgs, added), collapse = ", "))

# install.packages() installs missing dependencies only: check that the image versions meet the new requirements
ip <- installed.packages(lib.loc = .libPaths())
ip <- ip[!duplicated(ip[, "Package"]), ]
versions <- setNames(ip[, "Version"], ip[, "Package"])
unmet <- character()
for (p in added) for (field in c("Depends", "Imports", "LinkingTo")) {
  if (is.na(ip[p, field])) next
  for (req in tools:::.split_dependencies(ip[p, field])) {
    if (req$name == "R" || is.null(req$op) || is.na(versions[req$name])) next
    if (!do.call(req$op, list(package_version(versions[req$name]), req$version)))
      unmet <- c(unmet, sprintf("%s needs %s %s %s, renv.lock has %s", p, req$name, req$op, req$version, versions[req$name]))
  }
}
if (length(unmet)) stop("requirements not met by renv.lock (choose a newer snapshot):\n  ", paste(unmet, collapse = "\n  "))
for (p in added) if (!requireNamespace(p, quietly = TRUE)) stop("cannot load ", p)

# Lockfile records written by renv itself, as for the existing entries
project <- file.path(tempdir(), "project")
dir.create(project)
renv::snapshot(project = project, library = .libPaths(), lockfile = "/out/new.lock", packages = added,
               prompt = FALSE, force = TRUE)
records <- jsonlite::read_json("/out/new.lock")$Packages[added]
jsonlite::write_json(records, "/out/added.json", auto_unbox = TRUE, pretty = TRUE, digits = NA)
cat("Adding", length(added), "packages:", paste(sort(added), collapse = ", "), "\n")
' "$@"

# Merge the new records; packages sorted by name as renv writes them, no newline at the end as renv writes it.
# renv names the snapshot repository RSPM; the packages are CRAN's, as for the existing records.
printf '%s' "$(jq --slurpfile added "$out/added.json" \
  '.Packages = (.Packages + ($added[0] | map_values(.Repository = "CRAN")) | to_entries | sort_by(.key) | from_entries)' \
  "$here/renv.lock")" > "$out/merged.lock"
mv "$out/merged.lock" "$here/renv.lock"
echo "Updated env/renv.lock: $(jq '.Packages | length' "$here/renv.lock") packages. Commit it; CI builds and checks the new image."
