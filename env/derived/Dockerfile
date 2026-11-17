# A derived environment image: a published r-env digest plus the packages of derived/<NAME>/extra.lock. All
# binaries are in the image, so containers need no package repository; hosts need no network for packages.
# Built by .github/workflows/derived-image.yml with the env/ folder as context:
#   docker build -f env/derived/Dockerfile --build-arg BASE="$(cat env/derived/<name>/base)" --build-arg NAME=<name> env
# Packages come from the base image's own repository setting (its CRAN snapshot), so they are built for the
# same R and system libraries. verify.R refuses an extra.lock that changes a version the base image has.
ARG BASE
# hadolint ignore=DL3006
FROM ${BASE}
ARG NAME
COPY verify.R /usr/local/share/r-env/verify.R
COPY derived/${NAME}/extra.lock /usr/local/share/r-env/extra.lock
# Working directory must not be /, otherwise renv treats the filesystem root as a project
WORKDIR /tmp
RUN RENV_CONFIG_REPOS_OVERRIDE="$(Rscript -e 'cat(getOption("repos")[["CRAN"]])')" \
 && export RENV_CONFIG_REPOS_OVERRIDE RENV_CONFIG_CACHE_ENABLED=FALSE RENV_CONFIG_SANDBOX_ENABLED=FALSE \
 && Rscript -e 'renv::restore(lockfile = "/usr/local/share/r-env/extra.lock", library = .libPaths()[1], prompt = FALSE, clean = FALSE)' \
 && rm -rf /tmp/Rtmp* /root/.cache
RUN chmod 644 /usr/local/share/r-env/* \
 && Rscript /usr/local/share/r-env/verify.R /usr/local/share/r-env/installed-packages.json \
 && sha256sum /usr/local/share/r-env/extra.lock > /usr/local/share/r-env/extra.lock.sha256
WORKDIR /home/analyst
LABEL org.opencontainers.image.title="r-env-${NAME}" \
      r-env.derived="${NAME}"
