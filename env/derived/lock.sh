#!/usr/bin/env bash
# Writes env/derived/<name>/extra.lock: the given CRAN packages and those of their dependencies the base image
# lacks, at the versions of the base image's CRAN snapshot. Packages already in extra.lock are kept.
# Runs in a container of the base image on this computer, which needs Docker and network (hosts need neither).
#
# Usage: env/derived/lock.sh <name> [package ...]
#   The base image is env/derived/<name>/base (one line, repository@sha256:...); for a new name it is created
#   from project-template/container.json.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
name="${1:?usage: env/derived/lock.sh <name> [package ...]}"; shift
[[ "$name" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "name: lowercase letters, digits and -" >&2; exit 2; }
dir="$here/$name"
mkdir -p "$dir"
if [ ! -f "$dir/base" ]; then
  command -v jq >/dev/null || { echo "jq is required to read container.json" >&2; exit 2; }
  jq -r .image "$here/../../project-template/container.json" > "$dir/base"
fi
base="$(tr -d '[:space:]' < "$dir/base")"
echo "Base: $base"
chmod 0777 "$dir"
docker run --rm --user 1000:1000 -e HOME=/tmp -w /tmp -v "$dir:/out" --entrypoint Rscript "$base" -e '
pkgs <- commandArgs(trailingOnly = TRUE)
if (file.exists("/out/extra.lock")) pkgs <- union(names(jsonlite::read_json("/out/extra.lock")$Packages), pkgs)
have <- rownames(installed.packages())
if (length(intersect(pkgs, have))) message("Already in the base image, not added: ", paste(intersect(pkgs, have), collapse = ", "))
pkgs <- setdiff(pkgs, have)
if (!length(pkgs)) stop("no packages to add")
lib <- file.path(tempdir(), "lib")
dir.create(lib)
.libPaths(c(lib, .libPaths()))
install.packages(pkgs, lib = lib)
added <- rownames(installed.packages(lib.loc = lib))
if (length(setdiff(pkgs, added))) stop("not installed: ", paste(setdiff(pkgs, added), collapse = ", "))
repo <- getOption("repos")[["CRAN"]]
lock <- list(
  R = list(Version = as.character(getRversion()), Repositories = list(list(Name = "CRAN", URL = repo))),
  Packages = sapply(sort(added), function(p) list(Package = p, Version = utils::packageDescription(p, lib.loc = lib)$Version,
                                                  Source = "Repository", Repository = "CRAN"), simplify = FALSE))
jsonlite::write_json(lock, "/out/extra.lock", auto_unbox = TRUE, pretty = TRUE)
cat("Wrote extra.lock:", length(added), "packages (", paste(sort(added), collapse = ", "), ")\n")
' "$@"
chmod 0755 "$dir"
